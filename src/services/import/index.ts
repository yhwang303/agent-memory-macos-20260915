/**
 * Public entry point for the history import feature.
 *
 * Stage 1 (this file): just exports the types and the discover() function.
 * Stage 5 will add `runImport(opts, onProgress)` here as the orchestrator
 * that wires adapters → iterateTurns → SDKAgent.runPrompt → insertSummary
 * with concurrency / rate-limit / fingerprint idempotency.
 */

export { discoverAll, getAdapter, getAllAdapters } from './discover.js';
export { insertImportedSummary } from './db-write.js';
export {
  countFingerprints,
  getExistingFingerprints,
  getHookCoverageWindow,
  hasFingerprint,
  hasHookSummaryNear,
  recordSessionFingerprint,
  resetAdapter,
} from './fingerprints.js';
export {
  pendingRetryTaskCount,
  pushPendingRetryTasks,
  retryFailedTasks,
  runImport,
  runImportDryRun,
  takePendingRetryTasks,
} from './orchestrator.js';
export {
  buildImportedSessionId,
  buildSourceIdeTag,
  collectSession,
  computeSessionFingerprint,
  isSessionSubstantive,
  isTurnSubstantive,
  truncate,
} from './turn-utils.js';
export type {
  AdapterDiscoveryResult,
  DiscoveryReport,
  ImportAdapter,
  ImportAdapterId,
  ImportOptions,
  ImportProgressListener,
  ImportProgressSnapshot,
  ImportResult,
  SessionData,
  TranscriptFile,
  Turn,
} from './types.js';
