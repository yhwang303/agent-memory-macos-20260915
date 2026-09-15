/**
 * Helpers shared by all import adapters and the orchestrator.
 */

import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type {
  ImportAdapter,
  ImportAdapterId,
  SessionData,
  TranscriptFile,
  Turn,
} from './types.js';

/** Hard cap on per-field length the import prompt receives, to bound tokens. */
export const MAX_USER_TEXT = 4000;
export const MAX_ASSISTANT_TEXT = 4000;
export const MAX_TOOL_INPUT_SUMMARY = 200;
/** Length of userText slice mixed into the fingerprint for uniqueness. */
export const FINGERPRINT_USER_PREFIX = 512;

/** Truncate a string to `n` code-units, appending an ellipsis marker. */
export function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Stringify a tool-call input for the prompt. We don't need full fidelity —
 * just a recognizable summary so the AI can describe what tools the agent
 * used during a turn.
 */
export function summarizeToolInput(
  input: unknown,
  cap = MAX_TOOL_INPUT_SUMMARY,
): string {
  if (input == null) return '';
  if (typeof input === 'string') return truncate(input, cap);
  try {
    return truncate(JSON.stringify(input), cap);
  } catch {
    return truncate(String(input), cap);
  }
}

/**
 * Fingerprint used by the idempotency layer.
 *
 *   sha256(adapterId | filePath | turnIndex | userText[0..512])
 *
 * The userText prefix gives us collision resistance for cases where two
 * different transcript files might share the same (adapterId, turnIndex)
 * pair. 512 chars is enough to disambiguate every realistic user prompt
 * while keeping the hash input bounded.
 */
export function computeFingerprint(
  adapterId: ImportAdapterId,
  filePath: string,
  turnIndex: number,
  userText: string,
): string {
  const h = createHash('sha256');
  h.update(adapterId);
  h.update('|');
  h.update(filePath);
  h.update('|');
  h.update(String(turnIndex));
  h.update('|');
  h.update((userText ?? '').slice(0, FINGERPRINT_USER_PREFIX));
  return h.digest('hex');
}

/**
 * Synthetic memory_session_id for an imported summary row.
 *
 * Format: `imp:<adapterId>:<sessionId>`
 * Stable, human-readable, unique per imported session.
 */
export function buildImportedSessionId(
  adapterId: ImportAdapterId,
  sessionId: string,
): string {
  return `imp:${adapterId}:${sessionId}`;
}

/**
 * source_ide tag stored on imported summaries, distinct from the live
 * adapter id ('claude'/'cursor'/'codebuddy-ide') so search and dashboards
 * can filter / count imported vs hook-captured rows.
 *
 * Display alias map (产品化:展示用 IDE 名,非 adapter id):
 *   - cursor-agent           → cursor       (adapter named after Cursor's
 *                                            "agent" CLI; user-facing IDE
 *                                            is just Cursor)
 *   - claude + path 含 .claude-internal/   → claude-internal
 *   - claude + path 含 .claude/projects/   → claude-code
 *   - claude  其它 / 无 path                → claude(保底,不臆测)
 *
 * `originalPath` 来自 TranscriptFile.path,代表这条 jsonl 在磁盘上的位置 —
 * 这是判断"是腾讯内网 claude-internal 还是 Anthropic 官方 claude"的唯一可靠
 * 信号,不依赖任何 hostname / username / env(那些会让其他用户机器误判)。
 */
export function buildSourceIdeTag(adapterId: ImportAdapterId, originalPath?: string): string {
  let display: string = adapterId;
  if (adapterId === 'cursor-agent') {
    display = 'cursor';
  } else if (adapterId === 'codex-cli') {
    display = 'codex-cli';
  } else if (adapterId === 'claude' && originalPath) {
    // 用正则而不是 includes('claude-internal'),避免 .claude/projects/foo-claude-internal-bar/ 误判
    if (/[\\/]\.claude-internal[\\/]/.test(originalPath)) {
      display = 'claude-internal';
    } else if (/[\\/]\.claude[\\/]/.test(originalPath)) {
      display = 'claude-code';
    }
  }
  return `imported:${display}`;
}

/**
 * Session-level fingerprint used by idempotency and "already imported" checks.
 *
 *   sha256(adapterId + '|' + sessionId)
 *
 * Deliberately excludes filePath so that moving / renaming the transcript on
 * disk doesn't break dedup. The orchestrator wants "we already imported this
 * session, regardless of where it lives now".
 */
export function computeSessionFingerprint(
  adapterId: ImportAdapterId,
  sessionId: string,
): string {
  const h = createHash('sha256');
  h.update(adapterId);
  h.update('|');
  h.update(sessionId);
  return h.digest('hex');
}

