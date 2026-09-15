/**
 * PreCompact-hook transcript snapshot.
 *
 * When Claude Code fires PreCompact (conversation about to be compressed),
 * read the current assistant response from the transcript JSONL and record
 * it as a pre_compact_snapshot observation. This protects against context
 * loss before compression.
 *
 * Gated on claude- adapter prefix, same as stop-transcript.
 */

import {
  recordTranscriptObservation,
  type TranscriptHookContext,
  type TranscriptHookInput,
} from './transcript-observation-common.js';

export type PreCompactContext = TranscriptHookContext;

export interface PreCompactInput extends TranscriptHookInput {
  trigger?: string;
}

const OBSERVATION_MAX_CHARS = 16000;

export async function recordPreCompactSnapshot(
  input: PreCompactInput,
  ctx: PreCompactContext
): Promise<boolean> {
  return recordTranscriptObservation(input, ctx, {
    toolName: 'pre_compact_snapshot',
    observationMaxChars: OBSERVATION_MAX_CHARS,
    buildExtraInput: (_msg, inp: PreCompactInput) => ({ trigger: inp.trigger || 'unknown' }),
  });
}
