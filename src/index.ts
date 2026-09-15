/**
 * AgentMemory System - Main Entry Point
 * 
 * This module exports all public APIs for the AgentMemory System.
 */

// Types
export * from './types/index.js';

// Hooks
export { hooks as memoryHooks } from './hooks/index.js';

// SDK
export { buildObservationPrompt, buildSummaryPrompt } from './sdk/prompts.js';
export { parseObservations, parseSummary, isSkipResponse } from './sdk/parser.js';

// Services
export { getDatabase, closeDatabase, getDatabaseStats } from './services/sqlite/Database.js';
export * from './services/sqlite/observations.js';
export * from './services/sqlite/sessions.js';
export * from './services/sqlite/summaries.js';
export { WorkerService, getDefaultConfig } from './services/worker/WorkerService.js';
export { WorkerClient } from './services/worker/client.js';
export { ContextBuilder } from './services/context/builder.js';

// Utilities
export { getDataDir, ensureDataDir, getDatabasePath, getProjectId } from './shared/paths.js';
export { logger } from './utils/logger.js';
