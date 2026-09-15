/**
 * Discovery — cheap, side-effect-free scan of all import adapter roots.
 *
 * This is what the desktop app calls on first-launch (and the tray
 * "导入历史对话…" entry calls on every click) to figure out whether
 * there's anything to import at all. No AI, no DB writes, just file IO.
 *
 * Returning an empty / zero-turn report is a perfectly normal outcome
 * (e.g. user has never used these IDEs) — callers must NOT treat it as
 * an error or surface any modal in that case.
 */

import { logger } from '../../utils/logger.js';
import { ClaudeAdapter } from './adapters/claude.js';
import { CodeBuddyIdeAdapter } from './adapters/codebuddy-ide.js';
import { CodexImportAdapter } from './adapters/codex.js';
import { CursorAgentAdapter } from './adapters/cursor-agent.js';
import type {
  DiscoveryReport,
  ImportAdapter,
  ImportAdapterId,
} from './types.js';

/**
 * Build the static set of import adapters. Order here is also the order they
 * appear in CLI / UI diagnostic output.
 *
 * Aligned 1:1 with the 5 hook-integrated IDEs from AgentMemory's setup wizard:
 *   - Claude Code + Claude Internal → handled by single `claude` adapter
 *     (identical jsonl format under two different config roots).
 *   - Cursor → `cursor-agent` adapter.
 *   - CodeBuddy IDE → `codebuddy-ide` adapter.
 *   - CodeBuddy 插件版 (gongfeng.gongfeng-copilot VSCode extension) → coming
 *     in a follow-up patch once a real chat-history sample is available to
 *     reverse-engineer the entry schema.
 */
export function getAllAdapters(): ImportAdapter[] {
  return [
    new ClaudeAdapter(),
    new CursorAgentAdapter(),
    new CodeBuddyIdeAdapter(),
    new CodexImportAdapter(),
  ];
}

export function getAdapter(id: ImportAdapterId): ImportAdapter | null {
  return getAllAdapters().find((a) => a.id === id) ?? null;
}

/**
 * Run discovery across every adapter (or a filtered subset).
 *
 * The estimatedTurns count is a coarse heuristic for v1: we skip exact
 * line counting (which would mean opening every jsonl) and just report
 * `files.length` × a placeholder factor of 0 — the orchestrator's
 * iterateTurns is the source of truth. Stage 5+ may replace this with
 * a cheap line-count estimate (line count / 4 ≈ turn count for Claude
 * jsonl) if the desktop UI needs a more useful preview.
 */
export async function discoverAll(
  adapterIds?: ImportAdapterId[],
): Promise<DiscoveryReport> {
  const all = getAllAdapters();
  const selected = adapterIds
    ? all.filter((a) => adapterIds.includes(a.id))
    : all;

  const adapters = await Promise.all(
    selected.map(async (a) => {
      try {
        return await a.discoverSessions();
      } catch (err) {
        logger.error(
          'IMPORT',
          `discoverAll: adapter ${a.id} failed`,
          {},
          err as Error,
        );
        // Keep the shape stable: report adapter as "no files found".
        return {
          adapterId: a.id,
          probedRoots: a.roots().map((p) => ({ path: p, exists: false })),
          files: [],
        };
      }
    }),
  );

  const totalFiles = adapters.reduce((acc, a) => acc + a.files.length, 0);
  // estimatedTurns is conservatively zero in v1 — see comment above.
  const estimatedTurns = 0;

  return { adapters, totalFiles, estimatedTurns };
}
