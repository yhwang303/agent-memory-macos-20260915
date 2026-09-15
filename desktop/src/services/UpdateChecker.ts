import { EventEmitter } from 'events';
import { app, shell, Notification } from 'electron';
import { getConfig, setConfig } from '../config/store.js';

export interface UpdateInfo {
  version: string;
  releaseNotes?: string;
  downloadPage: string;
  downloads?: Record<string, string>;
  mandatory?: boolean;
  releasedAt?: string;
}

// 官方发布服务器地址（固定，不依赖用户配置）
const RELEASE_SERVER = 'http://21.214.82.219:3850';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const STARTUP_DELAY_MS = 15_000; // 15 seconds after launch

/**
 * 根据当前平台返回 API 路径中的 platform 标识。
 * 官网接口: GET /api/latest/:platform
 * platform 取值: win | mac-arm64 | mac-x64 | linux-x64
 */
function getClientPlatform(): string {
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  }
  return `linux-${process.arch}`;
}

export class UpdateChecker extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private latestInfo: UpdateInfo | null = null;

  getLatestInfo(): UpdateInfo | null {
    return this.latestInfo;
  }

  start(): void {
    setTimeout(() => {
      void this.runCheck();
      this.timer = setInterval(() => void this.runCheck(), CHECK_INTERVAL_MS);
    }, STARTUP_DELAY_MS);
  }

  /**
   * Manually trigger an update check.
   * Returns the update info if a new version is found, null otherwise.
   */
  async checkNow(): Promise<UpdateInfo | null> {
    try {
      const info = await this.fetchLatest();
      if (info) {
        this.latestInfo = info;
        this.emit('update-available', info);
        this.showNotification(info);
      }
      return info;
    } catch (err) {
      console.error('[UpdateChecker] manual check failed:', err);
      return null;
    }
  }

  private async runCheck(): Promise<void> {
    try {
      const info = await this.fetchLatest();
      if (!info) return;
      this.latestInfo = info;
      this.emit('update-available', info);
      this.showNotification(info);
    } catch (err) {
      console.error('[UpdateChecker] check failed:', err);
    }
  }

  private async fetchLatest(): Promise<UpdateInfo | null> {
    const platform = getClientPlatform();
    const url = `${RELEASE_SERVER}/api/latest/${platform}`;

    const resp = await fetch(url, {
      headers: {
        'User-Agent': `AgentMemory/${app.getVersion()}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;

    const data = await resp.json() as any;
    if (!data.success || !data.release) return null;

    const release = data.release;
    if (!release.version) return null;
    if (!isNewer(release.version, app.getVersion())) return null;

    // 构建完整下载 URL（服务器返回的是相对路径）
    const downloadPage = release.downloadUrl
      ? `${RELEASE_SERVER}${release.downloadUrl}`
      : RELEASE_SERVER;

    return {
      version: release.version,
      downloadPage,
      releasedAt: release.date,
    };
  }

  private showNotification(info: UpdateInfo): void {
    if (getConfig().dismissedVersion === info.version) return;

    const notif = new Notification({
      title: 'AgentMemory',
      body: `发现新版本 v${info.version}，点击前往下载页面`,
    });

    let clicked = false;
    notif.on('click', () => {
      clicked = true;
      shell.openExternal(info.downloadPage);
    });
    notif.on('close', () => {
      if (!clicked) setConfig({ dismissedVersion: info.version });
    });
    notif.show();
  }

  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

function isNewer(latest: string, current: string): boolean {
  const parse = (v: string): number[] =>
    v.replace(/^v/, '').split('.').map(Number);
  const [la = 0, lb = 0, lc = 0] = parse(latest);
  const [ca = 0, cb = 0, cc = 0] = parse(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}
