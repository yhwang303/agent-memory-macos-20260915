/**
 * CodeBuddy IDE adapter.
 *
 * On-disk layout (Windows; macOS path differs but structure is identical):
 *   %LOCALAPPDATA%/CodeBuddyExtension/Data/<uid>/CodeBuddyIDE/<uid>/
 *     history/<workspace-hash>/<conversation-hash>/
 *       index.json                          (ordered message metadata)
 *       messages/<msgId>.json               (per-message text body)
 *
 * Each `<conversation-hash>` directory = one CodeBuddy IDE conversation.
 * The index.json `messages` array lists role-typed entries; pairing
 * consecutive `(user, assistant)` rows yields one Turn each. Tool rows
 * (role:"tool") in between feed into the turn's toolUses.
 *
 * CodeBuddy double-encodes message content: `messages/<id>.json` carries
 * `{role, message: "<stringified {role,content:[{type,text}]}>"}` — the
 * outer `message` field is itself a JSON string requiring a second
 * `JSON.parse`. The existing src/shared/codebuddy-transcript.ts already
 * handles this; stage 2 will extend it with a forward iterator.
 *
 * Windows long path note: history directories nest deeply
 * (~250+ chars under typical install) and can exceed MAX_PATH=260.
 * Stage 2 adapter implementation will normalize to `\\?\` long-path
 * prefix when running on win32 to be safe.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { iterateCodeBuddyTurns } from '../../../shared/codebuddy-transcript.js';
import { logger } from '../../../utils/logger.js';
import {
  computeFingerprint,
  MAX_ASSISTANT_TEXT,
  MAX_TOOL_INPUT_SUMMARY,
  MAX_USER_TEXT,
  truncate,
} from '../turn-utils.js';
import type {
  AdapterDiscoveryResult,
  ImportAdapter,
  TranscriptFile,
  Turn,
} from '../types.js';

export class CodeBuddyIdeAdapter implements ImportAdapter {
  readonly id = 'codebuddy-ide' as const;
  readonly displayName = 'CodeBuddy IDE';

  roots(): string[] {
    if (process.platform === 'win32') {
      const localAppData = process.env.LOCALAPPDATA;
      if (!localAppData) return [];
      return [join(localAppData, 'CodeBuddyExtension', 'Data')];
    }
    if (process.platform === 'darwin') {
      const home = process.env.HOME;
      if (!home) return [];
      return [
        join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data'),
      ];
    }
    // Linux: not officially supported but allow via XDG fallback.
    const home = process.env.HOME;
    if (!home) return [];
    return [join(home, '.config', 'CodeBuddyExtension', 'Data')];
  }

  async discoverSessions(): Promise<AdapterDiscoveryResult> {
    const probedRoots = this.roots().map((p) => ({
      path: p,
      exists: existsSync(p),
    }));

    const files: TranscriptFile[] = [];
    for (const { path: root, exists } of probedRoots) {
      if (!exists) continue;
      try {
        files.push(...this.scanRoot(root));
      } catch (err) {
        logger.warn('IMPORT', `codebuddy-ide adapter: failed scanning ${root}`, {
          error: String(err),
        });
      }
    }

    logger.info('IMPORT', 'codebuddy-ide adapter discovery', {
      probedRoots,
      filesFound: files.length,
    });

    return { adapterId: this.id, probedRoots, files };
  }

  /**
   * Walk: <root>/<uid>/CodeBuddyIDE/<uid>/history/<wsHash>/<convHash>/index.json
   *
   * Note: CodeBuddyExtension/Data also has an unrelated `default/` and
   * `Public/` subdir at the same level as the user's <uid>. Skip anything
   * that doesn't have a CodeBuddyIDE subdir.
   */
  private scanRoot(root: string): TranscriptFile[] {
    const out: TranscriptFile[] = [];
    let userDirs: string[];
    try {
      userDirs = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return out;
    }

    for (const uid of userDirs) {
      // Two-layer nesting: <uid>/CodeBuddyIDE/<uid>/history/...
      // Sibling: <uid>/CodeBuddyIDE/genie-cache/<projectBasename>/command-bar/<convHash>
      // genie-cache is the only place that maps conversation hashes back to a
      // human-readable project basename (the IDE never persists wsHash → cwd
      // anywhere else). We exploit it to recover project labels for history.
      const ideRoot = join(root, uid, 'CodeBuddyIDE');
      const ideDir = join(ideRoot, uid);
      const historyDir = join(ideDir, 'history');
      if (!existsSync(historyDir)) continue;

      const wsHashToProject = buildWsHashToProjectMap(ideRoot, historyDir);

      let workspaces: string[];
      try {
        workspaces = readdirSync(historyDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      } catch {
        continue;
      }

      for (const ws of workspaces) {
        const wsDir = join(historyDir, ws);
        let conversations: string[];
        try {
          conversations = readdirSync(wsDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
        } catch {
          continue;
        }

        const projectBasename = wsHashToProject.get(ws) ?? null;

        for (const conv of conversations) {
          const indexPath = join(wsDir, conv, 'index.json');
          let mtimeMs = 0;
          try {
            mtimeMs = statSync(indexPath).mtimeMs;
          } catch {
            // No index.json under this conv dir → skip.
            continue;
          }
          // Multi-tier cwd recovery, in priority order:
          //   1. genie-cache wsHash → project basename (e.g. `agent-memory`)
          //   2. file-tree.json — full absolute path (e.g. `d:/retrieval-bench`)
          //   3. messages content scan — drive-rooted absolute path
          //
          // Tier 2/3 give a full absolute path which is strictly better than
          // tier 1's bare basename for hook-overlap matching and dropdown
          // grouping. So tier 2 unconditionally overrides tier 1, and tier 3
          // overrides tier 1 too when it finds something with a slash.
          let cwd: string | null = projectBasename;
          const tier2 = recoverCwdFromFileTree(ideRoot, ws, conv);
          if (tier2) {
            cwd = tier2;
          } else {
            const tier3 = recoverCwdFromMessages(join(wsDir, conv, 'messages'));
            // Accept tier 3 when:
            //   - we have nothing yet, OR
            //   - tier 1 gave only a basename and tier 3 is that same
            //     workspace's full path.
            if (
              tier3 &&
              (!cwd || (!cwd.includes('/') && sameWorkspaceBasename(cwd, tier3)))
            ) {
              cwd = tier3;
            }
          }
          out.push({
            adapterId: this.id,
            filePath: indexPath,
            sessionId: conv,
            cwd,
            mtimeMs,
            extra: { uid, workspaceHash: ws, conversationHash: conv },
          });
        }
      }
    }
    return out;
  }

  // eslint-disable-next-line require-yield
  async *iterateTurns(file: TranscriptFile): AsyncIterable<Turn> {
    // CodeBuddy IDE doesn't store per-turn timestamps reliably, so we use
    // the file mtime as a coarse "started_at" for every turn from the same
    // conversation. Good enough for chronological sorting in AgentMemory search.
    const fallbackStart = file.mtimeMs || Date.now();

    for (const raw of iterateCodeBuddyTurns(file.filePath)) {
      const userText = truncate(raw.userText, MAX_USER_TEXT);
      const assistantText = truncate(raw.assistantText, MAX_ASSISTANT_TEXT);
      // CodeBuddy doesn't expose structured tool_use blocks in transcripts;
      // approximate by lifting truncated tool message bodies as inputSummary.
      const toolUses = raw.toolMessageTexts.map((t, i) => ({
        name: `tool#${i}`,
        inputSummary: truncate(t, MAX_TOOL_INPUT_SUMMARY),
      }));

      yield {
        adapterId: this.id,
        fingerprint: computeFingerprint(this.id, file.filePath, raw.turnIndex, userText),
        filePath: file.filePath,
        sessionId: file.sessionId,
        turnIndex: raw.turnIndex,
        userText,
        assistantText,
        toolUses,
        cwd: file.cwd,
        startedAt: fallbackStart,
      };
    }
  }
}

// ─── genie-cache wsHash → project basename recovery ─────────────────────
//
// CodeBuddy IDE never writes `cwd` into history transcripts, but it does
// keep a parallel cache at:
//
//   <ideRoot>/genie-cache/<projectBasename>/command-bar/<convHash>/
//
// The `<projectBasename>` segment IS the workspace folder name (e.g.
// `agent-memory`, `ai-ide-langfuse`). We can therefore build a
// (convHash → projectBasename) map by walking genie-cache, then derive the
// (wsHash → projectBasename) map by parsing each `history/<wsHash>/index.json`
// and finding which project owns its conversations. Conversations under one
// wsHash always belong to the same workspace, so the first hit per wsHash
// wins.
//
// This recovery is best-effort: a wsHash without any conv in genie-cache
// (e.g. genie-cache was wiped, or conversation pre-dates the cache) returns
// no entry and the adapter falls back to the shared `unknown:codebuddy-ide`
// placeholder.

interface ConvIndexJson {
  conversations?: Array<{ id?: string }>;
}

function buildWsHashToProjectMap(
  ideRoot: string,
  historyDir: string,
): Map<string, string> {
  const wsHashToProject = new Map<string, string>();

  // 1) Walk genie-cache → convHash → projectBasename.
  const convToProject = new Map<string, string>();
  const genieCacheDir = join(ideRoot, 'genie-cache');
  if (!existsSync(genieCacheDir)) {
    return wsHashToProject;
  }

  let projectBasenames: string[];
  try {
    projectBasenames = readdirSync(genieCacheDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    logger.warn('IMPORT', `codebuddy-ide: cannot read genie-cache ${genieCacheDir}`, {
      error: String(err),
    });
    return wsHashToProject;
  }

  for (const project of projectBasenames) {
    const cmdBarDir = join(genieCacheDir, project, 'command-bar');
    if (!existsSync(cmdBarDir)) continue;
    let convHashes: string[];
    try {
      convHashes = readdirSync(cmdBarDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const conv of convHashes) {
      // `current-session` is a non-conv marker dir — skip.
      if (conv === 'current-session') continue;
      // Only the first project for a given conv wins (they should be unique
      // anyway, but defensive).
      if (!convToProject.has(conv)) {
        convToProject.set(conv, project);
      }
    }
  }

  if (convToProject.size === 0) {
    return wsHashToProject;
  }

  // 2) Walk history wsHashes → look up first conv hit in convToProject.
  let wsHashes: string[];
  try {
    wsHashes = readdirSync(historyDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return wsHashToProject;
  }

  for (const ws of wsHashes) {
    const indexPath = join(historyDir, ws, 'index.json');
    let parsed: ConvIndexJson | null = null;
    try {
      const raw = readFileSync(indexPath, 'utf8');
      parsed = JSON.parse(raw) as ConvIndexJson;
    } catch {
      continue;
    }
    const convs = parsed?.conversations ?? [];
    for (const c of convs) {
      if (typeof c?.id !== 'string') continue;
      const project = convToProject.get(c.id);
      if (project) {
        wsHashToProject.set(ws, project);
        break;
      }
    }
  }

  return wsHashToProject;
}

// 1-segment top-level dirs that are USER PROJECT CONTAINERS (D:\github\<repo>,
// C:\ugit\<repo>, etc.). For these we prefer the 2-segment form as the
// workspace cwd. The 1-segment form alone is too coarse — it would lump
// every git clone into one bucket.
const CONTAINER_DIR_LIST = new Set([
  'github',
  'code',
  'dev',
  'src',
  'projects',
  'repos',
  'workspace',
  'ugit',
]);

// 1-segment top-level dirs that are SYSTEM/private data (Users\, AppData\,
// Windows\, etc.). For these the whole prefix is rejected — recovering
// `c:/users/milkwang` as a workspace cwd is never correct.
const SYSTEM_DIR_LIST = new Set([
  'users',
  'appdata',
  'codebuddyextension',
  'program files',
  'program files (x86)',
  'programdata',
  'windows',
  'temp',
  'tmp',
]);
//
// CodeBuddy IDE writes a per-conversation file edit log at:
//   <ideRoot>/<uid>/file-tree/<wsHash>/<convHash>/file-tree.json
// Wait — actually it's at <ideRoot>/file-tree/... (sibling to history).
// Each entry is `{ filePath: "d:/retrieval-bench/foo.ts", ... }`. The first
// non-IDE-data path's 1- or 2-segment workspace prefix is the cwd.

function recoverCwdFromFileTree(
  ideRoot: string,
  wsHash: string,
  convHash: string,
): string | null {
  // file-tree dir lives at <ideRoot>/<uid?>/file-tree/<wsHash>/<convHash>/
  // We don't know `uid` here; try both common layouts.
  const candidates = [
    join(ideRoot, 'file-tree', wsHash, convHash, 'file-tree.json'),
  ];
  // Also walk one level deeper if the genie-cache is at <ideRoot>/<uid>/file-tree.
  // Scanning userDirs is overkill here; in practice the layout matches the
  // history dir's nesting so we take ideRoot's own children once.
  try {
    for (const child of readdirSync(ideRoot, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      candidates.push(
        join(ideRoot, child.name, 'file-tree', wsHash, convHash, 'file-tree.json'),
      );
    }
  } catch {
    /* ignore */
  }

  for (const ftPath of candidates) {
    if (!existsSync(ftPath)) continue;
    let raw: string;
    try {
      raw = readFileSync(ftPath, 'utf8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const fp = (entry as { filePath?: unknown }).filePath;
      if (typeof fp !== 'string') continue;
      const cwd = extractWorkspacePrefix(fp);
      if (cwd) return cwd;
    }
  }
  return null;
}

// ─── tier-3: messages content scan ──────────────────────────────────────
//
// When file-tree.json is empty/missing, the conversation's own messages
// dir often contains the answer indirectly: assistant messages reference
// files via absolute paths like `d:/agentara/src/...` or `d:\\SST\\foo.ts`.
// We scan up to N message files, extract drive-rooted paths, and take the
// most common workspace prefix as the cwd.

function recoverCwdFromMessages(messagesDir: string): string | null {
  if (!existsSync(messagesDir)) return null;
  let files: string[];
  try {
    files = readdirSync(messagesDir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  // Cap scan to first 30 message files — usually enough to see workspace
  // prefix, and bounds the cost on huge conversations.
  const SCAN_CAP = 30;
  const counts = new Map<string, number>();
  // Match drive-letter absolute paths in either Windows (`D:\\foo\\bar`)
  // or POSIX-style (`d:/foo/bar`) form. Note: messages JSON often has
  // escaped backslashes (`d:\\\\foo`), so also handle that form.
  // The `(?<![A-Za-z0-9])` look-behind rejects `https:/...` style URLs
  // where the "drive letter" would be the trailing character of `https`.
  const PATH_RE = /(?<![A-Za-z0-9])([a-zA-Z]):[\\/](?:\\\\|\/)?([a-zA-Z0-9_.-]+)(?:[\\/](?:\\\\|\/)?([a-zA-Z0-9_.-]+))?/g;
  for (const f of files.slice(0, SCAN_CAP)) {
    let body: string;
    try {
      body = readFileSync(join(messagesDir, f), 'utf8');
    } catch {
      continue;
    }
    let m: RegExpExecArray | null;
    PATH_RE.lastIndex = 0;
    while ((m = PATH_RE.exec(body)) !== null) {
      const prefix = classifyPathSegments(m[1], m[2], m[3]);
      if (prefix) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return null;
  // Pick the most-cited prefix. Threshold logic:
  //   - When we have multiple candidate prefixes, require >=2 hits on the
  //     winner to avoid picking up a stray one-off mention amid noise.
  //   - When there's exactly ONE non-system candidate, accept it even with
  //     a single hit. This is the common case for short conversations
  //     where the workspace path is referenced once but unambiguously.
  //     The blacklist already filtered system paths so the lone candidate
  //     is almost always the real workspace.
  let best: string | null = null;
  let bestN = 0;
  for (const [prefix, n] of counts) {
    if (n > bestN) { bestN = n; best = prefix; }
  }
  if (counts.size === 1) return best;
  return bestN >= 2 ? best : null;
}

/**
 * Given a regex match's drive + 1st + (optional) 2nd segment, return the
 * canonical workspace prefix or null if the segments don't form a plausible
 * workspace. Splits the blacklist so SYSTEM dirs get fully rejected while
 * CONTAINER dirs (github/, code/, ugit/) fall back to the 2-segment form.
 */
function classifyPathSegments(
  driveRaw: string,
  seg1Raw: string,
  seg2Raw: string | undefined,
): string | null {
  const drive = driveRaw.toLowerCase();
  const seg1 = seg1Raw.toLowerCase();
  const seg2 = seg2Raw?.toLowerCase();
  if (SYSTEM_DIR_LIST.has(seg1)) return null;
  if (CONTAINER_DIR_LIST.has(seg1)) {
    // Need a non-system 2-seg to claim a workspace. Also reject when seg2
    // looks like a file (has a dot, e.g. plan.md, scoreFusion.ts), since
    // file basenames aren't workspace names.
    if (!seg2 || SYSTEM_DIR_LIST.has(seg2) || /\.[a-z0-9]{1,5}$/.test(seg2)) return null;
    return `${drive}:/${seg1}/${seg2}`;
  }
  return `${drive}:/${seg1}`;
}

function sameWorkspaceBasename(projectBasename: string, recoveredPath: string): boolean {
  const expected = normalizeProjectSegment(projectBasename);
  if (!expected) return false;
  const segments = recoveredPath
    .replace(/\\/g, '/')
    .split('/')
    .map(normalizeProjectSegment)
    .filter(Boolean);
  return segments[segments.length - 1] === expected;
}

function normalizeProjectSegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Extract a 1-segment-deep workspace prefix from an absolute path. e.g.
// `d:/retrieval-bench/PLAN.md` → `d:/retrieval-bench`. Returns null when
// the input doesn't look like a real workspace file path or points at
// the CodeBuddy data dir itself.
function extractWorkspacePrefix(absPath: string): string | null {
  const norm = absPath.replace(/\\/g, '/').toLowerCase();
  const m = /^([a-z]):\/([a-z0-9_.-]+)(?:\/([a-z0-9_.-]+))?(?:\/|$)/i.exec(norm);
  if (!m) return null;
  return classifyPathSegments(m[1], m[2], m[3]);
}
