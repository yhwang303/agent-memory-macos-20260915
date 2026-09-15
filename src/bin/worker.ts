#!/usr/bin/env node
/**
 * agent-memory worker CLI (headless).
 *
 * Commands:
 *   start [--foreground]   Spawn worker. Without --foreground we detach so the
 *                          shell returns immediately; pid is recorded so `stop`
 *                          can find it. With --foreground we stay in the
 *                          current process (used by systemd / Docker / debug).
 *   stop                   Read the pid file and SIGTERM the worker. Removes
 *                          the pid file once the process is gone.
 *   restart                stop && start (preserves --foreground if passed).
 *   status                 Combine pid liveness + HTTP /health probe.
 */

import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { WorkerService, getDefaultConfig } from '../services/worker/WorkerService.js';
import { logger } from '../utils/logger.js';
import { ensureDataDir, getPidFilePath } from '../shared/paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..', '..');

/** Load .env.local / .env from the install directory (best-effort). */
function loadEnvFile(): void {
  const envLocalPath = resolve(projectRoot, '.env.local');
  const envPath = resolve(projectRoot, '.env');
  const configPath = existsSync(envLocalPath) ? envLocalPath : (existsSync(envPath) ? envPath : null);
  if (!configPath) {
    logger.debug('CLI', 'No .env.local or .env file found, using environment variables');
    return;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex > 0) {
        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = value;
      }
    }
    logger.info('CLI', `Loaded config from ${configPath}`);
  } catch (error) {
    logger.warn('CLI', `Failed to load config from ${configPath}`, { error: String(error) });
  }
}

/**
 * Returns true if a process with `pid` is currently alive.
 *
 * `process.kill(pid, 0)` is the canonical liveness check on POSIX; on Windows
 * Node implements the same semantics for signal 0.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(): number | null {
  const pidPath = getPidFilePath();
  if (!existsSync(pidPath)) return null;
  try {
    const raw = readFileSync(pidPath, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    if (Number.isFinite(pid) && pid > 0) return pid;
  } catch {
    /* fall through */
  }
  return null;
}

function writePidFile(pid: number): void {
  ensureDataDir();
  writeFileSync(getPidFilePath(), String(pid), 'utf-8');
}

