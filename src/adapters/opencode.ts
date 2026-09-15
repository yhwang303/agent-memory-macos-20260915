import path from 'path';
import os from 'os';
import { IDEAdapter } from './types.js';
import { logger } from '../utils/logger.js';
import { coalesceTranscriptPath } from './utils.js';

const EVENT_MAP: Record<string, string> = {
  'UserPromptSubmit': 'beforeSubmitPrompt',
  'SessionStart': 'sessionStart',
  'SessionEnd': 'sessionEnd',
  'PreToolUse': 'beforeShellExecution',
  'PostToolUse': 'afterToolUse',
  'Stop': 'stop',
};

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout: number }>;
}

const HOOKS_EVENTS: Array<{ ideEvent: string; timeout: number; matcher?: string }> = [
  { ideEvent: 'UserPromptSubmit', timeout: 10000 },
  { ideEvent: 'SessionStart', timeout: 15000 },
  { ideEvent: 'PostToolUse', timeout: 10000 },
  { ideEvent: 'PreToolUse', timeout: 10000, matcher: 'Bash' },
  { ideEvent: 'Stop', timeout: 30000 },
  { ideEvent: 'SessionEnd', timeout: 10000 },
];

export class OpenCodeAdapter implements IDEAdapter {
  id = 'opencode';
  displayName = 'OpenCode';
  configDir = path.join(os.homedir(), '.opencode');
  hooksConfigFile = 'settings.json';
  mcpConfigFile = 'settings.json';
  projectDirEnvVar = 'OPENCODE_PROJECT_DIR';

  mapEventName(ideEventName: string): string | null {
    return EVENT_MAP[ideEventName] ?? null;
  }

  normalizeInput(internalEventName: string, rawInput: any): any {
    if (internalEventName === 'stop') {
      return coalesceTranscriptPath(rawInput, 'OpenCodeAdapter', internalEventName);
    }

    if (internalEventName !== 'afterToolUse') {
      return rawInput;
    }

    const input = rawInput ?? {};
    const toolName: string = input.tool_name ?? input.tool ?? '';
    const normalizedToolName = String(toolName).toLowerCase();
    const ti = (input.tool_input && typeof input.tool_input === 'object')
      ? input.tool_input as Record<string, unknown>
      : {};

    if (
      normalizedToolName === 'bash' ||
      input.command !== undefined ||
      ti.command !== undefined ||
      input.exit_code !== undefined
    ) {
      return { ...input, _routeTo: 'afterShellExecution' };
    }

    if (
      toolName.startsWith('mcp__') ||
      input.mcp_server !== undefined ||
      ti.serverName !== undefined ||
      ti.server_name !== undefined ||
      ti.mcp_server !== undefined
    ) {
      return { ...input, _routeTo: 'afterMCPExecution' };
    }

    if (
      normalizedToolName === 'write' || normalizedToolName === 'edit' ||
      normalizedToolName === 'multiedit' ||
      normalizedToolName === 'filewrite' || normalizedToolName === 'fileedit' ||
      normalizedToolName === 'notebookedit' || input.file_path !== undefined
    ) {
      return { ...input, _routeTo: 'afterFileEdit' };
    }

    logger.warn('OpenCodeAdapter',
      'PostToolUse sub-type unknown, defaulting to afterShellExecution.',
      { toolName, inputKeys: Object.keys(input) },
    );
    return { ...input, _routeTo: 'afterShellExecution' };
  }

  generateHooksConfig(hooksCliPath: string, platform: NodeJS.Platform): object {
    const hooks: Record<string, HookEntry[]> = {};

    for (const { ideEvent, timeout, matcher } of HOOKS_EVENTS) {
      const cmd = platform === 'win32'
        ? `cmd.exe /c chcp 65001 >nul & set "AGENTMEM_IDE=${this.id}" && node "${hooksCliPath}" ${ideEvent}`
        : `AGENTMEM_IDE=${this.id} node "${hooksCliPath}" ${ideEvent}`;

      const entry: HookEntry = {
        matcher: matcher ?? '',
        hooks: [{ type: 'command', command: cmd, timeout }],
      };

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
