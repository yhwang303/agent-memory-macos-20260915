/**
 * VectorProgressPanel — 右下角浮窗,只在 reindexAll(老用户首次升级 catch-up
 * 或用户手动触发)期间显示进度条。增量 embed(每条 obs 写入后 500ms drainQueue)
 * 不会进入 indexer.status='running',所以不会弹窗,符合 "增量无感" 体验。
 *
 * 触发逻辑(由 main.ts 的 VectorProgressPoller snapshot 监听器驱动):
 *   - 状态从非 running 切到 running   → showWithProgress()
 *   - 状态保持 running               → updateProgress()
 *   - 状态从 running 切到非 running  → markDoneAndClose()(2s 后关闭)
 *
 * 设计要点:
 *   - 透明背景 + 圆角阴影,不抢焦点(focusable: false)
 *   - 不在 dock / 任务栏出现
 *   - 用户关掉窗口不影响后台任务
 *   - macOS dock.hide() 已在 main.ts 设过,这里 skipTaskbar 保证 Win 也不出现
 */
import { BrowserWindow, screen } from 'electron';
import * as path from 'path';
import type { VectorStatusSnapshot } from '../worker/VectorProgressPoller';

const PANEL_WIDTH = 340;
const PANEL_HEIGHT = 140;
const EDGE_PADDING = 16;
const AUTO_CLOSE_DELAY_MS = 2000;

export class VectorProgressPanel {
  private window: BrowserWindow | null = null;
  private autoCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private isReindexRunning = false;
  /**
   * beta.8: 用户切换索引性能档位时, Worker 会重启 ~3s。这段时间 poller
   * 会拿不到 indexer.status='running', 默认逻辑会触发 markDoneAndClose
   * 把面板关掉, 体感上"切档面板闪一下消失了, 进度条重来了"。
   *
   * suppressClose 期间 (closeUntilTs 到期之前), feed() 看到 not-running
   * 不会触发关闭, 而是保持当前显示 — Worker 恢复后会自动续上 running 状态。
   */
  private closeUntilTs = 0;

  /**
   * 在指定毫秒数内抑制"重建结束自动关闭"。多次调用取最大值。
   * 由 TrayManager 在切档时主动喂入。
   */
  suppressCloseFor(ms: number): void {
    const until = Date.now() + Math.max(0, ms);
    if (until > this.closeUntilTs) this.closeUntilTs = until;
  }

  /**
   * 喂入 poller 最新 snapshot。内部决定要不要显示 / 更新 / 关闭。
   */
  feed(snap: VectorStatusSnapshot | null): void {
    const running = snap?.indexer?.status === 'running';

    if (running && !this.isReindexRunning) {
      this.isReindexRunning = true;
      this.showAndUpdate(snap);
      return;
    }

    if (running && this.isReindexRunning) {
      this.updateProgress(snap);
      return;
    }

    if (!running && this.isReindexRunning) {
      // 切档/Worker 重启间隙: 暂时拿不到 running, 但用户期望面板保持
      // 显示, 所以在 suppressClose 窗口内不触发关闭。
      if (Date.now() < this.closeUntilTs) {
        return;
      }
      this.isReindexRunning = false;
      this.markDoneAndClose();
    }
  }

  private showAndUpdate(snap: VectorStatusSnapshot | null): void {
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
      focusable: true, // beta.8: 加了暂停按钮, 必须能拿焦点接收点击
      show: false,
      hasShadow: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    });

    this.window.loadFile(path.join(__dirname, 'vector-progress.html'));
    this.window.once('ready-to-show', () => {
      this.window?.show();
      this.updateProgress(snap);
    });

    this.window.on('closed', () => {
      this.window = null;
    });
  }

  private updateProgress(snap: VectorStatusSnapshot | null): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send('vector-progress:update', snap);
  }

  private markDoneAndClose(): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send('vector-progress:done');

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
