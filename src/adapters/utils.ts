import { logger } from '../utils/logger.js';

/**
 * Coalesce the various transcript_path aliases Claude Code / CodeBuddy IDE
 * might emit into a single canonical `transcript_path` field.
 *
 * Priority: transcript_path > transcriptPath > transcript.
 * Uses `||` rather than `??` so empty strings are treated as missing.
 */
export function coalesceTranscriptPath(
  rawInput: any,
  adapterName: string,
  internalEventName: string,
): any {
  const input = rawInput ?? {};
  const transcript_path =
    input.transcript_path || input.transcriptPath || input.transcript || undefined;
  logger.debug(adapterName, `normalizeInput transcript_path normalization for ${internalEventName}`, {
    inputKeys: Object.keys(input),
    hasTranscriptPath: transcript_path !== undefined,
  });
  return { ...input, transcript_path };
}
