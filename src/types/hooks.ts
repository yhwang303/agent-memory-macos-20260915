/**
 * CodeBuddy Agent Hook Types
 * Defines the hook interfaces for CodeBuddy's lifecycle events
 */

/**
 * Base context provided to all hooks
 */
export interface HookContext {
  sessionId: string;
  project: string;
  timestamp: number;
}

/**
 * beforeSubmitPrompt hook context
 * Called before user prompt is sent to the backend
 */
export interface BeforeSubmitPromptContext extends HookContext {
  prompt: string;
  isNewSession: boolean;
}

/**
 * beforeSubmitPrompt hook return type
 */
export interface BeforeSubmitPromptResult {
  allow: boolean;
  modifiedPrompt?: string;
  additionalContext?: string;
  reason?: string;
}

/**
 * afterAgentResponse hook context
 * Called after Agent completes a response
 */
export interface AfterAgentResponseContext extends HookContext {
  response: string;
  turnNumber: number;
}

/**
 * afterAgentThought hook context
 * Called after Agent completes a thought
 */
export interface AfterAgentThoughtContext extends HookContext {
  thought: string;
  turnNumber: number;
}

/**
 * stop hook context
 * Called when agent loop ends
 */
export interface StopContext extends HookContext {
  reason: 'user_stop' | 'completed' | 'error';
  totalTurns: number;
}

/**
 * stop hook return type
 */
export interface StopResult {
  continueWith?: string;
}

/**
 * beforeShellExecution hook context
 */
export interface BeforeShellExecutionContext extends HookContext {
  command: string;
  workingDirectory: string;
}

/**
 * beforeShellExecution hook return type
 */
export interface BeforeShellExecutionResult {
  allow: boolean;
  reason?: string;
}

/**
 * afterShellExecution hook context
 */
export interface AfterShellExecutionContext extends HookContext {
  command: string;
  workingDirectory: string;
  output: string;
  exitCode: number;
  duration: number;
}

/**
 * beforeMCPExecution hook context
 */
export interface BeforeMCPExecutionContext extends HookContext {
  serverName: string;
  toolName: string;
  input: Record<string, unknown>;
}

/**
 * beforeMCPExecution hook return type
 */
export interface BeforeMCPExecutionResult {
  allow: boolean;
  reason?: string;
}

/**
 * afterMCPExecution hook context
 */
export interface AfterMCPExecutionContext extends HookContext {
  serverName: string;
  toolName: string;
  input: Record<string, unknown>;
  result: unknown;
  duration: number;
}

/**
 * afterSearchReplaceFileEdit hook context
 */
export interface AfterSearchReplaceFileEditContext extends HookContext {
  filePath: string;
  searchPattern: string;
  replacement: string;
  matchCount: number;
}

/**
 * afterFileEdit hook context
 */
export interface AfterFileEditContext extends HookContext {
  filePath: string;
  diff: string;
  linesAdded: number;
  linesRemoved: number;
}

/**
 * Unified observation data from any tool execution
 */
export interface ToolObservation {
  type: 'shell' | 'mcp' | 'file_edit' | 'search_replace';
  tool_name: string;
  tool_input: unknown;
  tool_output: unknown;
  timestamp: number;
  duration?: number;
}

/**
 * Hook handler function types
 */
export type BeforeSubmitPromptHandler = (context: BeforeSubmitPromptContext) => Promise<BeforeSubmitPromptResult>;
export type AfterAgentResponseHandler = (context: AfterAgentResponseContext) => Promise<void>;
export type AfterAgentThoughtHandler = (context: AfterAgentThoughtContext) => Promise<void>;
export type StopHandler = (context: StopContext) => Promise<StopResult>;
export type BeforeShellExecutionHandler = (context: BeforeShellExecutionContext) => Promise<BeforeShellExecutionResult>;
export type AfterShellExecutionHandler = (context: AfterShellExecutionContext) => Promise<void>;
export type BeforeMCPExecutionHandler = (context: BeforeMCPExecutionContext) => Promise<BeforeMCPExecutionResult>;
export type AfterMCPExecutionHandler = (context: AfterMCPExecutionContext) => Promise<void>;
export type AfterSearchReplaceFileEditHandler = (context: AfterSearchReplaceFileEditContext) => Promise<void>;
export type AfterFileEditHandler = (context: AfterFileEditContext) => Promise<void>;

/**
 * Complete hooks configuration
 */
export interface CodeBuddyHooks {
  beforeSubmitPrompt?: BeforeSubmitPromptHandler;
  afterAgentResponse?: AfterAgentResponseHandler;
  afterAgentThought?: AfterAgentThoughtHandler;
  stop?: StopHandler;
  beforeShellExecution?: BeforeShellExecutionHandler;
  afterShellExecution?: AfterShellExecutionHandler;
  beforeMCPExecution?: BeforeMCPExecutionHandler;
  afterMCPExecution?: AfterMCPExecutionHandler;
  afterSearchReplaceFileEdit?: AfterSearchReplaceFileEditHandler;
  afterFileEdit?: AfterFileEditHandler;
}

// Re-exports for adapters and downstream packages.
export interface StopInputShape {
  session_id?: string;
  conversation_id?: string;
  reason?: string;
  cwd?: string;
  transcript_path?: string;
  stop_hook_active?: boolean;
}

export interface PreCompactInputShape {
  session_id?: string;
  conversation_id?: string;
  cwd?: string;
  transcript_path?: string;
  trigger?: string;
}
