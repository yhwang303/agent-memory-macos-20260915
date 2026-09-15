/**
 * Claude / claude-internal adapter.
 *
 * Two on-disk locations share the same JSONL format (Anthropic-style:
 * `{type:"user"|"assistant", message:{role,content}, cwd, sessionId,
 * timestamp, version, gitBranch}`):
 *
 *   1. ~/.claude-internal/projects/<encoded-cwd>/<sessionId>.jsonl
 *      (Tencent claude-internal — primary path used inside the company)
 *   2. ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 *      (Anthropic official `claude` CLI — fallback for overseas / OSS users)
 *
 * Encoding: `D:\agent-memory` ⇄ `D--agent-memory` (slash → dash, drive
 * `:\` → `--`). We don't strictly need to decode the dir name because each
 * jsonl line carries its own `cwd` field — we read that and only fall back
 * to dir-name decoding when the line metadata is missing.
 *
 * Sibling `<sessionId>/subagents/agent-*.jsonl` and `<sessionId>/tool-results/`
 * are intentionally NOT discovered in v1 — sub-agent turns are too granular
 * to summarize meaningfully, and tool-results are auxiliary blobs.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../../../utils/logger.js';
import { streamJsonlTurns } from '../jsonl-stream.js';
import type {
  AdapterDiscoveryResult,
  ImportAdapter,
  TranscriptFile,
  Turn,
} from '../types.js';

export class ClaudeAdapter implements ImportAdapter {
  readonly id = 'claude' as const;
  readonly displayName = 'Claude / claude-internal';

  roots(): string[] {
    const home = homedir();
    return [
      join(home, '.claude-internal', 'projects'),
      join(home, '.claude', 'projects'),
    ];
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
        logger.warn('IMPORT', `claude adapter: failed scanning ${root}`, {
          error: String(err),
        });
      }
    }

    logger.info('IMPORT', 'claude adapter discovery', {
      probedRoots,
      filesFound: files.length,
    });

    return { adapterId: this.id, probedRoots, files };
  }

  /**
   * Scan one root: walk first-level encoded-cwd dirs, then collect their
   * direct *.jsonl children (= primary session transcripts). Skip any
   * subagents/ subdir contents.
   */
  private scanRoot(root: string): TranscriptFile[] {
    const out: TranscriptFile[] = [];
    let projectDirs: string[];
    try {
      projectDirs = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return out;
    }

    for (const projectDir of projectDirs) {
      const projectPath = join(root, projectDir);
      let entries: string[];
      try {
        entries = readdirSync(projectPath, { withFileTypes: true })
          .filter((d) => d.isFile() && d.name.endsWith('.jsonl'))
          .map((d) => d.name);
      } catch {
        continue;
      }

      for (const fileName of entries) {
        const filePath = join(projectPath, fileName);
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(filePath).mtimeMs;
        } catch {
          continue;
        }
        const sessionId = fileName.replace(/\.jsonl$/, '');
        out.push({
          adapterId: this.id,
          filePath,
          sessionId,
          cwd: this.decodeCwd(projectDir),
          mtimeMs,
          extra: { encodedDir: projectDir, scanRoot: root },
        });
      }
    }
    return out;
  }

  /**
   * Decode the project dir name back to a cwd. Used as the AUTHORITATIVE cwd
   * source for matching hook attribution (see jsonl-stream.ts comments).
   *
   * Encoding rules observed: `/` → `-`, `:\` → `--`. The drive separator is
   * unambiguous (consecutive `--`), but the remaining hyphens are AMBIGUOUS:
   * each could be a literal `-` in a directory name (e.g. `agent-memory`)
   * OR a slash `/` (e.g. `agent/memory`). claude-internal's encoder loses
   * that distinction.
   *
   * Strategy: enumerate candidate decodings and pick the first one that
   * exists on disk. Falls back to the all-literal-hyphen candidate when
   * none match (covers the case where the user moved / deleted the
   * project after the transcript was written — better to write a slightly
   * wrong cwd than a definitely wrong one with extra slashes inserted).
   *
   * Capped at 2^6 candidates to avoid blowup on pathological dir names with
   * many hyphens — beyond that we just try literal vs all-slash.
   */
  private decodeCwd(encoded: string): string {
    const driveResolved = encoded.replace(/--/g, ':/');
    const colonIdx = driveResolved.indexOf(':/');
    // Pre-compute the segment we still need to disambiguate (everything
    // after the drive separator) and the drive prefix to glue back on.
    const drive = colonIdx >= 0 ? driveResolved.slice(0, colonIdx + 2) : '';
    const rest = colonIdx >= 0 ? driveResolved.slice(colonIdx + 2) : driveResolved;
    const hyphenIdxs: number[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest.charCodeAt(i) === 45 /* '-' */) hyphenIdxs.push(i);
    }
    if (hyphenIdxs.length === 0) return drive + rest;

    const buildCandidate = (mask: number): string => {
      let out = '';
      let cursor = 0;
      for (let i = 0; i < hyphenIdxs.length; i++) {
        const idx = hyphenIdxs[i];
        out += rest.slice(cursor, idx);
        out += (mask & (1 << i)) ? '/' : '-';
        cursor = idx + 1;
      }
      out += rest.slice(cursor);
      return drive + out;
    };

    if (hyphenIdxs.length <= 6) {
      const total = 1 << hyphenIdxs.length;
      for (let mask = 0; mask < total; mask++) {
        const cand = buildCandidate(mask);
        try { if (existsSync(cand)) return cand; } catch { /* ignore */ }
      }
      // No filesystem match — return the all-literal-hyphen candidate
      // (mask=0). Hyphens in directory names are common; over-splitting
      // into slashes is the worse failure mode because it produces a
      // path that LIKELY doesn't exist anywhere.
      return buildCandidate(0);
    }

    // Long path: just try the two extremes — all-literal then all-slash —
    // before giving up to literal.
    const literal = buildCandidate(0);
    try { if (existsSync(literal)) return literal; } catch { /* ignore */ }
    const allSlash = buildCandidate((1 << hyphenIdxs.length) - 1);
    try { if (existsSync(allSlash)) return allSlash; } catch { /* ignore */ }
    return literal;
  }

  // eslint-disable-next-line require-yield
  async *iterateTurns(file: TranscriptFile): AsyncIterable<Turn> {
    // Each line carries its own `cwd`, so the dir-name decode here is just a
    // best-effort default for transcripts where individual lines lack it.
    for (const turn of streamJsonlTurns('claude', file.filePath, file.cwd)) {
      yield turn;
    }
  }
}
