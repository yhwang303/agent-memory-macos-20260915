#!/usr/bin/env node
/**
 * agentMemory-hybrid-mcp evaluation against agentMemory-eval datasets.
 *
 * Reuses agentMemory-eval's metrics logic; spawns our own MCP server over stdio and
 * calls the `search` tool for each query. Writes a result JSON to
 * <eval-root>/results/<timestamp>-external-<mode>.json so make-report.mjs
 * can pick it up alongside the sqlite baseline.
 *
 * The eval root must be passed via --eval-root or the CBM_EVAL_ROOT env var.
 * It points at a checkout of the agentMemory-eval repo (which provides the metrics
 * lib + datasets dir).
 *
 * Usage:
 *   CBM_EVAL_ROOT=/path/to/agentMemory-eval node scripts/eval.mjs --mode=hybrid
 *   node scripts/eval.mjs --eval-root=/path/to/agentMemory-eval --mode=vector
 *   node scripts/eval.mjs --eval-root=/path/to/agentMemory-eval --mode=hybrid \
 *     --dataset=/path/to/agentMemory-eval/datasets/auto-v2.json --limit=20
 */
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'dist', 'server.js');

// CLI args
const args = Object.fromEntries(
  process.argv.slice(2).map((s) => {
    const m = s.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [s.replace(/^--/, ''), true];
  })
);
const mode = args.mode || 'hybrid';
if (!['sqlite', 'vector', 'hybrid'].includes(mode)) {
  console.error(`mode must be sqlite/vector/hybrid, got: ${mode}`);
  process.exit(1);
}
const limit = parseInt(args.limit || '20', 10);
const ks = (args.ks || '1,5,10,20').split(',').map(Number);
const concurrency = parseInt(args.concurrency || '1', 10); // default 1 since vector embed is CPU-bound
const evalRoot = args['eval-root'] || process.env.CBM_EVAL_ROOT;
if (!evalRoot) {
  console.error('error: --eval-root=<path> or CBM_EVAL_ROOT env var is required');
  console.error('  it should point at a checkout of agentMemory-eval that contains lib/metrics.mjs and datasets/');
  process.exit(1);
}
const datasetArg = args.dataset;

// Load metrics from agentMemory-eval
const metrics = await import(pathToFileURL(path.join(evalRoot, 'lib', 'metrics.mjs')).href);

async function resolveDataset() {
  if (datasetArg) return datasetArg;
  const dir = path.join(evalRoot, 'datasets');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort().reverse();
  if (files.length === 0) throw new Error(`no dataset in ${dir}`);
  return path.join(dir, files[0]);
}
const datasetPath = await resolveDataset();
const dataset = JSON.parse(await readFile(datasetPath, 'utf-8'));
console.log(`[eval] dataset: ${datasetPath} (${dataset.total} queries)`);
console.log(`[eval] mode=${mode} limit=${limit} ks=${ks.join(',')} concurrency=${concurrency}`);

// Spawn MCP server
const child = spawn(process.execPath, [SERVER], { stdio: ['pipe','pipe','pipe'], env: process.env });
child.stderr.on('data', () => {}); // silent — we'll inspect MCP-side via index_status

let pending = '';
const waiters = new Map();
let nextId = 1;
child.stdout.on('data', (chunk) => {
  pending += chunk.toString();
  const lines = pending.split(/\r?\n/);
  pending = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      }
    } catch {}
  }
});
function send(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc:'2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout id=${id}`)), 60000);
    waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
  });
}
async function callTool(name, ar = {}) {
  const r = await send('tools/call', { name, arguments: ar });
  if (r.error) throw new Error(`Tool ${name}: ${JSON.stringify(r.error)}`);
  const t = r.result?.content?.[0]?.text;
  return t ? JSON.parse(t) : null;
}

// Handshake + wait for model ready
await send('initialize', { protocolVersion:'2024-11-05', capabilities:{}, clientInfo:{name:'eval',version:'0'} });
console.log('[eval] handshake ok, waiting for model ready...');
let initialStatus;
for (let i = 0; i < 60; i++) {
  initialStatus = await callTool('index_status');
  if (initialStatus.model?.status === 'ready') break;
  await new Promise(r => setTimeout(r, 500));
}
console.log(`[eval] model: ${initialStatus.model?.status}, vec.totalDocs: ${initialStatus.vectorIndex?.totalDocs}`);

