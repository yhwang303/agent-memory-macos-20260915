import type { OpenClawPluginConfig } from '../config.js';

interface ToolResultEvent {
  session_id?: string;
  sessionId?: string;
  tool_name?: string;
  toolName?: string;
  name?: string;
  result?: string;
  output?: unknown;
  input?: unknown;
  args?: unknown;
  [key: string]: any;
}

interface ToolResultCtx {
  sessionId?: string;
  [key: string]: any;
}

/**
 * `tool_result_persist` 是 OpenClaw 标记的 **sync** hook：handler 必须返回
 * `void`（或 `PluginHookToolResultPersistResult`），不能返回 Promise。
 *
 * 我们在内部 fire-and-forget 触发 worker 写入，再把异常吞掉，保证：
 *   1. OpenClaw 不会再出现 `returned a Promise; result was ignored` 警告
 *   2. worker 不可达时不阻塞 OpenClaw 主流程
 */
export function toolResultPersist(
  baseUrl: string,
  config: OpenClawPluginConfig,
  event: ToolResultEvent,
  ctx: ToolResultCtx = {}
): void {
  const toolName = event?.toolName || event?.tool_name || event?.name || 'tool';
  if ((config.syncMemoryFileExclude || []).includes(toolName)) return;

  const sessionId =
    event?.sessionId || event?.session_id || ctx?.sessionId || 'openclaw-unknown';
  const output = event?.result ?? event?.output ?? event ?? '';
  const text = typeof output === 'string' ? output : safeStringify(output);

  void fetch(`${baseUrl}/api/observation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      toolName,
      toolInput: event?.input ?? event?.args ?? {},
      toolOutput: text.slice(0, 2000),
      observationType: 'tool_output',
      sourceIDE: 'openclaw',
    }),
  }).catch(() => {
    // Worker unreachable — non-blocking
  });
}

function safeStringify(value: unknown): string {
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
