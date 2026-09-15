/**
 * VectorProgressPoller — Worker → Electron 主进程的索引进度桥接。
 *
 * Worker 内部维护 hybridIndexer.getProgress(),通过 HTTP `/api/vector/status`
 * 暴露。这里在 Electron 主进程开一个 2s 间隔的轮询,把当前进度 emit 给监听者
 * (典型: TrayManager)。
 *
 * 为什么轮询而不是 fork IPC?
 *   - Worker 是独立 fork 的 node 子进程,fork 的 IPC channel 已经被原有的
 *     'shutdown' 消息 + WorkerManager 的 child.send 占用,功能耦合度变高
 *   - Worker 已经原生暴露 HTTP API,主进程已有 healthCheck 走 http.get,
 *     沿用这一路径风险最低
 *   - 2s 一次的本机 HTTP GET 开销可以忽略 (~1ms)
 *
 * 自动启停: 监听 WorkerManager 状态,running → 启动轮询; 其它 → 停止。
 */
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import { WorkerManager, type WorkerStatus } from './WorkerManager';
import { getConfig } from '../config/store';

export interface VectorStatusSnapshot {
  available: boolean;
  reason?: string;
  vectorIndex?: { totalDocs: number; observations: number; summaries: number };
  agentMemoryDb?: { observations: number; summaries: number };
  coverage?: { observations: number; summaries: number; total: number };
  model?: { status: string; lastError?: string };
  indexer?: {
    status: 'idle' | 'running' | 'failed';
    observations: { processed: number; embedded: number; total?: number; previouslyEmbedded?: number };
    summaries: { processed: number; embedded: number; total?: number; previouslyEmbedded?: number };
    lastError?: string;
    paused?: boolean;
  };
  bootstrapTriggered?: boolean;
}

export class VectorProgressPoller extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private readonly intervalMs: number;

  constructor(private workerManager: WorkerManager, intervalMs = 2000) {
    super();
    this.intervalMs = intervalMs;
  }

  start(): void {
    this.workerManager.on('status-changed', (status: WorkerStatus) => {
      if (status === 'running') this.startPolling();
      else this.stopPolling();
    });
    if (this.workerManager.getStatus() === 'running') this.startPolling();
  }

  stop(): void {
    this.stopPolling();
    this.removeAllListeners();
  }

  private startPolling(): void {
    if (this.timer) return;
    // 立刻先打一次,避免菜单首次显示时空了 2s
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
      `http://127.0.0.1:${port}/api/vector/status`,
      { timeout: 3000 },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          this.inFlight = false;
          try {
            const snap = JSON.parse(data) as VectorStatusSnapshot;
            this.emit('snapshot', snap);
          } catch {
            // 503 / 错误 body 都吞掉 — 503 通常是 hybrid 栈没初始化(初装无数据)
            this.emit('snapshot', { available: false, reason: 'parse error' });
          }
        });
      }
    );
    req.on('error', () => {
      this.inFlight = false;
      // Worker 重启间隙的连接错误,emit 一个 unavailable 让 UI 自动隐藏进度
      this.emit('snapshot', { available: false, reason: 'http error' });
    });
    req.on('timeout', () => {
      req.destroy();
      this.inFlight = false;
    });
  }
}
