import { test } from 'node:test';
import assert from 'node:assert/strict';

test('WorkerClient.updateSessionField POSTs correct shape', async () => {
  const calls: Array<{ url: string; init: any }> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as any;

  try {
    const { WorkerClient } = await import('../src/services/worker/client.js');
    const client = new WorkerClient('http://localhost:65535');
    await client.updateSessionField('s1', 'last_assistant_message', 'hello');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://localhost:65535/api/session/field');
    assert.equal(calls[0].init.method, 'POST');
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body, { sessionId: 's1', field: 'last_assistant_message', value: 'hello' });
  } finally {
    globalThis.fetch = orig;
  }
});

test('WorkerClient.updateSessionField is graceful on network error', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('network down'); }) as any;
  try {
    const { WorkerClient } = await import('../src/services/worker/client.js');
    const client = new WorkerClient('http://localhost:65535');
    await client.updateSessionField('s1', 'last_assistant_message', 'hello');
    assert.ok(true);
  } finally {
    globalThis.fetch = orig;
  }
});
