import Store from 'electron-store';
import { safeStorage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { decryptSecureValue, encryptSecureValue } from './secure-value';

const DATA_DIR = path.join(require('os').homedir(), '.agent-memory');
const LEGACY_DATA_DIR = path.join(require('os').homedir(), '.codebuddy-mem');

function migrateLegacyDataDirectory(): void {
  try {
    if (!fs.existsSync(DATA_DIR) && fs.existsSync(LEGACY_DATA_DIR)) {
      fs.renameSync(LEGACY_DATA_DIR, DATA_DIR);
    }
    if (!fs.existsSync(DATA_DIR)) return;

    for (const name of fs.readdirSync(DATA_DIR)) {
      if (!name.startsWith('codebuddy-mem.db')) continue;
      const nextName = `agent-memory.db${name.slice('codebuddy-mem.db'.length)}`;
      const from = path.join(DATA_DIR, name);
      const to = path.join(DATA_DIR, nextName);
      if (!fs.existsSync(to)) fs.renameSync(from, to);
    }
  } catch (error) {
    console.warn('[AgentMemory] Legacy data migration failed; existing data was left untouched:', error);
  }
}

migrateLegacyDataDirectory();

export interface ViewerBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

export interface ShadowFolkWorkspaceAlias {
  workspace: string;
  memoryRoots: string[];
}

export type ApiProvider = 'timiai' | 'openai' | 'anthropic' | 'deepseek' | 'aliyun-bailian';

/**
 * 向量重建性能档位。控制 onnxruntime intra-op 线程数与 indexer page 节奏。
 *   - eco    省电:   2 线程,           不影响其他程序 (默认 — 兼顾老用户机器)
 *   - normal 普通:   min(4, cores/2)
 *   - fast   高速:   max(2, cores - 2), 最快但会让机器明显卡顿
 * 用户可在托盘菜单切换;切换后下次启动 / 下次 reindex 生效。
 */
export type VectorIndexerProfile = 'eco' | 'normal' | 'fast';

export interface AppConfig {
  port: number;
  openAtLogin: boolean;
  globalShortcut: string;
  maxRestartAttempts: number;
  healthCheckInterval: number;
  apiProvider: ApiProvider;
  // Legacy single API key, kept for one-time migration into apiKeys.
  apiKey: string;
  // Per-provider encrypted API keys. Each provider stores one key (safeStorage base64).
  apiKeys: Partial<Record<ApiProvider, string>>;
  apiModel: string;
  // Tier 2 中级（便宜）模型的服务商；留空时回退到 apiProvider
  apiProviderLight: ApiProvider;
  // Tier 2 中级（便宜）模型，用于普通蒸馏；留空时回退到 apiModel
  apiModelLight: string;
  claudeCodePath: string;
  // Server connection (FR-10/11)
  serverEnabled: boolean;
  serverUrl: string;
  serverToken: string;
  serverUserName: string;
  deviceName: string;
  // ShadowFolk Upload Plugin configuration (third-party uploader)
  shadowfolkEnabled: boolean;
  shadowfolkDailyTime: string;
  shadowfolkWorkspaces: string[];
  shadowfolkWorkspaceAliases: ShadowFolkWorkspaceAlias[];
  // Viewer window persisted bounds (PRD: viewer-frameless-window)
  viewerBounds?: ViewerBounds;
  // Update checker: version the user has dismissed
  dismissedVersion?: string;
  // Vector indexer 性能档位 (beta.8 新增, 缺省 eco)
  vectorIndexerProfile?: VectorIndexerProfile;
}

const defaults: AppConfig = {
  port: 3847,
  openAtLogin: true,
  globalShortcut: 'CmdOrCtrl+Shift+M',
  maxRestartAttempts: 5,
  healthCheckInterval: 3000,
  apiProvider: 'timiai',
  apiKey: '',
  apiKeys: {},
  apiModel: 'gpt-5.4',
  apiProviderLight: 'timiai',
  apiModelLight: 'gpt-4o-mini',
  claudeCodePath: 'claude',
  serverEnabled: false,
  serverUrl: '',
  serverToken: '',
  serverUserName: '',
  deviceName: '',
  shadowfolkEnabled: false,
  shadowfolkDailyTime: '23:30',
  shadowfolkWorkspaces: [],
  shadowfolkWorkspaceAliases: [],
  vectorIndexerProfile: 'eco',
};

const store = new Store<AppConfig>({
  name: 'desktop-config',
  cwd: DATA_DIR,
  defaults,
});

function normalizeShadowFolkPath(value: string): string {
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/([a-z]:\/)/i, '$1')
    .replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function normalizeShadowFolkWorkspaceAliases(value: unknown): ShadowFolkWorkspaceAlias[] {
  if (!Array.isArray(value)) return [];
  const aliases = new Map<string, ShadowFolkWorkspaceAlias>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const workspace = typeof record.workspace === 'string'
      ? normalizeShadowFolkPath(record.workspace)
      : '';
    const memoryRoots = Array.isArray(record.memoryRoots)
      ? Array.from(new Set(record.memoryRoots
        .filter((root): root is string => typeof root === 'string')
        .map(root => normalizeShadowFolkPath(root))
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

function migrateApiKeys(apiProvider: ApiProvider, apiKey: string, apiKeys: unknown): Partial<Record<ApiProvider, string>> {
  const map: Partial<Record<ApiProvider, string>> = (apiKeys && typeof apiKeys === 'object' && !Array.isArray(apiKeys))
    ? { ...(apiKeys as Partial<Record<ApiProvider, string>>) }
    : {};
  const hasAny = Object.values(map).some((v) => !!v);
  // One-time migration: if no per-provider keys exist yet but the legacy single
  // apiKey is set, move it under the current provider and persist once.
  if (!hasAny && apiKey) {
    map[apiProvider] = apiKey;
    store.set('apiKeys', map);
  }
  return map;
}

export function getConfig(): AppConfig {
  const apiProvider = store.get('apiProvider');
  const apiKey = store.get('apiKey');
  const apiKeys = migrateApiKeys(apiProvider, apiKey, store.get('apiKeys'));
  const apiProviderLight = (store.get('apiProviderLight') as ApiProvider) || apiProvider;
  return {
    port: store.get('port'),
    openAtLogin: store.get('openAtLogin'),
    globalShortcut: store.get('globalShortcut'),
    maxRestartAttempts: store.get('maxRestartAttempts'),
    healthCheckInterval: store.get('healthCheckInterval'),
    apiProvider,
    apiKey,
    apiKeys,
    apiModel: store.get('apiModel'),
    apiProviderLight,
    apiModelLight: store.get('apiModelLight'),
    claudeCodePath: store.get('claudeCodePath'),
    serverEnabled: store.get('serverEnabled'),
    serverUrl: store.get('serverUrl'),
    serverToken: store.get('serverToken'),
    serverUserName: store.get('serverUserName'),
    deviceName: store.get('deviceName'),
    shadowfolkEnabled: store.get('shadowfolkEnabled'),
    shadowfolkDailyTime: store.get('shadowfolkDailyTime'),
    shadowfolkWorkspaces: store.get('shadowfolkWorkspaces') || [],
    shadowfolkWorkspaceAliases: normalizeShadowFolkWorkspaceAliases(store.get('shadowfolkWorkspaceAliases')),
    viewerBounds: store.get('viewerBounds') as ViewerBounds | undefined,
    dismissedVersion: store.get('dismissedVersion') as string | undefined,
    vectorIndexerProfile: (store.get('vectorIndexerProfile') as VectorIndexerProfile | undefined) ?? 'eco',
  };
}

export function setConfig(partial: Partial<AppConfig>): void {
  for (const [key, value] of Object.entries(partial)) {
    if (key === 'shadowfolkWorkspaceAliases') {
      store.set(key, normalizeShadowFolkWorkspaceAliases(value));
      continue;
    }
    store.set(key as keyof AppConfig, value);
  }
}

export function encryptApiKey(plainKey: string): string {
  return encryptSecureValue(plainKey, safeStorage);
}

export function decryptApiKey(encrypted: string): string {
  return decryptSecureValue(encrypted, safeStorage);
}

// Server token uses the same safeStorage scheme as apiKey
export const encryptToken = encryptApiKey;
export const decryptToken = decryptApiKey;

function normalizeServerUrl(raw: string): string {
  if (!raw) return '';
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  return url.replace(/\/+$/, '');
}

/**
 * Profile → 线程数映射。`eco` 强制 2,即使机器只有 2 核也保留下限。
 * Worker 进程的 ONNX intra-op + libuv 线程池都吃这个值。
 */
export function profileToNumThreads(profile: VectorIndexerProfile): number {
  const cores = require('os').cpus().length || 4;
  switch (profile) {
    case 'fast':
      return Math.max(2, cores - 2);
    case 'normal':
      return Math.max(2, Math.min(4, Math.floor(cores / 2)));
    case 'eco':
    default:
      return 2;
  }
}

/**
 * Infer the API endpoint for a provider. DeepSeek has its own host; everyone
 * else falls back to the worker's default (the built-in TimiAPI proxy) by
 * returning '' — we intentionally do NOT invent openai/anthropic endpoints.
 */
function resolveProviderEndpoint(provider: ApiProvider): string {
  if (provider === 'deepseek') return 'https://api.deepseek.com/chat/completions';
  if (provider === 'aliyun-bailian') {
    return 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
  }
  return process.env.CODEBUDDY_MEM_API_ENDPOINT || '';
}

/**
 * Resolve the plaintext key for a provider from the per-provider key map.
 * TimiAI may use an explicitly configured environment key when left blank.
 */
function resolveProviderKey(config: AppConfig, provider: ApiProvider): string {
  const plain = decryptApiKey(config.apiKeys?.[provider] || '');
  if (plain) return plain;
  return provider === 'timiai' ? (process.env.TIMIAI_API_KEY || '') : '';
}

export function getWorkerEnv(config: AppConfig): Record<string, string> {
  const serverUrl = normalizeServerUrl(config.serverUrl);
  const serverToken = decryptToken(config.serverToken);
  const syncEnabled = !!(config.serverEnabled && serverUrl && serverToken);

  // Hybrid 检索栈环境变量:
  //   - AGENTMEM_MODELS_DIR: BGE-zh ONNX 模型缓存根目录(installer 把模型放在 resources/models/ 下)
  //   forked Worker 不会自动继承 Electron 的 process.resourcesPath,所以这里显式注入。
  //   - OMP_NUM_THREADS / UV_THREADPOOL_SIZE: 把 ONNX intra-op + libuv 线程池都
  //     按当前性能档位限制。EmbeddingService 会读 OMP_NUM_THREADS, 同时也会通过
  //     env.backends.onnx 显式注入 — 双保险, 老用户机器 32k 重建不再卡死整机。
  //   - AGENTMEM_VECTOR_INDEXER_PROFILE: 让 Worker 端 (WorkerService.initHybridStack)
  //     根据档位映射 pageSize / batchDelayMs。
  const hybridEnv: Record<string, string> = {};
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const modelsDir = path.join(resourcesPath, 'models');
    if (fs.existsSync(modelsDir)) {
      hybridEnv.AGENTMEM_MODELS_DIR = modelsDir;
    }
  }
  const profile = config.vectorIndexerProfile ?? 'eco';
  const numThreads = profileToNumThreads(profile);
  hybridEnv.OMP_NUM_THREADS = String(numThreads);
  hybridEnv.UV_THREADPOOL_SIZE = String(numThreads);
  hybridEnv.AGENTMEM_VECTOR_INDEXER_PROFILE = profile;

  // High (advanced) channel.
  const highProvider = config.apiProvider;
  const highKey = resolveProviderKey(config, highProvider);

  // Light (mid-tier) channel — defaults to the high provider when unset.
  const lightProvider = config.apiProviderLight || highProvider;
  const lightKey = resolveProviderKey(config, lightProvider);
  const lightEndpoint = resolveProviderEndpoint(lightProvider);

  return {
    ...process.env as Record<string, string>,
    ...hybridEnv,
    CODEBUDDY_MEM_PORT: String(config.port),
    CODEBUDDY_MEM_HOST: '127.0.0.1',
    CODEBUDDY_MEM_PROVIDER: 'api',
    // High channel: fill exactly one provider slot (DeepSeek rides OPENAI's slot
    // because it is OpenAI-compatible).
    TIMIAI_API_KEY: highProvider === 'timiai' ? highKey : '',
    OPENAI_API_KEY: (highProvider === 'openai' || highProvider === 'deepseek' || highProvider === 'aliyun-bailian') ? highKey : '',
    ANTHROPIC_API_KEY: highProvider === 'anthropic' ? highKey : '',
    CODEBUDDY_MEM_API_ENDPOINT: resolveProviderEndpoint(highProvider),
    CODEBUDDY_MEM_MODEL: config.apiModel || '',
    CODEBUDDY_MEM_MODEL_LIGHT: config.apiModelLight || config.apiModel || '',
    // Light channel: dedicated endpoint + key. Empty values let the worker fall
    // back to the high channel (i.e. "mid-tier follows advanced").
    CODEBUDDY_MEM_LIGHT_ENDPOINT: lightEndpoint,
    CODEBUDDY_MEM_LIGHT_API_KEY: lightKey,
    // Sync env consumed by src/shared/identity.ts → SyncQueue
    CODEBUDDY_MEM_SYNC_ENABLED: syncEnabled ? 'true' : 'false',
    CODEBUDDY_MEM_REMOTE_URL: serverUrl,
    CODEBUDDY_MEM_REMOTE_TOKEN: serverToken,
    CODEBUDDY_MEM_DEVICE_NAME: config.deviceName || '',
    CODEBUDDY_MEM_SHADOWFOLK_ENABLED: config.shadowfolkEnabled ? 'true' : 'false',
    CODEBUDDY_MEM_SHADOWFOLK_DAILY_TIME: config.shadowfolkDailyTime || '23:30',
    CODEBUDDY_MEM_SHADOWFOLK_WORKSPACES: JSON.stringify(config.shadowfolkWorkspaces || []),
    CODEBUDDY_MEM_SHADOWFOLK_WORKSPACE_ALIASES: JSON.stringify(config.shadowfolkWorkspaceAliases || []),
  };
}
