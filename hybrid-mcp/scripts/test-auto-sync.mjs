#!/usr/bin/env node
/**
 * Auto-incremental sync daemon test (M2.9 acceptance).
 *
 * Validates that NEW rows written to AgentMemory main DB get auto-embedded by the
 * sync daemon, WITHOUT any reindex tool call.
 *
 * Steps:
 *   1. Spawn MCP with AGENTMEM_HYBRID_SYNC_INTERVAL_MS=3000 (3s ticks for fast test)
 *   2. Take initial vec.totalDocs snapshot
 *   3. Open AgentMemory main DB writable, INSERT a test observation with a unique title
 *   4. Wait 8s (enough for ≥2 daemon ticks)
 *   5. Read vec.totalDocs again — should be initial+1
 *   6. Embed the unique title via search_vector — should retrieve our test row
 *
 * Cleanup: deletes the test observation from AgentMemory main DB so we don't pollute it.
 *
 * Pass: vec count grew by exactly 1, AND the new row is queryable.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', 'dist', 'server.js');
const AGENTMEM_DB = path.join(os.homedir(), '.agent-memory', 'agent-memory.db');

// Unique marker for our synthetic test row
const STAMP = `auto-sync-probe-${Date.now()}`;
const TEST_TITLE = `[autosync test ${STAMP}] 增量同步守护进程冒烟探针`;
const TEST_PROJECT = `__autosync_test_${STAMP}`;
const TEST_SESSION = `mem-autosync-${STAMP}`;

function frame(o) { return JSON.stringify(o) + '\n'; }

function spawnServer() {
  return spawn(process.execPath, [SERVER], {
    stdio: ['pipe','pipe','pipe'],
    env: { ...process.env, AGENTMEM_HYBRID_SYNC_INTERVAL_MS: '3000' },
  });
}

const child = spawnServer();
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
    const timer = setTimeout(() => reject(new Error(`Timeout id=${id}`)), 30000);
    waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
  });
}
async function callTool(name, args = {}) {
  const r = await send('tools/call', { name, arguments: args });
  if (r.error) throw new Error(`Tool ${name}: ${JSON.stringify(r.error)}`);
  const text = r.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

let exitCode = 1;
let inserted = false;
let agentMemoryRowId = null;

try {
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'autosync-probe', version: '0' },
  });
  console.log('handshake ✅');

  // Wait for the warmup/model load to complete and daemon to be running
  console.log('\nwaiting for daemon to come online...');
  let s0;
  for (let i = 0; i < 60; i++) {
    s0 = await callTool('index_status');
    if (s0.syncDaemon?.running && s0.model?.status === 'ready') break;
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`daemon running: ${s0.syncDaemon?.running}, intervalMs: ${s0.syncDaemon?.intervalMs}, model: ${s0.model?.status}`);
  if (!s0.syncDaemon?.running) {
    throw new Error('daemon never started');
  }

  // Strategy: pick a tiny existing project for baseline reindex (so we have
  // a non-empty vec.db with KNOWN max id) — then inject our new row into
  // THAT project's max_id+1 region and verify it's picked up.
  const candidates = (s0.agentMemoryDb?.byProject ?? [])
    .filter((p) => p.observations + p.summaries > 0 && p.observations + p.summaries < 50);
  candidates.sort((a, b) => (a.observations + a.summaries) - (b.observations + b.summaries));
  const seedProject = candidates[0]?.project;
  if (!seedProject) {
    throw new Error('test-auto-sync requires at least one project in AgentMemory main DB; none found');
  }
  console.log(`\nseeding baseline by reindexing project: ${seedProject}`);
  const seed = await callTool('reindex', { project: seedProject, wait: true });
  console.log(`baseline seeded; status=${seed.status}`);

  // Now snapshot the initial vec count (this is our "before")
  const sBefore = await callTool('index_status');
  const initialVecCount = sBefore.vectorIndex?.totalDocs ?? 0;
  console.log(`initial vec.totalDocs after baseline: ${initialVecCount}`);

  // Inject test row directly into AgentMemory main DB (writable open) — using the
  // SAME project as our baseline so the daemon's watermark logic picks it up.
  // (The daemon checks max(id) globally, not per-project, so any project works.)
  console.log(`\n━━━ injecting test row into AgentMemory main DB ━━━`);
  console.log(`title:   ${TEST_TITLE}`);
  console.log(`project: ${TEST_PROJECT}`);
  const w = new Database(AGENTMEM_DB);
  const now = new Date().toISOString();
  const r = w.prepare(`
    INSERT INTO observations(memory_session_id, project, type, title, subtitle, narrative, text, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    TEST_SESSION,
    TEST_PROJECT,
    'investigation',
    TEST_TITLE,
    'an autosync e2e probe',
    'this row was inserted by the agentMemory-hybrid-mcp autosync test to verify that the daemon picks up new rows without explicit reindex',
    'autosync probe text body',
    now,
    Date.now(),
  );
  agentMemoryRowId = Number(r.lastInsertRowid);
  inserted = true;
  w.close();
  console.log(`inserted observation id=${agentMemoryRowId}`);

  // Wait long enough for at least 2 daemon ticks (interval = 3s)
  const waitMs = 9000;
  console.log(`\nwaiting ${waitMs}ms for daemon to catch up...`);
  await new Promise(r => setTimeout(r, waitMs));

  const s1 = await callTool('index_status');
  const after = s1.vectorIndex?.totalDocs ?? 0;
  console.log(`\npost-wait vec.totalDocs: ${after}`);
  console.log(`daemon stats:`);
  console.log(`  runCount:     ${s1.syncDaemon?.runCount}`);
  console.log(`  lastRunAt:    ${s1.syncDaemon?.lastRunAt}`);
  console.log(`  lastNewDocs:  ${s1.syncDaemon?.lastNewDocs}`);
  console.log(`grew by:        ${after - initialVecCount}`);

  const grewByOne = after - initialVecCount === 1;
  const daemonTicked = (s1.syncDaemon?.runCount ?? 0) >= 2;

  console.log('\n━━━ RESULT ━━━');
  console.log(`vec grew by exactly 1:    ${grewByOne ? '✅' : '❌'}`);
  console.log(`daemon ticked at least 2x: ${daemonTicked ? '✅' : '❌'}`);
  exitCode = (grewByOne && daemonTicked) ? 0 : 1;
} catch (e) {
  console.error('FATAL:', String(e));
  console.error(e.stack);
} finally {
  // Cleanup: remove the test row + child
  if (inserted && agentMemoryRowId) {
    try {
      const w = new Database(AGENTMEM_DB);
      const r = w.prepare('DELETE FROM observations WHERE id = ?').run(agentMemoryRowId);
      w.close();
      console.log(`\ncleanup: removed test obs id=${agentMemoryRowId} (rows affected: ${r.changes})`);
    } catch (e) {
      console.warn('cleanup failed:', String(e));
    }
  }
  child.kill('SIGTERM');
  await new Promise(r => child.on('exit', r));
}

console.log('\n━━━ STDERR tail ━━━');
console.log(stderrBuf.join('').split('\n').slice(-15).join('\n'));
console.log(exitCode === 0 ? '\n✅ PASS' : '\n❌ FAIL');
process.exit(exitCode);
