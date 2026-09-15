/**
 * AgentMemory Hook Plugin
 * 
 * Main entry point for CodeBuddy Agent hooks integration.
 * Maps CodeBuddy's 11 lifecycle hooks to the memory system.
 */

import type {
  HookEventName,
  BeforeSubmitPromptContext,
  BeforeSubmitPromptResult,
  AfterAgentResponseContext,
  AfterAgentThoughtContext,
  StopContext,
  StopResult,
  BeforeShellExecutionContext,
  BeforeMCPExecutionContext,
  PermissionResult,
  AfterShellExecutionContext,
  AfterMCPExecutionContext,
  AfterSearchReplaceFileEditContext,
  AfterFileEditContext,
  ObservationResult,
  NormalizedObservation
} from './types.js';
import { WorkerClient } from '../services/worker/client.js';
import { logger } from '../utils/logger.js';

// Worker client singleton
let workerClient: WorkerClient | null = null;

// Session state tracking
const sessionState = new Map<string, {
  isInitialized: boolean;
  sessionDbId?: number;
  projectPath: string;
}>();

/**
 * Initialize the worker client
 */
async function ensureWorkerClient(): Promise<WorkerClient> {
  if (!workerClient) {
    workerClient = new WorkerClient();
    await workerClient.ensureRunning();
  }
  return workerClient;
}

/**
 * Check if this is a new session
 */
function isNewSession(sessionId: string): boolean {
  return !sessionState.has(sessionId);
}

// ============================================================================
// Hook Handlers
// ============================================================================

/**
 * beforeSubmitPrompt - Session initialization + context injection
 * 
 * This is the key hook for:
 * 1. Detecting new sessions
 * 2. Initializing the memory session
 * 3. Injecting historical context into the prompt
 */
export async function beforeSubmitPrompt(
  context: BeforeSubmitPromptContext
): Promise<BeforeSubmitPromptResult> {
  try {
    const client = await ensureWorkerClient();
    const isNew = isNewSession(context.sessionId);

    logger.debug('HOOK', 'beforeSubmitPrompt', { sessionId: context.sessionId, isNew });

    if (isNew) {
      // Initialize new session
      const { sessionDbId } = await client.initSession(context);
      sessionState.set(context.sessionId, {
        isInitialized: true,
        sessionDbId,
        projectPath: context.projectPath
      });

      // Get historical context for injection
      const additionalContext = await client.getContext(context.projectPath);

      logger.info('HOOK', `Session initialized: ${context.sessionId}`, { projectPath: context.projectPath });

      return {
        allow: true,
        additionalContext: additionalContext || undefined
      };
    }

    return { allow: true };
  } catch (error) {
    logger.error('HOOK', 'beforeSubmitPrompt failed', {}, error as Error);
    // Don't block the user on memory system failure
    return { allow: true };
  }
}

/**
 * afterAgentResponse - Record agent responses for context
 */
export async function afterAgentResponse(
  context: AfterAgentResponseContext
): Promise<ObservationResult> {
  try {
    const client = await ensureWorkerClient();
    await client.recordResponse(context.sessionId, context.response);
    return { recorded: true };
  } catch (error) {
    logger.error('HOOK', 'afterAgentResponse failed', {}, error as Error);
    return { recorded: false };
  }
}

/**
 * afterAgentThought - Record agent thoughts for richer observations
 */
export async function afterAgentThought(
  context: AfterAgentThoughtContext
): Promise<ObservationResult> {
  try {
    const client = await ensureWorkerClient();
    await client.recordThought(context.sessionId, context.thought);
    return { recorded: true };
  } catch (error) {
    logger.error('HOOK', 'afterAgentThought failed', {}, error as Error);
    return { recorded: false };
  }
}

/**
 * stop - Generate session summary
 */
export async function stop(context: StopContext): Promise<StopResult> {
  try {
    const client = await ensureWorkerClient();
    await client.summarizeSession(context.sessionId);
    
    // Cleanup session state
    sessionState.delete(context.sessionId);
    
    logger.info('HOOK', 'Session summarized and closed', { sessionId: context.sessionId });
    
    return { summarized: true, continueWith: null };
  } catch (error) {
    logger.error('HOOK', 'stop failed', {}, error as Error);
    return { summarized: false, continueWith: null };
  }
}

/**
 * beforeShellExecution - Privacy check for shell commands
 */
export async function beforeShellExecution(
  context: BeforeShellExecutionContext
): Promise<PermissionResult> {
  // Check for private data patterns
  const privatePatterns = [
    /password/i,
    /secret/i,
    /api[_-]?key/i,
    /token/i,
    /credential/i
  ];

  const commandStr = `${context.command} ${(context.args || []).join(' ')}`;
  
  for (const pattern of privatePatterns) {
    if (pattern.test(commandStr)) {
      logger.warn('HOOK', 'Potentially sensitive command detected', { command: context.command });
      // Still allow execution, but mark for exclusion from memory
      return { allow: true, reason: 'sensitive_excluded' };
    }
  }

  return { allow: true };
}

