#!/usr/bin/env node
/**
 * CodeBuddy/Cursor Memory Hooks CLI
 * 
 * This is the entry point for CodeBuddy and Cursor Agent hooks.
 * It receives JSON input from stdin and outputs JSON response to stdout.
 * 
 * Supports CodeBuddy (plugin & IDE) and Cursor hook formats:
 * - CodeBuddy 插件版: ~/.gongfeng-copilot/hooks/hooks.json
 * - CodeBuddy IDE: ~/.codebuddy/settings.json
 * - Cursor: ~/.cursor/hooks.json or <project>/.cursor/hooks.json
 * 
 * Usage:
 *   echo '{"command": "ls", "cwd": "/path"}' | node hooks-cli.js beforeShellExecution
 */

import { stdin, stdout, exit } from 'process';
import { decodeBufferWithFallback } from './utils/decodeHookInput.js';
import { WorkerClient } from './services/worker/client.js';
import { logger } from './utils/logger.js';
import { detectAdapterByEvent, getAdapter } from './adapters/registry.js';
import { recordAttachmentsMetadata } from './hooks/attachments.js';
import { recordStopTranscript } from './hooks/stop-transcript.js';
import { recordPreCompactSnapshot } from './hooks/pre-compact.js';
import { isMainModule } from './utils/isMainModule.js';
import { resolveHookProjectPath } from './utils/projectPath.js';

// Enable CLI mode FIRST before any logging happens
// This ensures all logs go to file only, not stderr
logger.setCliMode(true);
// Force debug level for memory flow debugging
logger.setLevel('debug');
logger.init('hooks-cli');

// Enable debug logging for memory flow debugging
// Now uses logger which writes to file in CLI mode
function debugLog(stage: string, message: string, data?: any): void {
  logger.debug(`MEMORY_DEBUG:${stage}`, message, data);
}

export function buildDiffFromFileEdits(edits: unknown): string | undefined {
  if (!Array.isArray(edits)) return undefined;

  const parts: string[] = [];
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object') continue;
    const e = edit as Record<string, unknown>;
    const oldValue = typeof e.old_string === 'string'
      ? e.old_string
      : typeof e.oldString === 'string'
        ? e.oldString
        : undefined;
    const newValue = typeof e.new_string === 'string'
      ? e.new_string
      : typeof e.newString === 'string'
        ? e.newString
        : undefined;
    if (oldValue === undefined && newValue === undefined) continue;
    parts.push(`- ${oldValue ?? ''}\n+ ${newValue ?? ''}`);
  }

  return parts.length > 0 ? parts.join('\n') : undefined;
}

// ============================================================================
// Types - Compatible with both CodeBuddy and Cursor Hook Formats
// ============================================================================

// Input types (compatible with both CodeBuddy and Cursor)
interface BeforeShellExecutionInput {
  command?: string;
  // Claude Code / CodeBuddy IDE nest the shell command under tool_input
  tool_input?: { command?: string; cmd?: string; [key: string]: unknown };
  cwd?: string;
  session_id?: string;
  conversation_id?: string; // Cursor format
}

interface BeforeMCPExecutionInput {
  tool_name: string;
  server_name?: string;  // Cursor provides this
  tool_input: string | object;
  url?: string;
  command?: string;
  session_id?: string;
  conversation_id?: string; // Cursor format
}

interface AfterShellExecutionInput {
  command?: string;
  output?: string;
  tool_input?: { command?: string; cmd?: string; [key: string]: unknown };
  tool_response?: { output?: string; stdout?: string; stderr?: string; exit_code?: number; interrupted?: boolean; [key: string]: unknown };
  duration?: number;      // CodeBuddy format
  duration_ms?: number;   // Cursor format
  exit_code?: number;     // Cursor provides this
  cwd?: string;           // Cursor provides this
  error?: string;         // Cursor provides this
  session_id?: string;
  conversation_id?: string; // Cursor format
}

interface AfterMCPExecutionInput {
  tool_name: string;
  server_name?: string;   // Cursor provides this
  tool_input: string | object;
  result_json?: string;   // CodeBuddy format (string)
  tool_result?: object;   // Cursor format (object)
  duration?: number;      // CodeBuddy format
  duration_ms?: number;   // Cursor format
  success?: boolean;      // Cursor provides this
  error?: string;         // Cursor provides this
  session_id?: string;
  conversation_id?: string; // Cursor format
}

interface AfterSearchReplaceFileEditInput {
  file_path: string;
  edits: Array<{ old_string: string; new_string: string }>;
  session_id?: string;
  conversation_id?: string; // Cursor format
}

interface AfterFileEditInput {
  file_path: string;
  content?: string;
  diff?: string;
  edits?: Array<{ old_string?: string; new_string?: string; oldString?: string; newString?: string }>;
  session_id?: string;
  conversation_id?: string; // Cursor format
}

interface BeforeSubmitPromptInput {
  session_id?: string;
  conversation_id?: string; // Cursor format
  message_id?: string;
  model?: string;
  hook_event_name?: string;
  agent_version?: string;
  workspace?: string[];
  workspace_roots?: string[]; // Cursor format
  user_name?: string;
  prompt: string;
  attachments?: any[];
  cwd?: string; // Genie/CodeBuddy IDE format
  // Cursor specific
  is_background_agent?: boolean;
  composer_mode?: 'agent' | 'ask' | 'edit';
}

interface AfterAgentResponseInput {
  session_id?: string;
  conversation_id?: string; // Cursor format
  message_id?: string;
  model?: string;
  hook_event_name?: string;
  agent_version?: string;
  workspace?: string[];
  user_name?: string;
  text?: string;      // CodeBuddy format
  response?: string;  // Cursor format
}

interface AfterAgentThoughtInput {
  session_id?: string;
  conversation_id?: string; // Cursor format
  thought?: string;
  text?: string; // Cursor format
}

interface StopInput {
  session_id?: string;
  conversation_id?: string; // Cursor format
  reason?: string;
  cwd?: string;
  transcript_path?: string;
  stop_hook_active?: boolean;
}

interface PreCompactInput {
  session_id?: string;
  conversation_id?: string;
  cwd?: string;
  transcript_path?: string;
  trigger?: string; // "manual" | "auto"
}

// Cursor-specific hooks
interface SessionStartInput {
  session_id?: string;
  conversation_id?: string; // Cursor format
  is_background_agent?: boolean;
  composer_mode?: 'agent' | 'ask' | 'edit';
}

