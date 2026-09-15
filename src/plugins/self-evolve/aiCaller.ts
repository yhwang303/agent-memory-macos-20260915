/**
 * AI calling helper for Self-Evolve plugin.
 * Reuses Agent-Mem's same env-var based configuration (SDKAgent pattern).
 */

import { spawn } from 'child_process';
import { logger } from '../../utils/logger.js';

function getAiConfig(overrideModel?: string) {
  const provider = process.env.CODEBUDDY_MEM_PROVIDER === 'claude-code' ? 'claude-code' : 'api';
  const apiKey = process.env.TIMIAI_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
  const endpoint = process.env.CODEBUDDY_MEM_API_ENDPOINT || 'http://api.timiai.woa.com/ai_api_manage/llmproxy/chat/completions';
  const model = overrideModel || process.env.CODEBUDDY_MEM_MODEL || 'gpt-5.4';
  const claudePath = process.env.CODEBUDDY_MEM_CLAUDE_CODE_PATH || 'claude';
  return { provider, apiKey, endpoint, model, claudePath };
}

export async function callEvolveAI(prompt: string, overrideModel?: string): Promise<string> {
  const cfg = getAiConfig(overrideModel);

  if (cfg.provider === 'claude-code') {
    return callClaudeCli(prompt, cfg.claudePath);
  }
  return callApi(prompt, cfg);
}

async function callApi(prompt: string, cfg: ReturnType<typeof getAiConfig>): Promise<string> {
  if (!cfg.apiKey) {
    logger.error('SELF_EVOLVE_AI', 'No API key configured');
    return '';
  }
  const isTimiai = cfg.endpoint.includes('timiai.woa.com');
  const authHeader = isTimiai ? cfg.apiKey : `Bearer ${cfg.apiKey}`;
  const isGpt5 = cfg.model.toLowerCase().startsWith('gpt-5');
  const maxTokens = isGpt5 ? 8000 : 4000;

  try {
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        ...(!isGpt5 && { temperature: 0.3 }),
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error('SELF_EVOLVE_AI', `API error ${res.status}`, { body: body.slice(0, 300) });
      return '';
    }
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? '';
  } catch (err) {
    logger.error('SELF_EVOLVE_AI', 'API call failed', {}, err as Error);
    return '';
  }
}

function callClaudeCli(prompt: string, claudePath: string): Promise<string> {
  return new Promise((resolve) => {
    const args = ['--print', '--dangerously-skip-permissions', '--output-format', 'text'];
    const child = spawn(claudePath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      windowsHide: true,
      env: { ...process.env },
    });

    const out: string[] = [];
    child.stdout?.on('data', (c: Buffer) => out.push(c.toString()));
    child.stderr?.on('data', (c: Buffer) => logger.debug('SELF_EVOLVE_AI', c.toString().trimEnd()));
    child.on('close', () => resolve(out.join('')));
    child.on('error', (err: Error) => {
      logger.error('SELF_EVOLVE_AI', 'Failed to spawn claude CLI', {}, err);
      resolve('');
    });
    child.stdin?.write(prompt, 'utf8');
    child.stdin?.end();
  });
}

export function parseJsonResponse<T>(raw: string): T | null {
  const candidates = [raw.trim()];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const braceMatch = raw.match(/\{[\s\S]*\}/);
  if (braceMatch) candidates.push(braceMatch[0]);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch { /* try next */ }
  }
  return null;
}
