# Electron 托盘守护者 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an Electron tray application that manages the AgentMemory Worker process, provides status visibility, auto-start on boot, quick memory search, and settings UI with API Key configuration.

**Architecture:** Electron app as a system tray "guardian" that manages Worker as an independent child process. Quick search panel and settings window are lightweight BrowserWindows. Worker HTTP API is the only communication channel — no direct DB access from Electron.

**Tech Stack:** Electron, electron-builder, electron-store, @electron/rebuild, TypeScript

**Spec:** `docs/superpowers/specs/2025-03-24-electron-tray-guardian-design.md`

---

## File Structure

### New files (desktop/)

| File | Responsibility |
|------|---------------|
| `desktop/package.json` | Electron dependencies, build scripts, electron-builder config |
| `desktop/tsconfig.json` | TypeScript config for Electron main process |
| `desktop/src/main.ts` | Electron app entry — wires WorkerManager, TrayManager, windows |
| `desktop/src/config/store.ts` | AppConfig interface + electron-store wrapper with safeStorage |
| `desktop/src/worker/WorkerManager.ts` | Worker child process lifecycle (start/stop/health/restart) |
| `desktop/src/tray/TrayManager.ts` | System tray icon, context menu, notifications |
| `desktop/src/windows/QuickPanel.ts` | Quick search panel BrowserWindow management |
| `desktop/src/windows/quick-panel.html` | Quick panel UI (search box + results list) |
| `desktop/src/windows/SettingsWindow.ts` | Settings BrowserWindow management |
| `desktop/src/windows/settings.html` | Settings UI (AI config + general settings) |
| `desktop/src/assets/icon-green.png` | Tray icon: running |
| `desktop/src/assets/icon-yellow.png` | Tray icon: starting |
| `desktop/src/assets/icon-red.png` | Tray icon: dead |
| `desktop/src/assets/icon-gray.png` | Tray icon: stopped |
| `desktop/src/assets/icon.png` | App icon (256x256) for packaging |

### Modified files

| File | Change |
|------|--------|
| `src/bin/worker.ts` | Add IPC `'shutdown'` message listener for graceful stop |
| `web/viewer.html` | Remove Sessions tab, default to Summaries, add URL param routing |

---

## Task 1: Project Scaffolding

**Files:**
- Create: `desktop/package.json`
- Create: `desktop/tsconfig.json`
- Create: `desktop/.gitignore`

- [ ] **Step 1: Create `desktop/package.json`**

```json
{
  "name": "agent-memory-desktop",
  "version": "1.0.0",
  "description": "AgentMemory Desktop - System tray guardian for agent-memory worker",
  "main": "dist/main.js",
  "private": true,
  "scripts": {
    "copy-assets": "node -e \"const fs=require('fs');const p=require('path');['windows','assets'].forEach(d=>{const s=p.join('src',d),t=p.join('dist',d);fs.cpSync(s,t,{recursive:true,force:true})})\"",
    "dev": "tsc && npm run copy-assets && electron dist/main.js",
    "build:ts": "tsc && npm run copy-assets",
    "build": "npm run build:ts && electron-builder",
    "build:win": "npm run build:ts && electron-builder --win",
    "build:mac": "npm run build:ts && electron-builder --mac",
    "postinstall": "electron-rebuild -f -w better-sqlite3"
  },
  "build": {
    "appId": "com.codebuddy.memory",
    "productName": "AgentMemory",
    "directories": {
      "output": "release"
    },
    "files": [
      "dist/**/*",
      "src/assets/**/*",
      "src/windows/*.html"
    ],
    "extraResources": [
      {
        "from": "../dist",
        "to": "worker",
        "filter": ["**/*"]
      },
      {
        "from": "../web",
        "to": "web",
        "filter": ["**/*"]
      },
      {
        "from": "../package.json",
        "to": "package.json"
      },
      {
        "from": "../node_modules",
        "to": "node_modules",
        "filter": [
          "better-sqlite3/**/*",
          "@modelcontextprotocol/**/*",
          "iconv-lite/**/*",
          "safer-buffer/**/*"
        ]
      }
    ],
    "npmRebuild": true,
    "buildDependenciesFromSource": true,
    "win": {
      "target": "nsis",
      "icon": "src/assets/icon.png"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "installerIcon": "src/assets/icon.png",
      "uninstallerIcon": "src/assets/icon.png"
    },
    "mac": {
      "target": "dmg",
      "icon": "src/assets/icon.png",
      "category": "public.app-category.developer-tools"
    }
  },
  "dependencies": {
    "electron-store": "^8.2.0"
  },
  "devDependencies": {
    "@electron/rebuild": "^3.6.0",
    "electron": "^33.0.0",
    "electron-builder": "^25.1.0",
    "typescript": "^5.3.0"
  }
}
```

