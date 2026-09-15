import { Tray, Menu, nativeImage, Notification, app, shell, globalShortcut } from 'electron';
import type { NativeImage, Rectangle } from 'electron';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { WorkerManager, WorkerStatus } from '../worker/WorkerManager';
import type { VectorStatusSnapshot } from '../worker/VectorProgressPoller';
import { getConfig, setConfig, type VectorIndexerProfile } from '../config/store';
import type { ViewerOpenOptions } from '../windows/ViewerWindow';
import type { UpdateInfo } from '../services/UpdateChecker';

export class TrayManager {
  private tray: Tray | null = null;
  private workerManager: WorkerManager;
  private onShowQuickPanel: (anchorBounds?: Rectangle) => void;
  private onShowSettings: () => void;
  private onOpenViewer: (opts?: ViewerOpenOptions) => void;
  private onCheckUpdate: (() => Promise<void>) | null = null;
  /** 切档时通知 VectorProgressPanel 抑制重启间隙的误关闭, ms 后自动解除 */
  private onSuppressVectorPanelClose: ((ms: number) => void) | undefined;
  /** 触发"导入历史对话"流程的回调,由 main.ts 注入 (激活 poller + POST /api/import/run) */
  private onTriggerImportHistory: (() => void) | undefined;
  private startTime: Date | null = null;
  private latestUpdate: UpdateInfo | null = null;
  /** 最近一次 vec status 轮询快照,用于菜单/tooltip 进度展示 */
  private vectorSnapshot: VectorStatusSnapshot | null = null;
  /** 最近一次 import status 轮询快照,用于菜单状态显示 */
  private importInProgress = false;

  constructor(
    workerManager: WorkerManager,
    onShowQuickPanel: (anchorBounds?: Rectangle) => void,
    onShowSettings: () => void,
    onOpenViewer: (opts?: ViewerOpenOptions) => void,
    onSuppressVectorPanelClose?: (ms: number) => void,
    onTriggerImportHistory?: () => void,
  ) {
    this.workerManager = workerManager;
    this.onShowQuickPanel = onShowQuickPanel;
    this.onShowSettings = onShowSettings;
    this.onOpenViewer = onOpenViewer;
    this.onSuppressVectorPanelClose = onSuppressVectorPanelClose;
    this.onTriggerImportHistory = onTriggerImportHistory;
  }

  init(): void {
    this.tray = new Tray(this.buildTrayImage('gray'));
    this.tray.setToolTip('AgentMemory');

    this.tray.on('click', (_event, bounds) => {
      if (process.platform === 'darwin') {
        // A macOS menu-bar item is expected to open its menu on a normal click.
        // The previous Windows-style behavior opened only QuickPanel, leaving
        // Settings, Viewer and service controls discoverable only via right-click.
        this.tray?.popUpContextMenu();
        return;
      }
      this.onShowQuickPanel(bounds);
    });

    this.updateMenu();
    this.registerShortcut();

    if (process.platform === 'darwin') {
      // Keep a concrete diagnostic in the app log for menu-bar visibility
      // issues (notches and third-party menu-bar managers can move the item).
      setImmediate(() => {
        console.log('[TrayManager] macOS menu-bar item ready:', this.tray?.getBounds());
      });
    }

    this.workerManager.on('status-changed', (status: WorkerStatus) => {
      this.updateIcon(status);
      this.updateMenu();
      if (status === 'running') this.startTime = new Date();
      if (status === 'stopped') this.startTime = null;
    });

    this.workerManager.on('restart-attempt', ({ attempt, maxAttempts }: { attempt: number; maxAttempts: number }) => {
      new Notification({
        title: 'AgentMemory',
        body: `服务异常，正在自动重启 (${attempt}/${maxAttempts})...`,
      }).show();
    });

    this.workerManager.on('error', ({ message }: { message: string }) => {
      new Notification({
        title: 'AgentMemory',
        body: message,
      }).show();
    });
  }

  private getIconPath(color: string): string {
    const fileName = process.platform === 'darwin'
      ? `icon-${color}-tray.png`
      : `icon-${color}.png`;

    if (app.isPackaged) {
      // asar is disabled, so use 'app' directory instead of 'app.asar'
      return path.join(process.resourcesPath, 'app', 'dist', 'assets', fileName);
    }
    return path.join(__dirname, '..', 'assets', fileName);
  }

