import path from 'path';
import os from 'os';
import { IDEAdapter } from './types.js';
import { logger } from '../utils/logger.js';
import { coalesceTranscriptPath } from './utils.js';

const EVENT_MAP: Record<string, string> = {
  'UserPromptSubmit': 'beforeSubmitPrompt',
  'PreToolUse': 'beforeShellExecution',
  'PostToolUse': 'afterToolUse',
  'Stop': 'stop',
  'SessionStart': 'sessionStart',
  'SessionEnd': 'sessionEnd',
};

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout: number }>;
}

const HOOKS_EVENTS: Array<{ ideEvent: string; timeout: number; matcher?: string }> = [
  { ideEvent: 'UserPromptSubmit', timeout: 10000 },
  { ideEvent: 'PostToolUse', timeout: 10000 },
  { ideEvent: 'PreToolUse', timeout: 10000, matcher: 'Bash' },
  { ideEvent: 'Stop', timeout: 30000 },
  { ideEvent: 'SessionStart', timeout: 15000 },
  { ideEvent: 'SessionEnd', timeout: 10000 },
];

export class CodeBuddyIDEAdapter implements IDEAdapter {
  id = 'codebuddy-ide';
  displayName = 'CodeBuddy IDE';
  configDir = path.join(os.homedir(), '.codebuddy');
  hooksConfigFile = 'settings.json';
  mcpConfigFile = 'mcp.json';
  projectDirEnvVar = 'CODEBUDDY_IDE_PROJECT_DIR';

  mapEventName(ideEventName: string): string | null {
    return EVENT_MAP[ideEventName] ?? null;
  }

  normalizeInput(internalEventName: string, rawInput: any): any {
    if (internalEventName === 'stop' || internalEventName === 'beforePreCompact') {
      return coalesceTranscriptPath(rawInput, 'CodeBuddyIDEAdapter', internalEventName);
    }

    if (internalEventName !== 'afterToolUse') {
      logger.debug('CodeBuddyIDEAdapter', `normalizeInput pass-through for ${internalEventName}`, {
        inputKeys: rawInput ? Object.keys(rawInput) : [],
      });
      return rawInput;
    }

    const input = rawInput ?? {};
    const inputKeys = Object.keys(input);
    logger.info('CodeBuddyIDEAdapter', 'PostToolUse received, analyzing input for sub-type routing', {
      inputKeys,
      inputSnapshot: JSON.stringify(input).substring(0, 1000),
    });

    // CodeBuddy IDE 给每条 PostToolUse 都带 tool_name(Bash/Read/Grep/Edit/Write/
    // mcp_call_tool/...),所以不能像 master 那样靠 `input.tool_name !== undefined`
    // 兜底匹配 MCP — 那会把所有事件都丢到 afterMCPExecution 去。
    // 改为按 tool_name 精确分发,字段名兼容 master(snake_case file_path)与
    // codebuddy-ide(camelCase tool_input.filePath / tool_input.command 等嵌套)两套语义。
    const toolName: string = String(input.tool_name ?? input.tool ?? '').toLowerCase();
    const ti = (input.tool_input && typeof input.tool_input === 'object')
      ? (input.tool_input as Record<string, unknown>)
      : {};

    // Bash / shell:tool_name=Bash 或顶层 / 嵌套有 command
    if (
      toolName === 'bash' ||
      input.command !== undefined ||
      (ti as any).command !== undefined ||
      input.exit_code !== undefined
    ) {
      logger.info('CodeBuddyIDEAdapter', 'PostToolUse → afterShellExecution (Bash)', {
        hasTopCommand: input.command !== undefined,
        hasNestedCommand: (ti as any).command !== undefined,
      });
      return { ...input, _routeTo: 'afterShellExecution' };
    }

    // MCP:codebuddy 用统一 tool_name="mcp_call_tool" / "mcp_get_tool_description",
    // claude-style 是 mcp__server__tool。两种都路由到 afterMCPExecution,
    // 真实 server/action 由 hooks-cli 的 handleAfterMCPExecution 从嵌套字段抽。
    if (
      toolName === 'mcp_call_tool' ||
      toolName === 'mcp_get_tool_description' ||
      toolName.startsWith('mcp__') ||
      input.mcp_server !== undefined ||
      (ti as any).serverName !== undefined ||
      (ti as any).server_name !== undefined
    ) {
      logger.info('CodeBuddyIDEAdapter', 'PostToolUse → afterMCPExecution (MCP)', {
        toolName: input.tool_name,
        innerTool: (ti as any).toolName ?? (ti as any).tool_name,
        serverName: (ti as any).serverName ?? (ti as any).server_name ?? input.mcp_server,
      });
      return { ...input, _routeTo: 'afterMCPExecution' };
    }

    // File edit:**只**按 tool_name 显式匹配真正的写类工具,或顶层 file_path
    // (master 风格的 explicit 信号)。
    // 千万不能用 ti.filePath / ti.file_path 兜底 — Read / Grep / Glob 等只读工具
    // 的 tool_input 里也有 filePath(读哪个文件),那样会把所有 Read 都误送到
    // file_edit,handleAfterFileEdit 把 tool_response.content(整个文件内容)当成
    // diff 喂给 classifier,长度足够直接走 tier=2 light → LLM 蒸馏 → "实现 / 重构 /
    // 更新 XXX 模块"幻觉。这是上一版引入的真 bug。
    if (
      toolName === 'edit' || toolName === 'write' ||
      toolName === 'multiedit' ||
      toolName === 'notebookedit' || toolName === 'fileedit' || toolName === 'filewrite' ||
      toolName === 'search_replace' ||
      input.file_path !== undefined
    ) {
      logger.info('CodeBuddyIDEAdapter', 'PostToolUse → afterFileEdit (file edit)', {
        toolName: input.tool_name,
        filePath: input.file_path ?? (ti as any).file_path ?? (ti as any).filePath,
      });
      return { ...input, _routeTo: 'afterFileEdit' };
    }

    // 默认:Read/Grep/Glob 等只读 / 未识别工具走 afterShellExecution,
    // handleAfterShellExecution 在没 command 时由 classifier tier=0 丢弃。
    logger.warn('CodeBuddyIDEAdapter', 'PostToolUse sub-type UNKNOWN, defaulting to afterShellExecution.', {
      toolName: input.tool_name,
      inputKeys,
      inputFull: JSON.stringify(input).substring(0, 2000),
    });
    return { ...input, _routeTo: 'afterShellExecution' };
  }

  generateHooksConfig(hooksCliPath: string, platform: NodeJS.Platform): object {
    const hooks: Record<string, HookEntry[]> = {};

    for (const { ideEvent, timeout, matcher } of HOOKS_EVENTS) {
      // 注入 AGENTMEM_IDE=codebuddy-ide,让 hooks-cli 一眼区分自己 vs claude-code
      // (两者 PascalCase EVENT_MAP 完全一致,detect 逻辑只看事件名会把
      // claude-code 排在前面)。
      const cmd = platform === 'win32'
        ? `cmd.exe /c chcp 65001 >nul & set "AGENTMEM_IDE=${this.id}" && node "${hooksCliPath}" ${ideEvent}`
        : `AGENTMEM_IDE=${this.id} node "${hooksCliPath}" ${ideEvent}`;

      const entry: HookEntry = {
        hooks: [{ type: 'command', command: cmd, timeout }],
      };
      if (matcher) {
        entry.matcher = matcher;
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
