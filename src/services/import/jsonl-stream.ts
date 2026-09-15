/**
 * Forward streaming JSONL turn extractor for Claude / claude-internal /
 * Cursor Agent transcripts.
 *
 * All three flavors share the same underlying conversation shape — a flat
 * sequence of {user, assistant, ...metadata} JSON objects, one per line,
 * where:
 *
 *   - Claude / claude-internal lines are typed via `type` (e.g.
 *     `{"type":"user","message":{"role":"user","content":"..."},...}`),
 *     and may also include `cwd`, `sessionId`, `timestamp`, `version`.
 *   - Cursor Agent lines are typed via `role` (e.g.
 *     `{"role":"user","message":{"content":[{type:"text",...}]}}`),
 *     no `cwd` field; project mapping is derived from the workspace dir.
 *
 * In both, `message.content` is either a plain string (sometimes for user
 * messages) or an array of content blocks (`{type:"text"|"tool_use"|"image",...}`).
 *
 * The non-conversational lines we MUST skip include:
 *   - {type:"last-prompt"} / {type:"permission-mode"}
 *   - {type:"hook_success"} / {type:"summary"} / {type:"system"}
 *   - any line missing both `type` and `role`
 *   - {type:"user", isMeta:true} — IDE-injected image-paste sidecar lines
 *     (claude-internal emits one per multimodal prompt; not a human turn)
 *   - {type:"user", isCompactSummary:true} — `/compact` continuation stub
 *   - {type:"user", isSidechain:true} — sub-agent invocation lines
 *
 * Turn grouping rule (matches AgentMemory's online Stop-hook semantics):
 *   - When we see a user line, finalize the in-progress turn (if any with
 *     non-empty assistant text) and open a new turn from this user line.
 *   - When we see an assistant line, append its text + tool_uses to the
 *     current turn.
 *   - At EOF, finalize the last turn the same way.
 */

import { readFileSync } from 'node:fs';
import { logger } from '../../utils/logger.js';
import {
  computeFingerprint,
  MAX_ASSISTANT_TEXT,
  MAX_USER_TEXT,
  summarizeToolInput,
  truncate,
} from './turn-utils.js';
import type { ImportAdapterId, Turn } from './types.js';

/** Internal accumulator for a turn under construction. */
interface PendingTurn {
  turnIndex: number;
  userText: string;
  assistantTextParts: string[];
  toolUses: Array<{ name: string; inputSummary: string }>;
  startedAt: number;
  cwd: string | null;
  sessionId: string | null;
}

/** Extract `{role, text, toolUses, ts, cwd, sessionId}` from one JSONL line. */
interface NormalizedLine {
  role: 'user' | 'assistant';
  text: string;
  toolUses: Array<{ name: string; inputSummary: string }>;
  /**
   * True when the line is a `type:"user"` JSON object whose content array
   * contains ONLY tool_result blocks (the agent's own tool feedback eating
   * its way through an agentic turn). These lines look like "user" messages
   * to the parser but they are NOT real conversational turn boundaries —
   * starting a new turn on them shrinks the dedup window from "real next
   * user message" to "next tool feedback" (often seconds away), causing
   * the hook row at end-of-agentic-turn to fall outside the window and the
   * hook-overlap dedup to miss the duplicate. Treated as continuation
   * instead. See streamJsonlTurns for the use site.
   */
  isToolResultOnly: boolean;
  timestampMs: number;
  cwd: string | null;
  sessionId: string | null;
}

/**
 * Extract a NormalizedLine from a raw JSONL object, or null if the line is
 * non-conversational metadata.
 */
