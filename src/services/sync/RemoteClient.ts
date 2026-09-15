/**
 * HTTP client for communicating with the remote agent-mem-server.
 */

import { logger } from '../../utils/logger.js';

export interface SyncItem {
  client_uuid: string;
  device_id: string;
  source_ide: string;
  payload: Record<string, unknown>;
}

export interface SyncResult {
  success: boolean;
  received: number;
  duplicates: number;
}

const KIND_TO_RESOURCE: Record<string, string> = {
  session: 'sessions',
  observation: 'observations',
  summary: 'summaries',
};

export class RemoteClient {
  private baseUrl: string;
  private token: string;

  constructor(config: { baseUrl: string; token: string }) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.token = config.token;
  }

  async syncBatch(kind: string, items: SyncItem[]): Promise<SyncResult> {
    const resource = KIND_TO_RESOURCE[kind] || `${kind}s`;
    const url = `${this.baseUrl}/api/v1/sync/${resource}`;
    const body = {
      items: items.map(item => ({
        client_uuid: item.client_uuid,
        device_id: item.device_id,
        source_ide: item.source_ide,
        ...item.payload,
      })),
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown');
      throw new Error(`Sync ${kind} failed: ${response.status} - ${errorText}`);
    }

    return await response.json() as SyncResult;
  }

  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch (error) {
      logger.debug('REMOTE_CLIENT', 'Connection test failed', { error: String(error) });
      return false;
    }
  }

  /**
   * Test the configured token by hitting an authenticated endpoint.
   * Returns { ok, status, message, user? }.
   */
  async testAuth(): Promise<{ ok: boolean; status: number; message: string; user?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/whoami`, {
        headers: { 'Authorization': `Bearer ${this.token}` },
        signal: AbortSignal.timeout(8000),
      });
      if (response.status === 401 || response.status === 403) {
        return { ok: false, status: response.status, message: '钥匙不对，服务器拒绝了' };
      }
      if (!response.ok) {
        return { ok: false, status: response.status, message: `服务器返回 ${response.status}` };
      }
      const data = await response.json().catch(() => ({})) as { user?: { name?: string } };
      return { ok: true, status: response.status, message: '连上了', user: data?.user?.name };
    } catch (error) {
      return { ok: false, status: 0, message: `连不上：${String(error).slice(0, 200)}` };
    }
  }

  getBaseUrl(): string { return this.baseUrl; }
}