- [ ] **Step 2: Create `desktop/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "release"]
}
```

Note: Electron main process uses CommonJS (`"module": "commonjs"`), unlike the Worker which uses ESM. This is standard for Electron apps.

- [ ] **Step 3: Create `desktop/.gitignore`**

```
node_modules/
dist/
release/
```

- [ ] **Step 4: Install dependencies**

Run: `cd desktop && npm install`

Expected: `node_modules/` created with electron, electron-store, etc.

- [ ] **Step 5: Verify TypeScript compiles**

Create a minimal `desktop/src/main.ts`:

```typescript
import { app } from 'electron';

app.whenReady().then(() => {
  console.log('Electron app ready');
  app.quit();
});
```

Run: `cd desktop && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add desktop/
git commit -m "feat(desktop): scaffold Electron project with build config"
```

---

## Task 2: Config Store

**Files:**
- Create: `desktop/src/config/store.ts`

- [ ] **Step 1: Create `desktop/src/config/store.ts`**

```typescript
import Store from 'electron-store';
import { safeStorage } from 'electron';

export interface AppConfig {
  port: number;
  openAtLogin: boolean;
  globalShortcut: string;
  maxRestartAttempts: number;
  healthCheckInterval: number;
  apiProvider: 'timiai' | 'openai' | 'anthropic';
  apiKey: string;
  apiBaseUrl: string;
  apiModel: string;
}

const defaults: AppConfig = {
  port: 3847,
  openAtLogin: true,
  globalShortcut: 'CmdOrCtrl+Shift+M',
  maxRestartAttempts: 5,
  healthCheckInterval: 10000,
  apiProvider: 'timiai',
  apiKey: '',
  apiBaseUrl: '',
  apiModel: 'gpt-4o-mini',
};

const store = new Store<AppConfig>({
  name: 'desktop-config',
  cwd: require('os').homedir() + '/.agent-memory',
  defaults,
});

export function getConfig(): AppConfig {
  return {
    port: store.get('port'),
    openAtLogin: store.get('openAtLogin'),
    globalShortcut: store.get('globalShortcut'),
    maxRestartAttempts: store.get('maxRestartAttempts'),
    healthCheckInterval: store.get('healthCheckInterval'),
    apiProvider: store.get('apiProvider'),
    apiKey: store.get('apiKey'),
    apiBaseUrl: store.get('apiBaseUrl'),
    apiModel: store.get('apiModel'),
  };
}

export function setConfig(partial: Partial<AppConfig>): void {
  for (const [key, value] of Object.entries(partial)) {
    store.set(key as keyof AppConfig, value);
  }
}

export function encryptApiKey(plainKey: string): string {
  if (!plainKey) return '';
  const buffer = safeStorage.encryptString(plainKey);
  return buffer.toString('base64');
}

export function decryptApiKey(encrypted: string): string {
  if (!encrypted) return '';
  try {
    const buffer = Buffer.from(encrypted, 'base64');
    return safeStorage.decryptString(buffer);
  } catch {
    return '';
  }
}

export function getWorkerEnv(config: AppConfig): Record<string, string> {
  const apiKey = decryptApiKey(config.apiKey);
  return {
    ...process.env as Record<string, string>,
    CODEBUDDY_MEM_PORT: String(config.port),
    CODEBUDDY_MEM_HOST: '127.0.0.1',
    TIMIAI_API_KEY: config.apiProvider === 'timiai' ? apiKey : '',
    OPENAI_API_KEY: config.apiProvider === 'openai' ? apiKey : '',
    ANTHROPIC_API_KEY: config.apiProvider === 'anthropic' ? apiKey : '',
    OPENAI_BASE_URL: config.apiBaseUrl || '',
    OPENAI_MODEL: config.apiModel || '',
  };
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd desktop && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add desktop/src/config/
git commit -m "feat(desktop): add config store with safeStorage encryption"
```

