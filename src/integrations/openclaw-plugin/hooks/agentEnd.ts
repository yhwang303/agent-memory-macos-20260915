import type { OpenClawPluginConfig } from '../config.js';

interface AgentEndEvent {
  session_id?: string;
  sessionId?: string;
  response?: unknown;
  output?: unknown;
  message?: unknown;
  messages?: unknown;
  [key: string]: any;
}

interface AgentEndCtx {
  sessionId?: string;
  sessionKey?: string;
  session_id?: string;
  [key: string]: any;
}

function pickSessionId(event: AgentEndEvent, ctx: AgentEndCtx): string | undefined {
  return (
    event?.session_id ||
    event?.sessionId ||
    ctx?.sessionId ||
    ctx?.session_id ||
    ctx?.sessionKey
  );
}

function safeStringify(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * `agent_end` hook：把 agent 最终响应写一条 `agent_response` observation，
 * 然后调用 `/api/session/end` 让 worker 走 `generateSummary` 自动总结
 * 并把 session 翻成 `completed`（含 `completed_at`）。
 *
 * 历史问题：早期版本调用 `/api/summary`（手动提交端点，需要 body 带
 * `summary` 对象）+ `/api/session/complete`，两条都被 worker 400 拒收，
 * 导致 OpenClaw 来源会话从未生成过 LLM summary、status 永远 active。
 * 现在统一走 `/api/session/end`，该端点内部已包含「写 summary + 翻
 * status=completed + 设 completed_at」三件事，原先的两条调用合并成一条。
 */
export async function agentEnd(
  baseUrl: string,
  config: OpenClawPluginConfig,
  event: AgentEndEvent = {},
  ctx: AgentEndCtx = {}
): Promise<void> {
  const sessionId = pickSessionId(event, ctx);
  if (!sessionId) return;

  try {
    const response = safeStringify(
      event?.response ?? event?.output ?? event?.message ?? event?.messages
    );
    if (response) {
      await fetch(`${baseUrl}/api/observation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          toolName: 'openclaw_agent_end',
          toolInput: { source: 'openclaw', project: config.project },
          toolOutput: response.slice(0, 4000),
          observationType: 'agent_response',
          sourceIDE: 'openclaw',
        }),
      });
    }

    await fetch(`${baseUrl}/api/session/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, reason: 'openclaw_agent_end' }),
    });
  } catch {
    // Non-blocking
  }
}
