#!/usr/bin/env node
/**
 * Indexer e2e on a small project (M2.6 acceptance).
 * - Pick the smallest project (so test stays fast)
 * - Run reindexAll(project=...) to a fresh tmp vec.db
 * - Verify counts match AgentMemory stats for that project
 * - Run a hybrid-vector probe to confirm we can retrieve relevant rows
 *
 * Pass:
 *   - vec.db doc count == AgentMemory project obs+sum count (give or take empty rows)
 *   - At least 1 vector probe lands on a sane top-1
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { mkdir, rm } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const tmpDir = path.join(os.tmpdir(), `agentMemory-hybrid-mcp-indexer-${Date.now()}`);
await mkdir(tmpDir, { recursive: true });
process.env.AGENTMEM_HYBRID_DATA_DIR = tmpDir;

const { loadConfig } = await import(pathToFileURL(path.join(ROOT, 'dist', 'config.js')).href);
const { configureLogger } = await import(pathToFileURL(path.join(ROOT, 'dist', 'logger.js')).href);
const { ModelStore } = await import(pathToFileURL(path.join(ROOT, 'dist', 'modelStore.js')).href);
const { VectorStore } = await import(pathToFileURL(path.join(ROOT, 'dist', 'vectorStore.js')).href);
const { AgentMemoryDb } = await import(pathToFileURL(path.join(ROOT, 'dist', 'agentMemoryDb.js')).href);
const { Indexer } = await import(pathToFileURL(path.join(ROOT, 'dist', 'indexer.js')).href);

configureLogger({});
const cfg = loadConfig();
// Re-use persistent model cache
cfg.paths.modelsDir = path.join(os.homedir(), '.agentMemory-hybrid-mcp', 'models');

const agentMemory = new AgentMemoryDb(cfg.agentMemoryDbPath);
const agentMemoryStats = agentMemory.stats();

// Pick the smallest project with > 0 docs
const candidates = agentMemoryStats.byProject
  .filter((p) => p.observations + p.summaries > 0 && p.observations + p.summaries < 100)
  .sort((a, b) => (a.observations + a.summaries) - (b.observations + b.summaries));
const target = candidates[0] ?? agentMemoryStats.byProject[agentMemoryStats.byProject.length - 1];
console.log(`Target project: ${target.project}  obs=${target.observations} sum=${target.summaries}`);

const model = new ModelStore(cfg);
const vec = new VectorStore({ dbPath: cfg.paths.vecDbPath, dim: cfg.embedder.dim });
const indexer = new Indexer(model, vec, agentMemory);

console.log('\n━━━ Loading model ━━━');
await model.ensureReady();
console.log('model status:', model.getStatus().status);

console.log(`\n━━━ reindexAll(project=${target.project}) ━━━`);
const t0 = Date.now();
const prog = await indexer.reindexAll({ project: target.project });
const took = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`took ${took}s`);
console.log('progress:', JSON.stringify(prog, null, 2));

console.log('\n━━━ vec.db stats ━━━');
const vstats = vec.stats();
console.log(JSON.stringify(vstats, null, 2));

const expected = target.observations + target.summaries;
const actual = vstats.totalDocs;
const countOk = actual >= Math.floor(expected * 0.9); // allow up to 10% empty-text skips
console.log(`expected ~${expected}, got ${actual}, ${countOk ? '✅' : '❌'}`);

// Vector probe — pick a real obs from this project, embed similar query, expect it to land near top
console.log('\n━━━ Vector probe ━━━');
let probeOk = false;
for (const page of agentMemory.streamObservations({ project: target.project, pageSize: 5 })) {
  for (const sample of page) {
    if (!sample.text) continue;
    // Use the title (first line) as query — should obviously self-retrieve
    const firstLine = sample.text.split('\n').filter(Boolean)[0]?.slice(0, 80) ?? '';
    if (!firstLine) continue;
    const qv = await model.embed(firstLine);
    const hits = vec.query(qv, 3, { project: target.project });
    const top = hits[0];
    console.log(`  query: "${firstLine.slice(0, 60)}"`);
    console.log(`  top-1: ${top?.kind}#${top?.sqliteId} d=${top?.distance.toFixed(4)}  (target was obs#${sample.sqliteId})`);
    if (top?.sqliteId === sample.sqliteId) probeOk = true;
    break;
  }
  break;
}

vec.close();
agentMemory.close();
await rm(tmpDir, { recursive: true, force: true });

console.log('\n━━━ RESULT ━━━');
console.log('count ok:', countOk ? '✅' : '❌');
console.log('probe ok:', probeOk ? '✅' : '❌');
const ok = countOk && probeOk;
console.log(ok ? '\n✅ PASS' : '\n❌ FAIL');
process.exit(ok ? 0 : 1);