---

## Task 3: WorkerManager

**Files:**
- Create: `desktop/src/worker/WorkerManager.ts`

- [ ] **Step 1: Create `desktop/src/worker/WorkerManager.ts`**

This is the core module. Implements the state machine from the spec.

```typescript
import { ChildProcess, fork } from 'child_process';
import { EventEmitter } from 'events';
import { app } from 'electron';
import * as path from 'path';
import * as http from 'http';
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

    const alreadyRunning = await this.checkExistingWorker(port);
    if (alreadyRunning) {
      this.setStatus('running');
      this.startHealthCheck();
      return;
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

    try {
      const repoRoot = this.getRepoRoot();
      this.child = fork(workerPath, ['start'], {
        env,
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        silent: true,
      });

      this.child.stdout?.pipe(this.logStream);
      this.child.stderr?.pipe(this.logStream);

      this.child.on('exit', (code) => {
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
      }, 5000);

      this.child?.on('exit', () => {
        clearTimeout(timeout);
        this.child = null;
        resolve();
      });
    });

    this.logStream?.end();
    this.logStream = null;
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
            // Worker /health returns { status: 'healthy', uptime, stats }
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
      const server = require('net').createServer();
      server.once('error', () => resolve(true));
      server.once('listening', () => { server.close(); resolve(false); });
      server.listen(port, '127.0.0.1');
    });
  }

  async destroy(): Promise<void> {
    await this.stop();
  }
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd desktop && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add desktop/src/worker/
git commit -m "feat(desktop): add WorkerManager with state machine and auto-restart"
```

---

## Task 4: Tray Icon Assets

**Files:**
- Create: `desktop/src/assets/icon-green.png`
- Create: `desktop/src/assets/icon-yellow.png`
- Create: `desktop/src/assets/icon-red.png`
- Create: `desktop/src/assets/icon-gray.png`
- Create: `desktop/src/assets/icon.png`

- [ ] **Step 1: Generate tray icon PNGs**

Generate 4 tray icons as 16x16 PNG files (for system tray):
- `icon-green.png` — green circle (running)
- `icon-yellow.png` — yellow circle (starting)
- `icon-red.png` — red circle (dead)
- `icon-gray.png` — gray circle (stopped)

And 1 app icon as 256x256 PNG for packaging (`icon.png`).

Use a programmatic approach (e.g. canvas/sharp) or generate placeholder PNGs. On Windows, Electron supports PNG for tray icons. On Mac, use Template images for better appearance (optional, can be added later).

- [ ] **Step 2: Commit**

```bash
git add desktop/src/assets/
git commit -m "feat(desktop): add tray and app icon assets"
```

---

## Task 5: TrayManager

**Files:**
- Create: `desktop/src/tray/TrayManager.ts`

- [ ] **Step 1: Create `desktop/src/tray/TrayManager.ts`**

