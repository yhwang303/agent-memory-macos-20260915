/**
 * ShadwMonitor 插件子进程管理
 *
 * 启停 plugins/shadwmonitor/src/main.py 的 capture / web 两个进程，
 * 自动捕获日志、检测崩溃，向桌面端通过 EventEmitter 推状态。
 *
 * 后续 PyInstaller 打包完成后（docs/release/features/shadwmonitor-pyinstaller-bundle/），
 * 这里只需要把 `python src/main.py` 改成 `shadwmonitor.exe`，调用方完全无感。
 */

import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
import { ShadwMonitorConfigBridge } from './ShadwMonitorConfigBridge';

export type ShadwProcessStatus = 'stopped' | 'starting' | 'running' | 'dead';

export interface ShadwHealthSnapshot {
  capture: ShadwProcessStatus;
  web: ShadwProcessStatus;
  capturePid: number | null;
  webPid: number | null;
  startedAt: number | null;
  lastError: string | null;
}

interface ProcessHandle {
  child: ChildProcess;
  logStream: fs.WriteStream;
  startedAt: number;
}

export class ShadwMonitorProcessManager extends EventEmitter {
  private captureHandle: ProcessHandle | null = null;
  private webHandle: ProcessHandle | null = null;
  private captureStatus: ShadwProcessStatus = 'stopped';
  private webStatus: ShadwProcessStatus = 'stopped';
  private lastError: string | null = null;
  private startedAt: number | null = null;

  private readonly bridge: ShadwMonitorConfigBridge;
  private readonly logDir: string;

  constructor(bridge?: ShadwMonitorConfigBridge) {
    super();
    this.bridge = bridge ?? new ShadwMonitorConfigBridge();
    this.logDir = path.join(os.homedir(), '.agent-memory', 'logs', 'shadwmonitor');
  }

  getStatus(): ShadwHealthSnapshot {
    return {
      capture: this.captureStatus,
      web: this.webStatus,
      capturePid: this.captureHandle?.child.pid ?? null,
      webPid: this.webHandle?.child.pid ?? null,
      startedAt: this.startedAt,
      lastError: this.lastError,
    };
  }

  /** 检测 Python 是否可用 + 是否装了关键依赖。 */
  async detectPython(): Promise<{ ok: boolean; version: string | null; missingDeps: string[]; error?: string }> {
    try {
      const ver = await this.runPythonCheck(['--version']);
      const versionLine = (ver.stdout + ver.stderr).trim();
      // 检测关键依赖（importable check 避免误判 .egg-info 缺失但模块可用）
      const probe = await this.runPythonCheck([
        '-c',
        'import sys; mods = ["httpx", "aiosqlite", "fastapi", "mcp"]; missing = []\nfor m in mods:\n    try:\n        __import__(m)\n    except Exception:\n        missing.append(m)\nprint(",".join(missing))',
      ]);
      const missingDeps = probe.stdout.trim() ? probe.stdout.trim().split(',') : [];
      return { ok: true, version: versionLine || null, missingDeps };
    } catch (err: any) {
      return { ok: false, version: null, missingDeps: [], error: err?.message || String(err) };
    }
  }

  /** 触发 pip install -r requirements.txt 安装依赖；返回 exit code。 */
  async installDependencies(): Promise<{ ok: boolean; output: string; exitCode: number }> {
    const pluginRoot = ShadwMonitorConfigBridge.defaultPluginRoot();
    const requirementsPath = path.join(pluginRoot, 'requirements.txt');
    if (!fs.existsSync(requirementsPath)) {
      return { ok: false, output: `requirements.txt not found: ${requirementsPath}`, exitCode: -1 };
    }
    return await new Promise((resolve) => {
      const chunks: string[] = [];
      const child = spawn(this.getPythonCommand(), ['-m', 'pip', 'install', '-r', requirementsPath], {
        cwd: pluginRoot,
        shell: process.platform === 'win32',
      });
      child.stdout?.on('data', (b) => chunks.push(b.toString()));
      child.stderr?.on('data', (b) => chunks.push(b.toString()));
      child.on('exit', (code) => resolve({ ok: code === 0, output: chunks.join(''), exitCode: code ?? -1 }));
      child.on('error', (err) => resolve({ ok: false, output: err.message, exitCode: -1 }));
    });
  }

