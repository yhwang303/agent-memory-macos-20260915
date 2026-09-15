/**
 * Shared logic for hook handlers that read a transcript JSONL file and record
 * the assistant's last message as an observation.
 *
 * Consumers today: stop-transcript.ts (Stop hook), pre-compact.ts (PreCompact).
 * Future: codex-cli (M3 milestone).
 *
 * Gated on adapter id prefix `claude-` — adapters that emit `transcript_path`
 * in their payload.
 */

import {
  safeReadLastAssistantMessage,
  safeReadLastImageTurnAssistantMessage,
  safeReadLastUserMessage,
} from '../shared/transcript-parser.js';
import type { AssistantMessage } from '../shared/transcript-parser.js';
import {
  readCodeBuddyLastAssistantMessage,
  readCodeBuddyLastUserMessage,
} from '../shared/codebuddy-transcript.js';

export const MAX_IMAGE_REFS = 10;
export const SESSION_FIELD_MAX_CHARS = 4000;

/**
 * Prefix marker prepended to `last_assistant_message` when the user's turn
 * that triggered the response contained an image. This is how we propagate
 * the "user posted an image" signal to `buildSummaryPrompt` — which would
 * otherwise only see the plain-text `user_prompt` (Cursor strips [Image]
 * markers from the text that gets written into sdk_sessions.user_prompt).
 * The marker is stripped before the text is shown to the LLM.
 */
export const USER_IMAGE_MARKER = '[USER_POSTED_IMAGE]';
/**
 * Whether the user turn that triggered this assistant response actually
 * contained an image. Only when this is true do we attach has_images=true
 * to the observation — which the summary prompt uses to decide whether to
 * include the <media_context> slot at all.
 */
function userTurnHasImage(
  userMsg: { hasImages?: boolean; attachments?: Array<{ type: string }> } | null
): boolean {
  if (!userMsg) return false;
  if (userMsg.hasImages) return true;
  if (Array.isArray(userMsg.attachments)) {
    return userMsg.attachments.some(a => a?.type === 'image');
  }
  return false;
}

export interface TranscriptHookInput {
  session_id?: string;
  conversation_id?: string;
  transcript_path?: string;
}

export interface TranscriptHookContext {
  client: {
    addObservation: (o: any) => Promise<any>;
    updateSessionField: (
      sid: string,
      f: 'last_assistant_message' | 'transcript_path' | 'user_prompt',
      v: string
    ) => Promise<void>;
  };
  projectPath: string;
  adapterId: string;
  now?: () => number;
}

export interface TranscriptObservationOptions {
  /** Observation toolName (distinguishes Stop vs PreCompact) */
  toolName: string;
  /** Truncation cap for toolOutput.response */
  observationMaxChars: number;
  /** Hook-specific toolInput fields (merged with shared ones) */
  buildExtraInput: (msg: AssistantMessage, input: any) => Record<string, any>;
  /** Some adapters already record assistant replies via a dedicated hook. */
  recordObservation?: boolean;
}

const TRANSCRIPT_ADAPTER_IDS = new Set([
  'claude-code',
  'claude-internal',
  'cursor',
  'gemini-cli',
  'codex-cli',
  'opencode',
  'codebuddy-ide',
]);

export function adapterEmitsTranscript(adapterId: string): boolean {
  return TRANSCRIPT_ADAPTER_IDS.has(adapterId) || adapterId.startsWith('claude-');
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '...' : s;
}

/**
 * Record a transcript-based observation. Returns true iff recorded; false if
 * any gate blocks (wrong adapter, missing transcript, missing session, empty
 * text). Best-effort updates sdk_sessions.last_assistant_message after.
 */
