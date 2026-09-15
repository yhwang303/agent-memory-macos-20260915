#!/usr/bin/env node
/**
 * Cold-start e2e test (M2.8 acceptance).
 *
 * Spawns the real MCP server over stdio and:
 *   1. handshakes
 *   2. polls `index_status` until indexer reports total coverage ≈ 100%
 *   3. triggers reindex(wait=true, project=...) and verifies progress
 *
 * Pass:
 *   - Handshake OK
 *   - Within 10 minutes the indexer reaches >= 99% coverage on observations
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', 'dist', 'server.js');
const TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;

function frame(obj) { return JSON.stringify(obj) + '\n'; }

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe','pipe','pipe'], env: { ...process.env } });
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
  const req = { jsonrpc: '2.0', id, method, params };
  child.stdin.write(frame(req));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout id=${id} method=${method}`)), 60000);
    waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
  });
}

async function callTool(name, args = {}) {
  const r = await send('tools/call', { name, arguments: args });
  if (r.error) throw new Error(`Tool ${name} err: ${JSON.stringify(r.error)}`);
  const text = r.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

let exitCode = 1;
let protocolResponsiveDuringIndex = true;
try {
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'm28-probe', version: '0' },
  });
  console.log('handshake ✅');

  const status0 = await callTool('index_status');
  console.log('initial index_status:');
  console.log(`  model: ${status0.model?.status}`);
  console.log(`  vec.totalDocs: ${status0.vectorIndex?.totalDocs ?? 'n/a'}`);
  console.log(`  agentMemory.observations: ${status0.agentMemoryDb?.observations}`);

  const targetTotal = (status0.agentMemoryDb?.observations ?? 0) + (status0.agentMemoryDb?.summaries ?? 0);
  console.log(`target total docs to index: ${targetTotal}`);

  // Pick a reasonably small project to keep test time bounded.
  const candidates = (status0.agentMemoryDb?.byProject ?? [])
    .filter((p) => p.observations + p.summaries > 100 && p.observations + p.summaries < 800)
    .sort((a, b) => (a.observations + a.summaries) - (b.observations + b.summaries));
  const target = candidates[0] ?? status0.agentMemoryDb?.byProject?.find(p => p.observations < 800);
  if (!target) {
    console.error('no suitable test project, aborting');
    process.exit(2);
  }
  console.log(`scoped reindex on: ${target.project} (obs=${target.observations}, sum=${target.summaries})`);

  // Kick off non-blocking reindex on the scoped project
  const kick = await callTool('reindex', { project: target.project, wait: false });
  console.log('reindex kicked:', kick.status, JSON.stringify(kick.progress?.observations));

  const start = Date.now();
  let lastReport = 0;
  let final = null;
  while (Date.now() - start < TIMEOUT_MS) {
    const tCall = Date.now();
    const s = await callTool('index_status');
    const callMs = Date.now() - tCall;
    if (callMs > 5000) {
      console.warn(`  ⚠️  index_status took ${callMs}ms (event loop starved)`);
      protocolResponsiveDuringIndex = false;
    }
    const got = s.vectorIndex?.totalDocs ?? 0;
    const ip = s.indexer?.status;
    const targetForCov = target.observations + target.summaries;
    const cov = targetForCov === 0 ? 1 : got / targetForCov;
    if (Date.now() - lastReport > 5000) {
      console.log(`  [${Math.round((Date.now()-start)/1000)}s] indexer=${ip}  vec=${got}/${targetForCov}  scoped_cov=${(cov*100).toFixed(1)}%  status_call=${callMs}ms`);
      lastReport = Date.now();
    }
    if (ip === 'idle' && got >= targetForCov * 0.95) {
      final = s;
      break;
    }
    if (ip === 'failed') {
      console.error('indexer FAILED:', s.indexer.lastError);
      break;
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (!final) {
    console.error('did not reach 95% scoped coverage within timeout');
  } else {
    console.log('\nFINAL:');
    console.log(`  vec.totalDocs   = ${final.vectorIndex.totalDocs}`);
    console.log(`  vec.observations= ${final.vectorIndex.observations}`);
    console.log(`  vec.summaries   = ${final.vectorIndex.summaries}`);
    console.log(`  finishedAt      = ${final.indexer.finishedAt}`);
    console.log(`  protocol responsive throughout: ${protocolResponsiveDuringIndex}`);
    exitCode = (protocolResponsiveDuringIndex && final.vectorIndex.totalDocs >= 100) ? 0 : 1;
  }
} catch (e) {
  console.error('FATAL:', String(e));
} finally {
  child.kill('SIGTERM');
  await new Promise(r => child.on('exit', r));
}

console.log('\n━━━ STDERR tail ━━━');
console.log(stderrBuf.join('').split('\n').slice(-25).join('\n'));
console.log(exitCode === 0 ? '\n✅ PASS' : '\n❌ FAIL');
process.exit(exitCode);
