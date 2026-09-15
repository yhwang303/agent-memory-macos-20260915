#!/usr/bin/env node
/**
 * Build auto-v3.json: extend `expected` for paraphrase / concept / keyword
 * queries by using our own vector store as a "semantic neighbor finder".
 *
 * Rationale: auto-v2.json was generated with a trivial-baseline assumption
 * (1 expected id per query = the obs the query was derived from). For
 * categories where the corpus contains many near-duplicate observations
 * (shell command logs, file edits, etc.), retrieving ANY semantic equivalent
 * should count as success — but auto-v2 only credits the exact derived id.
 *
 * Algorithm:
 *   For each query in auto-v2:
 *     - Embed the *original* obs's title (the one the query was derived from)
 *     - Vector ANN top-N where N=30
 *     - Keep all hits with cosine_distance <= threshold (default 0.20)
 *     - The original derived obs gets relevance=3, others get relevance=1
 *   Categories targeted: paraphrase, concept, keyword
 *   exact / subtitle keep relevance=3 only on the derived obs (no expansion)
 *
 * Usage:
 *   node scripts/build-eval-v3.mjs --in=<path-to-auto-v2.json> --out=<path-to-auto-v3.json>
 *
 * Output is the same shape as v2, just with more `expected` items per query.
 * Original derived obs stays as relevance=3.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = Object.fromEntries(
  process.argv.slice(2).map((s) => {
    const m = s.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [s.replace(/^--/, ''), true];
  })
);

const DATASET_IN = args.in;
const DATASET_OUT = args.out;
if (!DATASET_IN || !DATASET_OUT) {
  console.error('error: --in=<auto-v2.json> --out=<auto-v3.json> are both required');
  process.exit(1);
}
// L2 distance threshold for normalized BGE-zh embeddings.
// Empirically: same-topic obs (e.g. "shell command logged" duplicates) cluster
// at L2 ~0.65-0.75; weakly related obs at ~0.85-0.95; unrelated at >1.0.
// 0.80 captures dense topical clusters without leaking unrelated content.
const DISTANCE_THRESHOLD = 0.80;
const ANN_K = 30;
const TARGET_CATEGORIES = new Set(['paraphrase', 'concept', 'keyword']);

const { loadConfig } = await import(pathToFileURL(path.join(ROOT, 'dist', 'config.js')).href);
const { configureLogger, logger } = await import(pathToFileURL(path.join(ROOT, 'dist', 'logger.js')).href);
const { ModelStore } = await import(pathToFileURL(path.join(ROOT, 'dist', 'modelStore.js')).href);
const { VectorStore } = await import(pathToFileURL(path.join(ROOT, 'dist', 'vectorStore.js')).href);
const { AgentMemoryDb } = await import(pathToFileURL(path.join(ROOT, 'dist', 'agentMemoryDb.js')).href);

configureLogger({});
const cfg = loadConfig();

console.log(`Reading ${DATASET_IN}...`);
const v2 = JSON.parse(await readFile(DATASET_IN, 'utf-8'));
console.log(`  ${v2.queries.length} queries`);

const agentMemory = new AgentMemoryDb(cfg.agentMemoryDbPath);
const model = new ModelStore(cfg);
const vec = new VectorStore({ dbPath: cfg.paths.vecDbPath, dim: cfg.embedder.dim });

console.log('Loading model...');
await model.ensureReady();
console.log(`vec.totalDocs: ${vec.stats().totalDocs}`);

// Group derived-obs ids so we can fetch their titles in one batch
const derivedIds = new Set();
for (const q of v2.queries) {
  for (const e of q.expected) derivedIds.add(e.obs_id);
}
console.log(`unique derived obs: ${derivedIds.size}`);

// Pull derived obs content from AgentMemory main DB
const idArr = [...derivedIds];
const derivedDocs = new Map();
for (let i = 0; i < idArr.length; i += 200) {
  const slice = idArr.slice(i, i + 200);
  const rows = agentMemory.getObservationsByIds(slice);
  for (const d of rows) derivedDocs.set(d.sqliteId, d);
}
console.log(`fetched ${derivedDocs.size} derived obs`);

// For each target-category query, expand expected via vector neighbors
// Use the obs's TITLE (not subtitle / narrative) as the canonical seed —
// it's the cleanest summary of what makes that obs "this thing not other things".
let expanded = 0;
let totalAddedIds = 0;
const out = { ...v2, version: 'v0.2-expanded', generatedAt: new Date().toISOString(),
              source: { ...v2.source, expandedFrom: 'auto-v2.json', threshold: DISTANCE_THRESHOLD, k: ANN_K },
              queries: [] };

for (const q of v2.queries) {
  if (!TARGET_CATEGORIES.has(q.category)) {
    out.queries.push(q);
    continue;
  }
  const derivedId = q.expected[0]?.obs_id;
  const derived = derivedDocs.get(derivedId);
  if (!derived || !derived.text) {
    out.queries.push(q);
    continue;
  }
  // Use first line of the derived doc (the title) as seed
  const seedText = derived.text.split('\n').filter(Boolean)[0]?.slice(0, 200) ?? '';
  if (!seedText) {
    out.queries.push(q);
    continue;
  }
  const seedVec = await model.embed(seedText);
  const hits = vec.query(seedVec, ANN_K, q.project ? { project: q.project, kind: 'observation' } : { kind: 'observation' });

  // Build expanded expected: relevance=3 for original, relevance=1 for neighbors within threshold
  const expectedMap = new Map();
  expectedMap.set(derivedId, 3);
  for (const h of hits) {
    if (h.distance > DISTANCE_THRESHOLD) continue;
    if (h.sqliteId === derivedId) continue;
    expectedMap.set(h.sqliteId, 1);
  }
  const expanded_expected = [...expectedMap.entries()].map(([obs_id, relevance]) => ({ obs_id, relevance }));
  const added = expanded_expected.length - 1;
  if (added > 0) {
    expanded++;
    totalAddedIds += added;
  }
  out.queries.push({
    ...q,
    expected: expanded_expected,
    note: q.note + ` [v3: +${added} semantic neighbors @threshold=${DISTANCE_THRESHOLD}]`,
  });
  if ((expanded % 10) === 0 && added > 0) {
    process.stdout.write(`  expanded ${expanded} queries...\r`);
  }
}

console.log(`\n\nexpansion summary:`);
console.log(`  queries expanded     : ${expanded} / ${v2.queries.filter(q => TARGET_CATEGORIES.has(q.category)).length} target-category queries`);
console.log(`  total neighbors added: ${totalAddedIds}`);
console.log(`  avg neighbors/query  : ${(totalAddedIds / Math.max(1, expanded)).toFixed(1)}`);

await writeFile(DATASET_OUT, JSON.stringify(out, null, 2), 'utf-8');
console.log(`\n💾 ${DATASET_OUT}`);

vec.close();
agentMemory.close();
process.exit(0);
