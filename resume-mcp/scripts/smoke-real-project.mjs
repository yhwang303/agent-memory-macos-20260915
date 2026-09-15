#!/usr/bin/env node
/**
 * Smoke test: call load_recent_context with explicit project=d:/agent-memory
 * and print the full response. Used to eyeball the rendered XML against
 * known recent sessions in AgentMemory.
 *
 * Usage:
 *   node scripts/smoke-real-project.mjs                  → d:/agent-memory, n=3
 *   node scripts/smoke-real-project.mjs d:/ai-ide-langfuse 5
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', 'dist', 'server.js');

const project = process.argv[2] || 'd:/agent-memory';
const n = parseInt(process.argv[3] || '3', 10);

function frame(o) { return JSON.stringify(o) + '\n'; }

async function run() {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  const stderr = [];
  child.stderr.on('data', (d) => stderr.push(d.toString()));

  let pending = '';
  const waiters = new Map();
  child.stdout.on('data', (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      }
    }
  });

  function send(method, params, id) {
    child.stdin.write(frame({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout id=' + id)), 15000);
      waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
    });
  }

  await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } }, 1);
  const call = await send('tools/call', {
    name: 'load_recent_context',
    arguments: { project, n, max_tokens: 4000, obs_per_session: 3 },
  }, 2);

  child.kill('SIGTERM');
  await new Promise((r) => child.on('exit', r));

  console.log('━━━ STDERR ━━━');
  console.log(stderr.join(''));
  console.log('━━━ TOOL RESULT ━━━');
  console.log('isError:', !!call.result?.isError);
  console.log('---');
  console.log(call.result?.content?.[0]?.text ?? '(no content)');
}

run().catch((e) => { console.error(e); process.exit(1); });
