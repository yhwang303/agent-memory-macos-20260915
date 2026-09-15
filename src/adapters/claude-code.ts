import path from 'path';
import os from 'os';
import { IDEAdapter } from './types.js';
import { logger } from '../utils/logger.js';
import { coalesceTranscriptPath } from './utils.js';

/**
 * Claude Code event name → agent-memory internal event name
 *
 * Claude Code fires PascalCase events via its hooks system.
 * We map only the events that are useful for the memory system.
 */
const EVENT_MAP: Record<string, string> = {
  'UserPromptSubmit': 'beforeSubmitPrompt',
  'SessionStart': 'sessionStart',
  'SessionEnd': 'sessionEnd',
  'PreToolUse': 'beforeShellExecution',
  'PostToolUse': 'afterToolUse',      // unified entry; normalizeInput routes to sub-handler
  'Stop': 'stop',
  'PreCompact': 'beforePreCompact',
};

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout: number }>;
}

/**
 * The subset of Claude Code events we actually register hooks for.
 *
 * - `UserPromptSubmit`: session init + context injection
 * - `SessionStart`: detect new / resumed sessions
 * - `PostToolUse`: record tool execution observations (routed by tool type)
 * - `PreToolUse` (matcher Bash): privacy check for shell commands
 * - `Stop`: trigger session summary generation
 * - `SessionEnd`: session cleanup
 */
const HOOKS_EVENTS: Array<{ ideEvent: string; timeout: number; matcher?: string }> = [
  { ideEvent: 'UserPromptSubmit', timeout: 10000 },
  { ideEvent: 'SessionStart', timeout: 15000 },
  { ideEvent: 'PostToolUse', timeout: 10000 },
  { ideEvent: 'PreToolUse', timeout: 10000, matcher: 'Bash' },
  { ideEvent: 'Stop', timeout: 30000 },
  { ideEvent: 'PreCompact', timeout: 30000 },
  { ideEvent: 'SessionEnd', timeout: 10000 },
];

export class ClaudeCodeAdapter implements IDEAdapter {
  id = 'claude-code';
  displayName = 'Claude Code';
  configDir = path.join(os.homedir(), '.claude');

  hooksConfigFile = 'settings.json';
  mcpConfigFile = 'settings.json';              // Claude Code stores MCP config in same settings.json
  projectDirEnvVar = 'CLAUDE_PROJECT_DIR';

  mapEventName(ideEventName: string): string | null {
    return EVENT_MAP[ideEventName] ?? null;
  }

