/**
 * Resolve a raw cwd from an IDE transcript into the project string AgentMemory
 * actually stores in `session_summaries.project`.
 *
 * Why this exists: the online AgentMemory Stop hook does NOT store the literal cwd
 * the user was sitting in when the agent finished. Hook context is built
 * from `CLAUDE_PROJECT_DIR` / `CURSOR_PROJECT_DIR` / `CODEBUDDY_PROJECT_DIR`
 * env vars (set by the IDE itself) which point to the workspace / git root,
 * NOT a deep subdirectory. So if the user runs `claude` from
 * `D:/agent-memory/desktop`, hook ends up writing `project = D:/agent-memory`.
 *
 * Import on the other hand reads cwd straight from the jsonl line or the
 * encoded transcript dir name, which are the literal launch cwd. If we leave
 * it as-is, the import row's project is `D:/agent-memory/desktop` — different
 * string, different label in the UI ("desktop" vs "agent-memory"), and the
 * hook-overlap dedup can't cross-match the two.
 *
 * Strategy: climb to the git repository toplevel. This is the same shape
 * the IDEs use when they set `*_PROJECT_DIR`. Falls back to the literal cwd
 * if git lookup fails (no `.git`, git not installed, path doesn't exist).
 *
 * Result is memoized per cwd because runImport processes many turns and we
 * don't want to spawn `git rev-parse` thousands of times.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const cache = new Map<string, string>();

/**
 * Return the git toplevel ancestor of `cwd` (with forward slashes), or `cwd`
 * itself when no git toplevel is found. Always returns a non-empty string
 * when `cwd` is non-null; returns `null` only for null / empty input.
 *
 * The result is INTENTIONALLY NOT lowercased — `normalizeProjectPath` (called
 * by the DB write layer) does that. We only normalize slashes here.
 */
export function resolveProjectFromCwd(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const trimmed = cwd.trim();
  if (!trimmed) return null;

  // Normalize slashes once. Cache key uses the normalized form so
  // `D:\agent-memory\desktop` and `D:/agent-memory/desktop` share an entry.
  const normalized = trimmed.replace(/\\/g, '/');
  const cached = cache.get(normalized);
  if (cached) return cached;

  // Path must actually exist on disk for git to work — and even if git fails,
  // we still want to return a sensible value, so we always end up storing
  // SOMETHING in the cache.
  let resolved = normalized;
  if (existsSync(normalized)) {
    try {
      // 2s timeout: git is normally instant, but a hung antivirus scanner or
      // unmounted network share could block forever. Don't let one bad cwd
      // freeze the entire import pipeline.
      const out = execFileSync(
        'git',
        ['rev-parse', '--show-toplevel'],
        { cwd: normalized, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      if (out) {
        resolved = out.replace(/\\/g, '/');
      }
    } catch {
      // Not a git repo, git not installed, or it timed out — keep the literal
      // cwd as the project. Better than failing the whole import.
    }
  }

  cache.set(normalized, resolved);
  return resolved;
}

/** Test/debug hook — clears the memoization cache. */
export function _resetProjectResolverCache(): void {
  cache.clear();
}
