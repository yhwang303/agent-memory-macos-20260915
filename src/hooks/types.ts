/**
 * CodeBuddy Hook Types
 * 
 * Defines the 11 lifecycle hooks provided by CodeBuddy Agent
 */

// ============================================================================
// Hook Context Types - Input data for each hook
// ============================================================================

/**
 * Base context shared by all hooks
 */
export interface BaseHookContext {
  sessionId: string;
  projectPath: string;
  timestamp: number;
}

/**
 * beforeSubmitPrompt - Called before user prompt is submitted
 */
export interface BeforeSubmitPromptContext extends BaseHookContext {
  prompt: string;
  isNewSession?: boolean;
}

/**
 * afterAgentResponse - Called after Agent completes a response
 */
export interface AfterAgentResponseContext extends BaseHookContext {
  response: string;
  tokenUsage?: {
    input: number;
    output: number;
  };
}

/**
 * afterAgentThought - Called after Agent completes a thought
 */
export interface AfterAgentThoughtContext extends BaseHookContext {
  thought: string;
}

/**
 * stop - Called when agent loop ends
 */
export interface StopContext extends BaseHookContext {
  reason?: string;
  summary?: string;
}

/**
 * beforeShellExecution - Called before any shell command
 */
export interface BeforeShellExecutionContext extends BaseHookContext {
  command: string;
  args?: string[];
  workingDirectory?: string;
}

/**
 * beforeMCPExecution - Called before any MCP tool
 */
export interface BeforeMCPExecutionContext extends BaseHookContext {
  toolName: string;
  serverName: string;
  input: unknown;
}

/**
 * afterShellExecution - Called after shell command execution
 */
export interface AfterShellExecutionContext extends BaseHookContext {
  command: string;
  args?: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  duration?: number;
}

/**
 * afterMCPExecution - Called after MCP tool execution
 */
export interface AfterMCPExecutionContext extends BaseHookContext {
  toolName: string;
  serverName: string;
  input: unknown;
  output: unknown;
  success: boolean;
  duration?: number;
}

/**
 * afterSearchReplaceFileEdit - Called after search/replace file edit
 */
export interface AfterSearchReplaceFileEditContext extends BaseHookContext {
  filePath: string;
  searchPattern: string;
  replacement: string;
  matchCount: number;
  diff?: string;
}

/**
 * afterFileEdit - Called after file edit
 */
export interface AfterFileEditContext extends BaseHookContext {
  filePath: string;
  editType: 'create' | 'modify' | 'delete';
  diff?: string;
  content?: string;
}

// ============================================================================
// Hook Result Types - Return values for each hook
// ============================================================================

/**
 * Result for beforeSubmitPrompt hook
 */
export interface BeforeSubmitPromptResult {
  allow: boolean;
  modifiedPrompt?: string;
  additionalContext?: string;
  reason?: string;
}

/**
 * Result for before* permission hooks
 */
export interface PermissionResult {
  allow: boolean;
  reason?: string;
}

/**
 * Result for after* observation hooks
 */
export interface ObservationResult {
  recorded: boolean;
  observationId?: string;
}

/**
 * Result for stop hook
 */
export interface StopResult {
  continueWith?: string | null;
  summarized: boolean;
}

// ============================================================================
// Hook Handler Interface
// ============================================================================

/**
 * Generic hook handler interface
 */
export interface HookHandler<TContext, TResult> {
  execute(context: TContext): Promise<TResult>;
}

/**
 * All hook types union
 */
export type HookContext =
  | BeforeSubmitPromptContext
  | AfterAgentResponseContext
  | AfterAgentThoughtContext
  | StopContext
  | BeforeShellExecutionContext
  | BeforeMCPExecutionContext
  | AfterShellExecutionContext
  | AfterMCPExecutionContext
  | AfterSearchReplaceFileEditContext
  | AfterFileEditContext;

/**
 * Hook event names matching CodeBuddy's API
 */
export type HookEventName =
  | 'beforeSubmitPrompt'
  | 'afterAgentResponse'
  | 'afterAgentThought'
  | 'stop'
  | 'beforeShellExecution'
  | 'beforeMCPExecution'
  | 'afterShellExecution'
  | 'afterMCPExecution'
  | 'afterSearchReplaceFileEdit'
  | 'afterFileEdit';

// ============================================================================
// Internal Types for Memory System
// ============================================================================

/**
 * Normalized observation data for storage
 */
export interface NormalizedObservation {
  sessionId: string;
  projectPath: string;
  timestamp: number;
  type: 'shell' | 'mcp' | 'file_edit' | 'search_replace' | 'thought' | 'response';
  toolName: string;
  toolInput: unknown;
  toolOutput: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * Worker API client interface
 */
export interface WorkerClient {
  initSession(context: BeforeSubmitPromptContext): Promise<{ sessionDbId: number; isNew: boolean }>;
  addObservation(observation: NormalizedObservation): Promise<{ observationId: string }>;
  getContext(projectPath: string): Promise<string>;
  summarizeSession(sessionId: string): Promise<{ summary: string }>;
  recordThought(sessionId: string, thought: string): Promise<void>;
  recordResponse(sessionId: string, response: string): Promise<void>;
}