  /**
   * Normalize raw input from Claude Code hooks into our internal format.
   *
   * For `PostToolUse`, Claude Code provides a `tool_name` field (e.g. "Bash",
   * "Write", "Edit", "mcp__github__search") that we use to route to the
   * correct sub-handler.
   */
  normalizeInput(internalEventName: string, rawInput: any): any {
    if (internalEventName === 'stop' || internalEventName === 'beforePreCompact') {
      return coalesceTranscriptPath(rawInput, 'ClaudeCodeAdapter', internalEventName);
    }

    if (internalEventName !== 'afterToolUse') {
      logger.debug('ClaudeCodeAdapter', `normalizeInput pass-through for ${internalEventName}`, {
        inputKeys: rawInput ? Object.keys(rawInput) : [],
      });
      return rawInput;
    }

    const input = rawInput ?? {};
    const inputKeys = Object.keys(input);
    logger.info('ClaudeCodeAdapter', 'PostToolUse received, analyzing input for sub-type routing', {
      inputKeys,
      inputSnapshot: JSON.stringify(input).substring(0, 1000),
    });

    // Claude Code provides tool_name (e.g. "Bash", "Write", "Edit", "Read",
    // "Grep", "Glob", "mcp__xxx__yyy" etc.)
    const toolName: string = input.tool_name ?? input.tool ?? '';
    const normalizedToolName = String(toolName).toLowerCase();
    const ti = (input.tool_input && typeof input.tool_input === 'object')
      ? input.tool_input as Record<string, unknown>
      : {};

    // Shell (Bash) tool
    if (
      normalizedToolName === 'bash' ||
      input.command !== undefined ||
      ti.command !== undefined ||
      input.exit_code !== undefined
    ) {
      logger.info('ClaudeCodeAdapter', 'PostToolUse -> afterShellExecution (Bash tool)', {
        toolName,
        hasCommand: input.command !== undefined || ti.command !== undefined,
      });
      return { ...input, _routeTo: 'afterShellExecution' };
    }

    // MCP tools (naming convention: mcp__<server>__<tool>)
    if (
      toolName.startsWith('mcp__') ||
      input.mcp_server !== undefined ||
      ti.serverName !== undefined ||
      ti.server_name !== undefined ||
      ti.mcp_server !== undefined
    ) {
      logger.info('ClaudeCodeAdapter', 'PostToolUse -> afterMCPExecution (MCP tool)', {
        toolName,
        mcpServer: input.mcp_server ?? ti.serverName ?? ti.server_name ?? ti.mcp_server,
      });
      return { ...input, _routeTo: 'afterMCPExecution' };
    }

    // File edit tools (Write, Edit, FileWrite, FileEdit, NotebookEdit)
    if (
      normalizedToolName === 'write' || normalizedToolName === 'edit' ||
      normalizedToolName === 'multiedit' ||
      normalizedToolName === 'filewrite' || normalizedToolName === 'fileedit' ||
      normalizedToolName === 'notebookedit' ||
      input.file_path !== undefined
    ) {
      logger.info('ClaudeCodeAdapter', 'PostToolUse -> afterFileEdit (file edit tool)', {
        toolName,
        filePath: input.file_path,
      });
      return { ...input, _routeTo: 'afterFileEdit' };
    }

    // Default: Read/Grep/Glob/WebFetch/Todo* and other non-listed tools are not
    // AgentMemory observations. Route to shell so the classifier drops them as empty
    // command instead of recording generic tool noise.
    logger.warn('ClaudeCodeAdapter',
      'PostToolUse sub-type unknown, defaulting to afterShellExecution.',
      { toolName, inputKeys, inputFull: JSON.stringify(input).substring(0, 2000) },
    );
    return { ...input, _routeTo: 'afterShellExecution' };
  }

  /**
   * Generate the hooks config object to merge into ~/.claude/settings.json.
   *
   * Claude Code uses the same nested format as CodeBuddy IDE:
   *   { hooks: { EventName: [{ matcher, hooks: [{ type, command, timeout }] }] } }
   *
   * For events that don't support matcher or should match everything, we use
   * an empty string "" (Claude Code convention).
   */
  generateHooksConfig(hooksCliPath: string, platform: NodeJS.Platform): object {
    const hooks: Record<string, HookEntry[]> = {};

    for (const { ideEvent, timeout, matcher } of HOOKS_EVENTS) {
      // 注入 AGENTMEM_IDE=<adapter id> 让 hooks-cli 进程一眼知道自己是哪个 IDE,
      // 不再靠 input.client / transcript_path 这类启发式字段去猜
      // (claude-code 与 codebuddy-ide 的 EVENT_MAP 完全相同,事件名层面无法区分)。
      const cmd = platform === 'win32'
        ? `cmd.exe /c chcp 65001 >nul & set "AGENTMEM_IDE=${this.id}" && node "${hooksCliPath}" ${ideEvent}`
        : `AGENTMEM_IDE=${this.id} node "${hooksCliPath}" ${ideEvent}`;

      const entry: HookEntry = {
        hooks: [{ type: 'command', command: cmd, timeout }],
      };
      if (matcher) {
        entry.matcher = matcher;
      } else {
        entry.matcher = '';     // Claude Code: empty string means "match all"
      }

      hooks[ideEvent] = [entry];
    }

    return { hooks };
  }

  generateMcpConfig(mcpServerPath: string): object {
    return {
      mcpServers: {
        'agent-memory': {
          command: 'node',
          args: [mcpServerPath],
          env: {},
        },
      },
    };
  }
}

/**
 * Claude Internal (腾讯内网版 @tencent/claude-code-internal).
 *
 * Hooks system is identical to ClaudeCode — only the config directory differs:
 *   ~/.claude-internal/  (instead of ~/.claude/)
 */
export class ClaudeInternalAdapter extends ClaudeCodeAdapter {
  override id = 'claude-internal';
  override displayName = 'Claude Internal';
  override configDir = path.join(os.homedir(), '.claude-internal');
}
