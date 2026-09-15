/**
 * End-to-end integration scaffold for M2 RAG stack.
 *
 * Uses real chroma-mcp + bge-m3 when `uv` is installed; self-skips otherwise.
 * Full-body test (spawn sidecar → bulkReindex → hybrid query) is deferred
 * until the bge-m3 model is cached locally, since first run downloads ~2 GB.
 *
 * See docs/superpowers/TODO.md M2 section for manual verification steps.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectUv } from '../../src/services/sync/ChromaProcessManager.js';

const hasUv = await detectUv();

if (!hasUv) {
  test('M2 integration skipped — uv not installed', () => {
    assert.ok(true, 'install uv to run M2 integration tests (see docs/superpowers/TODO.md)');
  });
} else {
  test('E2E: chroma-mcp round trip with Chinese observations', async (t) => {
    t.diagnostic('note: first run may take ~2 min for bge-m3 model download');
    t.skip('integration body deferred to manual run; see docs/superpowers/TODO.md M2 section');
  });
}
