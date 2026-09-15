import { spawn, ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../../utils/logger.js';

export interface ChromaProcessOptions {
  dataDir: string;
  embeddingModel: string;
  modelCacheDir?: string;
  port?: number;
  detectUv?: () => Promise<boolean>;
}

// Scan $PATH directly instead of shelling out to `where`/`which`. Shelling out
// via execSync hangs on Windows when the worker is spawned detached with
// stdio:'ignore' (Electron WorkerManager path), because the cmd.exe child
// cannot attach to a console and blocks forever. PATH lookup is side-effect
// free and portable.
export async function detectUv(): Promise<boolean> {
  const pathEnv = process.env.PATH || process.env.Path || '';
  if (!pathEnv) return false;

  const isWin = process.platform === 'win32';
  const sep = isWin ? ';' : ':';
  const exts = isWin
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map(e => e.trim()).filter(Boolean)
    : [''];
  const bin = isWin ? 'uv' : 'uv';

  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      try {
        if (existsSync(candidate)) return true;
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}

export interface ChromaStartResult {
  started: boolean;
  reason?: string;
  pid?: number;
}

export class ChromaProcessManager {
  private proc: ChildProcess | null = null;
  private opts: ChromaProcessOptions;
  private detectFn: () => Promise<boolean>;

  constructor(opts: ChromaProcessOptions) {
    this.opts = { ...opts };
    this.detectFn = opts.detectUv ?? detectUv;
  }

  buildArgv(): string[] {
    const args: string[] = [
      'chroma-mcp',
      '--client-type',
      'persistent',
      '--data-dir',
      this.opts.dataDir,
      '--embedding-function',
      this.opts.embeddingModel,
    ];
    if (this.opts.modelCacheDir) {
      args.push('--model-cache-dir', this.opts.modelCacheDir);
    }
    return args;
  }

  isRunning(): boolean {
    return this.proc !== null && !this.proc.killed;
  }

  async start(): Promise<ChromaStartResult> {
    if (this.isRunning()) {
      return { started: true, pid: this.proc!.pid };
    }
    const hasUv = await this.detectFn();
    if (!hasUv) {
      logger.warn('CHROMA', 'uv not found on PATH — chroma-mcp cannot start');
      return {
        started: false,
        reason: 'uv not installed. See docs/superpowers/TODO.md for install instructions.',
      };
    }

    try {
      const argv = this.buildArgv();
      const env: Record<string, string> = {
        ...process.env as Record<string, string>,
      };
      if (process.env.SSL_CERT_FILE) env.SSL_CERT_FILE = process.env.SSL_CERT_FILE;
      const proc = spawn('uvx', argv, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        windowsHide: true,
      });
      this.proc = proc;
      proc.on('exit', (code, signal) => {
        logger.warn('CHROMA', 'chroma-mcp exited', { code, signal });
        this.proc = null;
      });
      proc.on('error', (err) => {
        logger.error('CHROMA', 'chroma-mcp spawn error', {}, err as Error);
      });
      return { started: true, pid: proc.pid };
    } catch (err) {
      logger.error('CHROMA', 'failed to spawn chroma-mcp', {}, err as Error);
      return { started: false, reason: String(err) };
    }
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    try {
      this.proc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (!this.proc) return resolve();
        this.proc.once('exit', () => resolve());
        setTimeout(() => {
          try { this.proc?.kill('SIGKILL'); } catch {}
          resolve();
        }, 3000);
      });
    } finally {
      this.proc = null;
    }
  }

  getStdio(): { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream } | null {
    if (!this.proc || !this.proc.stdin || !this.proc.stdout) return null;
    return { stdin: this.proc.stdin, stdout: this.proc.stdout };
  }
}
