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

const HOOKS_EVENTS = [
  'beforeSubmitPrompt',
  'afterShellExecution',
  'afterMCPExecution',
  'afterFileEdit',
  'stop',
];

export class CodeBuddyAdapter implements IDEAdapter {
  id = 'codebuddy';
  displayName = 'CodeBuddy';
  configDir = path.join(os.homedir(), '.gongfeng-copilot');
  hooksConfigFile = path.join('hooks', 'hooks.json');
  mcpConfigFile = 'mcp.json';
  projectDirEnvVar = 'CODEBUDDY_PROJECT_DIR';

  mapEventName(ideEventName: string): string | null {
    return SUPPORTED_EVENTS.has(ideEventName) ? ideEventName : null;
  }

  normalizeInput(_internalEventName: string, rawInput: any): any {
    return rawInput;
  }

  generateHooksConfig(hooksCliPath: string, platform: NodeJS.Platform): object {
    const hooks: Record<string, string> = {};

    for (const event of HOOKS_EVENTS) {
      // 注入 AGENTMEM_IDE=codebuddy 让 hooks-cli 一眼区分自己 vs cursor
      // (两者 SUPPORTED_EVENTS 完全相同;cursor 在 registry 中靠前会先匹配)。
      hooks[event] = platform === 'win32'
        ? `cmd.exe /c chcp 65001 >nul & set "AGENTMEM_IDE=${this.id}" && node "${hooksCliPath}" ${event}`
        : `AGENTMEM_IDE=${this.id} node "${hooksCliPath}" ${event}`;
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
