/**
 * ImportProgressPoller — Worker → Electron 主进程的导入进度桥接。
 *
 * 与 VectorProgressPoller 同构,但目标 endpoint 是 /api/import/status,
 * 节奏更慢一些(默认 2s),因为单次 turn 的 AI 调用通常 3–10s,无需更快。
 *
 * 监听者(典型: ImportProgressPanel + TrayManager)只需 .on('snapshot', s)
 * 拿到最新状态即可,内部事件总线由 main.ts 接驳。
 */
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import { WorkerManager, type WorkerStatus } from './WorkerManager';
import { getConfig } from '../config/store';

/**
 * 与 src/services/import/types.ts:ImportProgressSnapshot 保持同形。
 * desktop tsconfig.rootDir = src,所以这里本地复制类型,避免跨包导入。
 */
export interface ImportProgressSnapshot {
  phase: 'discovering' | 'running' | 'done' | 'cancelled' | 'failed';
  totalSessions: number;
  processedSessions: number;
  importedSummaries: number;
  skippedSessions: number;
  failedSessions: number;
  currentAdapterId?: string;
  currentFilePath?: string;
  etaSec: number | null;
  errorMessage?: string;
}

export interface ImportStatusEnvelope {
  success: boolean;
  inProgress: boolean;
  progress: ImportProgressSnapshot | null;
  lastResult: unknown;
  startedAt: number | null;
}

export class ImportProgressPoller extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private readonly intervalMs: number;
  /**
   * 是否处于"用户期望接收进度"的状态。默认 false——因为大多数时候没有
   * 导入在跑,持续轮询是浪费;由 TrayManager / SetupWizard 在触发导入时
   * .activate() 一下,在收到 done/failed 后自动 .deactivate()。
   */
  private active = false;

  constructor(private workerManager: WorkerManager, intervalMs = 2000) {
    super();
    this.intervalMs = intervalMs;
  }

  start(): void {
    this.workerManager.on('status-changed', (status: WorkerStatus) => {
      if (status === 'running' && this.active) this.startPolling();
      else this.stopPolling();
    });
  }

  stop(): void {
    this.stopPolling();
    this.removeAllListeners();
  }

  /** 由 UI 触发导入流程时调用,激活轮询。 */
  activate(): void {
    if (this.active) return;
    this.active = true;
    if (this.workerManager.getStatus() === 'running') this.startPolling();
  }

  /** 收到终态 snapshot 后由内部调用,停止轮询节省 CPU。 */
  private deactivate(): void {
    this.active = false;
    this.stopPolling();
  }

  private startPolling(): void {
    if (this.timer) return;
    this.tickOnce();
    this.timer = setInterval(() => this.tickOnce(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  private stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tickOnce(): void {
    if (this.inFlight) return;
    this.inFlight = true;
    const port = getConfig().port;
    const req = http.get(
      `http://127.0.0.1:${port}/api/import/status`,
      { timeout: 3000 },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          this.inFlight = false;
          try {
            const env = JSON.parse(data) as ImportStatusEnvelope;
            this.emit('snapshot', env.progress ?? null);
            const phase = env.progress?.phase ?? null;
            // 自动停轮询:终态后 UI 已经看到结果,不必再消耗。
            if (
              !env.inProgress &&
              (phase === 'done' || phase === 'failed' || phase === 'cancelled')
            ) {
              this.deactivate();
            }
          } catch {
            this.emit('snapshot', null);
          }
        });
      },
    );
    req.on('error', () => {
      this.inFlight = false;
      this.emit('snapshot', null);
    });
    req.on('timeout', () => {
      req.destroy();
      this.inFlight = false;
    });
  }
}
