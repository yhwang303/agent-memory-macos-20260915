import type { OpenClawPluginConfig } from '../config.js';

interface MessageReceivedEvent {
  session_id?: string;
  sessionId?: string;
  channel?: string;
  from?: string;
  text?: string;
  message?: string;
  content?: string;
  raw?: unknown;
  [key: string]: any;
}

interface MessageReceivedCtx {
  sessionId?: string;
  sessionKey?: string;
  channel?: string;
  [key: string]: any;
}

function pickSessionId(event: MessageReceivedEvent, ctx: MessageReceivedCtx): string {
  return (
    event?.session_id ||
    event?.sessionId ||
    ctx?.sessionId ||
    ctx?.sessionKey ||
    `openclaw-channel-${Date.now()}`
  );
}

function pickText(event: MessageReceivedEvent): string {
  const raw = event?.text ?? event?.message ?? event?.content ?? '';
  return typeof raw === 'string' ? raw.slice(0, 4000) : '';
}

/**
 * 处理 OpenClaw `message_received` hook：把 channel 入站消息写入 agent-memory
 * 作为新 session（如不存在）+ 一条 `channel_inbound` observation。
 */
export async function messageReceived(
  baseUrl: string,
  config: OpenClawPluginConfig,
  event: MessageReceivedEvent,
  ctx: MessageReceivedCtx
): Promise<void> {
  if (config.captureChannel === false) return;

  const sessionId = pickSessionId(event, ctx);
  const text = pickText(event);
  if (!text) return;

  const channel = event?.channel || ctx?.channel || 'unknown';
  const from = event?.from || 'unknown';

  try {
    await fetch(`${baseUrl}/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        project: config.project,
        userPrompt: text,
        sourceIDE: 'openclaw',
        metadata: { source: 'openclaw-channel', channel, from },
      }),
    });
    await fetch(`${baseUrl}/api/observation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        toolName: 'channel_inbound',
        toolInput: { channel, from },
        toolOutput: text,
        observationType: 'channel_inbound',
        sourceIDE: 'openclaw',
      }),
    });
  } catch {
    // Worker unreachable — non-blocking, OpenClaw must keep running.
  }
}
