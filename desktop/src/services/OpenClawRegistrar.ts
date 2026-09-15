import { execFileSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const PLUGIN_TEMPLATE_VERSION = 'v2-session-end';

const PLUGIN_INDEX_JS = String.raw`// AGENT_MEMORY_PLUGIN_VERSION=v2-session-end
import fs from 'node:fs';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

const DEFAULT_CONFIG = {
  enabled: true,
  project: 'openclaw-gateway',
  workerHost: '127.0.0.1',
  workerPort: 3847,
  syncMemoryFile: true,
  syncMemoryFileExclude: ['debugger'],
  captureChannel: true,
  captureLLMIO: false
};

function readSidecarConfig() {
  try {
    const raw = fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function resolveConfig(api) {
  return { ...DEFAULT_CONFIG, ...readSidecarConfig(), ...(api.pluginConfig || {}) };
}

function baseUrl(config) {
  return 'http://' + (config.workerHost || '127.0.0.1') + ':' + (config.workerPort || 3847);
}

function pickSessionId(event, ctx) {
  return event?.session_id || event?.sessionId || ctx?.sessionId || ctx?.sessionKey || 'openclaw-' + Date.now();
}

function pickChannelText(event) {
  const raw = event?.text ?? event?.message ?? event?.content ?? '';
  return typeof raw === 'string' ? raw.slice(0, 4000) : '';
}

async function postJson(url, body) {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch {
    // Agent Memory must never block OpenClaw turns.
  }
}

function fireAndForgetPostJson(url, body) {
  // sync hooks (e.g. tool_result_persist) must not return a Promise.
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).catch(() => {});
}

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

export default definePluginEntry({
  id: 'agent-memory',
  name: 'Agent Memory',
  description: 'Forwards OpenClaw agent lifecycle events to a local Agent Memory worker.',
  register(api) {
    const config = resolveConfig(api);
    if (config.enabled === false) return;
    const root = baseUrl(config);
    let cachedContext = '';
    let cachedContextExpires = 0;

    api.on('gateway_start', async () => {
      try { await fetch(root + '/api/readiness'); } catch {}
    });

    api.on('before_agent_start', async (event, ctx) => {
      const sessionId = pickSessionId(event, ctx);
      await postJson(root + '/api/session/start', {
        sessionId,
        project: config.project,
        userPrompt: textOf(event?.prompt || event?.message || event?.input || ''),
        sourceIDE: 'openclaw',
        metadata: {
          source: 'openclaw',
          agent_id: ctx?.agentId || event?.agent_id,
          session_key: ctx?.sessionKey
        }
      });
    });

    api.on('before_prompt_build', async (event) => {
      if (Date.now() >= cachedContextExpires) {
        try {
          const res = await fetch(root + '/api/context/inject?project=' + encodeURIComponent(config.project) + '&limit=20');
          cachedContext = await res.text();
          cachedContextExpires = Date.now() + 60000;
        } catch {}
      }
      if (!cachedContext) return;
      if (typeof event?.prompt === 'string') return { prompt: cachedContext + '\n\n' + event.prompt };
      return { prependSystemContext: cachedContext };
    });

    // tool_result_persist is a SYNC hook in OpenClaw. Returning a Promise
    // produces a "result was ignored" warning, so we fire-and-forget here.
    api.on('tool_result_persist', (event, ctx) => {
      const toolName = event?.toolName || event?.tool_name || event?.name || 'tool';
      if ((config.syncMemoryFileExclude || []).includes(toolName)) return;
      fireAndForgetPostJson(root + '/api/observation', {
        sessionId: pickSessionId(event, ctx),
        toolName,
        toolInput: event?.input || event?.args || {},
        toolOutput: textOf(event?.result || event?.output || event).slice(0, 2000),
        observationType: 'tool_output',
        sourceIDE: 'openclaw'
      });
    });

    api.on('agent_end', async (event, ctx) => {
      const sessionId = pickSessionId(event, ctx);
      const messageText = textOf(event?.response || event?.output || event?.message || event?.messages || event);
      if (messageText) {
        await postJson(root + '/api/observation', {
          sessionId,
          toolName: 'openclaw_agent_end',
          toolInput: { source: 'openclaw', project: config.project },
          toolOutput: messageText.slice(0, 4000),
          observationType: 'agent_response',
          sourceIDE: 'openclaw'
        });
      }
      await postJson(root + '/api/session/end', { sessionId, reason: 'openclaw_agent_end' });
    });

    // P0: capture channel-based conversations (OpenClaw Control UI / Telegram / iMessage / ...).
    api.on('message_received', async (event, ctx) => {
      if (config.captureChannel === false) return;
      const sessionId = pickSessionId(event, ctx);
      const text = pickChannelText(event);
      if (!text) return;
      const channel = event?.channel || ctx?.channel || 'unknown';
      const from = event?.from || 'unknown';
      await postJson(root + '/api/session/start', {
        sessionId,
        project: config.project,
        userPrompt: text,
        sourceIDE: 'openclaw',
        metadata: { source: 'openclaw-channel', channel, from }
      });
      await postJson(root + '/api/observation', {
        sessionId,
        toolName: 'channel_inbound',
        toolInput: { channel, from },
        toolOutput: text,
        observationType: 'channel_inbound',
        sourceIDE: 'openclaw'
      });
    });

    api.on('message_sent', async (event, ctx) => {
      if (config.captureChannel === false) return;
      const sessionId = pickSessionId(event, ctx);
      const text = pickChannelText(event);
      if (!text) return;
      const channel = event?.channel || ctx?.channel || 'unknown';
      const to = event?.to || 'unknown';
      await postJson(root + '/api/observation', {
        sessionId,
        toolName: 'channel_outbound',
        toolInput: { channel, to },
        toolOutput: text,
        observationType: 'channel_outbound',
        sourceIDE: 'openclaw'
      });
    });
  }
});
`;

export interface OpenClawStatus {
  type: 'openclaw';
  ideDataDir: string;
  hooksJsonPath: string;
  isRegistered: boolean;
  isDetected: boolean;
  mechanism: 'plugin';
}

export interface OpenClawRegisterResult {
  success: boolean;
  message?: string;
}

function getOpenClawDir(): string {
  return path.join(os.homedir(), '.openclaw');
}

function getPluginDir(): string {
  return path.join(getOpenClawDir(), 'plugins', 'agent-memory');
}

function getConfigPath(): string {
  return path.join(getPluginDir(), 'config.json');
}

function getOpenClawConfigPath(): string {
  return path.join(getOpenClawDir(), 'openclaw.json');
}

function getOpenClawBinary(): string | null {
  const candidates = [
    'openclaw',
    '/opt/homebrew/bin/openclaw',
    '/usr/local/bin/openclaw',
    path.join(os.homedir(), '.npm-global', 'bin', 'openclaw'),
    path.join(os.homedir(), '.local', 'bin', 'openclaw'),
  ];
  for (const candidate of candidates) {
    try {
      if (candidate.includes('/') || candidate.includes('\\')) {
        if (fs.existsSync(candidate)) return candidate;
      } else {
        const cmd = process.platform === 'win32' ? `where ${candidate}` : `which ${candidate}`;
        execSync(cmd, { stdio: 'ignore' });
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function runOpenClaw(args: string[]): void {
  const openClawBinary = getOpenClawBinary();
  if (!openClawBinary) {
    throw new Error('OpenClaw CLI not found');
  }
  execFileSync(openClawBinary, args, { stdio: 'ignore' });
}

export function detectOpenClaw(): boolean {
  return fs.existsSync(getOpenClawDir()) || getOpenClawBinary() !== null;
}

export function getOpenClawStatus(): OpenClawStatus | null {
  const isDetected = detectOpenClaw();
  const configPath = getConfigPath();
  const pluginEntryPath = path.join(getPluginDir(), 'index.js');
  if (!isDetected && !fs.existsSync(configPath) && !fs.existsSync(pluginEntryPath)) return null;

  return {
    type: 'openclaw',
    ideDataDir: getOpenClawDir(),
    hooksJsonPath: configPath,
    isRegistered: fs.existsSync(configPath) && fs.existsSync(pluginEntryPath),
    isDetected,
    mechanism: 'plugin',
  };
}

function writePluginPackage(pluginDir: string, port: number): string[] {
  try {
    runOpenClaw(['plugins', 'uninstall', '--force', '--keep-files', 'agent-memory']);
  } catch {
    // It may not be installed yet; keep going.
  }
  fs.mkdirSync(pluginDir, { recursive: true });
  const packagePath = path.join(pluginDir, 'package.json');
  const manifestPath = path.join(pluginDir, 'openclaw.plugin.json');
  const indexPath = path.join(pluginDir, 'index.js');
  const configPath = getConfigPath();
  const config = {
    enabled: true,
    project: 'openclaw-gateway',
    workerHost: '127.0.0.1',
    workerPort: port || 3847,
    syncMemoryFile: true,
    syncMemoryFileExclude: ['debugger'],
    captureChannel: true,
    captureLLMIO: false,
    observationFeed: {
      enabled: false,
      channel: 'telegram',
      to: '',
    },
  };

  fs.writeFileSync(packagePath, JSON.stringify({
    name: 'agent-memory-openclaw-plugin',
    version: '0.0.0',
    type: 'module',
    private: true,
    main: './index.js',
    openclaw: { extensions: ['./index.js'] },
  }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(manifestPath, JSON.stringify({
    id: 'agent-memory',
    name: 'Agent Memory',
    description: 'Forwards OpenClaw agent lifecycle events to a local Agent Memory worker.',
    configSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        enabled: { type: 'boolean' },
        project: { type: 'string' },
        workerHost: { type: 'string' },
        workerPort: { type: 'number' },
        syncMemoryFile: { type: 'boolean' },
        syncMemoryFileExclude: { type: 'array', items: { type: 'string' } },
        captureChannel: { type: 'boolean' },
        captureLLMIO: { type: 'boolean' },
        observationFeed: { type: 'object' },
      },
    },
  }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(indexPath, PLUGIN_INDEX_JS, 'utf8');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  return [packagePath, manifestPath, indexPath, configPath];
}

function installLinkedPlugin(pluginDir: string): void {
  runOpenClaw(['plugins', 'install', '--link', pluginDir]);
}

function normalizePluginPath(value: string): string {
  return path.resolve(value.replace(/^~(?=$|[/\\])/, os.homedir()));
}

function isAgentMemoryPluginPath(value: string, pluginDir: string): boolean {
  const normalized = normalizePluginPath(value);
  const name = path.basename(normalized);
  return normalized === path.resolve(pluginDir) || name === 'agent-memory' || name === 'tmp-openclaw-agent-memory-plugin';
}

function ensureOpenClawConfigPointsToPlugin(pluginDir: string): void {
  const configPath = getOpenClawConfigPath();
  if (!fs.existsSync(configPath)) return;
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.plugins = config.plugins || {};
  config.plugins.entries = config.plugins.entries || {};
  config.plugins.entries['agent-memory'] = {
    ...(config.plugins.entries['agent-memory'] || {}),
    enabled: true,
    hooks: {
      ...((config.plugins.entries['agent-memory'] || {}).hooks || {}),
      allowConversationAccess: true,
    },
  };
  config.plugins.load = config.plugins.load || {};
  const existingPaths = Array.isArray(config.plugins.load.paths) ? config.plugins.load.paths : [];
  config.plugins.load.paths = [
    ...existingPaths.filter((value: unknown) => typeof value === 'string' && !isAgentMemoryPluginPath(value, pluginDir)),
    pluginDir,
  ];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

export function registerOpenClaw(port: number): OpenClawRegisterResult {
  try {
    const pluginDir = getPluginDir();
    const filesWritten = writePluginPackage(pluginDir, port);
    installLinkedPlugin(pluginDir);
    ensureOpenClawConfigPointsToPlugin(pluginDir);
    runOpenClaw(['plugins', 'registry', '--refresh']);
    runOpenClaw(['config', 'set', 'plugins.entries.agent-memory.hooks.allowConversationAccess', 'true']);
    try {
      runOpenClaw(['gateway', 'restart']);
    } catch {
      return { success: true, message: `OpenClaw 插件已安装，需要重启 OpenClaw Gateway 后生效：${filesWritten.join(', ')}` };
    }
    return { success: true, message: `OpenClaw 插件已安装并注册：${filesWritten.join(', ')}` };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 静默升级已部署的 OpenClaw plugin。
 *
 * 适用场景：用户已经把 agent-memory 跟 OpenClaw 关联过（部署版 index.js 存在），
 * 但 App 升级到新版后部署版还是旧的——此时直接判断版本标识，过期就重写并刷新。
 *
 * 行为：
 *  - 部署版不存在 / 未注册：不动（用户没主动开 OpenClaw 集成，不擅自启用）
 *  - 部署版已是最新模板：不动
 *  - 部署版与最新模板版本不一致：重写所有 plugin 文件 + plugins registry --refresh + gateway restart
 *
 * 返回 true 表示有更新动作（无论成功/失败），false 表示跳过。失败不会抛——升级路径必须不阻塞 App 启动。
 */
export function ensureOpenClawPluginUpToDate(port: number): boolean {
  try {
    const pluginDir = getPluginDir();
    const indexPath = path.join(pluginDir, 'index.js');
    if (!fs.existsSync(indexPath)) return false;

    let deployed: string;
    try {
      deployed = fs.readFileSync(indexPath, 'utf8');
    } catch {
      return false;
    }

    const versionTag = `AGENT_MEMORY_PLUGIN_VERSION=${PLUGIN_TEMPLATE_VERSION}`;
    if (deployed.includes(versionTag)) {
      return false;
    }

    writePluginPackage(pluginDir, port);
    ensureOpenClawConfigPointsToPlugin(pluginDir);
    try {
      runOpenClaw(['plugins', 'registry', '--refresh']);
    } catch {
      // Refresh is best-effort.
    }
    try {
      runOpenClaw(['gateway', 'restart']);
    } catch {
      // Restart is best-effort; new index.js will be picked up on next gateway start.
    }
    return true;
  } catch {
    return false;
  }
}

export function unregisterOpenClaw(): OpenClawRegisterResult {
  try {
    try {
      runOpenClaw(['plugins', 'uninstall', '--force', '--keep-files', 'agent-memory']);
    } catch {
      // Best-effort; continue removing sidecar config.
    }
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      fs.rmSync(configPath, { force: true });
    }
    return { success: true, message: 'OpenClaw 插件已卸载；如果 Gateway 仍在运行，请重启 OpenClaw' };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : String(error) };
  }
}
