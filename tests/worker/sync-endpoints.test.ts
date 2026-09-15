/**
 * T13 — Worker /api/chroma/status and /api/chroma/reindex endpoints.
 *
 * NOTE: Renamed from /api/sync/* during the master <- feat/claude-mem-integration
 * merge to avoid clashing with master's pre-existing /api/sync/* (remote sync
 * queue) routes. Handler methods are now handleChromaStatus / handleChromaReindex.
 *
 * Narrow coverage: exercises handlers directly with mock req/res (same style
 * as worker-search-handler.test.ts). Full HTTP roundtrip is deferred to T15.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WorkerService } from '../../src/services/worker/WorkerService.js';
import type { AgentMemorySettings } from '../../src/config/settings.js';
import { getDatabase } from '../../src/services/sqlite/Database.js';

function disabledSettings(): AgentMemorySettings {
  return {
    rag: {
      enabled: false,
      embedding_model: 'bge-m3',
      fallback_mode: 'sqlite-only',
      hybrid_weights: { sqlite: 0.4, chroma: 0.6 },
      rrf_k: 60,
    },
  };
}

function makeReq(): any {
  const emitter = new EventEmitter() as any;
  emitter.method = 'GET';
  emitter.headers = {};
  return emitter;
}

function makeRes(): { res: any; captured: { status?: number; body?: string; headers: Record<string, string> } } {
  const captured: { status?: number; body?: string; headers: Record<string, string> } = { headers: {} };
  const res: any = {
    set statusCode(v: number) { captured.status = v; },
    get statusCode() { return captured.status ?? 200; },
    end(data?: string) { captured.body = data; },
    setHeader(k: string, v: string) { captured.headers[k] = v; },
    writeHead(status: number) { captured.status = status; },
  };
  return { res, captured };
}

test('GET /api/chroma/status returns zeros when chromaSync null and table empty', async () => {
  const worker = new WorkerService({
    port: 0,
    host: '127.0.0.1',
    loadSettings: disabledSettings,
  });

  // Ensure a clean sync-state table so counts are deterministic.
  const db = getDatabase();
  db.exec('DELETE FROM chroma_sync_state');

  const req = makeReq();
  const { res, captured } = makeRes();
  await (worker as any).handleChromaStatus(req, res);

  assert.equal(captured.status, 200);
  const body = JSON.parse(captured.body!);
  assert.equal(body.chromaAvailable, false);
  assert.equal(body.pending, 0);
  assert.equal(body.synced, 0);
  assert.equal(body.failed, 0);
  assert.equal(body.total, 0);
});

test('POST /api/chroma/reindex returns 503 when chromaSync is null', async () => {
  const worker = new WorkerService({
    port: 0,
    host: '127.0.0.1',
    loadSettings: disabledSettings,
  });

  // sanity: chromaSync is null by default until initChroma succeeds
  assert.equal(worker.getChromaSync(), null);

  const req = makeReq();
  (req as any).method = 'POST';
  const { res, captured } = makeRes();
  await (worker as any).handleChromaReindex(req, res);

  assert.equal(captured.status, 503);
  const body = JSON.parse(captured.body!);
  assert.equal(body.success, false);
  assert.match(body.error, /Chroma not available/);
});
