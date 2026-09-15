import path from 'path';
import os from 'os';
import { IDEAdapter } from './types.js';
import { coalesceTranscriptPath } from './utils.js';

const SUPPORTED_EVENTS = new Set([
  'beforeShellExecution',
  'beforeMCPExecution',
  'beforeSubmitPrompt',
  'afterShellExecution',
  'afterMCPExecution',
  'afterSearchReplaceFileEdit',
  'afterFileEdit',
  'afterAgentResponse',
  'afterAgentThought',
  'sessionStart',
  'sessionEnd',
  'stop',
]);

const HOOKS_EVENTS: Array<{ event: string; timeout: number }> = [
  { event: 'beforeSubmitPrompt', timeout: 10 },
  { event: 'afterShellExecution', timeout: 10 },
  { event: 'afterMCPExecution', timeout: 10 },
  { event: 'afterFileEdit', timeout: 10 },
  { event: 'afterAgentResponse', timeout: 10 },
  { event: 'afterAgentThought', timeout: 10 },
  { event: 'stop', timeout: 30 },
];

export class CursorAdapter implements IDEAdapter {
  id = 'cursor';
  displayName = 'Cursor';
  configDir = path.join(os.homedir(), '.cursor');
  hooksConfigFile = 'hooks.json';
  mcpConfigFile = 'mcp.json';
  projectDirEnvVar = 'CURSOR_PROJECT_DIR';

  mapEventName(ideEventName: string): string | null {
    return SUPPORTED_EVENTS.has(ideEventName) ? ideEventName : null;
  }

  normalizeInput(internalEventName: string, rawInput: any): any {
    if (internalEventName === 'stop') {
      return coalesceTranscriptPath(rawInput, 'CursorAdapter', internalEventName);
    }
    return rawInput;
  }

  generateHooksConfig(hooksCliPath: string, platform: NodeJS.Platform): object {
    const hooks: Record<string, Array<{ command: string; timeout: number }>> = {};

    for (const { event, timeout } of HOOKS_EVENTS) {
      // 注入 AGENTMEM_IDE=cursor 让 hooks-cli 不必再靠 conversation_id /
      // cursor_version 等启发式与 codebuddy(Gongfeng) 区分 —— 两者 SUPPORTED_EVENTS 完全相同。
      const cmd = platform === 'win32'
        ? `cmd.exe /c chcp 65001 >nul & set "AGENTMEM_IDE=${this.id}" && node "${hooksCliPath}" ${event}`
        : `AGENTMEM_IDE=${this.id} node "${hooksCliPath}" ${event}`;

      hooks[event] = [{ command: cmd, timeout }];
    }

    return { version: 1, hooks };
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
