import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Integration, InstallOptions, InstallResult, IntegrationStatus, IntegrationMechanism } from './types.js';

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

function normalizePluginPath(value: string): string {
  return resolve(value.replace(/^~(?=$|[/\\])/, homedir()));
}

function isAgentMemoryPluginPath(value: string, pluginDir: string): boolean {
  const normalized = normalizePluginPath(value);
  const name = basename(normalized);
  return normalized === resolve(pluginDir) || name === 'agent-memory' || name === 'tmp-openclaw-agent-memory-plugin';
}

function ensureOpenClawConfigPointsToPlugin(configPath: string, pluginDir: string): void {
  if (!existsSync(configPath)) return;
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
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
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function getOpenClawBinary(): string | null {
  const candidates = [
    'openclaw',
    '/opt/homebrew/bin/openclaw',
    '/usr/local/bin/openclaw',
    join(homedir(), '.npm-global', 'bin', 'openclaw'),
    join(homedir(), '.local', 'bin', 'openclaw'),
  ];
  for (const candidate of candidates) {
    try {
      if (candidate.includes('/')) {
        if (existsSync(candidate)) return candidate;
      } else {
        execFileSync(process.platform === 'win32' ? 'where' : 'which', [candidate], { stdio: 'ignore' });
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function runOpenClaw(args: string[]): void {
  if (process.env.AGENT_MEMORY_DISABLE_OPENCLAW_CLI === '1') {
    throw new Error('OpenClaw CLI disabled by AGENT_MEMORY_DISABLE_OPENCLAW_CLI');
  }
  const openClawBinary = getOpenClawBinary();
  if (!openClawBinary) {
    throw new Error('OpenClaw CLI not found');
  }
  execFileSync(openClawBinary, args, { stdio: 'ignore' });
}

export class OpenClawInstaller implements Integration {
  id = 'openclaw';
  displayName = 'OpenClaw Gateway';
  mechanism: IntegrationMechanism = 'plugin';

  private get configDir(): string {
    return join(homedir(), '.openclaw');
  }

  async detect(): Promise<boolean> {
    return existsSync(this.configDir);
  }

  private writePluginFiles(pluginDir: string, port = 3847): string[] {
    if (!existsSync(pluginDir)) {
      mkdirSync(pluginDir, { recursive: true });
    }
    const packagePath = join(pluginDir, 'package.json');
    const manifestPath = join(pluginDir, 'openclaw.plugin.json');
    const indexPath = join(pluginDir, 'index.js');
    const configPath = join(pluginDir, 'config.json');
    const config = {
      enabled: true,
      project: 'openclaw-gateway',
      workerHost: '127.0.0.1',
      workerPort: port,
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

    writeFileSync(packagePath, JSON.stringify({
      name: 'agent-memory-openclaw-plugin',
      version: '0.0.0',
      type: 'module',
      private: true,
      main: './index.js',
      openclaw: { extensions: ['./index.js'] },
    }, null, 2) + '\n', 'utf8');
    writeFileSync(manifestPath, JSON.stringify({
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
    writeFileSync(indexPath, PLUGIN_INDEX_JS, 'utf8');
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    return [packagePath, manifestPath, indexPath, configPath];
  }

  async install(opts: InstallOptions): Promise<InstallResult> {
    const result: InstallResult = { success: false, filesWritten: [], filesBackedUp: [], warnings: [] };

    const pluginDir = join(this.configDir, 'plugins', 'agent-memory');
    try {
      runOpenClaw(['plugins', 'uninstall', '--force', '--keep-files', 'agent-memory']);
    } catch {
      // It may not be installed yet; keep going.
    }

    result.filesWritten.push(...this.writePluginFiles(pluginDir));

    try {
      runOpenClaw(['plugins', 'install', '--link', pluginDir]);
    } catch (err) {
      result.warnings.push(`OpenClaw plugin registration failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    ensureOpenClawConfigPointsToPlugin(join(this.configDir, 'openclaw.json'), pluginDir);
    try {
      runOpenClaw(['plugins', 'registry', '--refresh']);
    } catch (err) {
      result.warnings.push(`OpenClaw plugin registry refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      runOpenClaw(['config', 'set', 'plugins.entries.agent-memory.hooks.allowConversationAccess', 'true']);
    } catch (err) {
      result.warnings.push(`Failed to enable OpenClaw conversation access: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      runOpenClaw(['gateway', 'restart']);
    } catch {
      result.warnings.push('OpenClaw plugin installed; restart OpenClaw Gateway to load it.');
    }

    result.success = true;
    result.warnings.push('Configure observationFeed.botToken and .to for notification delivery');
    return result;
  }

  /**
   * 静默升级已部署的 OpenClaw plugin（npm 端等价于桌面版的自动升级）。
   *
   * 行为：
   *  - 部署版 index.js 不存在 → 跳过（用户没启用 OpenClaw 集成，不擅自激活）
   *  - 部署版已是当前模板版本 → 跳过（无更新）
   *  - 版本标识缺失或过期 → 重写 plugin 文件、刷新 registry、尝试重启 gateway
   *
   * 返回 true 表示执行了升级动作（无论后续 gateway 重启是否成功）。
   * 任何失败都不会抛——升级路径必须不阻塞调用方（典型：worker start）。
   */
  ensureUpToDate(port = 3847): boolean {
    try {
      const pluginDir = join(this.configDir, 'plugins', 'agent-memory');
      const indexPath = join(pluginDir, 'index.js');
      if (!existsSync(indexPath)) return false;

      let deployed: string;
      try {
        deployed = readFileSync(indexPath, 'utf8');
      } catch {
        return false;
      }

      const versionTag = `AGENT_MEMORY_PLUGIN_VERSION=${PLUGIN_TEMPLATE_VERSION}`;
      if (deployed.includes(versionTag)) {
        return false;
      }

      this.writePluginFiles(pluginDir, port);
      ensureOpenClawConfigPointsToPlugin(join(this.configDir, 'openclaw.json'), pluginDir);
      try {
        runOpenClaw(['plugins', 'registry', '--refresh']);
      } catch {
        // best-effort
      }
      try {
        runOpenClaw(['gateway', 'restart']);
      } catch {
        // best-effort: 新 index.js 会在下一次 gateway 启动时被加载
      }
      return true;
    } catch {
      return false;
    }
  }

  async uninstall(): Promise<InstallResult> {
    try {
      runOpenClaw(['plugins', 'uninstall', '--force', '--keep-files', 'agent-memory']);
    } catch {
      // Best-effort; continue removing sidecar files.
    }
    rmSync(join(this.configDir, 'plugins', 'agent-memory', 'config.json'), { force: true });
    return {
      success: true,
      filesWritten: [],
      filesBackedUp: [],
      warnings: ['OpenClaw plugin uninstalled; restart OpenClaw Gateway if it is still running'],
    };
  }

  async status(): Promise<IntegrationStatus> {
    const detected = await this.detect();
    const pluginConfigPath = join(this.configDir, 'plugins', 'agent-memory', 'config.json');
    const installed = existsSync(pluginConfigPath) && existsSync(join(this.configDir, 'plugins', 'agent-memory', 'index.js'));
    return {
      installed,
      detected,
      configPath: installed ? pluginConfigPath : null,
    };
  }
}
