import type { OpenClawPluginConfig } from '../config.js';

export async function gatewayStart(
  baseUrl: string,
  _config: OpenClawPluginConfig
): Promise<void> {
  const maxRetries = 30;
  const interval = 1000;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(`${baseUrl}/api/readiness`);
      if (res.ok) return;
    } catch {
      // not ready
    }
    await new Promise(r => setTimeout(r, interval));
  }
}