function normalizeLine(obj: unknown): NormalizedLine | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;

  // Claude uses `type`, Cursor uses `role`. Either points to the speaker.
  const role = (o.type ?? o.role) as string | undefined;
  if (role !== 'user' && role !== 'assistant') return null;

  // CRITICAL: drop synthetic / metadata user lines that claude-internal
  // injects into the JSONL alongside real conversational turns. These look
  // exactly like `type:"user"` entries to the parser, but the human did NOT
  // press enter to send them — they're emitted by the IDE itself for indexing
  // / cache / continuation purposes:
  //
  //   - `isMeta: true`  →  image-attachment side-channel. When the user pastes
  //     N images into a single prompt, claude-internal records the real user
  //     line ONCE (with the user's text + image blocks) AND emits a SECOND
  //     user line right after, content = N text blocks of the form
  //     `[Image: source: <abs path>]` for grep-ability. The two lines share
  //     the same timestamp.
  //
  //     If we treat the meta line as a real turn boundary:
  //       * a single user prompt becomes 2 fingerprinted turns (one of them
  //         is just `[Image: ...]` which the AI summarizes garbage from);
  //       * `turnStartsFor(session)` reports back-to-back boundaries at the
  //         SAME timestamp, so the hook-overlap dedup window for the real
  //         turn collapses to a sub-second range and the corresponding hook
  //         row (which fires AFTER the assistant finishes — typically 10+
  //         minutes later for image-heavy prompts) falls outside the window.
  //         End result: BOTH turns get re-imported as duplicates of an
  //         already-captured hook row.
  //
  //     This is the actual root cause of "重新安装后依然重复" — the previous
  //     fix (folding `tool_result-only` user lines into the current turn)
  //     covered ONE class of fake boundaries; this covers the IDE-injected
  //     image-meta class.
  //
  //   - `isCompactSummary: true` → injected after `/compact` ran. Carries a
  //     "This session is being continued from a previous conversation that
  //     ran out of context …" stub. Not a human turn; folding this into the
  //     prior turn would corrupt its userText, so we drop it entirely.
  //
  //   - `isSidechain: true` → sub-agent invocation lines. The adapter
  //     intentionally does NOT discover `<sessionId>/subagents/agent-*.jsonl`
  //     files (see claude.ts header) and the main jsonl normally doesn't carry
  //     sidechain rows. Defensive drop in case any leak in.
  //
  // Skipping these lines means streamJsonlTurns never sees them, never starts
  // a new turn for them, and never extends the current turn with their content.
  // The behavior is "as if the line didn't exist" — exactly what we want.
  if (o.isMeta === true) return null;
  if (o.isCompactSummary === true) return null;
  if (o.isSidechain === true) return null;

  const message = (o.message ?? null) as Record<string, unknown> | null;
  const content = (message?.content ?? o.content) as unknown;
  if (content == null) return null;

  const { text, toolUses, isToolResultOnly } = flattenContent(content);

  // Timestamps: prefer ISO string `timestamp`, fall back to numeric.
  let timestampMs = 0;
  if (typeof o.timestamp === 'string') {
    const t = Date.parse(o.timestamp);
    if (!Number.isNaN(t)) timestampMs = t;
  } else if (typeof o.timestamp === 'number') {
    timestampMs = o.timestamp;
  }

  const cwd = typeof o.cwd === 'string' ? o.cwd : null;
  const sessionId = typeof o.sessionId === 'string' ? o.sessionId : null;

  return { role, text, toolUses, isToolResultOnly, timestampMs, cwd, sessionId };
}

/**
 * Flatten message content into plain text + structured tool_uses.
 * Handles both:
 *   - string (Claude user messages, sometimes Cursor too)
 *   - array of content blocks (typical assistant content, also new Cursor user)
 *
 * Also reports `isToolResultOnly` — true when the array contains ONLY
 * tool_result blocks (no real text and no tool_use). claude-internal emits
 * a `type:"user"` line for every tool feedback the agent receives, which
 * the iterator MUST NOT treat as a new conversational turn (see
 * NormalizedLine.isToolResultOnly comments).
 */
function flattenContent(content: unknown): {
  text: string;
  toolUses: Array<{ name: string; inputSummary: string }>;
  isToolResultOnly: boolean;
} {
  if (typeof content === 'string') {
    return { text: content, toolUses: [], isToolResultOnly: false };
  }
  if (!Array.isArray(content)) {
    return { text: '', toolUses: [], isToolResultOnly: false };
  }
  const textParts: string[] = [];
  const toolUses: Array<{ name: string; inputSummary: string }> = [];
  let blockCount = 0;
  let toolResultCount = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    blockCount += 1;
    switch (b.type) {
      case 'text':
        if (typeof b.text === 'string') textParts.push(b.text);
        break;
      case 'tool_use':
        toolUses.push({
          name: typeof b.name === 'string' ? b.name : '',
          inputSummary: summarizeToolInput(b.input ?? {}),
        });
        break;
      case 'tool_result':
        toolResultCount += 1;
        break;
      // image / thinking blocks are intentionally dropped — we don't need
      // them for a AgentMemory-style summary, and image content is handled separately
      // by media_context in the prompt stage.
      default:
        break;
    }
  }
  const isToolResultOnly =
    blockCount > 0 && toolResultCount === blockCount && textParts.length === 0;
  return { text: textParts.join('\n'), toolUses, isToolResultOnly };
}

/**
 * Stream Turns from a JSONL transcript at `filePath`.
 *
 * `defaultCwd` is the adapter's best guess (e.g. decoded from the workspace
 * dir name). Each line may override it via its own `cwd` field.
 */