function clearPidFile(): void {
  const pidPath = getPidFilePath();
  if (existsSync(pidPath)) {
    try { unlinkSync(pidPath); } catch { /* ignore */ }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Wait for a predicate up to `timeoutMs`. Returns whether it became true. */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

async function pingHealth(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Wire signal handlers + heartbeat + uncaught hooks for foreground mode. */
function setupForegroundProcessMonitoring(): void {
  const startTime = new Date().toISOString();
  logger.info('CLI', `=== Worker process started at ${startTime} ===`, { pid: process.pid });

  let heartbeatCount = 0;

  process.on('uncaughtException', (error, origin) => {
    logger.error('CLI', '!!! UNCAUGHT EXCEPTION !!!', {
      origin,
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack,
    });
    setTimeout(() => process.exit(1), 1000);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('CLI', '!!! UNHANDLED REJECTION !!!', {
      reason: String(reason),
      stack: (reason as Error)?.stack,
    });
  });

  setInterval(() => {
    heartbeatCount++;
    const mem = process.memoryUsage();
    logger.info('CLI', `Heartbeat #${heartbeatCount}`, {
      rss: (mem.rss / 1024 / 1024).toFixed(1),
      heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(1),
    });
  }, 30000);
}

async function runForeground(): Promise<void> {
  setupForegroundProcessMonitoring();
  const config = getDefaultConfig();
  logger.info('CLI', `Starting AgentMemory Worker on port ${config.port}...`);

  const worker = new WorkerService(config);

  // Foreground mode owns the pid file so `agent-memory worker stop` works
  // even when the worker was launched directly under systemd / docker.
  writePidFile(process.pid);

  const shutdown = async (signal: string) => {
    logger.info('CLI', `Received ${signal}, shutting down gracefully...`);
    await worker.shutdown();
    clearPidFile();
    process.exit(0);
  };

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

  process.on('message', (msg) => {
    if (msg === 'shutdown') void shutdown('IPC');
  });

  await worker.start();
  logger.info('CLI', `Worker started successfully on http://${config.host}:${config.port}`);
}

/**
 * Detach a child node process running this very same script in --foreground
 * mode. The parent returns once the child reports healthy on /health (or
 * times out and prints the stderr tail for diagnosis).
 */
async function spawnDetached(): Promise<number> {
  const config = getDefaultConfig();
  const existingPid = readPidFile();
  if (existingPid && isProcessAlive(existingPid)) {
    if (await pingHealth(config.host, config.port)) {
      console.log(`Worker already running (pid=${existingPid}, http://${config.host}:${config.port})`);
      return 0;
    }
    console.log(`Stale pid file pointed at live but unresponsive pid=${existingPid}; cleaning up.`);
    try { process.kill(existingPid, 'SIGTERM'); } catch { /* ignore */ }
    await sleep(500);
    clearPidFile();
  } else if (existingPid) {
    clearPidFile();
  }

  const child = spawn(process.execPath, [__filename, 'start', '--foreground'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();

  if (!child.pid) {
    console.error('Failed to spawn worker child process.');
    return 1;
  }

  const ready = await waitFor(async () => {
    if (!isProcessAlive(child.pid!)) return false;
    return pingHealth(config.host, config.port);
  }, 15000);

  if (!ready) {
    console.error(`Worker did not become healthy within 15s (pid=${child.pid}).`);
    console.error('Check logs under ~/.agent-memory/logs/');
    return 1;
  }

  console.log(`Worker started (pid=${child.pid}, http://${config.host}:${config.port})`);
  return 0;
}

async function cmdStart(args: string[]): Promise<number> {
  const foreground = args.includes('--foreground') || args.includes('-f');
  if (foreground) {
    await runForeground();
    return 0; // foreground keeps the loop alive; this line is unreachable normally
  }
  return spawnDetached();
}

async function cmdStop(): Promise<number> {
  const pid = readPidFile();
  if (!pid) {
    console.log('Worker is not running (no pid file).');
    return 0;
  }
  if (!isProcessAlive(pid)) {
    console.log(`Stale pid file (pid=${pid} not alive); cleaning up.`);
    clearPidFile();
    return 0;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    console.error(`Failed to signal pid=${pid}:`, err);
    return 1;
  }
  const stopped = await waitFor(() => !isProcessAlive(pid), 10000);
  if (!stopped) {
    console.error(`Worker pid=${pid} did not exit within 10s; sending SIGKILL.`);
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  }
  clearPidFile();
  console.log(`Worker stopped (pid=${pid}).`);
  return 0;
}

async function cmdStatus(): Promise<number> {
  const config = getDefaultConfig();
  const pid = readPidFile();
  const alive = pid ? isProcessAlive(pid) : false;
  const healthy = await pingHealth(config.host, config.port);

  if (alive && healthy) {
    console.log(`Worker: RUNNING  pid=${pid}  http://${config.host}:${config.port}`);
    try {
      const res = await fetch(`http://${config.host}:${config.port}/health`, { signal: AbortSignal.timeout(2000) });
      console.log(JSON.stringify(await res.json(), null, 2));
    } catch { /* ignore */ }
    return 0;
  }
  if (alive && !healthy) {
    console.log(`Worker: UNHEALTHY  pid=${pid} alive but /health failed`);
    return 1;
  }
  if (!alive && healthy) {
    console.log(`Worker: RUNNING  (no pid file but http://${config.host}:${config.port}/health responded)`);
    return 0;
  }
  console.log('Worker: NOT RUNNING');
  return 1;
}

async function cmdRestart(args: string[]): Promise<number> {
  const stopCode = await cmdStop();
  if (stopCode !== 0) return stopCode;
  await sleep(500);
  return cmdStart(args);
}

async function main(): Promise<void> {
  loadEnvFile();
  const args = process.argv.slice(2);
  const command = args[0] || 'status';
  const rest = args.slice(1);

  let exitCode = 0;
  switch (command) {
    case 'start':   exitCode = await cmdStart(rest);   break;
    case 'stop':    exitCode = await cmdStop();        break;
    case 'restart': exitCode = await cmdRestart(rest); break;
    case 'status':  exitCode = await cmdStatus();      break;
    default:
      console.log('agent-memory worker');
      console.log('');
      console.log('Commands:');
      console.log('  start [--foreground]   Spawn worker (detached unless --foreground)');
      console.log('  stop                   SIGTERM the running worker');
      console.log('  restart                stop && start');
      console.log('  status                 Show pid + /health summary');
      exitCode = 0;
  }

  if (exitCode !== 0) process.exit(exitCode);
}

main().catch((error) => {
  logger.error('CLI', 'Fatal error', {}, error as Error);
  process.exit(1);
});
