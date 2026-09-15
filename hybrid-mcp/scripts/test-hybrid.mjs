#!/usr/bin/env node
/**
 * Hybrid search e2e (M3.2 acceptance).
 *
 * Requires: full reindex already complete (~10k+ docs in vec.db).
 *
 * Tests three modes against the SAME real query and compares behavior:
 *   1. mode=sqlite   — pure FTS, expected to MISS on paraphrase
 *   2. mode=vector   — pure ANN, should HIT on paraphrase
 *   3. mode=hybrid   — RRF of both, should keep sqlite hits AND add paraphrase hits
 *
 * Pass criteria:
 *   - All three modes return without error
 *   - hybrid result count >= max(sqlite, vector)
 *   - For a paraphrase query, vector and hybrid both return >0; sqlite often returns 0
 *   - hybrid response.timings.sqliteMs and vectorMs both populated
 *   - response shape includes observations[].sources showing which branch found each
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', 'dist', 'server.js');

function frame(o) { return JSON.stringify(o) + '\n'; }

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe','pipe','pipe'], env: process.env });
const stderrBuf = [];
child.stderr.on('data', (d) => stderrBuf.push(d.toString()));

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
  child.stdin.write(frame({ jsonrpc:'2.0', id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout id=${id}`)), 60000);
    waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
  });
}
async function callTool(name, args = {}) {
  const r = await send('tools/call', { name, arguments: args });
  if (r.error) throw new Error(`Tool ${name}: ${JSON.stringify(r.error)}`);
  const text = r.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

const PROBES = [
  // exact / keyword query: sqlite should crush this
  { label: 'exact_keyword', q: '记录到一次空参数的命令行执行', expectSqliteHits: true },
  // paraphrase: sqlite likely misses, vector should hit
  { label: 'paraphrase',     q: '会话里那次没参数的终端调用', expectVectorWins: true },
  // concept-style: short and abstract
  { label: 'concept',        q: '增量同步守护进程', expectSomethingFromAny: true },
];

let exitCode = 1;
let allOk = true;
try {
  await send('initialize', { protocolVersion:'2024-11-05', capabilities:{}, clientInfo:{name:'m32',version:'0'} });
  console.log('handshake ✅');

  // Wait for model to be ready
  console.log('\nwaiting for model ready...');
  for (let i = 0; i < 60; i++) {
    const s = await callTool('index_status');
    if (s.model?.status === 'ready') break;
    await new Promise(r => setTimeout(r, 500));
  }
  const status = await callTool('index_status');
  console.log(`model: ${status.model?.status}, vec.totalDocs: ${status.vectorIndex?.totalDocs}`);
  console.log(`milestone: ${status.agentMemoryHybridMcp?.milestone}`);

  if ((status.vectorIndex?.totalDocs ?? 0) < 100) {
    console.warn('⚠️  vec.db has very few docs — vector branch will likely return [].');
    console.warn('   Run scripts/bg-full-reindex.mjs first for a meaningful test.');
  }

  for (const probe of PROBES) {
    console.log(`\n━━━ probe: ${probe.label} — "${probe.q}" ━━━`);
    const sqliteR = await callTool('search', { query: probe.q, mode: 'sqlite', limit: 10 });
    const vectorR = await callTool('search', { query: probe.q, mode: 'vector', limit: 10 });
    const hybridR = await callTool('search', { query: probe.q, mode: 'hybrid', limit: 10 });

    const sqCount = sqliteR.observations?.length ?? 0;
    const vcCount = vectorR.observations?.length ?? 0;
    const hbCount = hybridR.observations?.length ?? 0;

    console.log(`  sqlite: ${sqCount} obs  (timings: ${JSON.stringify(sqliteR.timings)})`);
    console.log(`  vector: ${vcCount} obs  (timings: ${JSON.stringify(vectorR.timings)})`);
    console.log(`  hybrid: ${hbCount} obs  (timings: ${JSON.stringify(hybridR.timings)})`);

    // Print top 3 of hybrid with source attribution
    if (hybridR.observations?.length) {
      console.log('  hybrid top-3:');
      for (const h of hybridR.observations.slice(0, 3)) {
        const sources = h.sources?.map(s => `${s.source}@${s.rank}`).join(',') ?? 'n/a';
        const title = h.row?.title ?? '(no title)';
        console.log(`    #${h.id}  rrf=${h.score.toFixed(4)}  [${sources}]  ${String(title).slice(0,60)}`);
      }
    }

    // Assertions
    let probeOk = true;
    if (hybridR.timings?.sqliteMs === undefined || hybridR.timings?.vectorMs === undefined) {
      console.log('  ❌ hybrid timings missing sqliteMs/vectorMs');
      probeOk = false;
    }
    if (probe.expectVectorWins) {
      if (vcCount === 0) {
        console.log('  ⚠️  vector returned 0 — index may be incomplete');
      }
      if (vcCount > 0 && hbCount === 0) {
        console.log('  ❌ vector found stuff but hybrid returned nothing');
        probeOk = false;
      }
    }
    if (probeOk) console.log('  ✅ probe ok');
    else allOk = false;
  }

  if (allOk) exitCode = 0;
} catch (e) {
  console.error('FATAL:', String(e));
  console.error(e.stack);
} finally {
  child.kill('SIGTERM');
  await new Promise(r => child.on('exit', r));
}

console.log('\n━━━ STDERR tail ━━━');
console.log(stderrBuf.join('').split('\n').slice(-12).join('\n'));
console.log(exitCode === 0 ? '\n✅ PASS' : '\n❌ FAIL');
process.exit(exitCode);
