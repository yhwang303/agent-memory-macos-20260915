import type { OpenClawPluginConfig } from '../config.js';

interface MessageSentEvent {
  session_id?: string;
  sessionId?: string;
  channel?: string;
  to?: string;
  text?: string;
  message?: string;
  content?: string;
  raw?: unknown;
  [key: string]: any;
}

interface MessageSentCtx {
  sessionId?: string;
  sessionKey?: string;
  channel?: string;
  [key: string]: any;
}

function pickSessionId(event: MessageSentEvent, ctx: MessageSentCtx): string {
  return (
    event?.session_id ||
    event?.sessionId ||
    ctx?.sessionId ||
    ctx?.sessionKey ||
    `openclaw-channel-${Date.now()}`
  );
}

function pickText(event: MessageSentEvent): string {
  const raw = event?.text ?? event?.message ?? event?.content ?? '';
  return typeof raw === 'string' ? raw.slice(0, 4000) : '';
}

/**
 * 处理 OpenClaw `message_sent` hook：把 channel 出站消息写入一条
 * `channel_outbound` observation。沿用 `message_received` 创建的 session。
 */
export async function messageSent(
  baseUrl: string,
  config: OpenClawPluginConfig,
  event: MessageSentEvent,
  ctx: MessageSentCtx
): Promise<void> {
  if (config.captureChannel === false) return;

  const sessionId = pickSessionId(event, ctx);
  const text = pickText(event);
  if (!text) return;

  const channel = event?.channel || ctx?.channel || 'unknown';
  const to = event?.to || 'unknown';

  try {
    await fetch(`${baseUrl}/api/observation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        toolName: 'channel_outbound',
        toolInput: { channel, to },
        toolOutput: text,
        observationType: 'channel_outbound',
        sourceIDE: 'openclaw',
      }),
    });
  } catch {
    // Worker unreachable — non-blocking, OpenClaw must keep running.
  }
}