interface SessionEndInput {
  session_id?: string;
  conversation_id?: string; // Cursor format
  reason?: string;
  duration_ms?: number;
  is_background_agent?: boolean;
  final_status?: string;
  error_message?: string;
}

// Output types (compatible with both CodeBuddy and Cursor)
interface PermissionResult {
  permission: 'allow' | 'deny' | 'ask';
  user_message?: string;
  agent_message?: string;
  // Cursor specific
  decision?: 'allow' | 'deny' | 'ask';  // Cursor uses 'decision' instead of 'permission'
}

interface PromptModificationResult {
  permission: 'allow' | 'deny';
  additional_context?: string;
  user_message?: string;
  modified_prompt?: string;  // Cursor supports this
  // Genie/CodeBuddy IDE compatibility
  continue?: boolean | 'allow' | 'deny' | 'ask';
  hookSpecificOutput?: { additionalContext?: string; [key: string]: unknown };
}

interface MonitorResult {
  permission: 'allow' | 'deny';
  continue?: boolean;
}

// Cursor sessionStart output
interface SessionStartResult {
  env?: Record<string, string>;
  additional_context?: string;
  continue?: boolean;
  user_message?: string;
  // Genie/CodeBuddy IDE compatibility
  hookSpecificOutput?: { additionalContext?: string; [key: string]: unknown };
}

// sessionEnd output (fire-and-forget, no output needed)
interface SessionEndResult {
  permission: 'allow' | 'deny';
  continue?: boolean;
}

// ============================================================================
// Worker Client Singleton
// ============================================================================

let workerClient: WorkerClient | null = null;

// 当前 hook 调用所属的来源 IDE（原始 adapter id），由 main() 在解析出 adapter 后写入。
// observation/session 落库时随 payload 透传给 worker，作为 source_ide 的唯一原点。
let currentSourceIDE: string | undefined;

async function getWorkerClient(): Promise<WorkerClient> {
  if (!workerClient) {
    workerClient = new WorkerClient();
    await workerClient.ensureRunning();
  }
  return workerClient;
}

// ============================================================================
// Hook Handlers
// ============================================================================

/**
 * beforeShellExecution - Control hook
 * Called before any shell command execution
 */
async function handleBeforeShellExecution(input: BeforeShellExecutionInput): Promise<PermissionResult> {
  // Check for sensitive patterns
  const sensitivePatterns = [
    /password/i,
    /secret/i,
    /api[_-]?key/i,
    /token/i,
    /credential/i,
    /private[_-]?key/i
  ];

  // CodeBuddy/Cursor put the command at top level; Claude Code / CodeBuddy IDE
  // (PreToolUse) nest it under tool_input.command. Guard against undefined so a
  // missing command can't crash the hook (TypeError on .toLowerCase()), which
  // would surface to the IDE as "hooks not firing".
  const commandStr = String(input.command ?? input.tool_input?.command ?? input.tool_input?.cmd ?? '').toLowerCase();

  for (const pattern of sensitivePatterns) {
    if (pattern.test(commandStr)) {
      return {
        permission: 'allow',
        agent_message: '[Memory] Sensitive command detected - not recording to memory'
      };
    }
  }

  return {
    permission: 'allow'
  };
}

/**
 * beforeMCPExecution - Control hook
 * Called before any MCP tool execution
 */
async function handleBeforeMCPExecution(input: BeforeMCPExecutionInput): Promise<PermissionResult> {
  // Allow all MCP executions by default
  // Could add filtering for specific tools if needed
  return {
    permission: 'allow'
  };
}

/**
 * afterShellExecution - Monitor hook
 * Record shell command results
 * Compatible with both CodeBuddy and Cursor formats
 */
async function handleAfterShellExecution(input: AfterShellExecutionInput): Promise<MonitorResult> {
  // Cross-IDE field unification:
  //   - cursor / codebuddy 直接在 input 顶层放 command / output / exit_code
  //   - claude-code / claude-internal / codebuddy-ide(PostToolUse for Bash)把字段
  //     嵌在 input.tool_input.command / input.tool_response.{stdout,stderr,interrupted}
  //   - codex newer desktop payloads use tool_name=exec_command and tool_input.cmd
  // 同一文件第 ~259 行已经用 `input.command ?? input.tool_input?.command` 兼容过滤,
  // 这里用同样风格在上报路径补齐,否则 claude/codebuddy 的 shell 观测进 worker 后
  // 会被分类器以 "empty command" 丢到 tier=0,流水级数据全部缺失。
  const ti = (input as any).tool_input ?? {};
  const tr = (input as any).tool_response ?? {};
  const cmd = (input as any).command ?? ti.command ?? ti.cmd;
  const out = (input as any).output ?? tr.output ?? (([tr.stdout, tr.stderr].filter(Boolean).join('\n')) || undefined);
  const exitCode = (input as any).exit_code ?? tr.exit_code ?? (tr.interrupted ? 130 : (tr.stderr ? undefined : 0));
  const errStr = (input as any).error ?? tr.stderr;
  // Handle both CodeBuddy (duration) and Cursor (duration_ms) formats
  const duration = input.duration ?? (input.duration_ms ? input.duration_ms / 1000 : undefined);
  const projectPath = resolveHookProjectPath(input);

  debugLog('afterShellExecution', 'Hook triggered (fire-and-forget)', {
    command: typeof cmd === 'string' ? cmd.substring(0, 100) : cmd,
    duration,
    exit_code: exitCode,
    input_session_id: input.session_id || input.conversation_id
  });

  try {
    const client = await getWorkerClient();
    // Prefer session_id from input, fall back to env var, then default
    // Cursor passes session_id in the input
    const sessionId = input.session_id || input.conversation_id || process.env.CODEBUDDY_MEM_SESSION_ID || process.env.CODEBUDDY_SESSION_ID || 'default-session';
    debugLog('afterShellExecution', 'Session ID resolved', { sessionId, source: (input.session_id || input.conversation_id) ? 'input' : (process.env.CODEBUDDY_MEM_SESSION_ID ? 'env(mem)' : (process.env.CODEBUDDY_SESSION_ID ? 'env' : 'default')) });

    const observation = {
      sessionId,
      projectPath,
      timestamp: Date.now(),
      type: 'shell',
      toolName: 'shell_execution',
      sourceIDE: currentSourceIDE,
      toolInput: { command: cmd },
      toolOutput: {
        output: truncateString(out, 5000),
        duration,
        exit_code: exitCode,
        error: errStr
      }
    };
    debugLog('afterShellExecution', 'Dispatching observation (async)', { sessionId, toolName: 'shell_execution' });

    await client.addObservation(observation);
    return { permission: 'allow' };
  } catch (error) {
    debugLog('afterShellExecution', 'ERROR', { error: String(error) });
    logError('afterShellExecution', error);
    return { permission: 'allow' };
  }
}