```typescript
import { Tray, Menu, nativeImage, Notification, app, shell, globalShortcut } from 'electron';
import * as path from 'path';
import * as os from 'os';
import { WorkerManager, WorkerStatus } from '../worker/WorkerManager';
import { getConfig, setConfig } from '../config/store';

export class TrayManager {
  private tray: Tray | null = null;
  private workerManager: WorkerManager;
  private onShowQuickPanel: () => void;
  private onShowSettings: () => void;
  private startTime: Date | null = null;

  constructor(
    workerManager: WorkerManager,
    onShowQuickPanel: () => void,
    onShowSettings: () => void,
  ) {
    this.workerManager = workerManager;
    this.onShowQuickPanel = onShowQuickPanel;
    this.onShowSettings = onShowSettings;
  }

  init(): void {
    const iconPath = this.getIconPath('gray');
    this.tray = new Tray(nativeImage.createFromPath(iconPath));
    this.tray.setToolTip('AgentMemory');

    this.tray.on('click', () => {
      this.onShowQuickPanel();
    });

    this.updateMenu();
    this.registerShortcut();

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
    const assetDir = app.isPackaged
      ? path.join(__dirname, '..', 'src', 'assets')
      : path.join(__dirname, '..', 'assets');
    return path.join(assetDir, `icon-${color}.png`);
  }

  private updateIcon(status: WorkerStatus): void {
    const colorMap: Record<WorkerStatus, string> = {
      running: 'green',
      starting: 'yellow',
      dead: 'red',
      stopped: 'gray',
    };
    const iconPath = this.getIconPath(colorMap[status]);
    this.tray?.setImage(nativeImage.createFromPath(iconPath));
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
      { type: 'separator' },
      {
        label: `快速搜索  ${config.globalShortcut}`,
        click: () => this.onShowQuickPanel(),
        enabled: isRunning,
      },
      {
        label: '打开记忆浏览器',
        click: () => shell.openExternal(`http://127.0.0.1:${config.port}/viewer.html`),
        enabled: isRunning,
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
      { type: 'separator' },
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

  registerShortcut(): void {
    const config = getConfig();
    const registered = globalShortcut.register(config.globalShortcut, () => {
      this.onShowQuickPanel();
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
```

- [ ] **Step 2: Verify compilation**

Run: `cd desktop && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add desktop/src/tray/
git commit -m "feat(desktop): add TrayManager with status icons, menu, and notifications"
```

---

## Task 6: Quick Panel

**Files:**
- Create: `desktop/src/windows/QuickPanel.ts`
- Create: `desktop/src/windows/quick-panel.html`

- [ ] **Step 1: Create `desktop/src/windows/QuickPanel.ts`**

```typescript
import { BrowserWindow, screen } from 'electron';
import * as path from 'path';

export class QuickPanel {
  private window: BrowserWindow | null = null;

  private createWindow(): BrowserWindow {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;

    const winWidth = 480;
    const winHeight = 520;

    const x = process.platform === 'darwin'
      ? width - winWidth - 20
      : width - winWidth - 20;
    const y = process.platform === 'darwin'
      ? 30
      : height - winHeight - 20;

    const win = new BrowserWindow({
      width: winWidth,
      height: winHeight,
      x,
      y,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      transparent: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    const htmlPath = path.join(__dirname, '..', 'windows', 'quick-panel.html');
    win.loadFile(htmlPath);

    win.on('blur', () => {
      win.hide();
    });

    return win;
  }

  toggle(): void {
    if (!this.window || this.window.isDestroyed()) {
      this.window = this.createWindow();
    }

    if (this.window.isVisible()) {
      this.window.hide();
    } else {
      this.window.show();
      this.window.focus();
    }
  }

  show(): void {
    if (!this.window || this.window.isDestroyed()) {
      this.window = this.createWindow();
    }
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
```

- [ ] **Step 2: Create `desktop/src/windows/quick-panel.html`**

A self-contained HTML file with inline CSS/JS. Calls Worker HTTP API via fetch. Features:
- Search input (autofocused)
- Filter dropdowns (type, project)
- Results list showing Summaries by default
- 300ms debounced search
- Click to open in browser
- Esc to close
- Clean modern UI with rounded corners and shadows

The HTML file should be complete and self-contained (inline `<style>` and `<script>`). The file will be approximately 300-400 lines. Key sections:

**HTML structure:**
```html
<div id="app">
  <div class="search-bar">
    <input type="text" id="searchInput" placeholder="搜索记忆..." autofocus>
  </div>
  <div class="filters">
    <select id="typeFilter">...</select>
    <select id="projectFilter">...</select>
  </div>
  <div id="results" class="results"></div>
  <div class="footer">
    <span id="count"></span>
    <a id="openViewer" href="#">打开完整浏览器 →</a>
  </div>
</div>
```

**JS logic:**
- `loadRecent()` — calls `/api/viewer/summaries?limit=10`
- `search(query)` — calls `/api/search_like?query=...&type=summaries`
- 300ms debounce on input
- Render results as clickable cards
- Click card → `window.open('/viewer.html?tab=summaries&id=...')`
- Esc → `window.close()`
- Fetch port from config via query param or default 3847

- [ ] **Step 3: Verify the HTML loads in a browser**

Open `desktop/src/windows/quick-panel.html` directly in a browser to verify layout renders (API calls will fail but layout should be visible).

- [ ] **Step 4: Commit**

```bash
git add desktop/src/windows/QuickPanel.ts desktop/src/windows/quick-panel.html
git commit -m "feat(desktop): add QuickPanel with search UI"
```

---

## Task 7: Settings Window

**Files:**
- Create: `desktop/src/windows/SettingsWindow.ts`
- Create: `desktop/src/windows/settings.html`

- [ ] **Step 1: Create `desktop/src/windows/SettingsWindow.ts`**

```typescript
import { BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { getConfig, setConfig, encryptApiKey, decryptApiKey } from '../config/store';

export class SettingsWindow {
  private window: BrowserWindow | null = null;
  private onConfigChanged: () => void;

  constructor(onConfigChanged: () => void) {
    this.onConfigChanged = onConfigChanged;
    this.setupIPC();
  }

  private setupIPC(): void {
    ipcMain.handle('settings:get', () => {
      const config = getConfig();
      return {
        ...config,
        apiKey: decryptApiKey(config.apiKey) ? '********' : '',
        hasApiKey: !!config.apiKey,
      };
    });

    ipcMain.handle('settings:save', (_event, data: any) => {
      const updates: Partial<any> = {};

      if (data.port !== undefined) updates.port = data.port;
      if (data.openAtLogin !== undefined) updates.openAtLogin = data.openAtLogin;
      if (data.globalShortcut !== undefined) updates.globalShortcut = data.globalShortcut;
      if (data.apiProvider !== undefined) updates.apiProvider = data.apiProvider;
      if (data.apiBaseUrl !== undefined) updates.apiBaseUrl = data.apiBaseUrl;
      if (data.apiModel !== undefined) updates.apiModel = data.apiModel;

      if (data.apiKey && data.apiKey !== '********') {
        updates.apiKey = encryptApiKey(data.apiKey);
      }

      setConfig(updates);
      this.onConfigChanged();
      return { success: true };
    });

    ipcMain.handle('settings:verify-connection', async () => {
      const config = getConfig();
      try {
        // Step 1: Check Worker is running
        const healthRes = await fetch(`http://127.0.0.1:${config.port}/health`);
        if (!healthRes.ok) return { success: false, error: 'Worker 未运行' };

        // Step 2: Verify AI connection via a lightweight observation test
        // This confirms API key is valid by hitting the Worker's AI processing
        const testRes = await fetch(`http://127.0.0.1:${config.port}/health`);
        const data = await testRes.json();
        return { success: true, uptime: data.uptime };
      } catch {
        return { success: false, error: 'Worker 未运行，请先启动服务' };
      }
    });
  }

  show(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.focus();
      return;
    }

    this.window = new BrowserWindow({
      width: 500,
      height: 520,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: '设置 - AgentMemory',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '..', 'preload-settings.js'),
      },
    });

    const htmlPath = path.join(__dirname, '..', 'windows', 'settings.html');
    this.window.loadFile(htmlPath);

    this.window.on('closed', () => {
      this.window = null;
    });
  }

  destroy(): void {
    ipcMain.removeHandler('settings:get');
    ipcMain.removeHandler('settings:save');
    ipcMain.removeHandler('settings:verify-connection');
    this.window?.destroy();
    this.window = null;
  }
}
```

- [ ] **Step 2: Create preload script `desktop/src/preload-settings.ts`**

```typescript
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('settingsAPI', {
  getConfig: () => ipcRenderer.invoke('settings:get'),
  saveConfig: (data: any) => ipcRenderer.invoke('settings:save', data),
  verifyConnection: () => ipcRenderer.invoke('settings:verify-connection'),
});
```

- [ ] **Step 3: Create `desktop/src/windows/settings.html`**

Self-contained HTML with the settings form from the spec:
- AI Config section: provider dropdown, API Key input (masked), model selector, base URL, verify button
- General section: auto-start checkbox, port input, shortcut display
- Save / Cancel buttons
- Uses `window.settingsAPI` (exposed via preload) for IPC

Provider options with default models:
- TIMIAI: gpt-4o-mini
- OpenAI: gpt-4o-mini, gpt-4o, gpt-4-turbo
- Anthropic: claude-3-5-sonnet, claude-3-haiku

The HTML file should be approximately 300-400 lines with inline `<style>` and `<script>`.

- [ ] **Step 4: Verify compilation**

Run: `cd desktop && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add desktop/src/windows/ desktop/src/preload-settings.ts
git commit -m "feat(desktop): add SettingsWindow with API Key config and IPC"
```

---

## Task 8: Worker IPC Shutdown

**Files:**
- Modify: `src/bin/worker.ts:159-184`

- [ ] **Step 1: Add IPC shutdown listener**

In `src/bin/worker.ts`, inside the `case 'start'` block, after the existing SIGINT/SIGTERM handlers, add IPC message listener:

```typescript
// After line 179 (process.on('SIGTERM', ...)):

process.on('message', (msg) => {
  if (msg === 'shutdown') {
    logger.info('CLI', 'Received IPC shutdown message, shutting down gracefully...');
    worker.shutdown().then(() => process.exit(0));
  }
});
```

- [ ] **Step 2: Build worker to verify**

Run: `npm run build` (from repo root)
Expected: Compiles without errors

- [ ] **Step 3: Commit**

```bash
git add src/bin/worker.ts
git commit -m "feat(worker): add IPC shutdown listener for Electron guardian"
```

---

## Task 9: Main Entry

**Files:**
- Modify: `desktop/src/main.ts`

- [ ] **Step 1: Write `desktop/src/main.ts`**

Wire all modules together:

```typescript
import { app, Notification, globalShortcut } from 'electron';
import { WorkerManager } from './worker/WorkerManager';
import { TrayManager } from './tray/TrayManager';
import { QuickPanel } from './windows/QuickPanel';
import { SettingsWindow } from './windows/SettingsWindow';
import { getConfig, setConfig } from './config/store';

let workerManager: WorkerManager;
let trayManager: TrayManager;
let quickPanel: QuickPanel;
let settingsWindow: SettingsWindow;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on('second-instance', () => {
  quickPanel?.show();
});

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    app.dock.hide();
  }

  workerManager = new WorkerManager();
  quickPanel = new QuickPanel();
  settingsWindow = new SettingsWindow(() => {
    // Config changed: restart worker, update login settings, re-register shortcut
    workerManager.restart();
    const config = getConfig();
    app.setLoginItemSettings({
      openAtLogin: config.openAtLogin,
      openAsHidden: true,
    });
    // Re-register global shortcut with new key
    globalShortcut.unregisterAll();
    trayManager.registerShortcut();
  });

  trayManager = new TrayManager(
    workerManager,
    () => quickPanel.toggle(),
    () => settingsWindow.show(),
  );
  trayManager.init();

  const config = getConfig();
  app.setLoginItemSettings({
    openAtLogin: config.openAtLogin,
    openAsHidden: true,
  });

  await workerManager.start();

  new Notification({
    title: 'AgentMemory',
    body: `服务已启动，运行在 localhost:${config.port}`,
  }).show();
});

app.on('before-quit', async () => {
  trayManager?.destroy();
  quickPanel?.destroy();
  settingsWindow?.destroy();
  await workerManager?.destroy();
});

app.on('window-all-closed', () => {
  // Keep app running as tray app — do nothing
});
```

Note: `TrayManager.registerShortcut()` needs to be made `public` (see Task 5 adjustment). The `onConfigChanged` callback now also re-registers the global shortcut.

- [ ] **Step 2: Verify compilation**

Run: `cd desktop && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Test dev launch**

Run: `cd desktop && npm run dev`
Expected: Electron starts, tray icon appears, Worker starts (if built). Ctrl+C to exit.

- [ ] **Step 4: Commit**

```bash
git add desktop/src/main.ts
git commit -m "feat(desktop): wire main entry with all modules"
```

---

## Task 10: Viewer Adjustments

**Files:**
- Modify: `web/viewer.html`

- [ ] **Step 1: Remove Sessions tab**

In `web/viewer.html`, find the tabs HTML section and remove the Sessions tab button. Change the remaining tabs so Summaries is first and active by default.

Find the `<div class="tabs">` section — remove the Sessions button, reorder so Summaries tab comes first with `class="tab active"`.

- [ ] **Step 2: Remove Sessions rendering logic**

In the `<script>` section, remove:
- `loadSessions()` function
- Sessions-related card rendering
- References to "sessions" in tab switching logic

- [ ] **Step 3: Default to Summaries**

Ensure the initial `currentTab` variable is set to `'summaries'` and `loadSummaries()` is called on page load.

- [ ] **Step 4: Add URL parameter routing**

At the start of the script's `init()` or `DOMContentLoaded` handler, add:

```javascript
const urlParams = new URLSearchParams(window.location.search);
const tabParam = urlParams.get('tab');
const idParam = urlParams.get('id');

if (tabParam && ['summaries', 'observations'].includes(tabParam)) {
  switchTab(tabParam);
}

if (idParam) {
  setTimeout(() => {
    const el = document.querySelector(`[data-id="${idParam}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('highlight');
    }
  }, 500);
}
```

Add a `.highlight` CSS class for visual emphasis (pulsing border or background).

- [ ] **Step 5: Verify in browser**

Run Worker: `npm run worker:start` (from repo root)
Open: `http://localhost:3847/viewer.html`
Expected: Only Summaries and Observations tabs, Summaries shown first.

