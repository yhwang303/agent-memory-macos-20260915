#!/usr/bin/env node
/**
 * Standalone MCP handshake test.
 *
 * Runs three sequential JSON-RPC requests through dist/server.js over stdio:
 *   1. initialize
 *   2. tools/list
 *   3. tools/call (index_status)
 *
 * Pass = all three return a result object (no `error` field) and tools/list
 * shows >= 9 tools.
 *
 * Usage:
 *   node scripts/handshake-test.mjs
 *   AGENTMEM_BASE_URL=http://127.0.0.1:3847 node scripts/handshake-test.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', 'dist', 'server.js');

function frame(obj) {
  return JSON.stringify(obj) + '\n';
}

async function run() {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  const stderrBuf = [];
  child.stderr.on('data', (d) => stderrBuf.push(d.toString()));

  const responses = [];
  let pending = '';
  const waiters = new Map(); // id -> resolve

  child.stdout.on('data', (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        responses.push(msg);
        if (msg.id !== undefined && waiters.has(msg.id)) {
          waiters.get(msg.id)(msg);
          waiters.delete(msg.id);
        }
      } catch (e) {
        console.error(`[probe] non-JSON line on stdout: ${line.slice(0, 200)}`);
      }
    }
  });

  function send(method, params, id) {
    const req = { jsonrpc: '2.0', id, method, params };
    child.stdin.write(frame(req));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for id=${id} method=${method}`));
      }, 15000);
      waiters.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  let ok = true;
  const summary = {};

  try {
    // Step 1: initialize
    const init = await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'handshake-probe', version: '0.0.0' },
    }, 1);
    if (init.error) {
      ok = false;
      summary.initialize = { ok: false, error: init.error };
    } else {
      summary.initialize = {
        ok: true,
        serverInfo: init.result?.serverInfo,
        protocolVersion: init.result?.protocolVersion,
      };
    }

    // Step 2: tools/list
    const list = await send('tools/list', {}, 2);
    if (list.error) {
      ok = false;
      summary.toolsList = { ok: false, error: list.error };
    } else {
      const tools = list.result?.tools ?? [];
      summary.toolsList = {
        ok: tools.length >= 9,
        count: tools.length,
        names: tools.map((t) => t.name),
      };
      if (tools.length < 9) ok = false;
    }

    // Step 3: tools/call index_status (always callable, doesn't require working AgentMemory)
    const call = await send('tools/call', {
      name: 'index_status',
      arguments: {},
    }, 3);
    if (call.error) {
      ok = false;
      summary.toolsCall = { ok: false, error: call.error };
    } else {
      summary.toolsCall = {
        ok: !call.result?.isError,
        isError: !!call.result?.isError,
        textPreview: (call.result?.content?.[0]?.text ?? '').slice(0, 200),
      };
    }
  } catch (e) {
    ok = false;
    summary.exception = String(e);
  } finally {
    child.kill('SIGTERM');
  }

  // Wait for clean exit
  await new Promise((r) => child.on('exit', r));

  console.log('━━━ MCP HANDSHAKE TEST ━━━');
  console.log(JSON.stringify(summary, null, 2));
  console.log('━━━ STDERR (server logs) ━━━');
  console.log(stderrBuf.join(''));
  console.log('━━━ RESULT ━━━');
  console.log(ok ? '✅ PASS' : '❌ FAIL');
  process.exit(ok ? 0 : 1);
}

run();