/**
 * afterMCPExecution - Monitor hook
 * Record MCP tool results
 * Compatible with both CodeBuddy and Cursor formats
 */
async function handleAfterMCPExecution(input: AfterMCPExecutionInput): Promise<MonitorResult> {
  // Handle both CodeBuddy (duration) and Cursor (duration_ms) formats
  const duration = input.duration ?? (input.duration_ms ? input.duration_ms / 1000 : undefined);
  const projectPath = resolveHookProjectPath(input);
  
  debugLog('afterMCPExecution', 'Hook triggered (fire-and-forget)', { 
    tool_name: input.tool_name, 
    server_name: input.server_name,
    duration, 
    input_session_id: input.session_id || input.conversation_id 
  });
  
  try {
    const client = await getWorkerClient();
    // Prefer session_id from input, fall back to env var, then default
    const sessionId = input.session_id || input.conversation_id || process.env.CODEBUDDY_MEM_SESSION_ID || process.env.CODEBUDDY_SESSION_ID || 'default-session';
    debugLog('afterMCPExecution', 'Session ID resolved', { sessionId, source: (input.session_id || input.conversation_id) ? 'input' : (process.env.CODEBUDDY_MEM_SESSION_ID ? 'env(mem)' : (process.env.CODEBUDDY_SESSION_ID ? 'env' : 'default')) });

    // Handle tool_input: could be string (CodeBuddy) or object (Cursor)
    let toolInput: any;
    if (typeof input.tool_input === 'string') {
      try {
        toolInput = JSON.parse(input.tool_input);
      } catch {
        toolInput = input.tool_input;
      }
    } else {
      toolInput = input.tool_input;
    }

    // Handle result: CodeBuddy IDE 上报 tool_response.{data,isError},
    // Cursor 上报顶层 tool_result(object),老版 CodeBuddy 插件上报 result_json(string)。
    // 三者依次回退,任意一种命中即可。
    const tr = (input as any).tool_response ?? {};
    let resultJson: any;
    if ((input as any).tool_result !== undefined) {
      resultJson = (input as any).tool_result;
    } else if ((input as any).result_json !== undefined) {
      try {
        resultJson = JSON.parse((input as any).result_json);
      } catch {
        resultJson = (input as any).result_json;
      }
    } else if (tr && typeof tr === 'object' && (tr.data !== undefined || tr.content !== undefined)) {
      // CodeBuddy IDE PostToolUse 的结果体
      resultJson = tr.data ?? tr.content;
    }

    // 同步取真实 server / tool 名 — 多 IDE 的命名:
    //   - cursor: input.server_name + input.tool_name
    //   - claude: input.tool_name 已经是 mcp__<server>__<tool>(三段式),不需要拼
    //   - codebuddy-ide: input.tool_name == "mcp_call_tool" 是个壳,
    //     真实 serverName / toolName 在 tool_input 里(camelCase)
    const ti = (toolInput && typeof toolInput === 'object') ? toolInput as Record<string, unknown> : {};
    const serverName = (input as any).server_name ?? (input as any).mcp_server
      ?? (ti.serverName as string | undefined)
      ?? (ti.server_name as string | undefined);
    const innerToolName = (ti.toolName as string | undefined) ?? (ti.tool_name as string | undefined);

    // 构造分类器能识别的 mcp__<server>__<tool> 形式,确保
    // observationClassifier.mcpToolPart 能正确切出 action 名,从而让
    // get/list/search/read/query/fetch 这类只读查询命中 tier=1。
    let fullToolName: string;
    const rawTopName = String(input.tool_name ?? '');
    if (rawTopName.startsWith('mcp__')) {
      // 已经是规范三段式(claude),直接用
      fullToolName = rawTopName;
    } else if (rawTopName === 'mcp_call_tool' || rawTopName === 'mcp_get_tool_description') {
      // codebuddy-ide 壳事件,合成 mcp__<server>__<innerTool>
      fullToolName = `mcp__${serverName ?? 'unknown'}__${innerToolName ?? rawTopName}`;
    } else if (serverName) {
      // cursor 风格: server_name + tool_name
      fullToolName = `mcp__${serverName}__${rawTopName}`;
    } else {
      fullToolName = rawTopName;
    }

    // Build tool name with server prefix if available (Cursor provides server_name)
    const observation = {
      sessionId,
      projectPath,
      timestamp: Date.now(),
      type: 'mcp',
      toolName: fullToolName,
      sourceIDE: currentSourceIDE,
      toolInput: toolInput,
      toolOutput: {
        result: truncateString(JSON.stringify(resultJson), 5000),
        duration,
        success: input.success,
        error: input.error
      }
    };
    debugLog('afterMCPExecution', 'Dispatching observation (async)', { sessionId, toolName: fullToolName });
    
    await client.addObservation(observation);
    return { permission: 'allow' };
  } catch (error) {
    debugLog('afterMCPExecution', 'ERROR', { error: String(error) });
    logError('afterMCPExecution', error);
    return { permission: 'allow' };
  }
}

/**
 * afterSearchReplaceFileEdit - Monitor hook
 * Record file search/replace edits
 */
async function handleAfterSearchReplaceFileEdit(input: AfterSearchReplaceFileEditInput): Promise<MonitorResult> {
  debugLog('afterSearchReplaceFileEdit', 'Hook triggered (fire-and-forget)', { file_path: input.file_path, edit_count: input.edits?.length, input_session_id: input.session_id || input.conversation_id });
  try {
    const client = await getWorkerClient();
    // Prefer session_id from input, fall back to env var, then default
    const sessionId = input.session_id || input.conversation_id || process.env.CODEBUDDY_MEM_SESSION_ID || process.env.CODEBUDDY_SESSION_ID || 'default-session';
    debugLog('afterSearchReplaceFileEdit', 'Session ID resolved', { sessionId, source: (input.session_id || input.conversation_id) ? 'input' : (process.env.CODEBUDDY_MEM_SESSION_ID ? 'env(mem)' : (process.env.CODEBUDDY_SESSION_ID ? 'env' : 'default')) });

    const observation = {
      sessionId,
      projectPath: resolveHookProjectPath(input),
      timestamp: Date.now(),
      type: 'file_edit',
      toolName: 'search_replace',
      sourceIDE: currentSourceIDE,
      toolInput: {
        file_path: input.file_path,
        edit_count: input.edits.length
      },
      toolOutput: {
        edits: input.edits.map(e => ({
          old: truncateString(e.old_string, 200),
          new: truncateString(e.new_string, 200)
        }))
      }
    };

    await client.addObservation(observation);
    return { permission: 'allow' };
  } catch (error) {
    debugLog('afterSearchReplaceFileEdit', 'ERROR', { error: String(error) });
    logError('afterSearchReplaceFileEdit', error);
    return { permission: 'allow' };
  }
}