/**
 * Drain an adapter's per-turn iterator into a single SessionData.
 *
 * Why aggregate here instead of changing each adapter's iterator? The per-turn
 * iterators are battle-tested (see tests/import-iterators.test.ts) and handle
 * three different on-disk formats; rewriting all three would be churn for no
 * gain. Adapters keep yielding turns; orchestrator now operates at session
 * granularity by consuming the whole stream and producing one SessionData per
 * transcript file.
 *
 * Returns null if the file produced zero substantive turns — caller should
 * skip rather than emit an empty session.
 */
export async function collectSession(
  adapter: ImportAdapter,
  file: TranscriptFile,
): Promise<SessionData | null> {
  const turns: Turn[] = [];
  for await (const turn of adapter.iterateTurns(file)) {
    turns.push(turn);
  }
  if (turns.length === 0) return null;

  // Prefer the IDE-native sessionId from the file metadata; fall back to the
  // first turn's sessionId; final fallback to the file basename so we never
  // hand back an empty key (fingerprint depends on a stable id).
  const sessionId =
    file.sessionId ??
    turns.find((t) => t.sessionId)?.sessionId ??
    basename(file.filePath).replace(/\.(jsonl|json)$/i, '');

  // Resolve cwd: prefer the adapter's file-level cwd (decoded from the
  // encoded project dir) over any per-turn `cwd` carried by individual jsonl
  // lines.
  //
  // Why: the encoded dir name reflects the OS process cwd at session start —
  // the same value the online AgentMemory Stop hook reads when capturing summaries.
  // Per-line cwd in claude jsonl tracks the in-claude `/cwd` setting, which
  // the user can rebase mid-session without changing the OS process cwd. If
  // import uses per-line cwd it ends up with a different `project` string
  // than hook wrote for the same conversation, and the hook-overlap dedup
  // misses the duplicate (substring match on differing project labels).
  //
  // Fall back to per-line cwd ONLY when file.cwd couldn't be determined
  // (e.g. cursor-agent on a workspace dir whose decode failed). Final null
  // is a fail-shut — caller substitutes `unknown:<adapter>`.
  const cwd =
    file.cwd ?? turns.find((t) => t.cwd)?.cwd ?? null;

  // First / last turn timestamps drive the hook-overlap window check.
  // Filter out zero timestamps (some adapters can't extract per-line `timestamp`,
  // notably cursor-agent jsonl which never carries one). When per-turn ts is
  // unavailable, fall back to the transcript file's mtime — for append-only
  // jsonl that's an accurate proxy for "when this conversation finished".
  // Also drop any future-dated values just in case (a corrupt timestamp would
  // mislead hook-overlap into "outside window → import").
  const validTimes = turns
    .map((t) => t.startedAt)
    .filter((ms) => ms > 0 && ms < Date.now() + 86_400_000);

  let firstTurnAtMs = 0;
  let lastTurnAtMs = 0;
  if (validTimes.length > 0) {
    firstTurnAtMs = Math.min(...validTimes);
    lastTurnAtMs = Math.max(...validTimes);
  } else if (file.mtimeMs > 0 && file.mtimeMs < Date.now() + 86_400_000) {
    // Single fallback: the file's mtime is the only thing we know. We use it
    // for both ends — coarser than per-turn but better than treating the
    // session as time-unknown (which would let it bypass hook-overlap dedup).
    firstTurnAtMs = file.mtimeMs;
    lastTurnAtMs = file.mtimeMs;
  }

  return {
    adapterId: adapter.id,
    filePath: file.filePath,
    sessionId,
    cwd,
    firstTurnAtMs,
    lastTurnAtMs,
    turns,
    fingerprint: computeSessionFingerprint(adapter.id, sessionId),
  };
}

/**
 * Heuristic guard: is a session worth summarizing?
 * Skip when the conversation produced no meaningful exchange — e.g. a user
 * message with no assistant reply (session abandoned), or trivial 1-shot
 * pings whose total content is too short to summarize usefully.
 */
export function isSessionSubstantive(session: SessionData): boolean {
  if (session.turns.length === 0) return false;
  const totalAssistantChars = session.turns.reduce(
    (n, t) => n + t.assistantText.trim().length,
    0,
  );
  if (totalAssistantChars < 50) return false;
  return true;
}

/**
 * Heuristic guard for individual turns inside a session — used by adapters
 * that want to drop genuinely empty pairs before they reach the orchestrator.
 * Kept for backward compatibility with the per-turn era; orchestrator no
 * longer calls this directly (it uses isSessionSubstantive instead).
 */
export function isTurnSubstantive(
  userText: string,
  assistantText: string,
): boolean {
  if (!userText.trim()) return false;
  if (assistantText.trim().length < 20) return false;
  return true;
}
