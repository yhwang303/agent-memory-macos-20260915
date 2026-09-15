#!/usr/bin/env node
/**
 * VectorStore + ModelStore integration test (M2.4 acceptance).
 *
 * Build a tiny in-memory corpus, embed it through the real BGE model,
 * write into a temp vec.db, query, verify ranking is sane.
 *
 * Pass:
 *   - Schema creates without error
 *   - Upsert 5 docs (mix of obs + summary)
 *   - Query "命令行执行" returns the relevant doc on top
 *   - Filters work (project / kind)
 *   - stats() reports correct counts
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const tmpDir = path.join(os.tmpdir(), `agentMemory-hybrid-mcp-test-${Date.now()}`);
await mkdir(tmpDir, { recursive: true });
const tmpVec = path.join(tmpDir, 'vec.db');

// Override env to point dataDir into tmp (so config picks it up if needed)
process.env.AGENTMEM_HYBRID_DATA_DIR = tmpDir;

const { loadConfig } = await import(pathToFileURL(path.join(ROOT, 'dist', 'config.js')).href);
const { configureLogger } = await import(pathToFileURL(path.join(ROOT, 'dist', 'logger.js')).href);
const { ModelStore } = await import(pathToFileURL(path.join(ROOT, 'dist', 'modelStore.js')).href);
const { VectorStore } = await import(pathToFileURL(path.join(ROOT, 'dist', 'vectorStore.js')).href);

configureLogger({});
const cfg = loadConfig();

// Use the real persistent model cache (so we don't re-download every test run)
cfg.paths.modelsDir = path.join(os.homedir(), '.agentMemory-hybrid-mcp', 'models');

const model = new ModelStore(cfg);
const store = new VectorStore({ dbPath: tmpVec, dim: cfg.embedder.dim });

console.log('━━━ Loading model ━━━');
await model.ensureReady();
console.log('model status:', model.getStatus().status);

// Tiny corpus: a few observations (in d:/proj-a) + one summary
const corpus = [
  { kind: 'observation', sqliteId: 1, project: 'd:/proj-a', obsType: 'investigation',
    text: '记录到一次空参数的命令行执行' },
  { kind: 'observation', sqliteId: 2, project: 'd:/proj-a', obsType: 'feature',
    text: '实现了用户登录功能，支持邮箱和短信两种验证方式' },
  { kind: 'observation', sqliteId: 3, project: 'd:/proj-b', obsType: 'investigation',
    text: '排查向量库索引为何没有建立' },
  { kind: 'observation', sqliteId: 4, project: 'd:/proj-a', obsType: 'bugfix',
    text: '修复了登录页面密码框的显示问题' },
  { kind: 'session_summary', sqliteId: 100, project: 'd:/proj-a',
    text: '本次会话主要在调试 hybrid 检索的 RRF 融合参数' },
];

console.log('\n━━━ Embedding corpus ━━━');
const items = [];
for (const doc of corpus) {
  const v = await model.embed(doc.text);
  items.push({
    kind: doc.kind,
    sqliteId: doc.sqliteId,
    project: doc.project,
    obsType: doc.obsType ?? null,
    createdAtMs: Date.now(),
    vector: v,
  });
}
store.upsertBatch(items);
console.log('upserted', items.length, 'docs');

console.log('\n━━━ stats() ━━━');
console.log(JSON.stringify(store.stats(), null, 2));

// Probe 1: semantic match on "命令行执行" should top-rank doc #1
console.log('\n━━━ Q1: "命令行执行" (top 3) ━━━');
const q1 = await model.embed('命令行执行');
const r1 = store.query(q1, 3);
for (const hit of r1) {
  console.log(`  ${hit.kind}#${hit.sqliteId}  d=${hit.distance.toFixed(4)}  project=${hit.project}  type=${hit.obsType}`);
}
const q1ok = r1[0]?.sqliteId === 1;

// Probe 2: paraphrase "登入流程" should match doc #2 (登录功能) by semantic, NOT keyword
console.log('\n━━━ Q2: "登入流程" (top 3, paraphrase) ━━━');
const q2 = await model.embed('登入流程');
const r2 = store.query(q2, 3);
for (const hit of r2) {
  console.log(`  ${hit.kind}#${hit.sqliteId}  d=${hit.distance.toFixed(4)}  project=${hit.project}  type=${hit.obsType}`);
}
const q2ok = r2[0]?.sqliteId === 2;

// Probe 3: project filter — same query but only proj-b
console.log('\n━━━ Q3: "向量库索引" filter project=d:/proj-b ━━━');
const q3 = await model.embed('向量库索引');
const r3 = store.query(q3, 3, { project: 'd:/proj-b' });
for (const hit of r3) {
  console.log(`  ${hit.kind}#${hit.sqliteId}  d=${hit.distance.toFixed(4)}  project=${hit.project}`);
}
const q3ok = r3.length === 1 && r3[0].sqliteId === 3 && r3[0].project === 'd:/proj-b';

// Probe 4: kind filter — only summaries
console.log('\n━━━ Q4: "RRF 融合" filter kind=session_summary ━━━');
const q4 = await model.embed('RRF 融合');
const r4 = store.query(q4, 3, { kind: 'session_summary' });
for (const hit of r4) {
  console.log(`  ${hit.kind}#${hit.sqliteId}  d=${hit.distance.toFixed(4)}`);
}
const q4ok = r4.length === 1 && r4[0].sqliteId === 100 && r4[0].kind === 'session_summary';

// Probe 5: upsert idempotency — re-upsert sqliteId=1 with new vector, count should not grow
const before = store.stats().totalDocs;
const newV = await model.embed('改写后的文本');
store.upsert({
  kind: 'observation', sqliteId: 1, project: 'd:/proj-a',
  obsType: 'investigation', createdAtMs: Date.now(), vector: newV,
});
const after = store.stats().totalDocs;
const q5ok = before === after;
console.log(`\n━━━ Q5: upsert idempotency: ${before} → ${after} (${q5ok ? 'no growth' : 'GREW! 🐛'}) ━━━`);

// Cleanup
store.close();
await rm(tmpDir, { recursive: true, force: true });

console.log('\n━━━ RESULTS ━━━');
console.log(`Q1 (semantic match)    : ${q1ok ? '✅' : '❌'}`);
console.log(`Q2 (paraphrase)        : ${q2ok ? '✅' : '❌'}`);
console.log(`Q3 (project filter)    : ${q3ok ? '✅' : '❌'}`);
console.log(`Q4 (kind filter)       : ${q4ok ? '✅' : '❌'}`);
console.log(`Q5 (upsert idempotent) : ${q5ok ? '✅' : '❌'}`);

const allOk = q1ok && q2ok && q3ok && q4ok && q5ok;
console.log(allOk ? '\n✅ PASS' : '\n❌ FAIL');
process.exit(allOk ? 0 : 1);