/**
 * afterFileEdit - Monitor hook
 * Record file edit operations
 * Compatible with both CodeBuddy and Cursor formats
 */
async function handleAfterFileEdit(input: AfterFileEditInput): Promise<MonitorResult> {
  // Cross-IDE field unification:
  //   - cursor / codebuddy 直接在 input 顶层放 file_path / diff
  //   - claude-code / claude-internal / codebuddy-ide(PostToolUse for Write/Edit)
  //     把字段嵌在 input.tool_input.{file_path,old_string,new_string,content} 和
  //     input.tool_response.{filePath,structuredPatch,oldString,newString,content}
  // 这里同样在 hooks-cli 上报路径用顶层 ?? 嵌套兼容,否则分类器读不到 file_path
  // 与 diff,会一律落到 tier=0("no file_path"/"empty diff"),流水级 file_edit
  // 数据全部缺失。
  const ti = (input as any).tool_input ?? {};
  const tr = (input as any).tool_response ?? {};
  const filePath = (input as any).file_path ?? ti.file_path ?? ti.filePath ?? tr.filePath ?? tr.file_path;
  // diff 优先用顶层(cursor/codebuddy 已经计算好的);否则尽力从 claude tool_response
  // 拼出一个变更摘要,让分类器至少能够判定 SHORT_DIFF_LEN 与 binary 这些条件。
  let diff = (input as any).diff;
  if (!diff) {
    const editsDiff = buildDiffFromFileEdits((input as any).edits);
    if (editsDiff) {
      diff = editsDiff;
    } else if (typeof tr.structuredPatch === 'string' && tr.structuredPatch.trim()) {
      diff = tr.structuredPatch;
    } else if (Array.isArray(tr.structuredPatch)) {
      diff = JSON.stringify(tr.structuredPatch);
    } else if (typeof ti.old_string === 'string' || typeof ti.new_string === 'string') {
      diff = `- ${ti.old_string ?? ''}\n+ ${ti.new_string ?? ''}`;
    } else if (typeof ti.content === 'string') {
      diff = ti.content;
    } else if (typeof tr.content === 'string') {
      diff = tr.content;
    }
  }
  const projectPath = resolveHookProjectPath(input);

  debugLog('afterFileEdit', 'Hook triggered (fire-and-forget)', { file_path: filePath, input_session_id: input.session_id || input.conversation_id });
  try {
    const client = await getWorkerClient();
    // Prefer session_id from input, fall back to env var, then default
    const sessionId = input.session_id || input.conversation_id || process.env.CODEBUDDY_MEM_SESSION_ID || process.env.CODEBUDDY_SESSION_ID || 'default-session';
    debugLog('afterFileEdit', 'Session ID resolved', { sessionId, source: (input.session_id || input.conversation_id) ? 'input' : (process.env.CODEBUDDY_MEM_SESSION_ID ? 'env(mem)' : (process.env.CODEBUDDY_SESSION_ID ? 'env' : 'default')) });

    const observation = {
      sessionId,
      projectPath,
      timestamp: Date.now(),
      type: 'file_edit',
      toolName: 'file_edit',
      sourceIDE: currentSourceIDE,
      toolInput: {
        file_path: filePath
      },
      toolOutput: {
        diff: diff ? truncateString(diff, 3000) : undefined
      }
    };
    debugLog('afterFileEdit', 'Dispatching observation (async)', { sessionId, toolName: 'file_edit', file_path: filePath });

    await client.addObservation(observation);
    return { permission: 'allow' };
  } catch (error) {
    debugLog('afterFileEdit', 'ERROR', { error: String(error) });
    logError('afterFileEdit', error);
    return { permission: 'allow' };
  }
}

/**
 * beforeSubmitPrompt - Control hook
 * Initialize session and inject memory context
 * Compatible with both CodeBuddy and Cursor formats
 */
async function handleBeforeSubmitPrompt(input: BeforeSubmitPromptInput): Promise<PromptModificationResult> {
  debugLog('beforeSubmitPrompt', 'Hook triggered', { 
    session_id: input.session_id || input.conversation_id, 
    workspace: input.workspace || input.workspace_roots,
    prompt_length: input.prompt?.length,
    user_name: input.user_name,
    is_background_agent: input.is_background_agent,
    composer_mode: input.composer_mode
  });
  try {
    const client = await getWorkerClient();
    debugLog('beforeSubmitPrompt', 'Worker client obtained');
    
    // Extract project path from env vars (each IDE sets a different one) or input fields
    const projectPath = resolveHookProjectPath(input);
    debugLog('beforeSubmitPrompt', 'Project path extracted', { projectPath });

    // Initialize session
    debugLog('beforeSubmitPrompt', 'Initializing session...');
    const sessionId = input.session_id || input.conversation_id || 'default-session';
    const sessionResult = await client.initSession({
      sessionId: sessionId,
      projectPath: projectPath,
      prompt: input.prompt,
      sourceIDE: currentSourceIDE
    });
    debugLog('beforeSubmitPrompt', 'Session initialized', sessionResult);

    // Record attachment metadata (not content) — enables summaries to reference user-uploaded images.
    try {
      await recordAttachmentsMetadata(input, { client, projectPath, sourceIDE: currentSourceIDE });
    } catch (err) {
      logger.warn('beforeSubmitPrompt', 'attachments observation failed (non-fatal)', { err: String(err) });
    }

    // For IDEs that lack afterAgentResponse (e.g. CodeBuddy IDE, Claude Code),
    // record the user prompt as an observation so the session has data for summary.
    const sourceAdapter = resolveSourceAdapter(process.argv[2] || '', input);
    const lacksAgentResponse = sourceAdapter?.id === 'codebuddy-ide'
      || sourceAdapter?.id === 'claude-code'
      || sourceAdapter?.id === 'claude-internal'
      || sourceAdapter?.id === 'codex-cli';
    if (lacksAgentResponse && input.prompt) {
      try {
        await client.addObservation({
          sessionId,
          projectPath,
          timestamp: Date.now(),
          type: 'agent_response',
          toolName: 'user_prompt',
          sourceIDE: currentSourceIDE,
          toolInput: { prompt: truncateString(input.prompt, 2000) },
          toolOutput: { recorded: true }
        });
        debugLog('beforeSubmitPrompt', `User prompt recorded as observation for ${sourceAdapter!.displayName}`);
      } catch {
        debugLog('beforeSubmitPrompt', 'Failed to record prompt observation (non-fatal)');
      }
    }

    // Get memory context to inject
    debugLog('beforeSubmitPrompt', 'Getting memory context...');
    const additionalContext = await client.getContext(projectPath);
    debugLog('beforeSubmitPrompt', 'Memory context retrieved', { 
      hasContext: !!additionalContext, 
      contextLength: additionalContext?.length 
    });

    if (additionalContext) {
      // Return format compatible with:
      // - Cursor: permission/additional_context
      // - Gongfeng Copilot (gongfeng-copilot-chat-agent): continue:"allow"/user_message
      // - Genie/CodeBuddy IDE: continue/hookSpecificOutput.additionalContext
      // - Claude Code v2.1+: hookSpecificOutput must include hookEventName
      return {
        permission: 'allow',
        continue: 'allow',
        additional_context: additionalContext,
        user_message: additionalContext,
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext },
      };
    }

    return { permission: 'allow', continue: 'allow' };
  } catch (error) {
    debugLog('beforeSubmitPrompt', 'ERROR', { error: String(error) });
    logError('beforeSubmitPrompt', error);
    // Don't block on memory system failure
    return { permission: 'allow', continue: 'allow' };
  }
}