  private buildTrayImage(color: string): NativeImage {
    const image = nativeImage.createFromPath(this.getIconPath(color));
    if (process.platform !== 'darwin') return image;

    // 18 pt is the conventional menu-bar size and leaves enough vertical
    // padding when the menu bar changes height across displays / full-screen.
    const trayImage = image.resize({ width: 18, height: 18 });
    // Template images automatically remain visible on both light and dark menu bars.
    trayImage.setTemplateImage(true);
    return trayImage;
  }

  private updateIcon(status: WorkerStatus): void {
    const colorMap: Record<WorkerStatus, string> = {
      running: 'green',
      starting: 'yellow',
      dead: 'red',
      stopped: 'gray',
    };
    this.tray?.setImage(this.buildTrayImage(colorMap[status]));
  }

  /** Worker 上报的向量索引状态(VectorProgressPoller emit 'snapshot' 时调用) */
  setVectorStatus(snapshot: VectorStatusSnapshot | null): void {
    this.vectorSnapshot = snapshot;
    this.refreshTooltip();
    this.updateMenu();
  }

  /**
   * Worker 上报的"导入历史对话"流程进度。
   * 由 main.ts 的 ImportProgressPoller 'snapshot' 事件转发,
   * 用于在菜单中切换"导入历史对话…" / "正在导入历史对话…"两种状态。
   */
  setImportInProgress(inProgress: boolean): void {
    if (this.importInProgress === inProgress) return;
    this.importInProgress = inProgress;
    this.updateMenu();
  }

  private refreshTooltip(): void {
    if (!this.tray) return;
    const status = this.workerManager.getStatus();
    const base = `AgentMemory · ${status === 'running' ? '运行中' : status === 'starting' ? '启动中' : status === 'dead' ? '已停止' : '未启动'}`;
    const idx = this.formatIndexerProgress();
    this.tray.setToolTip(idx ? `${base}\n${idx}` : base);
  }

  /**
   * 把当前向量索引状态压成一行人类可读的摘要,放进 tooltip 与菜单。
   * 例:
   *   "向量索引: reindex 中 2341 / 9920 (24%)"
   *   "向量索引: 模型加载中..."
   *   "向量索引: 100% 已就绪 (12345 条)"
   *   "向量索引: 未启用"
   */
  private formatIndexerProgress(): string {
    const s = this.vectorSnapshot;
    if (!s) return '';
    if (!s.available) return '向量索引: 未启用';
    if (s.model && s.model.status !== 'ready' && s.model.status !== 'uninitialized') {
      const map: Record<string, string> = {
        downloading: '加载模型中…',
        failed: `模型加载失败 (${s.model.lastError ?? ''})`,
      };
      return `向量索引: ${map[s.model.status] ?? s.model.status}`;
    }
    if (s.indexer?.status === 'running') {
      const obs = s.indexer.observations;
      const sum = s.indexer.summaries;
      const totalA = (obs.total ?? 0) + (sum.total ?? 0);
      const doneA = obs.embedded + sum.embedded;
      const pct = totalA > 0 ? Math.floor((doneA / totalA) * 100) : 0;
      return `向量索引: 重建中 ${doneA} / ${totalA} (${pct}%)`;
    }
    if (s.coverage) {
      const pct = Math.round((s.coverage.total ?? 0) * 100);
      const total = s.vectorIndex?.totalDocs ?? 0;
      return `向量索引: ${pct}% 已就绪 (${total} 条)`;
    }
    return '';
  }