export async function recordTranscriptObservation(
  input: TranscriptHookInput,
  ctx: TranscriptHookContext,
  opts: TranscriptObservationOptions
): Promise<boolean> {
  if (!adapterEmitsTranscript(ctx.adapterId)) return false;
  if (!input.transcript_path) return false;

  const sessionId = input.session_id || input.conversation_id || '';
  // No default-session fallback: transcripts are high-signal data that
  // shouldn't be bucketed under a catch-all session id.
  if (!sessionId) return false;

  // CodeBuddy IDE uses a non-jsonl transcript (per-conversation index.json +
  // messages/<id>.json). Parse it with the dedicated reader. Image-turn support
  // is not implemented for this format yet, so we record the last assistant text only.
  const isCodeBuddyIde = ctx.adapterId === 'codebuddy-ide';
  if (isCodeBuddyIde) {
    const cbMsg = readCodeBuddyLastAssistantMessage(input.transcript_path);
    if (!cbMsg?.text) return false;
    const cbUser = readCodeBuddyLastUserMessage(input.transcript_path);
    const tsCb = (ctx.now ?? Date.now)();
    if (opts.recordObservation !== false) {
      await ctx.client.addObservation({
        sessionId,
        projectPath: ctx.projectPath,
        timestamp: tsCb,
        type: 'agent_response',
        toolName: opts.toolName,
        sourceIDE: ctx.adapterId || undefined,
        toolInput: {
          source: 'transcript',
          has_images: false,
          image_refs: [],
          ...opts.buildExtraInput(cbMsg, input),
        },
        toolOutput: { response: truncate(cbMsg.text, opts.observationMaxChars) },
      });
    }
    try {
      await ctx.client.updateSessionField(
        sessionId,
        'last_assistant_message',
        truncate(cbMsg.text, SESSION_FIELD_MAX_CHARS)
      );
    } catch {
      // advisory; observation is the source of truth
    }
    // 用 transcript 里当轮用户消息刷新 user_prompt，避免 UserPromptSubmit 漏触发
    // 时摘要 request 字段长期冻结在旧请求。
    if (cbUser?.text) {
      try {
        await ctx.client.updateSessionField(
          sessionId,
          'user_prompt',
          truncate(cbUser.text, SESSION_FIELD_MAX_CHARS)
        );
      } catch {
        // advisory; observation is the source of truth
      }
    }
    return true;
  }

  const userMsg = safeReadLastUserMessage(input.transcript_path);
  // Only flag has_images when the *user* turn that triggered this response
  // actually contained an image. Previously any image marker anywhere in the
  // session would fire, causing unrelated assistant text to be stored as
  // "image description".
  const hasImageContext = userTurnHasImage(userMsg);

  // A single user image turn can produce multiple assistant transcript rows:
  // an immediate "I can see..." analysis, followed by tool calls and a final
  // task-completion reply. For media_context, the useful source is the full
  // assistant discussion after that image turn, not only the last assistant row.
  const imageTurn = hasImageContext
    ? safeReadLastImageTurnAssistantMessage(input.transcript_path)
    : null;
  const msg = imageTurn?.assistant ?? safeReadLastAssistantMessage(input.transcript_path);
  if (!msg?.text) return false;

  const combinedImageRefs = collectCombinedImageRefs(msg, userMsg);

  const ts = (ctx.now ?? Date.now)();

  const baseInput: Record<string, any> = {
    source: 'transcript',
    has_images: hasImageContext || msg.hasImages,
    image_refs: combinedImageRefs.slice(0, MAX_IMAGE_REFS),
  };

  if (opts.recordObservation !== false) {
    await ctx.client.addObservation({
      sessionId,
      projectPath: ctx.projectPath,
      timestamp: ts,
      type: 'agent_response',
      toolName: opts.toolName,
      sourceIDE: ctx.adapterId || undefined,
      toolInput: { ...baseInput, ...opts.buildExtraInput(msg, input) },
      toolOutput: {
        response: truncate(msg.text, opts.observationMaxChars),
      },
    });
  }

  try {
    const prefix = hasImageContext ? `${USER_IMAGE_MARKER}\n\n` : '';
    await ctx.client.updateSessionField(
      sessionId,
      'last_assistant_message',
      truncate(prefix + msg.text, SESSION_FIELD_MAX_CHARS)
    );
  } catch {
    // advisory; observation is the source of truth
  }

  // 用 transcript 里当轮用户消息刷新 user_prompt，避免 UserPromptSubmit 漏触发
  // 时摘要 request 字段长期冻结在旧请求。
  if (userMsg?.text) {
    try {
      await ctx.client.updateSessionField(
        sessionId,
        'user_prompt',
        truncate(userMsg.text, SESSION_FIELD_MAX_CHARS)
      );
    } catch {
      // advisory; observation is the source of truth
    }
  }

  return true;
}

/**
 * Merge image refs from assistant's own content (structured image blocks or
 * text-literal markers detected by classifyContent) and the last user turn's
 * attachments (where Cursor-style pasted images live). Deduplicates while
 * preserving order: assistant refs first, then new refs from user message.
 */
function collectCombinedImageRefs(
  assistant: AssistantMessage,
  user: { attachments?: Array<{ type: string; ref?: string }> } | null
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of assistant.imageRefs) {
    if (!seen.has(ref)) { seen.add(ref); out.push(ref); }
  }
  if (user && Array.isArray(user.attachments)) {
    for (const att of user.attachments) {
      if (att?.type === 'image' && typeof att.ref === 'string' && !seen.has(att.ref)) {
        seen.add(att.ref);
        out.push(att.ref);
      }
    }
  }
  return out;
}
