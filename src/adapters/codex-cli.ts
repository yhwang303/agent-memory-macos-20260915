import path from 'path';
import os from 'os';
import { IDEAdapter } from './types.js';
import { coalesceTranscriptPath } from './utils.js';
import { logger } from '../utils/logger.js';

/** Codex App hook event ids -> internal hooks-cli event names. */
const EVENT_MAP: Record<string, string> = {
  user_prompt_submit: 'beforeSubmitPrompt',
  session_start: 'sessionStart',
  session_end: 'sessionEnd',
  pre_tool_use: 'beforeShellExecution',
  post_tool_use: 'afterToolUse',
  pre_compact: 'beforePreCompact',
  stop: 'stop',
  // Keep PascalCase aliases as a defensive fallback for older/manual payloads.
  UserPromptSubmit: 'beforeSubmitPrompt',
  SessionStart: 'sessionStart',
  SessionEnd: 'sessionEnd',
  PreToolUse: 'beforeShellExecution',
  PostToolUse: 'afterToolUse',
  PreCompact: 'beforePreCompact',
  Stop: 'stop',
};

const TRANSCRIPT_EVENTS = new Set(['stop', 'beforePreCompact']);

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout: number }>;
}

const HOOKS_EVENTS: Array<{ ideEvent: string; timeout: number; matcher?: string }> = [
  { ideEvent: 'UserPromptSubmit', timeout: 10 },
  { ideEvent: 'SessionStart', timeout: 15 },
  { ideEvent: 'PostToolUse', timeout: 10 },
  { ideEvent: 'PreToolUse', timeout: 10 },
  { ideEvent: 'PreCompact', timeout: 30 },
  { ideEvent: 'Stop', timeout: 30 },
  { ideEvent: 'SessionEnd', timeout: 10 },
];

/** True when stdin JSON matches Codex hook payloads. */
export function isCodexHookInput(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  if (typeof o.turn_id !== 'string' || !o.turn_id) return false;
  const name = o.hook_event_name;
  if (typeof name === 'string' && name in EVENT_MAP) return true;
  return typeof o.stop_hook_active === 'boolean';
}

export class CodexCliAdapter implements IDEAdapter {
  id = 'codex-cli';
  displayName = 'Codex App / CLI';
  configDir = path.join(os.homedir(), '.codex');
  hooksConfigFile = 'hooks.json';
  mcpConfigFile = 'mcp.json';
  projectDirEnvVar = 'CODEX_PROJECT_DIR';

  sessionsDir = path.join(os.homedir(), '.codex', 'sessions');

  mapEventName(ideEventName: string): string | null {
    return EVENT_MAP[ideEventName] ?? null;
  }

  normalizeInput(internalEventName: string, rawInput: any): any {
    if (TRANSCRIPT_EVENTS.has(internalEventName)) {
      return coalesceTranscriptPath(rawInput, 'CodexCliAdapter', internalEventName);
    }

    if (internalEventName !== 'afterToolUse') {
      logger.debug('CodexCliAdapter', `normalizeInput pass-through for ${internalEventName}`, {
        inputKeys: rawInput ? Object.keys(rawInput) : [],
      });
      return rawInput;
    }

    const input = rawInput ?? {};
    const inputKeys = Object.keys(input);
    const toolName = String(input.tool_name ?? input.tool ?? input.name ?? '');
    const normalizedToolName = toolName.toLowerCase();
    const ti = (input.tool_input && typeof input.tool_input === 'object')
      ? input.tool_input as Record<string, unknown>
      : {};

    logger.info('CodexCliAdapter', 'PostToolUse received, analyzing input for sub-type routing', {
      inputKeys,
      toolName,
      inputSnapshot: JSON.stringify(input).substring(0, 1000),
    });

    if (
      normalizedToolName === 'bash'
      || normalizedToolName === 'shell'
      || normalizedToolName === 'shell_command'
      || normalizedToolName === 'exec_command'
      || input.command !== undefined
      || ti.command !== undefined
      || ti.cmd !== undefined
      || input.exit_code !== undefined
    ) {
      return { ...input, _routeTo: 'afterShellExecution' };
    }

    if (
      toolName.startsWith('mcp__')
      || normalizedToolName.startsWith('mcp')
      || input.mcp_server !== undefined
      || input.server_name !== undefined
      || ti.serverName !== undefined
      || ti.server_name !== undefined
      || ti.mcp_server !== undefined
    ) {
      return { ...input, _routeTo: 'afterMCPExecution' };
    }

    if (
      normalizedToolName === 'write'
      || normalizedToolName === 'edit'
      || normalizedToolName === 'multiedit'
      || normalizedToolName === 'apply_patch'
      || normalizedToolName === 'filewrite'
      || normalizedToolName === 'fileedit'
      || normalizedToolName === 'notebookedit'
      || input.file_path !== undefined
      || ti.file_path !== undefined
      || ti.filePath !== undefined
    ) {
      return { ...input, _routeTo: 'afterFileEdit' };
    }

    logger.warn('CodexCliAdapter', 'PostToolUse sub-type unknown, defaulting to afterShellExecution.', {
      toolName,
      inputKeys,
      inputFull: JSON.stringify(input).substring(0, 2000),
    });
    return { ...input, _routeTo: 'afterShellExecution' };
  }

  generateHooksConfig(hooksCliPath: string, platform: NodeJS.Platform): object {
    const hooks: Record<string, HookEntry[]> = {};

    for (const { ideEvent, timeout, matcher } of HOOKS_EVENTS) {
      const cmd = platform === 'win32'
        ? `cmd.exe /c chcp 65001 >nul & set "AGENTMEM_IDE=${this.id}" && node "${hooksCliPath}" ${ideEvent}`
        : `AGENTMEM_IDE=${this.id} node "${hooksCliPath}" ${ideEvent}`;

      const entry: HookEntry = {
        hooks: [{ type: 'command', command: cmd, timeout }],
      };
      if (matcher) entry.matcher = matcher;
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