/**
 * afterAgentResponse - Monitor hook
 * Record agent responses AND generate session summary
 * NOTE: Uses fire-and-forget pattern to avoid 30s timeout from CodeBuddy/Cursor Agent
 * Compatible with both CodeBuddy (text) and Cursor (response) formats
 */
async function handleAfterAgentResponse(input: AfterAgentResponseInput): Promise<MonitorResult> {
  // Handle both CodeBuddy (text) and Cursor (response) formats
  const responseContent = input.text || input.response || '';
  
  debugLog('afterAgentResponse', 'Hook triggered (fire-and-forget)', { 
    session_id: input.session_id || input.conversation_id, 
    response_length: responseContent.length,
    user_name: input.user_name
  });
  try {
    const client = await getWorkerClient();
    const sessionId = input.session_id || input.conversation_id || process.env.CODEBUDDY_MEM_SESSION_ID || process.env.CODEBUDDY_SESSION_ID || 'default-session';
    
    await client.recordResponse(sessionId, responseContent, currentSourceIDE);
    debugLog('afterAgentResponse', 'Response recorded successfully');
    return { permission: 'allow' };
  } catch (error) {
    debugLog('afterAgentResponse', 'ERROR', { error: String(error) });
    logError('afterAgentResponse', error);
    return { permission: 'allow' };
  }
}

/**
 * afterAgentThought - Monitor hook
 * Record agent thoughts
 */
async function handleAfterAgentThought(input: AfterAgentThoughtInput): Promise<MonitorResult> {
  const thoughtContent = input.thought || input.text || '';
  debugLog('afterAgentThought', 'Hook triggered (fire-and-forget)', { session_id: input.session_id || input.conversation_id, thought_length: thoughtContent.length });
  try {
    // Cursor emits thought updates as evolving intermediate text. The final
    // assistant response is recorded separately and is much less noisy.
    if (currentSourceIDE === 'cursor') {
      debugLog('afterAgentThought', 'Skipped Cursor agent_thought to avoid streaming duplicates');
      return { permission: 'allow' };
    }

    const client = await getWorkerClient();
    const sessionId = input.session_id || input.conversation_id || process.env.CODEBUDDY_MEM_SESSION_ID || process.env.CODEBUDDY_SESSION_ID || 'default-session';
    
    await client.recordThought(sessionId, thoughtContent, currentSourceIDE);
    return { permission: 'allow' };
  } catch (error) {
    debugLog('afterAgentThought', 'ERROR', { error: String(error) });
    logError('afterAgentThought', error);
    return { permission: 'allow' };
  }
}

/**
 * stop - Monitor hook
 * Generate session summary when stopped
 */
async function handleStop(input: StopInput & { response?: string; text?: string }): Promise<MonitorResult> {
  debugLog('stop', 'Hook triggered (fire-and-forget)', { session_id: input.session_id || input.conversation_id, reason: input.reason });
  try {
    const client = await getWorkerClient();
    const sessionId = input.session_id || input.conversation_id || process.env.CODEBUDDY_MEM_SESSION_ID || process.env.CODEBUDDY_SESSION_ID || 'default-session';
    const projectPath = resolveHookProjectPath(input);

    // Try transcript-based capture for Claude Code / Claude Internal adapters.
    const sourceAdapter = resolveSourceAdapter(process.argv[2] || '', input);
    if (sourceAdapter?.id === 'codex-cli') {
      await client.initSession({
        sessionId,
        projectPath,
        prompt: '',
        sourceIDE: currentSourceIDE,
      });
    }
    const shouldRecordTranscriptObservation = sourceAdapter?.id !== 'cursor';
    const recorded = await recordStopTranscript(input, {
      client: {
        addObservation: client.addObservation.bind(client),
        updateSessionField: client.updateSessionField.bind(client),
      },
      projectPath,
      adapterId: sourceAdapter?.id || '',
    }, {
      recordObservation: shouldRecordTranscriptObservation,
    });

    // Fallback: legacy response-text path for adapters that populate input.text/.response directly.
    if (!recorded) {
      const responseText =
        input.text
        || input.response
        || (typeof (input as { last_assistant_message?: string }).last_assistant_message === 'string'
          ? (input as { last_assistant_message: string }).last_assistant_message
          : '');
      if (responseText) {
        try {
          await client.addObservation({
            sessionId,
            projectPath,
            timestamp: Date.now(),
            type: 'agent_response',
            toolName: 'agent_response',
            sourceIDE: currentSourceIDE,
            toolInput: { event: 'stop', reason: input.reason },
            toolOutput: { response: truncateString(responseText, 5000) }
          });
          debugLog('stop', 'Response recorded as observation');
        } catch {
          debugLog('stop', 'Failed to record response observation (non-fatal)');
        }
      }
    } else {
      debugLog('stop', 'Transcript-based agent_response recorded');
    }

    // Pass transcript_path through so the worker can run reverse dedup —
    // delete any imported summary row for the same (jsonl sid, last turn
    // index) that import beat hook to writing during the post-install race
    // window. No-op for non-jsonl IDEs (codebuddy-ide etc).
    // sourceIDE is recorded so the summary row knows which IDE it came from
    // (master 2.0.19+ feature).
    await client.summarizeSession(sessionId, currentSourceIDE);
    debugLog('stop', 'Summarization request sent');
    return { permission: 'allow', continue: true };
  } catch (error) {
    debugLog('stop', 'ERROR', { error: String(error) });
    logError('stop', error);
    return { permission: 'allow', continue: true };
  }
}

