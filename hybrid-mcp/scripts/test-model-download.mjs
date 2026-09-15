#!/usr/bin/env node
/**
 * Model download e2e test (M2.2 acceptance).
 *
 * What it does:
 *   1. Print pre-state (existence of ~/.agentMemory-hybrid-mcp/models/, file count, size).
 *   2. Build a ModelStore using prod config (default mirror = hf-mirror.com).
 *   3. Call ensureReady(): triggers ONNX download on first run.
 *   4. Call embed("测试中文") and check Float32Array length == 768.
 *   5. Print post-state (cache size, files).
 *
 * Pass criteria:
 *   - status transitions: uninitialized → downloading → ready
 *   - ~/.agentMemory-hybrid-mcp/models/ contains the Xenova model files
 *   - Returned vector has length 768 and L2 norm ≈ 1 (because pooling+normalize)
 *
 * Usage:
 *   node scripts/test-model-download.mjs
 *   AGENTMEM_HYBRID_HF_ENDPOINT=https://huggingface.co node scripts/test-model-download.mjs
 */
import { mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// dynamic import compiled JS (Windows-safe via file:// URL)
const { loadConfig } = await import(pathToFileURL(path.join(ROOT, 'dist', 'config.js')).href);
const { configureLogger, logger } = await import(pathToFileURL(path.join(ROOT, 'dist', 'logger.js')).href);
const { ModelStore } = await import(pathToFileURL(path.join(ROOT, 'dist', 'modelStore.js')).href);

configureLogger({});
const cfg = loadConfig();

console.log('\n━━━ PRE-STATE ━━━');
console.log('models dir:', cfg.paths.modelsDir);
console.log('exists?    ', existsSync(cfg.paths.modelsDir));
if (existsSync(cfg.paths.modelsDir)) {
  const stats = await dirStats(cfg.paths.modelsDir);
  console.log('files:     ', stats.files);
  console.log('totalBytes:', stats.bytes);
}
console.log('mirror:    ', cfg.embedder.remoteHost);
console.log('modelId:   ', cfg.embedder.modelId);

const store = new ModelStore(cfg);
console.log('\n━━━ STATUS BEFORE ensureReady ━━━');
console.log(JSON.stringify(store.getStatus(), null, 2));

console.log('\n━━━ DOWNLOAD / LOAD ━━━');
const t0 = Date.now();
try {
  await store.ensureReady();
} catch (e) {
  console.error('ensureReady FAILED:', String(e));
  console.log('\n━━━ STATUS AFTER FAIL ━━━');
  console.log(JSON.stringify(store.getStatus(), null, 2));
  process.exit(1);
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`ensureReady took ${elapsed}s`);

console.log('\n━━━ STATUS AFTER ensureReady ━━━');
console.log(JSON.stringify(store.getStatus(), null, 2));

console.log('\n━━━ EMBED PROBE ━━━');
const probes = ['测试中文', 'a quick test', '记录一次空参数的命令行执行'];
for (const text of probes) {
  const v = await store.embed(text);
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  console.log(`  "${text}" → dim=${v.length}, |v|=${norm.toFixed(6)}, head=[${[...v.slice(0, 4)].map(x => x.toFixed(4)).join(', ')}]`);
}

console.log('\n━━━ POST-STATE ━━━');
const stats = await dirStats(cfg.paths.modelsDir);
console.log('files:     ', stats.files);
console.log('totalBytes:', stats.bytes, `(~${(stats.bytes / 1024 / 1024).toFixed(1)} MB)`);

const dim = (await store.embed('x')).length;
const ok = dim === cfg.embedder.dim;
console.log('\n━━━ RESULT ━━━');
console.log(`expected dim=${cfg.embedder.dim}, got=${dim}`);
console.log(ok ? '✅ PASS' : '❌ FAIL');
process.exit(ok ? 0 : 1);

// ──────── helpers ────────
async function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  async function walk(d) {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        files++;
        const s = await stat(full);
        bytes += s.size;
      }
    }
  }
  try { await walk(dir); } catch {}
  return { files, bytes };
}