const expectedTotal = (initialStatus.agentMemoryDb?.observations ?? 0) + (initialStatus.agentMemoryDb?.summaries ?? 0);
if (mode !== 'sqlite' && (initialStatus.vectorIndex?.totalDocs ?? 0) < expectedTotal * 0.9) {
  console.warn(`⚠️  vec.db has only ${initialStatus.vectorIndex?.totalDocs} docs (expected ~${expectedTotal}). Vector branch may underperform. Run scripts/bg-full-reindex.mjs first.`);
}

// Run each query
async function runOne(q) {
  let resp, latencyMs = -1;
  const t0 = Date.now();
  try {
    resp = await callTool('search', {
      query: q.query,
      mode,
      project: q.project,
      limit,
    });
    latencyMs = Date.now() - t0;
  } catch (e) {
    return {
      qid: q.id, query: q.query, _category: q.category, _error: String(e),
      _latencyMs: -1, returnedIds: [],
      ...metrics.evalQuery([], q.expected, ks),
    };
  }
  const returnedIds = (resp.observations || []).map((o) => o.id);
  const detail = metrics.evalQuery(returnedIds, q.expected, ks);
  return {
    qid: q.id, query: q.query, _category: q.category,
    _latencyMs: latencyMs,
    _modeReturned: resp.mode,
    _fellBack: resp.fellBack,
    _serverTimings: resp.timings,
    _branchCounts: resp.counts,
    returnedIds: returnedIds.slice(0, Math.max(...ks)),
    expectedIds: q.expected.map((e) => e.obs_id),
    ...detail,
  };
}

async function pool(items, n, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
      if ((i + 1) % 20 === 0) {
        process.stdout.write(`  ${i + 1}/${items.length}\r`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => worker()));
  return results;
}

console.log(`\n[eval] running...`);
const t0 = Date.now();
const perQuery = await pool(dataset.queries, concurrency, runOne);
const totalMs = Date.now() - t0;
console.log(`\n[eval] done in ${(totalMs/1000).toFixed(1)}s`);

// Aggregate
const summary = metrics.aggregate(perQuery, ks);
const fellBackCount = perQuery.filter((r) => r._fellBack === true).length;
const errorCount = perQuery.filter((r) => r._error).length;

const out = {
  meta: {
    timestamp: new Date().toISOString(),
    mode: `external-${mode}`,
    limit, ks, datasetPath, datasetTotal: dataset.total,
    mcpVersion: initialStatus.agentMemoryHybridMcp?.version,
    mcpMilestone: initialStatus.agentMemoryHybridMcp?.milestone,
    vecTotalDocs: initialStatus.vectorIndex?.totalDocs,
    cbmObservations: initialStatus.agentMemoryDb?.observations,
    cbmSummaries: initialStatus.agentMemoryDb?.summaries,
    totalMs, fellBackCount, errorCount,
  },
  summary, perQuery,
};

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const resultsDir = path.join(evalRoot, 'results');
await mkdir(resultsDir, { recursive: true });
const outPath = path.join(resultsDir, `${stamp}-external-${mode}.json`);
await writeFile(outPath, JSON.stringify(out, null, 2), 'utf-8');

// Console summary
console.log(`\n========== ${mode} ==========`);
const m = summary.overall;
console.log(`  zeroResult : ${(m.zeroResultRate * 100).toFixed(1)}%`);
console.log(`  miss       : ${(m.missRate * 100).toFixed(1)}%`);
console.log(`  MRR        : ${m.MRR.toFixed(4)}`);
for (const k of ks) {
  console.log(`  Recall@${k.toString().padStart(2)} : ${(m[`recall@${k}`] * 100).toFixed(2)}%   nDCG@${k.toString().padStart(2)}: ${m[`ndcg@${k}`].toFixed(4)}`);
}
console.log(`  latency    : P50=${m.latencyP50}ms P95=${m.latencyP95}ms P99=${m.latencyP99}ms`);
console.log(`  fellBack   : ${fellBackCount}/${dataset.total}`);
if (errorCount) console.log(`  errors    : ${errorCount}`);

console.log(`\nby category:`);
for (const [cat, sub] of Object.entries(summary.byCategory)) {
  console.log(`  [${cat.padEnd(11)}] n=${sub.count} R@10=${(sub['recall@10']*100).toFixed(1)}% MRR=${sub.MRR.toFixed(3)} zero=${(sub.zeroResultRate*100).toFixed(1)}%`);
}
console.log(`\n💾 ${outPath}`);

child.kill('SIGTERM');
await new Promise((r) => child.on('exit', r));
process.exit(0);