/**
 * beforePreCompact - Monitor hook
 * Snapshot assistant response before Claude Code compresses context
 */
async function handleBeforePreCompact(input: PreCompactInput): Promise<MonitorResult> {
  debugLog('beforePreCompact', 'Hook triggered', {
    session_id: input.session_id || input.conversation_id,
    trigger: input.trigger,
    transcript_path: input.transcript_path,
  });
  try {
    const client = await getWorkerClient();
    const projectPath = resolveHookProjectPath(input);

    const sourceAdapter = resolveSourceAdapter(process.argv[2] || '', input);
    const ok = await recordPreCompactSnapshot(input, {
      client: {
        addObservation: client.addObservation.bind(client),
        updateSessionField: client.updateSessionField.bind(client),
      },
      projectPath,
      adapterId: sourceAdapter?.id || '',
    });
    debugLog('beforePreCompact', 'Snapshot recorded', { recorded: ok });
    return { permission: 'allow', continue: true };
  } catch (error) {
    debugLog('beforePreCompact', 'ERROR', { error: String(error) });
    logError('beforePreCompact', error);
    return { permission: 'allow', continue: true };
  }
}

/**
 * sessionStart - Cursor specific hook
 * Called when a composer session starts
 * Initialize session and optionally inject memory context
 */
async function handleSessionStart(input: SessionStartInput): Promise<SessionStartResult> {
  debugLog('sessionStart', 'Hook triggered', { 
    session_id: input.session_id || input.conversation_id, 
    is_background_agent: input.is_background_agent,
    composer_mode: input.composer_mode
  });
  
  try {
    const client = await getWorkerClient();
    // Each IDE sets a different env var for the project directory
    const projectPath = resolveHookProjectPath(input);
    
    debugLog('sessionStart', 'Initializing session...', { projectPath });
    const sessionId = input.session_id || input.conversation_id || 'default-session';
    const sessionResult = await client.initSession({
      sessionId: sessionId,
      projectPath: projectPath,
      prompt: '',  // No prompt available at session start
      sourceIDE: currentSourceIDE
    });
    debugLog('sessionStart', 'Session initialized', sessionResult);

    // Get memory context to inject
    debugLog('sessionStart', 'Getting memory context...');
    const additionalContext = await client.getContext(projectPath);
    debugLog('sessionStart', 'Memory context retrieved', { 
      hasContext: !!additionalContext, 
      contextLength: additionalContext?.length 
    });

    // Return format compatible with Cursor (additional_context/env),
    // Genie/CodeBuddy IDE (hookSpecificOutput.additionalContext), and
    // Claude Code v2.1+ (hookSpecificOutput must include hookEventName).
    return {
      continue: true,
      additional_context: additionalContext || undefined,
      env: {
        CODEBUDDY_MEM_SESSION_ID: sessionId
      },
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        ...(additionalContext ? { additionalContext } : {}),
      },
    };
  } catch (error) {
    debugLog('sessionStart', 'ERROR', { error: String(error) });
    logError('sessionStart', error);
    // Don't block session on memory system failure
    return { continue: true };
  }
}

/**
 * sessionEnd - Cursor specific hook
 * Called when a composer session ends
 * Fire-and-forget: response is logged but not used
 */
async function handleSessionEnd(input: SessionEndInput): Promise<SessionEndResult> {
  debugLog('sessionEnd', 'Hook triggered (fire-and-forget)', { 
    session_id: input.session_id || input.conversation_id, 
    reason: input.reason,
    duration_ms: input.duration_ms,
    final_status: input.final_status
  });
  
  try {
    const gate = shouldSummarizeOnSessionEnd(input, currentSourceIDE);
    if (!gate.summarize) {
      debugLog('sessionEnd', 'Summarization skipped', { reason: gate.reason });
      return { permission: 'allow', continue: true };
    }

    const client = await getWorkerClient();
    const sessionId = input.session_id || input.conversation_id || process.env.CODEBUDDY_MEM_SESSION_ID || process.env.CODEBUDDY_SESSION_ID || 'default-session';
    
    await client.summarizeSession(sessionId, currentSourceIDE);
    debugLog('sessionEnd', 'Summarization request sent');
    return { permission: 'allow', continue: true };
  } catch (error) {
    debugLog('sessionEnd', 'ERROR', { error: String(error) });
    logError('sessionEnd', error);
    return { permission: 'allow', continue: true };
  }
}

export const SESSION_END_STALE_DURATION_MS = 60 * 60 * 1000;

export function shouldSummarizeOnSessionEnd(
  input: Pick<SessionEndInput, 'reason' | 'duration_ms' | 'final_status'>,
  sourceIDE?: string,
): { summarize: boolean; reason?: string } {
  const reason = typeof input.reason === 'string' ? input.reason.toLowerCase() : '';
  const finalStatus = typeof input.final_status === 'string' ? input.final_status.toLowerCase() : '';

  if (reason && ['other', 'user_close', 'window_close', 'aborted', 'error', 'cancelled', 'canceled', 'interrupted'].includes(reason)) {
    return { summarize: false, reason: `low-confidence reason: ${reason}` };
  }

  if (
    typeof input.duration_ms === 'number'
    && Number.isFinite(input.duration_ms)
    && input.duration_ms > SESSION_END_STALE_DURATION_MS
  ) {
    return { summarize: false, reason: `stale sessionEnd duration: ${input.duration_ms}` };
  }

  if (reason === 'completed' || ['completed', 'success', 'succeeded', 'done'].includes(finalStatus)) {
    return { summarize: true };
  }

  return { summarize: false, reason: `no completion signal for ${sourceIDE || 'unknown'}` };
}

