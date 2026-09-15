import { ChildProcess, fork, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { app } from 'electron';
import * as path from 'path';
import * as http from 'http';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import { getConfig, getWorkerEnv } from '../config/store';

export type WorkerStatus = 'stopped' | 'starting' | 'running' | 'dead';

export class WorkerManager extends EventEmitter {
  private child: ChildProcess | null = null;
  private status: WorkerStatus = 'stopped';
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;
  private restartCount = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private startTimeout: ReturnType<typeof setTimeout> | null = null;
  private logStream: fs.WriteStream | null = null;

  getStatus(): WorkerStatus {
    return this.status;
  }

  private setStatus(newStatus: WorkerStatus): void {
    if (this.status === newStatus) return;
    this.status = newStatus;
    this.emit('status-changed', newStatus);
  }

  private getRepoRoot(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath);
    }
    return path.join(__dirname, '..', '..', '..');
  }

  private getWorkerPath(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'worker', 'bin', 'worker.js');
    }
    return path.join(this.getRepoRoot(), 'dist', 'bin', 'worker.js');
  }

  private getNodePath(): string {
    if (app.isPackaged) {
      const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
      return path.join(process.resourcesPath, nodeName);
    }
    return process.execPath;
  }

  private getLogPath(): string {
    const logDir = path.join(os.homedir(), '.agent-memory', 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    return path.join(logDir, 'worker.log');
  }

  private rotateLogIfNeeded(): void {
    const logPath = this.getLogPath();
    try {
      if (fs.existsSync(logPath)) {
        const stats = fs.statSync(logPath);
        if (stats.size > 10 * 1024 * 1024) {
          for (let i = 2; i >= 1; i--) {
            const from = i === 1 ? logPath : `${logPath}.${i}`;
            const to = `${logPath}.${i + 1}`;
            if (fs.existsSync(from)) {
              if (i === 2) {
                try { fs.unlinkSync(to); } catch {}
              }
              fs.renameSync(from, to);
            }
          }
        }
      }
    } catch {}
  }

  async start(): Promise<void> {
    if (this.status === 'running' || this.status === 'starting') return;
    this.restartCount = 0;
    await this.doStart();
  }

  private async doStart(): Promise<void> {
    const config = getConfig();
    const port = config.port;

    this.setStatus('starting');
    this.clearTimers();

    if (await this.checkExistingWorker(port)) {
      await this.stopDetachedWorker();
      if (await this.checkExistingWorker(port)) {
        this.emit('error', { message: `端口 ${port} 上已有旧服务运行，无法接管` });
        this.setStatus('dead');
        return;
      }
    }

    const portInUse = await this.isPortInUse(port);
    if (portInUse) {
      this.emit('error', { message: `端口 ${port} 被其他程序占用，无法启动服务` });
      this.setStatus('dead');
      return;
    }

    this.rotateLogIfNeeded();
    this.logStream = fs.createWriteStream(this.getLogPath(), { flags: 'a' });

    const workerPath = this.getWorkerPath();
    const env = getWorkerEnv(config);
    const repoRoot = this.getRepoRoot();

    try {
      this.child = fork(workerPath, ['start', '--foreground'], {
        env,
        cwd: repoRoot,
        execPath: this.getNodePath(),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        silent: true,
      });

      // Worker 进程降到 BelowNormal 优先级。重建向量索引时即使把限制后的
      // 线程数全跑满, 调度器也会优先把 CPU 时间片给前台 IDE / 浏览器,
      // 用户感知的"网都断了"症状会消失。失败仅 warn (Windows 部分 antivirus
      // 环境会 EPERM), 不阻塞启动。
      if (this.child?.pid != null) {
        try {
          os.setPriority(this.child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
        } catch (e) {
          // 不能 emit('error') — EventEmitter 在没人监听时会让进程崩溃,
          // 而 setPriority 失败 (Windows EPERM 等) 是可降级的, 不应阻塞启动。
          console.warn('[WorkerManager] setPriority failed (non-fatal):', (e as Error).message);
        }
      }

      this.child.stdout?.pipe(this.logStream);
      this.child.stderr?.pipe(this.logStream);

      this.child.on('exit', (_code) => {
        this.child = null;
        if (this.status === 'stopped') return;
        this.setStatus('dead');
        this.tryAutoRestart();
      });

      this.child.on('error', (err) => {
        this.emit('error', { message: err.message });
      });

      this.startTimeout = setTimeout(() => {
        if (this.status === 'starting') {
          this.setStatus('dead');
          this.tryAutoRestart();
        }
      }, 30000);

      this.startHealthCheck();
    } catch (err: any) {
      this.emit('error', { message: `启动 Worker 失败: ${err.message}` });
      this.setStatus('dead');
    }
  }

  async stop(): Promise<void> {
    this.clearTimers();
    this.restartCount = 0;

    if (!this.child) {
      await this.stopDetachedWorker();
      this.setStatus('stopped');
      return;
    }

    this.setStatus('stopped');

    try {
      this.child.send('shutdown');
    } catch {}

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.child) {
          this.child.kill();
          this.child = null;
        }
        resolve();
      }, 10000); // 10s — 留时间给 worker 跑 vectorStore.flush() + close()

      this.child?.on('exit', () => {
        clearTimeout(timeout);
        this.child = null;
        resolve();
      });
    });

    this.logStream?.end();
    this.logStream = null;
  }

  private async stopDetachedWorker(): Promise<void> {
    const workerPath = this.getWorkerPath();
    const repoRoot = this.getRepoRoot();
    const env = getWorkerEnv(getConfig());

    await new Promise<void>((resolve) => {
      const child = spawn(this.getNodePath(), [workerPath, 'stop'], {
        env,
        cwd: repoRoot,
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      });

      const timeout = setTimeout(() => {
        try { child.kill(); } catch {}
        resolve();
      }, 10000);

      child.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      child.on('error', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  private tryAutoRestart(): void {
    const config = getConfig();
    if (this.restartCount >= config.maxRestartAttempts) {
      this.emit('error', { message: '服务多次重启失败，请检查日志' });
      return;
    }

    this.restartCount++;
    const delay = 3000 * Math.pow(2, this.restartCount - 1);
    this.emit('restart-attempt', {
      attempt: this.restartCount,
      maxAttempts: config.maxRestartAttempts,
    });

    this.restartTimer = setTimeout(() => {
      this.doStart();
    }, delay);
  }

  private startHealthCheck(): void {
    this.stopHealthCheck();
    const config = getConfig();

    const check = async () => {
      const healthy = await this.healthCheck(config.port);
      if (healthy) {
        this.consecutiveFailures = 0;
        if (this.status === 'starting') {
          if (this.startTimeout) {
            clearTimeout(this.startTimeout);
            this.startTimeout = null;
          }
          this.setStatus('running');
        }
      } else {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= 3 && this.status === 'running') {
          this.setStatus('dead');
          this.tryAutoRestart();
        }
      }
    };

    check();
    this.healthTimer = setInterval(check, config.healthCheckInterval);
  }

  private stopHealthCheck(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    this.consecutiveFailures = 0;
  }

  private clearTimers(): void {
    this.stopHealthCheck();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.startTimeout) {
      clearTimeout(this.startTimeout);
      this.startTimeout = null;
    }
  }

  private healthCheck(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json.status === 'healthy');
          } catch {
            resolve(res.statusCode === 200);
          }
        });
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  private async checkExistingWorker(port: number): Promise<boolean> {
    return this.healthCheck(port);
  }

  private isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(true));
      server.once('listening', () => { server.close(); resolve(false); });
      server.listen(port, '127.0.0.1');
    });
  }

  async destroy(): Promise<void> {
    await this.stop();
  }
}
