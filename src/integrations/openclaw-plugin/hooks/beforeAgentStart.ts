import type { OpenClawPluginConfig } from '../config.js';

export async function beforeAgentStart(
  baseUrl: string,
  config: OpenClawPluginConfig,
  ctx: { session_id?: string; agent_id?: string; [key: string]: any }
): Promise<void> {
  const sessionId = ctx.session_id || `openclaw-${Date.now()}`;
  try {
    await fetch(`${baseUrl}/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        project: config.project,
        metadata: { agent_id: ctx.agent_id, source: 'openclaw' },
      }),
    });
  } catch {
    // Worker unreachable — non-blocking
  }
}
