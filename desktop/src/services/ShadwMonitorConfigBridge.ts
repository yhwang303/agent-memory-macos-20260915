/**
 * ShadwMonitor 插件配置桥
 *
 * 职责：
 *   - 读写 plugins/shadwmonitor/config/settings.yaml 的 agent_mem 节
 *     （保留其余节 + 注释，使用 yaml 库的 round-trip 模式）
 *   - 读写 plugins/shadwmonitor/.env 的 AI_MONITOR_BASE_URL / AI_MONITOR_API_KEY
 *
 * 设计文档：docs/memory-core/features/desktop-monitor-plugin/design.md §B 桌面端集成
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
import * as yaml from 'js-yaml';

export interface ShadwAgentMemConfig {
  enabled: boolean;
  endpoint: string;
  scope: string;
  poll_interval_seconds: number;
  batch_size: number;
  retry_max_attempts: number;
  retry_initial_delay_seconds: number;
  retry_max_delay_seconds: number;
  mirror: {
    moment: boolean;
    session: boolean;
    daily: boolean;
  };
}

export interface ShadwEnvConfig {
  baseUrl: string;
  hasApiKey: boolean;
  /** 仅返回脱敏字符串，真值通过 reveal 单独取 */
  apiKeyMasked: string;
}

const DEFAULT_AGENT_MEM: ShadwAgentMemConfig = {
  enabled: false,
  endpoint: 'http://127.0.0.1:3847',
  scope: 'desktop-monitor',
  poll_interval_seconds: 30,
  batch_size: 50,
  retry_max_attempts: 10,
  retry_initial_delay_seconds: 1,
  retry_max_delay_seconds: 60,
  mirror: { moment: true, session: false, daily: false },
};

export class ShadwMonitorConfigBridge {
  private readonly pluginRoot: string;

  constructor(pluginRoot?: string) {
    this.pluginRoot = pluginRoot ?? ShadwMonitorConfigBridge.defaultPluginRoot();
  }

  /** 默认插件路径：开发态走 repo/plugins/shadwmonitor；打包后走 resources/plugins/shadwmonitor。
   *
   * Windows installer 通过 desktop/package.json 的 `win.extraResources` 把
   * plugins/shadwmonitor/ 整目录（排除 data/__pycache__/.env 等运行时产物）
   * 拷贝到 <install dir>/resources/plugins/shadwmonitor/。
   * extraResources 直接进 resources/<to>，**不带 app/ 前缀**（那是 files 字段的去处）。
   */
  static defaultPluginRoot(): string {
    if (app.isPackaged) {
      const bundledRoot = path.join(process.resourcesPath, 'plugins', 'shadwmonitor');
      if (process.platform !== 'darwin') return bundledRoot;

      // A signed macOS app bundle must remain immutable. ShadwMonitor writes
      // settings.yaml, .env, its database, and screenshots at runtime, so give
      // it a per-user working copy instead of modifying Contents/Resources.
      const writableRoot = path.join(os.homedir(), '.agent-memory', 'plugins', 'shadwmonitor');
      const writableConfig = path.join(writableRoot, 'config', 'settings.yaml');
      if (!fs.existsSync(writableConfig)) {
        fs.mkdirSync(path.dirname(writableRoot), { recursive: true });
        fs.cpSync(bundledRoot, writableRoot, { recursive: true, force: true });
      }
      return writableRoot;
    }
    // dev: desktop/dist 之上倒推到 repo root
    return path.join(__dirname, '..', '..', '..', 'plugins', 'shadwmonitor');
  }

  get configPath(): string {
    return path.join(this.pluginRoot, 'config', 'settings.yaml');
  }

  get envPath(): string {
    return path.join(this.pluginRoot, '.env');
  }

  exists(): boolean {
    return fs.existsSync(this.configPath);
  }

