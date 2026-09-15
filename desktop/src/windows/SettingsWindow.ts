import { BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import {
  getConfig, setConfig,
  encryptApiKey, decryptApiKey,
  encryptToken, decryptToken,
} from '../config/store';
import type { AppConfig, ShadowFolkWorkspaceAlias } from '../config/store';
import { parseCmemInvite, parseCmemInviteDetailed } from '../config/inviteParser';
import { HooksRegistrar } from '../services/HooksRegistrar';
import type { DesktopIntegrationType } from '../services/HooksRegistrar';
import { ShadwMonitorConfigBridge } from '../services/ShadwMonitorConfigBridge';
import { ShadwMonitorProcessManager } from '../services/ShadwMonitorProcessManager';

const SHADOW_CONFIG_PATH = path.join(os.homedir(), '.shadow', 'config.json');

function normalizeShadowfolkPath(value: string): string {
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/([a-z]:\/)/i, '$1')
    .replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function normalizeShadowfolkWorkspaceAliases(value: unknown): ShadowFolkWorkspaceAlias[] {
  if (!Array.isArray(value)) return [];
  const aliases = new Map<string, ShadowFolkWorkspaceAlias>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const workspace = typeof record.workspace === 'string'
      ? normalizeShadowfolkPath(record.workspace)
      : '';
    const memoryRoots = Array.isArray(record.memoryRoots)
      ? Array.from(new Set(record.memoryRoots
        .filter((root): root is string => typeof root === 'string')
        .map(root => normalizeShadowfolkPath(root))
        .filter(Boolean)))
      : [];
    if (!workspace || memoryRoots.length === 0) continue;

    const existing = aliases.get(workspace);
    if (existing) {
      existing.memoryRoots = Array.from(new Set([...existing.memoryRoots, ...memoryRoots]));
    } else {
      aliases.set(workspace, { workspace, memoryRoots });
    }
  }
  return Array.from(aliases.values());
}

