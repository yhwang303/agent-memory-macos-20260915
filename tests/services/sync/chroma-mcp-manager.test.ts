import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';

function makeMockStdio() {
  const stdoutEmitter = new EventEmitter() as any;
  stdoutEmitter.on = stdoutEmitter.on.bind(stdoutEmitter);

  const stdin = new Writable({
    write(chunk, _enc, cb) {
      const text = chunk.toString('utf8');
      const lines = text.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const req = JSON.parse(line);
          setImmediate(() => {
            const resp = JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              result: req.method === 'tools/call'
                ? { content: [{ type: 'text', text: JSON.stringify({ ids: [1, 2], distances: [0.1, 0.2], metadatas: [{}, {}] }) }] }
                : {}
            }) + '\n';
            stdoutEmitter.emit('data', Buffer.from(resp, 'utf8'));
          });
        } catch {}
      }
      cb();
    }
  });

  return { stdin: stdin as any, stdout: stdoutEmitter as any };
}

test('ChromaMcpManager connects and sends initialize', async () => {
  const mgr = new ChromaMcpManager();
  const mock = makeMockStdio();
  await mgr.connect(mock);
  assert.equal(mgr.isConnected(), true);
  await mgr.close();
});

test('ChromaMcpManager.query returns parsed result', async () => {
  const mgr = new ChromaMcpManager();
  const mock = makeMockStdio();
  await mgr.connect(mock);
  const result = await mgr.query('observations', 'typeerror screenshot', 5);
  assert.ok(Array.isArray(result.ids));
  assert.equal(result.ids.length, 2);
  await mgr.close();
});

test('ChromaMcpManager rejects when not connected', async () => {
  const mgr = new ChromaMcpManager();
  await assert.rejects(() => mgr.query('x', 'y', 5), /not connected/i);
});

test('ChromaMcpManager.close is idempotent', async () => {
  const mgr = new ChromaMcpManager();
  await mgr.close();
  await mgr.close();
});

test('ChromaMcpManager disconnects when stdout closes', async () => {
  const mgr = new ChromaMcpManager();
  const mock = makeMockStdio();
  await mgr.connect(mock);
  assert.equal(mgr.isConnected(), true);
  (mock.stdout as any).emit('close');
  assert.equal(mgr.isConnected(), false);
  await assert.rejects(() => mgr.query('obs', 'q', 5), /not connected|closed|transport/i);
});

test('ChromaMcpManager rejects in-flight requests fast when stdout closes', async () => {
  const mgr = new ChromaMcpManager();
  const stdoutEmitter = new EventEmitter() as any;
  const stdinWithHandshake = new Writable({
    write(chunk, _enc, cb) {
      const text = chunk.toString('utf8');
      const lines = text.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.method === 'initialize') {
            setImmediate(() => {
              stdoutEmitter.emit(
                'data',
                Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n', 'utf8')
              );
            });
          }
          // tools/call: deliberately never respond so the request stays pending.
        } catch {
          /* ignore */
        }
      }
      cb();
    }
  });

  await mgr.connect({ stdin: stdinWithHandshake as any, stdout: stdoutEmitter as any });
  assert.equal(mgr.isConnected(), true);
  const pending = mgr.query('obs', 'q', 5);
  // Give callTool a tick to enqueue the tools/call request, then close stdout.
  setImmediate(() => stdoutEmitter.emit('close'));
  await assert.rejects(pending, /closed|transport|disconnect/i);
  assert.equal(mgr.isConnected(), false);
});

test('ChromaMcpManager disconnects when stdout errors', async () => {
  const mgr = new ChromaMcpManager();
  const mock = makeMockStdio();
  await mgr.connect(mock);
  (mock.stdout as any).emit('error', new Error('pipe broken'));
  assert.equal(mgr.isConnected(), false);
});
