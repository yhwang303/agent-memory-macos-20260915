/**
 * Cursor Agent adapter.
 *
 * On-disk layout:
 *   ~/.cursor/projects/<workspace-id>/agent-transcripts/<UUID>/<UUID>.jsonl
 *   ~/.cursor/projects/<workspace-id>/agent-transcripts/<UUID>/subagents/<UUID>.jsonl
 *
 * `<workspace-id>` comes in two flavors observed on real machines:
 *   - Path-encoded: e.g. `d-ai-ide-langfuse` ⇄ `D:/ai-ide-langfuse`.
 *   - Numeric workspace timestamp: e.g. `1776685781572`. These workspaces
 *     are typically non-Agent (Composer / Chat) sessions and don't have an
 *     agent-transcripts/ subdir at all — we just skip those.
 *
 * JSONL line shape (parsed by src/shared/transcript-parser.ts:classifyContent
 * in stage 2): `{role:"user"|"assistant", message:{content:[{type:"text"|
 * "tool_use"|"image", ...}]}, timestamp, ...}`. Cursor 3.x writes tool_use
 * blocks; Cursor ≤2.6.22 does not (degrades to empty toolUses, harmless).
 *
 * v1 only ingests the primary `<UUID>/<UUID>.jsonl` per session; sibling
 * `subagents/*.jsonl` are skipped (deferred to v1.1).
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

export class CursorAgentAdapter implements ImportAdapter {
  readonly id = 'cursor-agent' as const;
  readonly displayName = 'Cursor (Agent mode)';

  roots(): string[] {
    return [join(homedir(), '.cursor', 'projects')];
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
        logger.warn('IMPORT', `cursor-agent adapter: failed scanning ${root}`, {
          error: String(err),
        });
      }
    }

    logger.info('IMPORT', 'cursor-agent adapter discovery', {
      probedRoots,
      filesFound: files.length,
    });

    return { adapterId: this.id, probedRoots, files };
  }

  /**
   * For each workspace dir under `<root>`, look for `agent-transcripts/`.
   * Inside that, every `<UUID>/<UUID>.jsonl` is one session. Workspaces
   * without `agent-transcripts/` are silently ignored.
   */
  private scanRoot(root: string): TranscriptFile[] {
    const out: TranscriptFile[] = [];
    let workspaces: string[];
    try {
      workspaces = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return out;
    }

    for (const ws of workspaces) {
      const transcriptsDir = join(root, ws, 'agent-transcripts');
      if (!existsSync(transcriptsDir)) continue;

      let sessionDirs: string[];
      try {
        sessionDirs = readdirSync(transcriptsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      } catch {
        continue;
      }

      for (const sid of sessionDirs) {
        const primary = join(transcriptsDir, sid, `${sid}.jsonl`);
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(primary).mtimeMs;
        } catch {
          // Some session dirs only have subagents/ but no primary jsonl;
          // we still ingest the subagents (sub-conversations spawned inside
          // a parent agent run that the IDE persisted separately). v1.1+
          // includes them at per-turn granularity since each subagent jsonl
          // is just another sequence of user→assistant exchanges.
        }
        if (mtimeMs > 0) {
          out.push({
            adapterId: this.id,
            filePath: primary,
            sessionId: sid,
            cwd: this.decodeCwd(ws),
            mtimeMs,
            extra: { workspace: ws },
          });
        }

        // Also walk subagents/<UUID>.jsonl — each is one nested conversation.
        const subagentsDir = join(transcriptsDir, sid, 'subagents');
        if (existsSync(subagentsDir)) {
          let subFiles: string[];
          try {
            subFiles = readdirSync(subagentsDir).filter((f) => f.endsWith('.jsonl'));
          } catch {
            subFiles = [];
          }
          for (const sub of subFiles) {
            const subPath = join(subagentsDir, sub);
            let subMtimeMs = 0;
            try { subMtimeMs = statSync(subPath).mtimeMs; } catch { continue; }
            const subId = sub.replace(/\.jsonl$/i, '');
            out.push({
              adapterId: this.id,
              filePath: subPath,
              // Compose the subagent's session id so it doesn't collide with
              // the parent transcript's `sessionId` in the fingerprint table.
              sessionId: `${sid}:sub:${subId}`,
              cwd: this.decodeCwd(ws),
              mtimeMs: subMtimeMs,
              extra: { workspace: ws, parentSessionId: sid, subagent: true },
            });
          }
        }
      }
    }
    return out;
  }

  /**
   * Decode workspace dir name to a cwd if possible.
   *
   * Cursor's encoding is lossy: both path separators and original dashes
   * become a single `-`, so we cannot perfectly reconstruct multi-segment
   * paths. For v1 we only decode the leading `<drive>-` prefix and treat
   * the remainder as one opaque path segment — good enough for project
   * tagging in AgentMemory search (which uses normalizeProjectPath downstream).
   *
   * - `d-ai-ide-langfuse` → `D:/ai-ide-langfuse` (the most common case)
   * - `1776685781572`     → null (numeric workspace IDs are unmappable)
   * - `xx-foo`            → null (no leading single-letter drive)
   */
  private decodeCwd(workspace: string): string | null {
    if (/^\d+$/.test(workspace)) return null;
    if (workspace.length < 3) return null;
    const driveLetter = workspace[0];
    if (!/^[a-z]$/i.test(driveLetter)) return null;
    if (workspace[1] !== '-') return null;
    const rest = workspace.slice(2);
    if (!rest) return null;
    return `${driveLetter.toUpperCase()}:/${rest}`;
  }

  // eslint-disable-next-line require-yield
  async *iterateTurns(file: TranscriptFile): AsyncIterable<Turn> {
    // Cursor lines don't carry `cwd`; pass our workspace-derived default
    // through so each turn can be tagged with the right project.
    for (const turn of streamJsonlTurns('cursor-agent', file.filePath, file.cwd)) {
      yield turn;
    }
  }
}