  /** 启动 capture + web 两个进程；幂等。 */
  async start(): Promise<{ ok: boolean; error?: string }> {
    if (this.captureStatus !== 'stopped' && this.webStatus !== 'stopped') {
      return { ok: true };
    }
    const pluginRoot = ShadwMonitorConfigBridge.defaultPluginRoot();
    if (!fs.existsSync(pluginRoot)) {
      const error = `ShadwMonitor 插件目录不存在: ${pluginRoot}`;
      this.lastError = error;
      this.emit('error', { message: error });
      return { ok: false, error };
    }
    await fsp.mkdir(this.logDir, { recursive: true });

    const capRes = await this.spawnComponent('capture', pluginRoot);
    if (!capRes.ok) {
      return { ok: false, error: `capture 启动失败: ${capRes.error}` };
    }
    const webRes = await this.spawnComponent('web', pluginRoot);
    if (!webRes.ok) {
      await this.stopComponent('capture');
      return { ok: false, error: `web 启动失败: ${webRes.error}` };
    }
    this.startedAt = Date.now();
    this.lastError = null;
    this.emitStatus();
    return { ok: true };
  }

  async stop(): Promise<void> {
    await Promise.all([this.stopComponent('capture'), this.stopComponent('web')]);
    this.startedAt = null;
    this.emitStatus();
  }

  async restart(): Promise<{ ok: boolean; error?: string }> {
    await this.stop();
    return await this.start();
  }

  destroy(): void {
    void this.stop();
  }

  // ── internals ──

  private async spawnComponent(kind: 'capture' | 'web', pluginRoot: string): Promise<{ ok: boolean; error?: string }> {
    const logPath = path.join(this.logDir, `${kind}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    logStream.write(`\n[${new Date().toISOString()}] === starting ${kind} ===\n`);

    const setStatus = (s: ShadwProcessStatus) => {
      if (kind === 'capture') this.captureStatus = s;
      else this.webStatus = s;
      this.emitStatus();
    };
    setStatus('starting');

    try {
      const child = spawn(this.getPythonCommand(), ['src/main.py', kind], {
        cwd: pluginRoot,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1',
        },
        shell: process.platform === 'win32',
      });
      child.stdout?.pipe(logStream);
      child.stderr?.pipe(logStream);

      child.on('exit', (code, signal) => {
        const wasRunning = (kind === 'capture' ? this.captureStatus : this.webStatus) === 'running';
        logStream.write(`\n[${new Date().toISOString()}] exited code=${code} signal=${signal}\n`);
        logStream.end();
        if (kind === 'capture') this.captureHandle = null;
        else this.webHandle = null;
        const desired = (kind === 'capture' ? this.captureStatus : this.webStatus) === 'stopped';
        if (!desired) {
          setStatus('dead');
          this.lastError = `${kind} 进程异常退出 (code=${code})`;
          this.emit('error', { message: this.lastError });
        }
      });

      child.on('error', (err) => {
        logStream.write(`spawn error: ${err.message}\n`);
        this.lastError = `${kind} spawn 失败: ${err.message}`;
        setStatus('dead');
        this.emit('error', { message: this.lastError });
      });

      const handle: ProcessHandle = { child, logStream, startedAt: Date.now() };
      if (kind === 'capture') this.captureHandle = handle;
      else this.webHandle = handle;

      // 简单等待 1.5s 验证未立即退出
      await new Promise((r) => setTimeout(r, 1500));
      if (child.killed || child.exitCode !== null) {
        return { ok: false, error: `${kind} 进程立即退出 (exit=${child.exitCode})` };
      }
      setStatus('running');
      return { ok: true };
    } catch (err: any) {
      logStream.end();
      const msg = err?.message || String(err);
      this.lastError = `${kind} 启动异常: ${msg}`;
      setStatus('dead');
      return { ok: false, error: msg };
    }
  }

  private async stopComponent(kind: 'capture' | 'web'): Promise<void> {
    const handle = kind === 'capture' ? this.captureHandle : this.webHandle;
    if (kind === 'capture') this.captureStatus = 'stopped';
    else this.webStatus = 'stopped';
    if (!handle) return;
    try {
      // Windows 没有 SIGTERM 概念，直接 kill
      handle.child.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
    } catch {}
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { handle.child.kill('SIGKILL'); } catch {}
        resolve();
      }, 3000);
      handle.child.on('exit', () => { clearTimeout(timer); resolve(); });
    });
    handle.logStream.end();
    if (kind === 'capture') this.captureHandle = null;
    else this.webHandle = null;
  }

  private emitStatus(): void {
    this.emit('status-changed', this.getStatus());
  }

  private getPythonCommand(): string {
    // 优先 PATH 上的 python；将来打包成 .exe 后改成 shadwmonitor.exe 绝对路径
    return process.platform === 'win32' ? 'python' : 'python3';
  }

  private runPythonCheck(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.getPythonCommand(), args, { shell: process.platform === 'win32' });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (b) => { stdout += b.toString(); });
      child.stderr?.on('data', (b) => { stderr += b.toString(); });
      child.on('exit', (code) => {
        if (code === 0) resolve({ stdout, stderr, code });
        else reject(new Error(`python check failed (code=${code}): ${stderr || stdout}`));
      });
      child.on('error', (err) => reject(err));
    });
  }
}
