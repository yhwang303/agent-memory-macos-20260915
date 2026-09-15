/**
 * T6 — Worker Chroma init wiring: narrow coverage of the graceful-degrade path.
 *
 * Broader init paths (uv missing / sidecar fails to start / ensureCollection
 * throws) are exercised end-to-end in T15's integration scaffold; here we
 * only verify that `rag.enabled=false` short-circuits cleanly and leaves
 * the worker in SQLite-only mode with `getChromaSync()` returning null.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerService } from '../../src/services/worker/WorkerService.js';
import type { AgentMemorySettings } from '../../src/config/settings.js';

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

test('initChroma no-ops when rag.enabled=false', async () => {
  const worker = new WorkerService({
    port: 0,
    host: '127.0.0.1',
    loadSettings: disabledSettings,
  });

  // Drive the private init directly — cheaper than starting the HTTP server.
  await (worker as any).initChroma();

  assert.equal(worker.getChromaSync(), null,
    'getChromaSync() must stay null when RAG is disabled');
  assert.equal((worker as any).chromaProcess, null,
    'no ChromaProcessManager should be constructed when RAG is disabled');
  assert.equal((worker as any).chromaMcp, null,
    'no ChromaMcpManager should be constructed when RAG is disabled');
});

test('getChromaSync() returns null before initChroma has run', async () => {
  const worker = new WorkerService({
    port: 0,
    host: '127.0.0.1',
    loadSettings: disabledSettings,
  });
  assert.equal(worker.getChromaSync(), null);
});
