import { BrowserWindow, ipcMain, app, screen } from 'electron';
import * as path from 'path';
import { getConfig, setConfig } from '../config/store';
import type { ViewerBounds } from '../config/store';

export interface ViewerOpenOptions {
  tab?: 'summaries' | 'observations' | 'sessions';
  id?: string;
}

const MIN_WIDTH = 720;
const MIN_HEIGHT = 520;
const DEFAULT_WIDTH = 1100;
const DEFAULT_HEIGHT = 760;

export class ViewerWindow {
  private window: BrowserWindow | null = null;
  private isQuitting = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.setupIPC();
  }

  private setupIPC(): void {
    ipcMain.handle('viewer:minimize', () => {
      this.window?.minimize();
    });

    ipcMain.handle('viewer:toggle-maximize', () => {
      if (!this.window) return false;
      if (this.window.isMaximized()) {
        this.window.unmaximize();
        return false;
      }
      this.window.maximize();
      return true;
    });

    ipcMain.handle('viewer:close', () => {
      if (!this.window || this.window.isDestroyed()) return;
      this.persistBounds();
      this.window.hide();
    });

    ipcMain.handle('viewer:get-platform', () => process.platform);

    ipcMain.handle('viewer:get-port', () => getConfig().port);

    ipcMain.handle('viewer:is-maximized', () => {
      return this.window?.isMaximized() ?? false;
    });
  }

  private getViewerHtmlPath(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'web', 'viewer.html');
    }
    // dev: dist/windows/ViewerWindow.js -> ../../../web/viewer.html
    return path.join(__dirname, '..', '..', '..', 'web', 'viewer.html');
  }

  private clampBoundsToScreen(b: ViewerBounds): ViewerBounds {
    if (b.x === undefined || b.y === undefined) return b;
    const displays = screen.getAllDisplays();
    const inAny = displays.some((d) => {
      const wa = d.workArea;
      return (
        b.x! + 40 >= wa.x &&
        b.y! + 40 >= wa.y &&
        b.x! + 40 <= wa.x + wa.width &&
        b.y! + 40 <= wa.y + wa.height
      );
    });
    if (!inAny) {
      return { width: b.width, height: b.height, maximized: b.maximized };
    }
    return b;
  }

  private persistBounds(): void {
    if (!this.window || this.window.isDestroyed()) return;
    const maximized = this.window.isMaximized();
    if (maximized) {
      const cur = getConfig().viewerBounds;
      setConfig({
        viewerBounds: {
          x: cur?.x,
          y: cur?.y,
          width: cur?.width ?? DEFAULT_WIDTH,
          height: cur?.height ?? DEFAULT_HEIGHT,
          maximized: true,
        },
      });
      return;
    }
    const b = this.window.getBounds();
    setConfig({
      viewerBounds: {
        x: b.x,
        y: b.y,
        width: b.width,
        height: b.height,
        maximized: false,
      },
    });
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persistBounds(), 400);
  }

  private buildQuery(opts?: ViewerOpenOptions): Record<string, string> {
    const q: Record<string, string> = {
      port: String(getConfig().port),
      embed: '1',
    };
    if (opts?.tab) q.tab = opts.tab;
    if (opts?.id) q.id = opts.id;
    return q;
  }

  show(opts?: ViewerOpenOptions): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      if (opts && (opts.tab || opts.id)) {
        this.window.webContents.send('viewer:navigate', opts);
      }
      return;
    }

    const saved = getConfig().viewerBounds;
    const initial = saved
      ? this.clampBoundsToScreen(saved)
      : { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };

    this.window = new BrowserWindow({
      width: initial.width,
      height: initial.height,
      x: initial.x,
      y: initial.y,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      frame: false,
      backgroundColor: '#0a1014',
      autoHideMenuBar: true,
      title: 'AgentMem Viewer',
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: false,
        preload: path.join(__dirname, '..', 'preload-viewer.js'),
      },
    });

    this.window.removeMenu();

    const htmlPath = this.getViewerHtmlPath();
    this.window.loadFile(htmlPath, { query: this.buildQuery(opts) });

    this.window.once('ready-to-show', () => {
      if (!this.window) return;
      if (saved?.maximized) {
        this.window.maximize();
      }
      this.window.show();
      this.window.focus();
    });

    this.window.on('close', (e) => {
      if (!this.isQuitting && this.window) {
        e.preventDefault();
        this.persistBounds();
        this.window.hide();
      }
    });

    this.window.on('resize', () => this.schedulePersist());
    this.window.on('move', () => this.schedulePersist());

    this.window.on('maximize', () => {
      this.window?.webContents.send('viewer:maximize-changed', true);
      this.schedulePersist();
    });
    this.window.on('unmaximize', () => {
      this.window?.webContents.send('viewer:maximize-changed', false);
      this.schedulePersist();
    });
  }

  hide(): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.persistBounds();
    this.window.hide();
  }

  destroy(): void {
    this.isQuitting = true;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    ipcMain.removeHandler('viewer:minimize');
    ipcMain.removeHandler('viewer:toggle-maximize');
    ipcMain.removeHandler('viewer:close');
    ipcMain.removeHandler('viewer:get-platform');
    ipcMain.removeHandler('viewer:get-port');
    ipcMain.removeHandler('viewer:is-maximized');
    this.window?.destroy();
    this.window = null;
  }
}
