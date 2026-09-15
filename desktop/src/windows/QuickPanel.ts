import { BrowserWindow, screen } from 'electron';
import type { Rectangle } from 'electron';
import * as path from 'path';
import { getConfig } from '../config/store';

export class QuickPanel {
  private window: BrowserWindow | null = null;
  private readonly winWidth = 480;
  private readonly winHeight = 520;
  private ignoreBlurUntil = 0;
  private _pendingShow = false;

  private getAnchorPoint(anchorBounds?: Rectangle): { x: number; y: number } {
    if (anchorBounds) {
      return {
        x: anchorBounds.x + Math.round(anchorBounds.width / 2),
        y: anchorBounds.y + Math.round(anchorBounds.height / 2),
      };
    }

    return screen.getCursorScreenPoint();
  }

  private positionWindow(win: BrowserWindow, anchorBounds?: Rectangle): void {
    const padding = 12;
    const anchorPoint = this.getAnchorPoint(anchorBounds);
    const display = screen.getDisplayNearestPoint(anchorPoint);
    const { x: workX, y: workY, width, height } = display.workArea;
    const maxX = workX + width - this.winWidth - padding;
    const maxY = workY + height - this.winHeight - padding;

    const preferredX = anchorBounds
      ? anchorBounds.x + Math.round(anchorBounds.width / 2) - Math.round(this.winWidth / 2)
      : anchorPoint.x - Math.round(this.winWidth / 2);

    const preferredY = process.platform === 'darwin'
      ? workY + padding
      : anchorBounds
        ? anchorBounds.y - this.winHeight - 8
        : anchorPoint.y - this.winHeight - 8;

    const nextX = Math.min(Math.max(preferredX, workX + padding), Math.max(workX + padding, maxX));
    const nextY = Math.min(Math.max(preferredY, workY + padding), Math.max(workY + padding, maxY));

    win.setBounds({
      x: nextX,
      y: nextY,
      width: this.winWidth,
      height: this.winHeight,
    });
  }

  private createWindow(anchorBounds?: Rectangle): BrowserWindow {
    const config = getConfig();

    const win = new BrowserWindow({
      width: this.winWidth,
      height: this.winHeight,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      transparent: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: false,
        preload: path.join(__dirname, '..', 'preload-quick.js'),
      },
    });

    this.positionWindow(win, anchorBounds);

    const htmlPath = path.join(__dirname, 'quick-panel.html');
    win.loadFile(htmlPath, {
      query: { port: String(config.port) },
    });

    // 页面加载完成后再显示，避免隐藏状态下 fetch 被 Chromium 节流导致"服务无法连接"
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed() && this._pendingShow) {
        this._pendingShow = false;
        this.ignoreBlurUntil = Date.now() + 250;
        win.show();
        win.focus();
      }
    });

    win.on('blur', () => {
      if (Date.now() < this.ignoreBlurUntil) return;

      setTimeout(() => {
        if (!win.isDestroyed() && win.isVisible() && !win.isFocused()) {
          win.hide();
        }
      }, 120);
    });

    return win;
  }

  toggle(anchorBounds?: Rectangle): void {
    if (!this.window || this.window.isDestroyed()) {
      this._pendingShow = true;
      this.window = this.createWindow(anchorBounds);
      return;
    }

    this.positionWindow(this.window, anchorBounds);

    if (this.window.isVisible()) {
      this.window.hide();
    } else {
      this.ignoreBlurUntil = Date.now() + 250;
      this.window.show();
      this.window.focus();
    }
  }

  show(anchorBounds?: Rectangle): void {
    if (!this.window || this.window.isDestroyed()) {
      this._pendingShow = true;
      this.window = this.createWindow(anchorBounds);
      return;
    }
    this.positionWindow(this.window, anchorBounds);
    this.ignoreBlurUntil = Date.now() + 250;
    this.window.show();
    this.window.focus();
  }

  hide(): void {
    this.window?.hide();
  }

  destroy(): void {
    this.window?.destroy();
    this.window = null;
  }
}
