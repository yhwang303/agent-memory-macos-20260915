/**
 * Thin HTTP client for AgentMemory Worker.
 * Intentionally minimal — only the endpoints our 9 tools need.
 */
import { request } from 'undici';
import { logger } from './logger.js';

export interface AgentMemoryClientOpts {
  baseUrl: string;
  timeoutMs?: number;
}

export interface RawResponse {
  ok: boolean;
  status: number;
  bodyText: string;
  json: unknown;
}

export class AgentMemoryClient {
  constructor(private opts: AgentMemoryClientOpts) {}

  /** GET helper */
  async get(path: string, params?: Record<string, unknown>): Promise<RawResponse> {
    const url = this.buildUrl(path, params);
    return this.send('GET', url);
  }

  /** POST JSON helper */
  async postJson(path: string, body: unknown): Promise<RawResponse> {
    const url = this.buildUrl(path);
    return this.send('POST', url, body);
  }

  async health(): Promise<{ ok: boolean; status: number; data: unknown }> {
    const r = await this.get('/health');
    return { ok: r.ok, status: r.status, data: r.json };
  }

  private buildUrl(path: string, params?: Record<string, unknown>): string {
    const url = new URL(path.startsWith('/') ? path : '/' + path, this.opts.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) {
          // AgentMemory convention: comma-joined string for array params (e.g. obs_type)
          url.searchParams.set(k, v.map(String).join(','));
        } else if (typeof v === 'object') {
          url.searchParams.set(k, JSON.stringify(v));
        } else {
          url.searchParams.set(k, String(v));
        }
      }
    }
    return url.toString();
  }

  private async send(method: 'GET' | 'POST', url: string, body?: unknown): Promise<RawResponse> {
    const headers: Record<string, string> = { 'accept': 'application/json' };
    let bodyStr: string | undefined;
    if (body !== undefined) {
      bodyStr = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }

    logger.debug('agentMemory-http >', { method, url });
    const res = await request(url, {
      method,
      headers,
      body: bodyStr,
      bodyTimeout: this.opts.timeoutMs ?? 30000,
      headersTimeout: this.opts.timeoutMs ?? 30000,
    });
    const status = res.statusCode;
    const bodyText = await res.body.text();
    let json: unknown = null;
    try {
      json = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      json = { _rawText: bodyText };
    }
    logger.debug('agentMemory-http <', { method, url, status, bytes: bodyText.length });
    return {
      ok: status >= 200 && status < 300,
      status,
      bodyText,
      json,
    };
  }
}