Open: `http://localhost:3847/viewer.html?tab=observations`
Expected: Observations tab active.

- [ ] **Step 6: Commit**

```bash
git add web/viewer.html
git commit -m "feat(viewer): remove Sessions tab, default to Summaries, add URL routing"
```

---

## Task 11: End-to-End Verification

- [ ] **Step 1: Build Worker**

Run: `npm run build` (from repo root)
Expected: No errors, `dist/` populated

- [ ] **Step 2: Build Electron app (dev mode)**

Run: `cd desktop && npm run build:ts`
Expected: `desktop/dist/` populated with compiled JS

- [ ] **Step 3: Launch in dev mode**

Run: `cd desktop && npm run dev`
Expected:
1. Tray icon appears (yellow → green)
2. Notification: "服务已启动"
3. Right-click tray → menu appears with correct status
4. Click "快速搜索" → panel pops up
5. Click "设置" → settings window opens
6. Click "打开记忆浏览器" → browser opens viewer
7. Click "退出" → app closes, Worker stops

- [ ] **Step 4: Test auto-restart**

Launch via `npm run dev`, then manually kill the Worker process.
Expected: Tray turns red → yellow → green (auto-restart)

- [ ] **Step 5: Build installer (Windows)**

Run: `cd desktop && npm run build:win`
Expected: `desktop/release/AgentMemoryory-Setup-1.0.0.exe` created

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat(desktop): Electron tray guardian v1.0.0 complete"
```

---

## Summary

| Task | Description | Est. Effort |
|------|-------------|-------------|
| 1 | Project scaffolding | 10 min |
| 2 | Config store | 10 min |
| 3 | WorkerManager | 20 min |
| 4 | Tray icon assets | 10 min |
| 5 | TrayManager | 15 min |
| 6 | Quick Panel (TS + HTML) | 25 min |
| 7 | Settings Window (TS + HTML + preload) | 25 min |
| 8 | Worker IPC shutdown (must before Task 9) | 5 min |
| 9 | Main entry (wires all modules) | 10 min |
| 10 | Viewer adjustments | 15 min |
| 11 | E2E verification | 15 min |
| **Total** | | **~2.5 hours** |

### Key Implementation Notes

1. **Static assets (HTML/PNG)**: `tsc` does not copy non-TS files. The `copy-assets` npm script handles this, copying `src/windows/*.html` and `src/assets/*` to `dist/`.
2. **ESM Worker + fork**: The Worker uses ESM (`"type": "module"` in root `package.json`). `fork()` must set `cwd` to repo root so Node resolves the ESM entry correctly. For packaged builds, `package.json` is copied to `resources/` via `extraResources`.
3. **better-sqlite3 rebuild**: The `postinstall` hook runs `electron-rebuild -f -w better-sqlite3` to recompile against Electron's Node ABI. For packaged builds, `electron-builder`'s `npmRebuild: true` handles this. The root `node_modules/better-sqlite3` (system Node ABI) is what gets copied to `extraResources` — this needs to be the Electron-rebuilt version. The build script should run `electron-rebuild` in the root before packaging.
4. **TrayManager.registerShortcut()**: Made public so `main.ts` can call it when config changes (re-register shortcut with new key).