async function readShadowConfig(): Promise<Record<string, any>> {
  try {
    const raw = await fs.promises.readFile(SHADOW_CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (error: any) {
    if (error && error.code === 'ENOENT') return {};
    throw error;
  }
}

async function writeShadowConfig(config: Record<string, any>): Promise<void> {
  await fs.promises.mkdir(path.dirname(SHADOW_CONFIG_PATH), { recursive: true });
  await fs.promises.writeFile(SHADOW_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/**
 * Talk to the locally running worker (HTTP) on the configured port.
 */
function workerRequest(
  method: 'GET' | 'POST',
  urlPath: string,
  timeoutMs = 8000,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const port = getConfig().port || 3847;
    const req = http.request({
      method,
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let body: any = null;
        try { body = buf ? JSON.parse(buf) : null; } catch { body = buf; }
        resolve({ status: res.statusCode || 0, body });
      });
    });
    req.on('error', (e) => resolve({ status: 0, body: { error: String(e) } }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: { error: 'timeout' } }); });
    if (body !== undefined) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

/**
 * Like workerRequest, but if the worker hasn't responded yet (e.g. because it
 * is still restarting after a config change), keep retrying until totalMs.
 * This is the polite default for UI buttons users click while a worker
 * restart is in flight.
 */
async function workerRequestWithRetry(
  method: 'GET' | 'POST',
  urlPath: string,
  totalMs = 12000,
  perTryMs = 4000,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const start = Date.now();
  let last = await workerRequest(method, urlPath, perTryMs, body);
  while (last.status === 0 && Date.now() - start < totalMs) {
    await new Promise(r => setTimeout(r, 500));
    last = await workerRequest(method, urlPath, perTryMs, body);
  }
  return last;
}

export class SettingsWindow {
  private window: BrowserWindow | null = null;
  private onConfigChanged: () => void | Promise<void>;
  private registrar: typeof HooksRegistrar;
  private isQuitting = false;
  private pendingInvite: ReturnType<typeof parseCmemInvite> | null = null;
  private shadwBridge: ShadwMonitorConfigBridge;
  private shadwProcess: ShadwMonitorProcessManager;

  constructor(onConfigChanged: () => void | Promise<void>, registrar: typeof HooksRegistrar) {
    this.onConfigChanged = onConfigChanged;
    this.registrar = registrar;
    this.shadwBridge = new ShadwMonitorConfigBridge();
    this.shadwProcess = new ShadwMonitorProcessManager(this.shadwBridge);
    this.setupIPC();
  }

  private setupIPC(): void {
    ipcMain.handle('settings:get', () => {
      const config = getConfig();
      const plainServerToken = decryptToken(config.serverToken);

      // Per-provider key presence, masked. Never return plaintext keys.
      const providers: AppConfig['apiProvider'][] = ['timiai', 'openai', 'anthropic', 'deepseek', 'aliyun-bailian'];
      const maskedApiKeys: Record<string, string> = {};
      const hasApiKeys: Record<string, boolean> = {};
      for (const p of providers) {
        const present = !!decryptApiKey(config.apiKeys?.[p] || '');
        maskedApiKeys[p] = present ? '********' : '';
        hasApiKeys[p] = present;
      }

      return {
        ...config,
        // Drop legacy single key from the payload; UI uses apiKeys map.
        apiKey: '',
        apiKeys: maskedApiKeys,
        hasApiKeys,
        // Expose token presence only — never the plaintext. If safeStorage
        // can no longer decrypt an old token, force the UI to reconnect.
        serverToken: plainServerToken ? '********' : '',
        hasServerToken: !!plainServerToken,
        serverTokenNeedsReconnect: !!config.serverToken && !plainServerToken,
      };
    });

    ipcMain.handle('settings:save', async (_event, data: Record<string, unknown>) => {
      const updates: Partial<AppConfig> = {};

      if (data.port !== undefined) updates.port = Number(data.port);
      if (data.openAtLogin !== undefined) updates.openAtLogin = data.openAtLogin as boolean;
      if (data.globalShortcut !== undefined) updates.globalShortcut = data.globalShortcut as string;
      if (data.apiProvider !== undefined) updates.apiProvider = data.apiProvider as AppConfig['apiProvider'];
      if (data.apiProviderLight !== undefined) updates.apiProviderLight = data.apiProviderLight as AppConfig['apiProvider'];
      if (data.apiModel !== undefined) updates.apiModel = data.apiModel as string;
      if (data.apiModelLight !== undefined) updates.apiModelLight = data.apiModelLight as string;

      // Per-provider API keys. Incoming values are plaintext / '********' (unchanged)
      // / '' (cleared). We merge against the currently stored encrypted map so that
      // '********' preserves the existing key and we never persist plaintext markers.
      if (data.apiKeys && typeof data.apiKeys === 'object' && !Array.isArray(data.apiKeys)) {
        const incoming = data.apiKeys as Record<string, unknown>;
        const current = getConfig().apiKeys || {};
        const merged: Partial<Record<AppConfig['apiProvider'], string>> = { ...current };
        const providers: AppConfig['apiProvider'][] = ['timiai', 'openai', 'anthropic', 'deepseek', 'aliyun-bailian'];
        for (const p of providers) {
          if (!(p in incoming)) continue;
          const raw = incoming[p];
          if (raw === '' || raw === undefined || raw === null) {
            delete merged[p];
          } else if (raw === '********') {
            // keep existing encrypted value (already in merged via spread)
          } else {
            merged[p] = encryptApiKey(String(raw));
          }
        }
        updates.apiKeys = merged;
      }

      // Server connection fields
      if (data.serverEnabled !== undefined) updates.serverEnabled = !!data.serverEnabled;
      if (data.serverUrl !== undefined) updates.serverUrl = String(data.serverUrl).trim();
      if (data.serverUserName !== undefined) updates.serverUserName = String(data.serverUserName).trim();
      if (data.deviceName !== undefined) updates.deviceName = String(data.deviceName).trim();
      if (data.serverToken === '') {
        updates.serverToken = '';
      } else if (data.serverToken && data.serverToken !== '********') {
        updates.serverToken = encryptToken(data.serverToken as string);
      }

      // ShadowFolk Upload Plugin fields
      if (data.shadowfolkEnabled !== undefined) updates.shadowfolkEnabled = !!data.shadowfolkEnabled;
      if (data.shadowfolkDailyTime !== undefined) {
        updates.shadowfolkDailyTime = String(data.shadowfolkDailyTime || '23:30').trim();
      }
      if (data.shadowfolkWorkspaces !== undefined) {
        updates.shadowfolkWorkspaces = Array.isArray(data.shadowfolkWorkspaces)
          ? data.shadowfolkWorkspaces.map(v => String(v).trim()).filter(Boolean)
          : [];
      }
      if (data.shadowfolkWorkspaceAliases !== undefined) {
        updates.shadowfolkWorkspaceAliases = normalizeShadowfolkWorkspaceAliases(data.shadowfolkWorkspaceAliases);
      }

      setConfig(updates);

      const hasShadowfolkChanges = data.shadowfolkEnabled !== undefined
        || data.shadowfolkDailyTime !== undefined
        || data.shadowfolkWorkspaces !== undefined
        || data.shadowfolkWorkspaceAliases !== undefined;
      const hasNonShadowfolkChanges = Object.keys(updates).some(
        k => !k.startsWith('shadowfolk')
      );

      if (hasNonShadowfolkChanges) {
        await this.onConfigChanged();
      }

      if (hasShadowfolkChanges) {
        const cfg = getConfig();
        workerRequest('POST', '/api/shadowfolk/config', 5000, {
          enabled: cfg.shadowfolkEnabled,
          dailyTime: cfg.shadowfolkDailyTime,
          workspaces: cfg.shadowfolkWorkspaces,
          workspaceAliases: cfg.shadowfolkWorkspaceAliases,
        }).catch(() => {});
      }

      return { success: true };
    });

    ipcMain.handle('shadowfolk:get-config', async () => {
      const config = await readShadowConfig();
      return {
        path: SHADOW_CONFIG_PATH,
        server: typeof config.server === 'string' ? config.server : '',
        apiToken: config.api_token ? '********' : '',
        hasApiToken: !!config.api_token,
        memoryDb: typeof config.memory_db === 'string' ? config.memory_db : '',
      };
    });

    ipcMain.handle('shadowfolk:save-config', async (_event, data: Record<string, unknown>) => {
      const current = await readShadowConfig();
      const server = String(data.server || '').trim().replace(/\/+$/, '');
      current.server = server;
      if (data.apiToken === '') {
        delete current.api_token;
      } else if (data.apiToken && data.apiToken !== '********') {
        current.api_token = String(data.apiToken).trim();
      }
      await writeShadowConfig(current);
      return { success: true, path: SHADOW_CONFIG_PATH };
    });

    ipcMain.handle('shadowfolk:reveal-token', async () => {
      const config = await readShadowConfig();
      return {
        success: true,
        apiToken: typeof config.api_token === 'string' ? config.api_token : '',
      };
    });

    ipcMain.handle('shadowfolk:validate-workspace', async (_event, workspace: string) => {
      const r = await workerRequestWithRetry('POST', '/api/shadowfolk/workspaces/validate', 15000, 6000, { workspace });
      if (r.status === 0) return { success: false, error: 'worker 没响应' };
      if (r.status < 200 || r.status >= 300) {
        const body = r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? r.body : {};
        return {
          success: false,
          status: r.status,
          ...body,
          error: typeof body.error === 'string' ? body.error : '工作区校验失败',
        };
      }
      return r.body || { success: false };
    });

    ipcMain.handle('shadowfolk:list-memory-projects', async () => {
      const r = await workerRequestWithRetry('GET', '/api/viewer/projects', 15000, 6000);
      if (r.status === 0) return { success: false, error: 'worker 没响应', data: [] };
      if (r.status < 200 || r.status >= 300) {
        const body = r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? r.body : {};
        return {
          success: false,
          status: r.status,
          data: [],
          error: typeof body.error === 'string' ? body.error : '读取记忆项目列表失败',
        };
      }
      const body = r.body && typeof r.body === 'object' ? r.body : {};
      const projects = Array.isArray(body.data)
        ? body.data.map((project: unknown) => String(project).trim()).filter(Boolean)
        : [];
      return { success: true, data: projects, count: projects.length };
    });

    ipcMain.handle('shadowfolk:suggest-aliases', async (_event, workspace: string) => {
      const value = String(workspace || '').trim();
      if (!value) return { success: false, error: 'workspace is required', suggestions: [] };
      const r = await workerRequestWithRetry('POST', '/api/shadowfolk/workspaces/suggest-aliases', 15000, 6000, { workspace: value });
      if (r.status === 0) return { success: false, error: 'worker 没响应', suggestions: [] };
      return r.body || { success: false, suggestions: [] };
    });

    ipcMain.handle('shadowfolk:status', async () => {
      const r = await workerRequestWithRetry('GET', '/api/shadowfolk/status', 10000, 4000);
      if (r.status === 0) return { success: false, error: 'worker 没响应' };
      return r.body || { success: false };
    });

    ipcMain.handle('shadowfolk:push-now', async () => {
      const r = await workerRequestWithRetry('POST', '/api/shadowfolk/push', 120000, 120000);
      if (r.status === 0) return { success: false, error: 'worker 没响应' };
      return r.body || { success: false };
    });

    ipcMain.handle('shadowfolk:history', async (_event, workspace: string) => {
      const value = String(workspace || '').trim();
      if (!value) return { success: false, error: 'workspace is required', options: [] };
      const path = `/api/shadowfolk/history?workspace=${encodeURIComponent(value)}`;
      const r = await workerRequestWithRetry('GET', path, 15000, 6000);
      if (r.status === 0) return { success: false, error: 'worker 没响应', options: [] };
      return r.body || { success: false, options: [] };
    });

    ipcMain.handle('shadowfolk:replay', async (_event, data: Record<string, unknown>) => {
      const r = await workerRequestWithRetry('POST', '/api/shadowfolk/replay', 120000, 120000, data);
      if (r.status === 0) return { success: false, error: 'worker 没响应' };
      return r.body || { success: false };
    });

    /* ---------------- server connection IPC ---------------- */

    ipcMain.handle('server:parse-invite', (_event, raw: string) => {
      return parseCmemInviteDetailed(raw);
    });

    ipcMain.handle('server:apply-invite', async (_event, raw: string) => {
      const result = parseCmemInviteDetailed(raw);
      if (!result) return { success: false, error: '链接看不懂，请确认是 cmem:// 开头或服务器邀请链接' };
      if ('error' in result) return { success: false, error: result.error };
      const parsed = result;

      const oldConfig = getConfig();
      const isServerSwitch = oldConfig.serverUrl && oldConfig.serverUrl !== parsed.serverUrl;

      setConfig({
        serverUrl: parsed.serverUrl,
        serverUserName: parsed.userName,
        serverToken: encryptToken(parsed.token),
        serverEnabled: true,
      });
      await this.onConfigChanged();

      if (isServerSwitch) {
        // Wait for worker to restart, then reset sync state for the new server
        setTimeout(async () => {
          try {
            await workerRequestWithRetry('POST', '/api/sync/reset', 15000, 6000);
          } catch { /* best-effort */ }
        }, 3000);
      }

      return { success: true, data: { serverUrl: parsed.serverUrl, userName: parsed.userName } };
    });

    ipcMain.handle('server:test', async () => {
      const r = await workerRequestWithRetry('POST', '/api/sync/test', 15000, 6000);
      if (r.status === 0) {
        return { success: false, error: '本地服务一直没响应，请稍后重试或重启应用' };
      }
      return r.body || { success: false, error: '未知响应' };
    });

    ipcMain.handle('server:status', async () => {
      const r = await workerRequestWithRetry('GET', '/api/sync/status', 10000, 4000);
      if (r.status === 0) return { success: false, error: 'worker 没响应' };
      return r.body || { success: false };
    });

    ipcMain.handle('server:rescan', async () => {
      const r = await workerRequestWithRetry('POST', '/api/sync/rescan', 30000, 15000);
      if (r.status === 0) return { success: false, error: 'worker 没响应' };
      return r.body || { success: false };
    });

    ipcMain.handle('server:consume-pending-invite', () => {
      const p = this.pendingInvite;
      this.pendingInvite = null;
      return p;
    });

    /* ---------------- IDE hooks IPC (existing) ---------------- */

    ipcMain.handle('hooks:detect-ides', () => {
      return this.registrar.detectIDEs();
    });

    ipcMain.handle('hooks:register', (_event, ide: string) => {
      return this.registrar.register(ide as DesktopIntegrationType);
    });

    ipcMain.handle('hooks:unregister', (_event, ide: string) => {
      return this.registrar.unregister(ide as DesktopIntegrationType);
    });

    // ── ShadwMonitor Bridge (desktop-monitor-plugin) ──
    ipcMain.handle('shadwmonitor:get-config', async () => {
      const exists = this.shadwBridge.exists();
      if (!exists) {
        return { success: false, error: 'ShadwMonitor 插件目录不存在' };
      }
      const [agentMem, env] = await Promise.all([
        this.shadwBridge.readAgentMem(),
        this.shadwBridge.readEnv(),
      ]);
      return { success: true, agentMem, env, pluginRoot: ShadwMonitorConfigBridge.defaultPluginRoot() };
    });

    ipcMain.handle('shadwmonitor:save-config', async (_event, data: { agentMem?: Record<string, unknown>; env?: Record<string, unknown> }) => {
      try {
        if (data.agentMem) {
          await this.shadwBridge.writeAgentMem(data.agentMem as any);
        }
        if (data.env) {
          await this.shadwBridge.writeEnv(data.env as any);
        }
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err?.message || String(err) };
      }
    });

    ipcMain.handle('shadwmonitor:reveal-api-key', async () => {
      const key = await this.shadwBridge.revealApiKey();
      return { success: true, apiKey: key };
    });

    ipcMain.handle('shadwmonitor:detect-python', async () => {
      return await this.shadwProcess.detectPython();
    });

    ipcMain.handle('shadwmonitor:install-deps', async () => {
      return await this.shadwProcess.installDependencies();
    });

    ipcMain.handle('shadwmonitor:start', async () => {
      return await this.shadwProcess.start();
    });

    ipcMain.handle('shadwmonitor:stop', async () => {
      await this.shadwProcess.stop();
      return { success: true };
    });

    ipcMain.handle('shadwmonitor:status', () => {
      return this.shadwProcess.getStatus();
    });

    // ── Self-Evolve Plugin ──
    const seSettingsPath = path.join(os.homedir(), '.config', 'agent-memory', 'settings.json');

    ipcMain.handle('selfevolve:get-config', async () => {
      try {
        const raw = await fs.promises.readFile(seSettingsPath, 'utf8');
        const parsed = JSON.parse(raw);
        const se = parsed?.plugins?.selfEvolve ?? {};
        return {
          success: true,
          enabled: se.enabled ?? false,
          reviewMode: se.reviewMode ?? 'manual',
          qualityGateThreshold: se.qualityGateThreshold ?? 70,
          maxContextRules: se.maxContextRules ?? 20,
          criticOnGenerate: se.criticOnGenerate !== false,
        };
      } catch {
        return { success: true, enabled: false, reviewMode: 'manual', qualityGateThreshold: 70, maxContextRules: 20, criticOnGenerate: true };
      }
    });

    ipcMain.handle('selfevolve:save-config', async (_event, data: Record<string, unknown>) => {
      try {
        await fs.promises.mkdir(path.dirname(seSettingsPath), { recursive: true });
        let current: Record<string, unknown> = {};
        try {
          const raw = await fs.promises.readFile(seSettingsPath, 'utf8');
          current = JSON.parse(raw);
        } catch { /* start fresh */ }

        if (!current.plugins || typeof current.plugins !== 'object') current.plugins = {};
        const plugins = current.plugins as Record<string, unknown>;
        if (!plugins.selfEvolve || typeof plugins.selfEvolve !== 'object') plugins.selfEvolve = {};
        const se = plugins.selfEvolve as Record<string, unknown>;

        if (data.enabled !== undefined) se.enabled = !!data.enabled;
        if (data.reviewMode !== undefined) se.reviewMode = data.reviewMode;
        if (data.qualityGateThreshold !== undefined) se.qualityGateThreshold = Number(data.qualityGateThreshold);
        if (data.maxContextRules !== undefined) se.maxContextRules = Number(data.maxContextRules);
        if (data.criticOnGenerate !== undefined) se.criticOnGenerate = !!data.criticOnGenerate;

        await fs.promises.writeFile(seSettingsPath, JSON.stringify(current, null, 2) + '\n', 'utf8');
        await this.onConfigChanged();
        return { success: true };
      } catch (err: unknown) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    });

    // ── Injector Plugin ──
    ipcMain.handle('injector:get-config', async () => {
      try {
        const raw = await fs.promises.readFile(seSettingsPath, 'utf8');
        const parsed = JSON.parse(raw);
        const inj = parsed?.plugins?.injector ?? {};
        return { success: true, enabled: inj.enabled ?? false };
      } catch {
        return { success: true, enabled: false };
      }
    });

    ipcMain.handle('injector:save-config', async (_event, data: Record<string, unknown>) => {
      try {
        await fs.promises.mkdir(path.dirname(seSettingsPath), { recursive: true });
        let current: Record<string, unknown> = {};
        try {
          const raw = await fs.promises.readFile(seSettingsPath, 'utf8');
          current = JSON.parse(raw);
        } catch { /* start fresh */ }

        if (!current.plugins || typeof current.plugins !== 'object') current.plugins = {};
        const plugins = current.plugins as Record<string, unknown>;
        if (!plugins.injector || typeof plugins.injector !== 'object') plugins.injector = {};
        const inj = plugins.injector as Record<string, unknown>;

        if (data.enabled !== undefined) inj.enabled = !!data.enabled;

        await fs.promises.writeFile(seSettingsPath, JSON.stringify(current, null, 2) + '\n', 'utf8');
        await this.onConfigChanged();
        return { success: true };
      } catch (err: unknown) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  /**
   * Called by main.ts when a cmem:// URL arrives. Stashes the parsed invite
   * and shows the settings window scrolled to the server section.
   */
  showWithInvite(rawInvite: string): void {
    const parsed = parseCmemInvite(rawInvite);
    if (parsed) this.pendingInvite = parsed;
    this.show();
    // Notify renderer (in case window already loaded)
    if (this.window && !this.window.isDestroyed() && this.window.webContents) {
      this.window.webContents.send('server:invite-arrived', parsed);
    }
  }

  show(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      return;
    }

    this.window = new BrowserWindow({
      width: 540,
      height: 820,
      resizable: true,
      minimizable: false,
      maximizable: false,
      show: false,
      title: '设置 - AgentMemory',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: false,
        preload: path.join(__dirname, '..', 'preload-settings.js'),
      },
    });

    const htmlPath = path.join(__dirname, 'settings.html');
    this.window.loadFile(htmlPath);

    this.window.once('ready-to-show', () => {
      this.window?.show();
    });

    this.window.on('close', (e) => {
      if (this.window && !this.isQuitting) {
        e.preventDefault();
        this.window.hide();
      }
    });
  }

  destroy(): void {
    this.isQuitting = true;
    ipcMain.removeHandler('settings:get');
    ipcMain.removeHandler('settings:save');
    ipcMain.removeHandler('shadowfolk:get-config');
    ipcMain.removeHandler('shadowfolk:save-config');
    ipcMain.removeHandler('shadowfolk:reveal-token');
    ipcMain.removeHandler('shadowfolk:validate-workspace');
    ipcMain.removeHandler('shadowfolk:list-memory-projects');
    ipcMain.removeHandler('shadowfolk:suggest-aliases');
    ipcMain.removeHandler('shadowfolk:status');
    ipcMain.removeHandler('shadowfolk:push-now');
    ipcMain.removeHandler('shadowfolk:history');
    ipcMain.removeHandler('shadowfolk:replay');
    ipcMain.removeHandler('server:parse-invite');
    ipcMain.removeHandler('server:apply-invite');
    ipcMain.removeHandler('server:test');
    ipcMain.removeHandler('server:status');
    ipcMain.removeHandler('server:rescan');
    ipcMain.removeHandler('server:consume-pending-invite');
    ipcMain.removeHandler('hooks:detect-ides');
    ipcMain.removeHandler('hooks:register');
    ipcMain.removeHandler('hooks:unregister');
    ipcMain.removeHandler('shadwmonitor:get-config');
    ipcMain.removeHandler('shadwmonitor:save-config');
    ipcMain.removeHandler('shadwmonitor:reveal-api-key');
    ipcMain.removeHandler('shadwmonitor:detect-python');
    ipcMain.removeHandler('shadwmonitor:install-deps');
    ipcMain.removeHandler('shadwmonitor:start');
    ipcMain.removeHandler('shadwmonitor:stop');
    ipcMain.removeHandler('shadwmonitor:status');
    ipcMain.removeHandler('selfevolve:get-config');
    ipcMain.removeHandler('selfevolve:save-config');
    this.shadwProcess.destroy();
    this.window?.destroy();
    this.window = null;
  }
}
