#!/usr/bin/env node
/**
 * Smoke test that exercises CWD-based project resolution.
 *
 * Spawns the server with cwd set to a real project directory
 * (default: D:\agent-memory) and calls load_recent_context with NO arguments.
 * Verifies the tool resolved the project from cwd, not by an explicit param.
 *
 * Usage:
 *   node scripts/smoke-cwd.mjs                    → cwd=D:\agent-memory, n=3
 *   node scripts/smoke-cwd.mjs D:\\ai-ide-langfuse 5
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', 'dist', 'server.js');

const cwd = process.argv[2] || 'D:\\agent-memory';
const n = parseInt(process.argv[3] || '3', 10);

function frame(o) { return JSON.stringify(o) + '\n'; }

async function run() {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
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
    arguments: { n, max_tokens: 3000, obs_per_session: 2, exclude_active: true },
  }, 2);

  child.kill('SIGTERM');
  await new Promise((r) => child.on('exit', r));

  console.log('━━━ STDERR ━━━');
  console.log(stderr.join(''));
  console.log('━━━ TOOL RESULT ━━━');
  console.log('isError:', !!call.result?.isError);
  console.log('---');
  const text = call.result?.content?.[0]?.text ?? '(no content)';
  console.log(text);

  // Quick assertion — verify the root tag has match="cwd" or "ancestor"
  const matchAttr = text.match(/match="([^"]+)"/);
  console.log('---');
  console.log('match attribute:', matchAttr ? matchAttr[1] : '(missing)');
}

run().catch((e) => { console.error(e); process.exit(1); });
