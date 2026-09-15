import type { OpenClawPluginConfig } from '../config.js';

export async function beforePromptBuild(
  getContext: () => Promise<string>,
  _config: OpenClawPluginConfig,
  ctx: { systemPrompt?: string; [key: string]: any }
): Promise<{ systemPrompt?: string }> {
  try {
    const context = await getContext();
    if (context && ctx.systemPrompt) {
      return { systemPrompt: `${ctx.systemPrompt}\n\n${context}` };
    }
  } catch {
    // Non-blocking
  }
  return {};
}
