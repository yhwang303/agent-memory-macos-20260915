/**
 * projectResolver — turn the caller's notion of "current project" into the
 * lower-cased forward-slash key that AgentMemory stores in its `project` column
 * (e.g. "d:/agent-memory").
 *
 * Resolution order:
 *   1. Explicit `project` argument from the tool call → normalised, used as-is.
 *   2. process.cwd() normalised → exact match against AgentMemory's known projects.
 *   3. Fallback: walk parent directories up to ANCESTOR_LIMIT levels.
 *      The first ancestor whose normalised path matches a known AgentMemory project
 *      wins. Tie-breaker: longest prefix match (deepest ancestor).
 *   4. No match → return an Unresolved result containing all known
 *      projects so the tool can surface a helpful error.
 */
import { AgentMemoryDb } from './agentMemoryDb.js';
import { logger } from './logger.js';

const ANCESTOR_LIMIT = 5;

export type ResolveSource = 'explicit' | 'cwd' | 'ancestor';

export interface ResolvedProject {
  ok: true;
  key: string;
  source: ResolveSource;
  /** When source=ancestor, the original CWD that triggered the walk. */
  attemptedCwd?: string;
}

export interface UnresolvedProject {
  ok: false;
  attemptedCwd: string;
  knownProjects: string[];
}

export type ResolveResult = ResolvedProject | UnresolvedProject;

/** Normalise a filesystem path to AgentMemory's storage form: lowercase + forward slashes, no trailing slash. */
export function normalizeProjectPath(p: string): string {
  if (!p) return p;
  let out = p.replace(/\\/g, '/').toLowerCase();
  // strip trailing slashes (but keep root "c:/" if that's all we have)
  while (out.length > 3 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/** Walk parent dirs up to `limit` levels. Yields normalised candidates, deepest first. */
function* ancestorChain(start: string, limit: number): Generator<string> {
  const norm = normalizeProjectPath(start);
  yield norm;
  let current = norm;
  for (let i = 0; i < limit; i++) {
    const idx = current.lastIndexOf('/');
    if (idx <= 2) return; // hit root like "d:/" — stop
    current = current.slice(0, idx);
    yield current;
  }
}

/** Resolve the project key. Pure function aside from the DB read. */
export function resolveProject(
  agentMemoryDb: AgentMemoryDb,
  opts: { explicitProject?: string; cwd?: string }
): ResolveResult {
  // 1. Explicit project always wins.
  if (opts.explicitProject && opts.explicitProject.trim().length > 0) {
    const key = normalizeProjectPath(opts.explicitProject.trim());
    logger.debug('resolveProject: explicit', { key });
    return { ok: true, key, source: 'explicit' };
  }

  const cwd = opts.cwd ?? process.cwd();
  const cwdNorm = normalizeProjectPath(cwd);

  // 2 & 3. Walk known projects looking for an exact match starting from CWD upward.
  // listKnownProjects is cheap (one SELECT DISTINCT), so we cache the Set here.
  const known = new Set(agentMemoryDb.listKnownProjects());

  let attempt = 0;
  for (const candidate of ancestorChain(cwd, ANCESTOR_LIMIT)) {
    if (known.has(candidate)) {
      const source: ResolveSource = attempt === 0 ? 'cwd' : 'ancestor';
      logger.debug('resolveProject: matched', { source, key: candidate, attemptedCwd: cwdNorm });
      return {
        ok: true,
        key: candidate,
        source,
        attemptedCwd: source === 'ancestor' ? cwdNorm : undefined,
      };
    }
    attempt++;
  }

  // 4. No match. Return the known projects so the caller can build a helpful message.
  const sorted = [...known].sort();
  logger.debug('resolveProject: unresolved', { cwd: cwdNorm, knownCount: sorted.length });
  return { ok: false, attemptedCwd: cwdNorm, knownProjects: sorted };
}
