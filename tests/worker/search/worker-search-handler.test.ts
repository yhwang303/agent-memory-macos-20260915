import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { URL } from 'node:url';
import { WorkerService } from '../../../src/services/worker/WorkerService.js';

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

async function invokeSearch(service: WorkerService, searchParams: Record<string, string>): Promise<any> {
  const url = new URL('http://localhost/api/search?' + new URLSearchParams(searchParams).toString());
  const req = makeReq();
  const { res, captured } = makeRes();
  await (service as any).handleSearch(req, res, url);
  return { status: captured.status, body: captured.body ? JSON.parse(captured.body) : null };
}

test('handleSearch returns 400 when query missing', async () => {
  const service = new WorkerService({ port: 0, host: '127.0.0.1' });
  // Force orchestrator init without calling start()
  const { SQLiteSearchStrategy } = await import('../../../src/services/worker/search/SQLiteSearchStrategy.js');
  const { SearchOrchestrator } = await import('../../../src/services/worker/search/SearchOrchestrator.js');
  (service as any).searchOrchestrator = new SearchOrchestrator({
    sqlite: new SQLiteSearchStrategy(),
    chroma: null,
    hybrid: null,
  });
  const r = await invokeSearch(service, {});
  assert.equal(r.status, 400);
});

test('handleSearch returns 503 when orchestrator not initialized', async () => {
  const service = new WorkerService({ port: 0, host: '127.0.0.1' });
  (service as any).searchOrchestrator = null;
  const r = await invokeSearch(service, { query: 'x' });
  assert.equal(r.status, 503);
});

test('handleSearch defaults to hybrid mode (falls back to sqlite when chroma null)', async () => {
  const service = new WorkerService({ port: 0, host: '127.0.0.1' });
  const { SQLiteSearchStrategy } = await import('../../../src/services/worker/search/SQLiteSearchStrategy.js');
  const { SearchOrchestrator } = await import('../../../src/services/worker/search/SearchOrchestrator.js');
  (service as any).searchOrchestrator = new SearchOrchestrator({
    sqlite: new SQLiteSearchStrategy(),
    chroma: null,
    hybrid: null,
  });
  const r = await invokeSearch(service, { query: 'a', limit: '5' });
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  // mode will reflect what the orchestrator returned — sqlite because chroma unavailable
  assert.equal(r.body.mode, 'sqlite');
  assert.equal(r.body.fellBack, true);
  // Backward-compat fields present
  assert.ok(Array.isArray(r.body.results));
  assert.ok(typeof r.body.count === 'number');
  assert.ok(Array.isArray(r.body.observations));
  assert.ok(Array.isArray(r.body.summaries));
});

test('handleSearch accepts mode=sqlite explicitly', async () => {
  const service = new WorkerService({ port: 0, host: '127.0.0.1' });
  const { SQLiteSearchStrategy } = await import('../../../src/services/worker/search/SQLiteSearchStrategy.js');
  const { SearchOrchestrator } = await import('../../../src/services/worker/search/SearchOrchestrator.js');
  (service as any).searchOrchestrator = new SearchOrchestrator({
    sqlite: new SQLiteSearchStrategy(),
    chroma: null,
    hybrid: null,
  });
  const r = await invokeSearch(service, { query: 'a', mode: 'sqlite' });
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'sqlite');
  assert.equal(r.body.fellBack, false);
});
