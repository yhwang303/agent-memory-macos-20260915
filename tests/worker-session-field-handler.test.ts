import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WorkerService } from '../src/services/worker/WorkerService.js';

// Construct a minimal mock IncomingMessage that emits the body as a stream.
function makeReq(body: string): any {
  const emitter = new EventEmitter() as any;
  emitter.method = 'POST';
  emitter.headers = { 'content-type': 'application/json' };
  setImmediate(() => {
    if (body) emitter.emit('data', Buffer.from(body, 'utf8'));
    emitter.emit('end');
  });
  return emitter;
}

function makeRes(): { res: any; captured: { status?: number; body?: string } } {
  const captured: { status?: number; body?: string } = {};
  const res: any = {
    set statusCode(v: number) { captured.status = v; },
    get statusCode() { return captured.status ?? 200; },
    end(data?: string) { captured.body = data; },
    setHeader() {},
    writeHead(status: number) { captured.status = status; },
  };
  return { res, captured };
}

// Helper: reach into the WorkerService private handler via `as any`.
async function invokeHandler(service: WorkerService, body: string) {
  const req = makeReq(body);
  const { res, captured } = makeRes();
  await (service as any).handleSessionField(req, res);
  return captured;
}

test('handleSessionField returns 400 when sessionId missing', async () => {
  const service = new WorkerService({ port: 0, host: '127.0.0.1' });
  const out = await invokeHandler(service, JSON.stringify({ field: 'last_assistant_message', value: 'x' }));
  assert.equal(out.status, 400);
  const parsed = JSON.parse(out.body!);
  assert.equal(parsed.success, false);
  assert.match(parsed.error, /sessionId/);
});

test('handleSessionField returns 400 when field missing', async () => {
  const service = new WorkerService({ port: 0, host: '127.0.0.1' });
  const out = await invokeHandler(service, JSON.stringify({ sessionId: 's1', value: 'x' }));
  assert.equal(out.status, 400);
});

test('handleSessionField returns 400 for disallowed field', async () => {
  const service = new WorkerService({ port: 0, host: '127.0.0.1' });
  const out = await invokeHandler(service, JSON.stringify({
    sessionId: 's1', field: 'status', value: 'danger',
  }));
  assert.equal(out.status, 400);
  const parsed = JSON.parse(out.body!);
  assert.match(parsed.error, /disallowed field/);
});

test('handleSessionField returns 200 for allowed field (no-op on missing session)', async () => {
  const service = new WorkerService({ port: 0, host: '127.0.0.1' });
  // Session doesn't exist; UPDATE affects 0 rows but endpoint still returns success.
  const out = await invokeHandler(service, JSON.stringify({
    sessionId: 'nonexistent-session-' + Date.now(), field: 'last_assistant_message', value: 'hello',
  }));
  assert.equal(out.status, 200);
  const parsed = JSON.parse(out.body!);
  assert.equal(parsed.success, true);
});
