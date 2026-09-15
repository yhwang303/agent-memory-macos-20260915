/**
 * ImportProgressPanel — 右下角浮窗,在历史对话导入(retroactive history
 * import)期间显示进度条。复刻 VectorProgressPanel 的样式,因此用户在两
 * 个流程里看到的是同一种"风格一致的轻量提示窗"。
 *
 * 触发逻辑(由 main.ts 的 ImportProgressPoller / EventBus 监听器驱动):
 *   - phase 从非 running 切到 running       → showWithProgress()
 *   - phase 保持 running                    → updateProgress()
 *   - phase 切到 'done' / 'cancelled' / 'failed' → markDoneAndClose()(2s 后关闭)
 *
 * 设计要点(与 VectorProgressPanel 完全对齐):
 *   - 透明背景 + 圆角阴影,不抢焦点
 *   - 不在 dock / 任务栏出现
 *   - 用户关掉窗口不影响后台任务(Worker 进程内的 runImport 继续跑)
 *   - macOS dock.hide() 已在 main.ts 设过,这里 skipTaskbar 保证 Win 也不出现
 */
import { BrowserWindow, screen } from 'electron';
import * as path from 'path';
import type { ImportProgressSnapshot } from '../worker/ImportProgressPoller';

const PANEL_WIDTH = 340;
const PANEL_HEIGHT = 140;
const EDGE_PADDING = 16;
const AUTO_CLOSE_DELAY_MS = 2000;

export class ImportProgressPanel {
  private window: BrowserWindow | null = null;
  private autoCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private isImportRunning = false;

  /**
   * 喂入 Worker 推送的最新 ImportProgressSnapshot。
   * 内部决定要不要显示 / 更新 / 关闭。
   *
   * 重要:不要在 'discovering' 阶段显示面板。Discovery 是纯文件 IO 扫盘,
   * 没有 AI 调用,通常 1-3 秒内结束。给用户看一个"正在统计可导入的会话数
   * (不调用 AI)..."的浮窗反而吓人——他会以为自己马上要被 AI 跑很多次。
   * 只在 phase === 'running'(真正开始调用 AI 处理候选 turn)时才显示。
   */
  feed(snap: ImportProgressSnapshot | null): void {
    const phase = snap?.phase ?? null;
    // 只把 'running' 视为"展示窗口的时机";'discovering' 阶段静默,等到
    // 进入 running 再亮窗。这样面板的进度条分母与"待 AI 处理"严格对齐。
    const running = phase === 'running';

    if (running && !this.isImportRunning) {
      this.isImportRunning = true;
      this.showAndUpdate(snap);
      return;
    }

    if (running && this.isImportRunning) {
      this.updateProgress(snap);
      return;
    }

    if (!running && this.isImportRunning) {
      this.isImportRunning = false;
      this.markDoneAndClose(snap);
    }
  }

  private showAndUpdate(snap: ImportProgressSnapshot | null): void {
    if (this.window && !this.window.isDestroyed()) {
      this.updateProgress(snap);
      return;
    }

    const display = screen.getPrimaryDisplay();
    const { x: workX, y: workY, width, height } = display.workArea;
    const x = workX + width - PANEL_WIDTH - EDGE_PADDING;
    const y = workY + height - PANEL_HEIGHT - EDGE_PADDING;

    this.window = new BrowserWindow({
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
      x,
      y,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: true,
      show: false,
      hasShadow: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    this.window.loadFile(path.join(__dirname, 'import-progress.html'));
    this.window.once('ready-to-show', () => {
      this.window?.show();
      this.updateProgress(snap);
    });

    this.window.on('closed', () => {
      this.window = null;
    });
  }

  private updateProgress(snap: ImportProgressSnapshot | null): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send('import-progress:update', snap);
  }

  private markDoneAndClose(snap: ImportProgressSnapshot | null): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send('import-progress:done', snap);

    if (this.autoCloseTimer) clearTimeout(this.autoCloseTimer);
    this.autoCloseTimer = setTimeout(() => {
      try {
        this.window?.close();
      } catch { /* ignore */ }
      this.window = null;
      this.autoCloseTimer = null;
    }, AUTO_CLOSE_DELAY_MS);
  }

  destroy(): void {
    if (this.autoCloseTimer) {
      clearTimeout(this.autoCloseTimer);
      this.autoCloseTimer = null;
    }
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
    }
    this.window = null;
  }
}