// ============================================================================
// Utility Functions
// ============================================================================

function truncateString(str: string, maxLength: number): string {
  if (!str) return str;
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength) + '...[truncated]';
}

function logError(hookName: string, error: unknown): void {
  logger.error(hookName, `Error occurred`, { error: String(error) });
}

/**
 * Resolve the source IDE adapter for a hook event.
 *
 * Claude Code and Claude Internal fire identical PascalCase events, so
 * detectAdapterByEvent() alone always resolves to claude-code (first match).
 * We disambiguate via:
 *   1. AGENTMEM_IDE env var set by the proxy launcher (cmd/sh) — authoritative.
 *   2. Fallback for installs predating the hint: claude-internal transcripts
 *      live under ~/.claude-internal, so a transcript_path containing
 *      ".claude-internal" implies claude-internal.
 */
function resolveSourceAdapter(eventName: string, input?: any) {
  const ideHint = process.env.AGENTMEM_IDE || process.env.CBMEM_IDE;
  if (ideHint) {
    const hinted = getAdapter(ideHint);
    if (hinted) return hinted;
  }
  let adapter = detectAdapterByEvent(eventName, input);
  if (adapter?.id === 'claude-code' && input) {
    const tp = input.transcript_path || input.transcriptPath || input.transcript;
    if (typeof tp === 'string' && tp.includes('.claude-internal')) {
      adapter = getAdapter('claude-internal') ?? adapter;
    }
    // CodeBuddy IDE fires the same PascalCase events as Claude Code but carries a
    // `client` field (e.g. "CodeBuddyIDE") that Claude Code never sends. Re-detect
    // so the codebuddy-ide adapter parses its non-jsonl transcript. (The proxy cmd
    // also sets AGENTMEM_IDE=codebuddy-ide, which takes precedence above.)
    else if (/codebuddy/i.test(String(input.client ?? ''))) {
      adapter = getAdapter('codebuddy-ide') ?? adapter;
    }
  }
  return adapter;
}

/**
 * Write JSON output to stdout and exit cleanly.
 * On Windows, process.exit() can crash with a libuv assertion when there are
 * open handles (e.g. fetch/HTTP keep-alive connections).
 * Instead, we set process.exitCode and end stdout to let Node.js exit naturally.
 */