export function* streamJsonlTurns(
  adapterId: ImportAdapterId,
  filePath: string,
  defaultCwd: string | null,
): Generator<Turn> {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    logger.warn('IMPORT', `streamJsonlTurns: cannot read ${filePath}`, {
      error: String(err),
    });
    return;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip BOM

  let pending: PendingTurn | null = null;
  let nextTurnIndex = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // truncated / malformed line — skip
    }
    const norm = normalizeLine(obj);
    if (!norm) continue;

    if (norm.role === 'user') {
      // CRITICAL: a `type:"user"` line carrying ONLY tool_result blocks is
      // NOT a new conversational turn — it's the agent's tool feedback being
      // fed back into the conversation. Treat it as a continuation of the
      // current turn so:
      //   (a) the turn's userText stays the user's actual prompt
      //   (b) turnStartsFor(session) doesn't get peppered with fake turn
      //       boundaries every few seconds, which would shrink the
      //       hook-overlap dedup window from "next real user message" to
      //       "next tool result", and the Stop-hook row at end-of-agentic-
      //       turn falls outside it. Symptoms: today's hook-captured
      //       conversations getting re-imported as duplicates.
      if (norm.isToolResultOnly) {
        // Don't break the turn. Don't even refresh ts/cwd — those should
        // anchor on the original user message. We just discard this line
        // and keep accumulating subsequent assistant lines into pending.
        continue;
      }
      // Real user message → close out the prior turn if it produced any
      // assistant text, then open a new pending turn.
      if (pending && pending.assistantTextParts.length > 0) {
        const t = finalizeTurn(adapterId, filePath, pending);
        if (t) yield t;
      }
      pending = {
        turnIndex: nextTurnIndex++,
        userText: truncate(norm.text, MAX_USER_TEXT),
        assistantTextParts: [],
        toolUses: [],
        // CRITICAL: don't fall back to Date.now() — that would corrupt the
        // hook-overlap dedup decision (every "no-timestamp" turn would look
        // like it happened "right now" and get judged outside the hook
        // window). Leave 0 so collectSession can fall back to the file's
        // mtime (more accurate for cursor-agent jsonl which doesn't carry
        // per-line timestamps).
        startedAt: norm.timestampMs || 0,
        // CRITICAL: prefer the adapter's file-level cwd (decoded from the
        // encoded project dir) over the per-line `cwd` field. Why?
        //
        // The encoded dir name reflects the OS process cwd at SESSION START
        // (claude/claude-internal places the jsonl under whichever directory
        // the `claude` CLI was launched from). The per-line `cwd` field
        // tracks claude's INTERNAL `/cwd` setting, which the user can rebase
        // to a logical sibling project mid-session — this does NOT change
        // the OS process cwd, and therefore does NOT match what the online
        // AgentMemory Stop hook sees (the hook reads the actual process cwd).
        //
        // For deduplication against hook-captured rows to work, import must
        // write the SAME project string the hook wrote. So file-level wins.
        // Falls back to per-line if the adapter couldn't determine a file
        // cwd (e.g. cursor-agent for unknown workspaces).
        cwd: defaultCwd ?? norm.cwd,
        sessionId: norm.sessionId,
      };
      continue;
    }

    // role === 'assistant'
    if (!pending) {
      // Stray assistant line before any user — shouldn't happen in healthy
      // transcripts; ignore. (claude-internal puts SessionStart hook output
      // before the first user line, but those are filtered by normalizeLine.)
      continue;
    }
    if (norm.text) pending.assistantTextParts.push(norm.text);
    if (norm.toolUses.length > 0) pending.toolUses.push(...norm.toolUses);
    // sessionId on assistant lines is just an opportunistic refinement when
    // the user line lacked one. cwd intentionally NOT refined here — see the
    // comment on pending.cwd above; file-level cwd is authoritative.
    if (norm.sessionId && !pending.sessionId) pending.sessionId = norm.sessionId;
  }

  if (pending && pending.assistantTextParts.length > 0) {
    const t = finalizeTurn(adapterId, filePath, pending);
    if (t) yield t;
  }
}

function finalizeTurn(
  adapterId: ImportAdapterId,
  filePath: string,
  p: PendingTurn,
): Turn | null {
  const assistantText = truncate(
    p.assistantTextParts.join('\n\n'),
    MAX_ASSISTANT_TEXT,
  );
  const fingerprint = computeFingerprint(
    adapterId,
    filePath,
    p.turnIndex,
    p.userText,
  );
  return {
    adapterId,
    fingerprint,
    filePath,
    sessionId: p.sessionId,
    turnIndex: p.turnIndex,
    userText: p.userText,
    assistantText,
    toolUses: p.toolUses,
    cwd: p.cwd,
    startedAt: p.startedAt,
  };
}
