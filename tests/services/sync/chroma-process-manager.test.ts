import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChromaProcessManager, detectUv } from '../../../src/services/sync/ChromaProcessManager.js';

test('detectUv returns boolean (smoke)', async () => {
  const ok = await detectUv();
  assert.equal(typeof ok, 'boolean');
});

test('ChromaProcessManager.start short-circuits when uv missing', async () => {
  const mgr = new ChromaProcessManager({
    dataDir: '/tmp/does-not-matter',
    embeddingModel: 'bge-m3',
    detectUv: async () => false,
  });
  const result = await mgr.start();
  assert.equal(result.started, false);
  assert.match(result.reason || '', /uv/i);
});

test('ChromaProcessManager builds correct uvx argv', () => {
  const mgr = new ChromaProcessManager({
    dataDir: '/tmp/chroma-data',
    embeddingModel: 'bge-m3',
    modelCacheDir: '/tmp/models',
  });
  const args = mgr.buildArgv();
  assert.equal(args[0], 'chroma-mcp');
  assert.ok(args.includes('--client-type'));
  assert.ok(args.includes('persistent'));
  assert.ok(args.includes('--data-dir'));
  assert.ok(args.includes('/tmp/chroma-data'));
  assert.ok(args.includes('--embedding-function'));
  assert.ok(args.includes('bge-m3'));
});

test('ChromaProcessManager.stop is idempotent when not started', async () => {
  const mgr = new ChromaProcessManager({
    dataDir: '/tmp/x',
    embeddingModel: 'bge-m3',
    detectUv: async () => false,
  });
  await mgr.stop();
  await mgr.stop();
});

test('ChromaProcessManager exposes isRunning=false before start', () => {
  const mgr = new ChromaProcessManager({
    dataDir: '/tmp/x',
    embeddingModel: 'bge-m3',
  });
  assert.equal(mgr.isRunning(), false);
});