  private getUptimeString(): string {
    if (!this.startTime) return '';
    const ms = Date.now() - this.startTime.getTime();
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  private updateMenu(): void {
    const status = this.workerManager.getStatus();
    const config = getConfig();
    const isRunning = status === 'running';
    const statusLabels: Record<WorkerStatus, string> = {
      running: `● 服务运行中 (${this.getUptimeString()})`,
      starting: '◐ 服务启动中...',
      dead: '● 服务已停止',
      stopped: '○ 服务未启动',
    };

    const menu = Menu.buildFromTemplate([
      { label: `AgentMemory v${app.getVersion()}`, enabled: false },
      { label: statusLabels[status], enabled: false },
      ...(this.formatIndexerProgress()
        ? [{ label: this.formatIndexerProgress(), enabled: false }]
        : []),
      { type: 'separator' },
      {
        label: `快速搜索  ${config.globalShortcut}`,
        click: () => this.onShowQuickPanel(this.tray?.getBounds()),
        enabled: isRunning,
      },
      {
        label: '打开记忆浏览器',
        click: () => this.onOpenViewer(),
        enabled: isRunning,
      },
      {
        label: 'ShadwMonitor 插件',
        submenu: [
          {
            label: '打开 ShadwMonitor Web (8080)',
            click: () => { shell.openExternal('http://localhost:8080'); },
          },
          {
            label: '在记忆浏览器中查看 (Tab=ShadwMonitor)',
            click: () => { shell.openExternal('http://localhost:3847/viewer.html?tab=shadwmonitor'); },
            enabled: isRunning,
          },
          { type: 'separator' },
          {
            label: '查看插件 README',
            click: () => {
              const pluginDir = app.isPackaged
                ? process.platform === 'darwin'
                  ? path.join(os.homedir(), '.agent-memory', 'plugins', 'shadwmonitor')
                  : path.join(process.resourcesPath, 'plugins', 'shadwmonitor')
                : path.join(process.cwd(), 'plugins', 'shadwmonitor');
              shell.openPath(pluginDir);
            },
          },
        ],
      },
      { type: 'separator' },
      {
        label: '启动服务',
        click: () => this.workerManager.start(),
        visible: !isRunning && status !== 'starting',
      },
      {
        label: '停止服务',
        click: () => this.workerManager.stop(),
        visible: isRunning || status === 'starting',
      },
      {
        label: '重启服务',
        click: () => this.workerManager.restart(),
        enabled: isRunning,
      },
      {
        label: '立即重建向量索引',
        click: () => this.triggerManualReindex(),
        enabled: isRunning && this.vectorSnapshot?.indexer?.status !== 'running',
      },
      {
        label: this.importInProgress ? '正在导入历史对话…' : '导入历史对话…',
        click: () => this.onTriggerImportHistory?.(),
        enabled: isRunning && !this.importInProgress && !!this.onTriggerImportHistory,
      },
      // beta.8: 索引性能档位 + 暂停/恢复
      {
        label: '索引性能',
        submenu: [
          {
            label: '省电（默认,不影响其他程序）',
            type: 'radio',
            checked: (config.vectorIndexerProfile ?? 'eco') === 'eco',
            click: () => this.setIndexerProfile('eco'),
          },
          {
            label: '普通',
            type: 'radio',
            checked: config.vectorIndexerProfile === 'normal',
            click: () => this.setIndexerProfile('normal'),
          },
          {
            label: '高速（最快但可能会卡）',
            type: 'radio',
            checked: config.vectorIndexerProfile === 'fast',
            click: () => this.setIndexerProfile('fast'),
          },
          { type: 'separator' },
          {
            label: '档位说明:省电=2 线程,普通≈一半核心,高速=几乎全部核心。',
            enabled: false,
          },
        ],
      },
      {
        label: this.vectorSnapshot?.indexer?.paused ? '继续索引' : '暂停索引',
        click: () => this.toggleIndexerPause(),
        enabled: isRunning && this.vectorSnapshot?.indexer?.status === 'running',
      },
      { type: 'separator' },
      {
        label: this.latestUpdate ? `🔔 新版本 v${this.latestUpdate.version} 可用` : '检查更新',
        click: () => {
          if (this.latestUpdate) {
            shell.openExternal(this.latestUpdate.downloadPage);
          } else if (this.onCheckUpdate) {
            void this.onCheckUpdate();
          }
        },
      },
      {
        label: '设置...',
        click: () => this.onShowSettings(),
      },
      { type: 'separator' },
      {
        label: '打开日志目录',
        click: () => {
          const logDir = path.join(os.homedir(), '.agent-memory', 'logs');
          shell.openPath(logDir);
        },
      },
      {
        label: '退出',
        click: () => {
          this.workerManager.stop().then(() => app.quit());
        },
      },
    ]);

    this.tray?.setContextMenu(menu);
  }

  setUpdateInfo(info: UpdateInfo): void {
    this.latestUpdate = info;
    this.updateMenu();
  }

  setCheckUpdateHandler(handler: () => Promise<void>): void {
    this.onCheckUpdate = handler;
  }

  /**
   * 手动触发后台 reindexAll(走 watermark 续做,不重做已 embed 的部分)。
   * 通过 Worker 的 POST /api/vector/reindex 端点。
   *
   * 用户场景:
   *   - 升级到 2.1.0-beta.5 之前的版本时遗留了未 embed 的 LLM rolling summaries
   *   - 之前 reindex 中断没跑完
   *   - 任何怀疑 vec.db 落后的情况
   *
   * 安全:reindex 在跑时会被 hybridIndexer 内部锁互斥,重复点不会重叠。
   */
  private async triggerManualReindex(): Promise<void> {
    const port = getConfig().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/vector/reindex`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        new Notification({
          title: 'AgentMemory',
          body: '已开始重建向量索引,进度将显示在托盘菜单中。',
        }).show();
      } else {
        const text = await res.text().catch(() => '');
        new Notification({
          title: 'AgentMemory',
          body: `重建向量索引失败 (${res.status}): ${text.substring(0, 120)}`,
        }).show();
      }
    } catch (err) {
      new Notification({
        title: 'AgentMemory',
        body: `重建向量索引失败:${err instanceof Error ? err.message : String(err)}`,
      }).show();
    }
  }

  /**
   * beta.8: 切换索引性能档位 — 立即生效。
   *
   * 实现:
   *   1. 写入 desktop-config 持久化新档位
   *   2. 通知 VectorProgressPanel 抑制后续 ~6s 内的"误关闭"(worker 重启间隙
   *      poller 会短暂拿不到 indexer.status='running', 否则 panel 会触发
   *      markDoneAndClose, 用户体验是面板闪一下消失)
   *   3. 异步调 workerManager.restart() — 内部 stop() 会 IPC 触发 worker 跑
   *      vectorStore.flush() 落盘, start() 重新 fork 时把新 OMP_NUM_THREADS /
   *      AGENTMEM_VECTOR_INDEXER_PROFILE 注入进去
   *   4. 重启完毕后 bootstrap 检测 vec.db 落后 → 自动续建(watermark, 已 embed
   *      的部分不重做; 体感上"切档秒生效, 进度无感继续")
   *
   * 用户视角: 点击档位 → 通知"切换中…" → ~3s 后自动按新档位继续重建,
   * 不需要任何手动操作。
   */
  private setIndexerProfile(profile: VectorIndexerProfile): void {
    const prev = getConfig().vectorIndexerProfile ?? 'eco';
    if (prev === profile) return;
    setConfig({ vectorIndexerProfile: profile });
    const labels: Record<VectorIndexerProfile, string> = {
      eco: '省电',
      normal: '普通',
      fast: '高速',
    };
    this.updateMenu();

    // 通知 panel 抑制重启间隙的 markDoneAndClose
    this.onSuppressVectorPanelClose?.(6000);

    new Notification({
      title: 'AgentMemory',
      body: `正在切换到 ${labels[profile]} 档,Worker 重启中…`,
    }).show();

    // 异步重启 — 不阻塞菜单回调
    this.workerManager.restart().then(() => {
      new Notification({
        title: 'AgentMemory',
        body: `${labels[profile]} 档已生效,索引会自动从中断处续建。`,
      }).show();
    }).catch((err: unknown) => {
      new Notification({
        title: 'AgentMemory',
        body: `切档失败,Worker 未能重启: ${err instanceof Error ? err.message : String(err)}`,
      }).show();
    });
  }

  /**
   * beta.8: 暂停 / 恢复 reindex。当前 page 处理完后, indexer 会卡在 gate 上,
   * 直到 resume。增量 drain 不受影响。
   */
  private toggleIndexerPause(): void {
    const port = getConfig().port;
    const paused = !!this.vectorSnapshot?.indexer?.paused;
    const apiPath = paused ? '/api/vector/resume' : '/api/vector/pause';
    const req = http.request({
      host: '127.0.0.1', port, path: apiPath, method: 'POST', timeout: 3000,
    }, (res) => { res.on('data', () => {}); res.on('end', () => {}); });
    req.on('error', () => {/* swallow */ });
    req.on('timeout', () => req.destroy());
    req.end();
  }

  registerShortcut(): void {
    const config = getConfig();
    const registered = globalShortcut.register(config.globalShortcut, () => {
      this.onShowQuickPanel(this.tray?.getBounds());
    });

    if (!registered) {
      new Notification({
        title: 'AgentMemory',
        body: `快捷键 ${config.globalShortcut} 注册失败（可能被其他应用占用），请在设置中修改`,
      }).show();
    }
  }

  destroy(): void {
    globalShortcut.unregisterAll();
    this.tray?.destroy();
    this.tray = null;
  }
}