function writeAndExit(json: string, code: number): void {
  process.exitCode = code;
  
  // Pause and unref stdin so Node.js won't wait for it
  stdin.pause();
  (stdin as any).unref?.();
  
  // Write to stdout, then end it to signal we're done
  stdout.write(json, () => {
    // After write completes, destroy stdout to close the pipe
    stdout.end();
    
    // Force all remaining handles to be unref'd so Node.js can exit naturally
    // This avoids the Windows libuv assertion crash from process.exit()
    const timer = setTimeout(() => {
      // If we're still alive after 200ms, something is holding us
      // Use process.exit with the intended code instead of SIGTERM
      // SIGTERM on Windows can cause exit code 1
      process.exit(code);
    }, 200);
    timer.unref();
  });
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  const hookName = process.argv[2];
  debugLog('MAIN', 'CLI started', { hookName, argv: process.argv });
  
  if (!hookName) {
    logger.error('CLI', 'No hook name provided', { usage: 'agent-memory-hooks <hook_name>' });
    exit(1);
  }

  // Read JSON input from stdin with timeout
  // Use Buffer to handle encoding properly on Windows
  let inputData = '';
  
  // Use a promise with timeout to avoid hanging when stdin is not closed
  inputData = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let resolved = false;
    
    const done = (result: string) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      stdin.removeAllListeners();
      stdin.pause();
      (stdin as any).unref?.();
      resolve(result);
    };

    const timeout = setTimeout(() => {
      if (chunks.length > 0) {
        // Concatenate all chunks and decode with encoding fallback
        const buffer = Buffer.concat(chunks);
        const data = decodeBufferWithFallback(buffer);
        done(data);
      } else {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error('stdin read timeout: no data received within 5s'));
      }
    }, 5000);

    stdin.on('data', (chunk: Buffer | string) => {
      // Handle both Buffer and string (in case setEncoding was called elsewhere)
      if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk, 'utf8'));
      } else {
        chunks.push(chunk);
      }
      // Try to parse as JSON immediately - if valid, we have all data
      try {
        const buffer = Buffer.concat(chunks);
        const data = decodeBufferWithFallback(buffer);
        JSON.parse(data);
        done(data);
      } catch {
        // Not valid JSON yet, continue reading
      }
    });

    stdin.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const data = decodeBufferWithFallback(buffer);
      done(data);
    });

    stdin.on('error', (err: Error) => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
  });

  let input: any;
  try {
    input = JSON.parse(inputData);
    debugLog('MAIN', 'Input parsed successfully', { inputKeys: Object.keys(input) });
  } catch (error) {
    debugLog('MAIN', 'Failed to parse input JSON', { error: String(error), inputData: inputData.substring(0, 200) });
    // Return safe default for control hooks
    writeAndExit(JSON.stringify({ permission: 'allow' }), 0);
    return;
  }

  // Detect source IDE and normalize event name
  let adapter = resolveSourceAdapter(hookName, input);
  // Gongfeng Copilot uses `session_id` (not `conversation_id`) and lacks `cursor_version`.
  // Since both share the same event names, cursor adapter matches first — re-detect by input fields.
  // Skip this 启发式 when AGENTMEM_IDE env is already set (新版 hooks 都自带 env,这条是
  // 升级期老 hooks.json 的兜底);也跳过那些明显是其它 IDE 转发过来的请求
  // (transcript_path 含 .claude-internal / .claude/),否则会把 claude 误判成 codebuddy。
  if (
    !process.env.AGENTMEM_IDE &&
    !process.env.CBMEM_IDE &&
    adapter?.id === 'cursor' &&
    (input as any).session_id && !(input as any).conversation_id && !(input as any).cursor_version
  ) {
    const tp = String((input as any).transcript_path ?? (input as any).transcriptPath ?? '');
    const looksLikeClaude = /\.(claude|claude-internal)[\\/]/i.test(tp);
    if (!looksLikeClaude) {
      adapter = getAdapter('codebuddy') ?? adapter;
    }
  }
  const internalEvent = adapter?.mapEventName(hookName) ?? hookName;
  const normalizedInput = adapter?.normalizeInput(internalEvent, input) ?? input;
  // 记录来源 IDE（原始 adapter id），供各 handler 落库时透传为 source_ide。
  currentSourceIDE = adapter?.id || undefined;

  if (adapter) {
    debugLog('ADAPTER', `IDE detected: ${adapter.id}`, {
      originalEvent: hookName,
      internalEvent,
      ide: adapter.id,
      rawInputKeys: Object.keys(input),
      rawInputPreview: JSON.stringify(input).substring(0, 500),
    });
    if (hookName !== internalEvent) {
      debugLog('ADAPTER', `Event mapped: ${hookName} → ${internalEvent}`);
    }
    if (normalizedInput._routeTo) {
      debugLog('ADAPTER', `PostToolUse routed to: ${normalizedInput._routeTo}`, {
        detectionBasis: normalizedInput.command !== undefined ? 'has command field' :
          normalizedInput.exit_code !== undefined ? 'has exit_code field' :
          normalizedInput.mcp_server !== undefined ? 'has mcp_server field' :
          normalizedInput.tool_name !== undefined ? 'has tool_name field' :
          normalizedInput.file_path !== undefined ? 'has file_path field' : 'fallback default',
      });
    }
  } else {
    debugLog('ADAPTER', `No adapter matched for event: ${hookName}, using as-is`);
  }

  // Route to appropriate handler
  let result: any;

  switch (internalEvent) {
    // Control hooks (can block operations)
    case 'beforeShellExecution':
      result = await handleBeforeShellExecution(normalizedInput);
      break;
    case 'beforeMCPExecution':
      result = await handleBeforeMCPExecution(normalizedInput);
      break;
    case 'beforeSubmitPrompt':
      result = await handleBeforeSubmitPrompt(normalizedInput);
      break;

    // Monitor hooks (observe and record)
    case 'afterShellExecution':
      result = await handleAfterShellExecution(normalizedInput);
      break;
    case 'afterMCPExecution':
      result = await handleAfterMCPExecution(normalizedInput);
      break;
    case 'afterSearchReplaceFileEdit':
      result = await handleAfterSearchReplaceFileEdit(normalizedInput);
      break;
    case 'afterFileEdit':
      result = await handleAfterFileEdit(normalizedInput);
      break;
    case 'afterAgentResponse':
      result = await handleAfterAgentResponse(normalizedInput);
      break;
    case 'afterAgentThought':
      result = await handleAfterAgentThought(normalizedInput);
      break;

    // Unified post-tool event (CodeBuddy IDE routes PostToolUse here)
    case 'afterToolUse': {
      const routeTo = normalizedInput._routeTo || 'afterShellExecution';
      debugLog('afterToolUse', `Routing PostToolUse → ${routeTo}`, {
        routeTo,
        inputKeys: Object.keys(normalizedInput),
        inputPreview: JSON.stringify(normalizedInput).substring(0, 800),
      });
      switch (routeTo) {
        case 'afterShellExecution':
          result = await handleAfterShellExecution(normalizedInput);
          break;
        case 'afterMCPExecution':
          result = await handleAfterMCPExecution(normalizedInput);
          break;
        case 'afterFileEdit':
          result = await handleAfterFileEdit(normalizedInput);
          break;
        default:
          debugLog('afterToolUse', `Unknown routeTo: ${routeTo}, falling back to afterShellExecution`);
          result = await handleAfterShellExecution(normalizedInput);
      }
      debugLog('afterToolUse', 'Handler completed', { routeTo, resultKeys: result ? Object.keys(result) : [] });
      break;
    }

    // Session lifecycle hooks
    case 'sessionStart':
      result = await handleSessionStart(normalizedInput);
      break;
    case 'sessionEnd':
      result = await handleSessionEnd(normalizedInput);
      break;
    case 'stop':
      result = await handleStop(normalizedInput);
      break;
    case 'beforePreCompact':
      result = await handleBeforePreCompact(normalizedInput);
      break;

    default:
      logger.warn('CLI', `Unknown hook: ${hookName} (internal: ${internalEvent})`);
      result = { permission: 'allow' };
  }

  // For Claude Code / Claude Internal, strip fields that fail schema validation.
  // Claude Code only accepts a strict subset of output fields per event.
  if (adapter && (adapter.id === 'claude-code' || adapter.id === 'claude-internal')) {
    result = sanitizeForClaudeCode(internalEvent, result);
  }

  // Output JSON result to stdout and exit
  writeAndExit(JSON.stringify(result), 0);
}

/**
 * Sanitize hook output for Claude Code strict JSON schema.
 * Claude Code rejects unknown top-level fields with "Invalid input".
 * Each event type only allows specific fields.
 */
function sanitizeForClaudeCode(internalEvent: string, result: any): any {
  if (!result || typeof result !== 'object') return result;

  switch (internalEvent) {
    case 'sessionStart': {
      // SessionStart: { continue?, stopReason?, hookSpecificOutput? { hookEventName, additionalContext } }
      const out: any = {};
      if (result.continue !== undefined) out.continue = result.continue;
      if (result.stopReason) out.stopReason = result.stopReason;
      const ctx = result.hookSpecificOutput?.additionalContext
        ?? result.additional_context;
      if (ctx) {
        out.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: ctx };
      }
      return out;
    }
    case 'beforeSubmitPrompt': {
      // UserPromptSubmit: { decision?, reason?, continue?, stopReason?, hookSpecificOutput? { hookEventName, additionalContext, sessionTitle } }
      const out: any = {};
      if (result.decision) out.decision = result.decision;
      if (result.reason) out.reason = result.reason;
      if (result.continue !== undefined && result.continue !== 'allow') out.continue = result.continue;
      if (result.stopReason) out.stopReason = result.stopReason;
      const ctx = result.hookSpecificOutput?.additionalContext
        ?? result.additional_context;
      if (ctx) {
        out.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext: ctx };
      }
      return out;
    }
    case 'stop':
    case 'sessionEnd':
    default: {
      // For other events, keep continue/decision/reason and strip unknown fields
      const out: any = {};
      if (result.continue !== undefined) out.continue = result.continue;
      if (result.decision) out.decision = result.decision;
      if (result.reason) out.reason = result.reason;
      if (result.stopReason) out.stopReason = result.stopReason;
      if (result.hookSpecificOutput) out.hookSpecificOutput = result.hookSpecificOutput;
      return out;
    }
  }
}

// Only run main() when executed directly as a CLI (not when imported as a module for tests).
if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    logger.error('CLI', `Fatal error: ${error}`);
    // Return safe default
    writeAndExit(JSON.stringify({ permission: 'allow' }), 0);
  });
}
