/**
 * Stop-hook transcript reader.
 * When an adapter (claude-code / claude-internal) provides transcript_path in
 * the Stop payload, reads the last assistant message from the JSONL file and
 * records it as an agent_response observation. Also updates
 * sdk_sessions.last_assistant_message so buildSummaryPrompt has it.
 *
 * Non-Claude adapters fall back to the legacy `input.text || input.response`
 * path (kept in hooks-cli.ts for the adapters that genuinely send response text
 * in the Stop payload, e.g. older CodeBuddy IDE).
 */

import {
  recordTranscriptObservation,
  type TranscriptHookContext,
  type TranscriptHookInput,
} from './transcript-observation-common.js';

export type StopTranscriptContext = TranscriptHookContext;

export interface StopTranscriptInput extends TranscriptHookInput {
  reason?: string;
}

const OBSERVATION_MAX_CHARS = 8000;

/**
 * Record transcript-derived agent_response observation when applicable.
 * Returns true if a transcript-based observation was recorded.
 * Returns false if:
 *   - adapter is not Claude Code family
 *   - transcript_path is missing
 *   - transcript read failed / returned empty
 * The caller can then fall back to the legacy response-text path.
 */
export async function recordStopTranscript(
  input: StopTranscriptInput,
  ctx: StopTranscriptContext,
  options: { recordObservation?: boolean } = {}
): Promise<boolean> {
  return recordTranscriptObservation(input, ctx, {
    toolName: 'agent_response',
    observationMaxChars: OBSERVATION_MAX_CHARS,
    buildExtraInput: (_msg, inp: StopTranscriptInput) => ({ reason: inp.reason }),
    recordObservation: options.recordObservation,
  });
}