  async readAgentMem(): Promise<ShadwAgentMemConfig> {
    if (!this.exists()) return { ...DEFAULT_AGENT_MEM };
    const raw = await fsp.readFile(this.configPath, 'utf-8');
    const doc = (yaml.load(raw) as Record<string, unknown>) ?? {};
    const section = (doc.agent_mem as Record<string, unknown> | undefined) ?? {};
    const mirrorRaw = (section.mirror as Record<string, unknown> | undefined) ?? {};
    return {
      enabled: Boolean(section.enabled ?? DEFAULT_AGENT_MEM.enabled),
      endpoint: String(section.endpoint ?? DEFAULT_AGENT_MEM.endpoint),
      scope: String(section.scope ?? DEFAULT_AGENT_MEM.scope),
      poll_interval_seconds: Number(section.poll_interval_seconds ?? DEFAULT_AGENT_MEM.poll_interval_seconds),
      batch_size: Number(section.batch_size ?? DEFAULT_AGENT_MEM.batch_size),
      retry_max_attempts: Number(section.retry_max_attempts ?? DEFAULT_AGENT_MEM.retry_max_attempts),
      retry_initial_delay_seconds: Number(section.retry_initial_delay_seconds ?? DEFAULT_AGENT_MEM.retry_initial_delay_seconds),
      retry_max_delay_seconds: Number(section.retry_max_delay_seconds ?? DEFAULT_AGENT_MEM.retry_max_delay_seconds),
      mirror: {
        moment: Boolean(mirrorRaw.moment ?? DEFAULT_AGENT_MEM.mirror.moment),
        session: Boolean(mirrorRaw.session ?? DEFAULT_AGENT_MEM.mirror.session),
        daily: Boolean(mirrorRaw.daily ?? DEFAULT_AGENT_MEM.mirror.daily),
      },
    };
  }

  /**
   * 写回 agent_mem 节。保留其他节但**会丢失注释**——js-yaml 不支持 round-trip 注释保留。
   * 这是 ShadwMonitor save_monitor_indices() 同样的妥协。
   */
  async writeAgentMem(updates: Partial<ShadwAgentMemConfig>): Promise<void> {
    if (!fs.existsSync(this.pluginRoot)) {
      throw new Error(`ShadwMonitor 插件目录不存在: ${this.pluginRoot}`);
    }
    const raw = this.exists() ? await fsp.readFile(this.configPath, 'utf-8') : '';
    const doc = (yaml.load(raw) as Record<string, unknown>) ?? {};
    const existing = await this.readAgentMem();
    const merged: ShadwAgentMemConfig = {
      ...existing,
      ...updates,
      mirror: { ...existing.mirror, ...(updates.mirror ?? {}) },
    };
    doc.agent_mem = {
      enabled: merged.enabled,
      endpoint: merged.endpoint,
      scope: merged.scope,
      poll_interval_seconds: merged.poll_interval_seconds,
      batch_size: merged.batch_size,
      retry_max_attempts: merged.retry_max_attempts,
      retry_initial_delay_seconds: merged.retry_initial_delay_seconds,
      retry_max_delay_seconds: merged.retry_max_delay_seconds,
      mirror: merged.mirror,
    };
    const out = yaml.dump(doc, { lineWidth: 200, noRefs: true });
    await fsp.mkdir(path.dirname(this.configPath), { recursive: true });
    await fsp.writeFile(this.configPath, out, 'utf-8');
  }

  // ── .env ──

  async readEnv(): Promise<ShadwEnvConfig> {
    if (!fs.existsSync(this.envPath)) return { baseUrl: '', hasApiKey: false, apiKeyMasked: '' };
    const raw = await fsp.readFile(this.envPath, 'utf-8');
    const map = parseDotEnv(raw);
    const apiKey = (map['AI_MONITOR_API_KEY'] || '').trim();
    return {
      baseUrl: (map['AI_MONITOR_BASE_URL'] || '').trim(),
      hasApiKey: apiKey.length > 0,
      apiKeyMasked: apiKey ? mask(apiKey) : '',
    };
  }

  async revealApiKey(): Promise<string> {
    if (!fs.existsSync(this.envPath)) return '';
    const raw = await fsp.readFile(this.envPath, 'utf-8');
    return (parseDotEnv(raw)['AI_MONITOR_API_KEY'] || '').trim();
  }

  async writeEnv(data: { baseUrl?: string; apiKey?: string }): Promise<void> {
    if (!fs.existsSync(this.pluginRoot)) {
      throw new Error(`ShadwMonitor 插件目录不存在: ${this.pluginRoot}`);
    }
    const map = fs.existsSync(this.envPath)
      ? parseDotEnv(await fsp.readFile(this.envPath, 'utf-8'))
      : {};
    if (typeof data.baseUrl === 'string') map['AI_MONITOR_BASE_URL'] = data.baseUrl.trim();
    if (typeof data.apiKey === 'string' && data.apiKey !== '********') {
      map['AI_MONITOR_API_KEY'] = data.apiKey.trim();
    }
    const lines = [
      '# Auto-managed by agent-mem desktop Settings · ShadwMonitor Bridge',
      `# Last updated: ${new Date().toISOString()}`,
      '',
      ...Object.entries(map).map(([k, v]) => `${k}=${v}`),
      '',
    ];
    await fsp.writeFile(this.envPath, lines.join(os.EOL), 'utf-8');
  }
}

function parseDotEnv(text: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    map[key] = value;
  }
  return map;
}

function mask(s: string): string {
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}${'*'.repeat(Math.min(8, s.length - 8))}${s.slice(-4)}`;
}