/**
 * beforeMCPExecution - Privacy check for MCP tools
 */
export async function beforeMCPExecution(
  _context: BeforeMCPExecutionContext
): Promise<PermissionResult> {
  // Allow all MCP executions, privacy filtering happens in afterMCPExecution
  return { allow: true };
}

/**
 * afterShellExecution - Record shell command observations
 */
export async function afterShellExecution(
  context: AfterShellExecutionContext
): Promise<ObservationResult> {
  try {
    const client = await ensureWorkerClient();
    
    const observation: NormalizedObservation = {
      sessionId: context.sessionId,
      projectPath: context.projectPath,
      timestamp: context.timestamp,
      type: 'shell',
      toolName: 'shell',
      toolInput: {
        command: context.command,
        args: context.args
      },
      toolOutput: {
        exitCode: context.exitCode,
        stdout: truncateOutput(context.stdout),
        stderr: truncateOutput(context.stderr)
      },
      metadata: {
        duration: context.duration
      }
    };

    const result = await client.addObservation(observation);
    logger.debug('HOOK', 'Shell observation recorded', { command: context.command });
    
    return { recorded: true, observationId: result.observationId?.toString() };
  } catch (error) {
    logger.error('HOOK', 'afterShellExecution failed', {}, error as Error);
    return { recorded: false };
  }
}

/**
 * afterMCPExecution - Record MCP tool observations
 */
export async function afterMCPExecution(
  context: AfterMCPExecutionContext
): Promise<ObservationResult> {
  try {
    const client = await ensureWorkerClient();
    
    const observation: NormalizedObservation = {
      sessionId: context.sessionId,
      projectPath: context.projectPath,
      timestamp: context.timestamp,
      type: 'mcp',
      toolName: `${context.serverName}:${context.toolName}`,
      toolInput: context.input,
      toolOutput: context.output,
      metadata: {
        success: context.success,
        duration: context.duration
      }
    };

    const result = await client.addObservation(observation);
    logger.debug('HOOK', 'MCP observation recorded', { tool: context.toolName });
    
    return { recorded: true, observationId: result.observationId?.toString() };
  } catch (error) {
    logger.error('HOOK', 'afterMCPExecution failed', {}, error as Error);
    return { recorded: false };
  }
}

/**
 * afterSearchReplaceFileEdit - Record search/replace file edits
 */
export async function afterSearchReplaceFileEdit(
  context: AfterSearchReplaceFileEditContext
): Promise<ObservationResult> {
  try {
    const client = await ensureWorkerClient();
    
    const observation: NormalizedObservation = {
      sessionId: context.sessionId,
      projectPath: context.projectPath,
      timestamp: context.timestamp,
      type: 'search_replace',
      toolName: 'search_replace',
      toolInput: {
        filePath: context.filePath,
        searchPattern: context.searchPattern,
        replacement: context.replacement
      },
      toolOutput: {
        matchCount: context.matchCount,
        diff: context.diff
      }
    };

    const result = await client.addObservation(observation);
    logger.debug('HOOK', 'Search/replace observation recorded', { file: context.filePath });
    
    return { recorded: true, observationId: result.observationId?.toString() };
  } catch (error) {
    logger.error('HOOK', 'afterSearchReplaceFileEdit failed', {}, error as Error);
    return { recorded: false };
  }
}

/**
 * afterFileEdit - Record file edit observations
 */
export async function afterFileEdit(
  context: AfterFileEditContext
): Promise<ObservationResult> {
  try {
    const client = await ensureWorkerClient();
    
    const observation: NormalizedObservation = {
      sessionId: context.sessionId,
      projectPath: context.projectPath,
      timestamp: context.timestamp,
      type: 'file_edit',
      toolName: 'file_edit',
      toolInput: {
        filePath: context.filePath,
        editType: context.editType
      },
      toolOutput: {
        diff: context.diff
      }
    };

    const result = await client.addObservation(observation);
    logger.debug('HOOK', 'File edit observation recorded', { file: context.filePath, type: context.editType });
    
    return { recorded: true, observationId: result.observationId?.toString() };
  } catch (error) {
    logger.error('HOOK', 'afterFileEdit failed', {}, error as Error);
    return { recorded: false };
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Truncate long output to prevent memory bloat
 */
function truncateOutput(output: string, maxLength: number = 10000): string {
  if (output.length <= maxLength) return output;
  return output.substring(0, maxLength) + '\n... [truncated]';
}

// ============================================================================
// Export All Hooks
// ============================================================================

export const hooks = {
  beforeSubmitPrompt,
  afterAgentResponse,
  afterAgentThought,
  stop,
  beforeShellExecution,
  beforeMCPExecution,
  afterShellExecution,
  afterMCPExecution,
  afterSearchReplaceFileEdit,
  afterFileEdit
};

export default hooks;
