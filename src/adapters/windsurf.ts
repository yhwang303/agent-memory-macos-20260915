import path from 'path';
import os from 'os';
import { IDEAdapter } from './types.js';

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
  { event: 'stop', timeout: 30 },
];

export class WindsurfAdapter implements IDEAdapter {
  id = 'windsurf';
  displayName = 'Windsurf';
  configDir = path.join(os.homedir(), '.windsurf');
  hooksConfigFile = 'hooks.json';
  mcpConfigFile = 'mcp.json';
  projectDirEnvVar = 'WINDSURF_PROJECT_DIR';

  mapEventName(ideEventName: string): string | null {
    return SUPPORTED_EVENTS.has(ideEventName) ? ideEventName : null;
  }

  normalizeInput(_internalEventName: string, rawInput: any): any {
    return rawInput;
  }

  generateHooksConfig(hooksCliPath: string, platform: NodeJS.Platform): object {
    const hooks: Record<string, Array<{ command: string; timeout: number }>> = {};

    for (const { event, timeout } of HOOKS_EVENTS) {
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
