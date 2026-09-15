import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  detectIDEs as detectIDEsShared,
  register as registerShared,
  unregister as unregisterShared,
  type DetectedIDE,
  type HooksConfigPaths,
  type IDEType,
  type RegisterResult,
  type UnregisterResult,
} from '../shared/hooks-config';
import { registerCodexMcp, unregisterCodexMcp } from '../shared/codex-config.js';
import { readCodexHookTrustEntries, trustCodexHookEntriesInConfig } from '../shared/codex-hook-trust.js';
import { getConfig } from '../config/store';
import {
  getOpenClawStatus,
  registerOpenClaw,
  unregisterOpenClaw,
  ensureOpenClawPluginUpToDate,
  type OpenClawStatus,
} from './OpenClawRegistrar';
import { registerMcp, unregisterMcp, type MCPRegisterResult } from './MCPConfigRegistrar';

const SETUP_STATE_VERSION = 1;

export interface SetupState {
  version: number;
  registeredIDEs: IDEType[];
  registeredAt: string;
}

export type DesktopIntegrationType = IDEType | 'openclaw';
export type DetectedDesktopIntegration = DetectedIDE | OpenClawStatus;

function getSetupStatePath(): string {
  return path.join(os.homedir(), '.agent-memory', 'setup-state.json');
}

function readSetupState(): SetupState | null {
  const p = getSetupStatePath();
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw) as SetupState;
    if (!data || typeof data !== 'object') return null;
    if (!Array.isArray(data.registeredIDEs)) return null;
    return data;
  } catch {
    return null;
  }
}

function writeSetupState(state: SetupState): void {
  const p = getSetupStatePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2), 'utf8');
}

function mergeRegisteredIde(ide: IDEType): void {
  const now = new Date().toISOString();
  const prev = readSetupState();
  const set = new Set<IDEType>(prev?.registeredIDEs ?? []);
  set.add(ide);
  writeSetupState({
    version: SETUP_STATE_VERSION,
    registeredIDEs: [...set],
    registeredAt: now,
  });
}

function removeRegisteredIde(ide: IDEType): void {
  const prev = readSetupState();
  if (!prev) return;
  const set = new Set(prev.registeredIDEs);
  set.delete(ide);
  writeSetupState({
    version: SETUP_STATE_VERSION,
    registeredIDEs: [...set],
    registeredAt: new Date().toISOString(),
  });
}

/**
 * In packaged mode uses `process.resourcesPath` for bundled `node` / `node.exe` and `hooks-cli.js`.
 * In development uses the system Node binary and repo-root `dist/hooks-cli.js`.
 */
export function getPaths(): HooksConfigPaths {
  if (app.isPackaged) {
    const base = process.resourcesPath;
    const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
    return {
      nodePath: path.join(base, nodeName),
      hooksCliPath: path.join(base, 'worker', 'hooks-cli.js'),
      mcpServerPath: path.join(base, 'worker', 'servers', 'mcp-server.js'),
      hybridMcpServerPath: path.join(base, 'hybrid-mcp', 'dist', 'server.js'),
    };
  }

  const repoRoot = path.join(__dirname, '..', '..', '..');
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
  return {
    nodePath: nodeName,
    hooksCliPath: path.join(repoRoot, 'dist', 'hooks-cli.js'),
    mcpServerPath: path.join(repoRoot, 'dist', 'servers', 'mcp-server.js'),
    hybridMcpServerPath: path.join(repoRoot, 'hybrid-mcp', 'dist', 'server.js'),
  };
}

export function isFirstRun(): boolean {
  return !fs.existsSync(getSetupStatePath());
}

/** True when a detected IDE exists but agent-memory hooks are not fully registered for it. */
export function hasNewUnregisteredIDEs(): boolean {
  return detectIDEs().some((d) => d.type !== 'openclaw' && !d.isRegistered);
}

export function detectIDEs(): DetectedDesktopIntegration[] {
  const list: DetectedDesktopIntegration[] = [...detectIDEsShared()];
  const openClaw = getOpenClawStatus();
  if (openClaw) list.push(openClaw);
  return list;
}

export function register(ide: DesktopIntegrationType): RegisterResult {
  if (ide === 'openclaw') {
    return registerOpenClaw(getConfig().port || 3847);
  }
  const paths = getPaths();
  const result = registerShared(ide, paths);
  if (!result.success) {
    return result;
  }
  if (ide === 'codex') {
    const mcpResult = registerCodexMcp(paths.nodePath, paths.mcpServerPath);
    if (!mcpResult.success) {
      return { success: false, message: mcpResult.message ?? 'Failed to write ~/.codex/mcp.json' };
    }
  }
  mergeRegisteredIde(ide);
  // 2.1.0-beta.7+:hooks 注册成功后,顺带为该 IDE 自动写入 agentmem 两条 MCP。
  // 失败仅 log,不阻塞 hooks 注册成功的语义。
  // codex 已经在上面走了专用 registerCodexMcp,这里再调一次 registerMcp 是无害的:
  // registerMcp 内部针对未识别 IDE 会直接 return noop。
  try {
    const mcpResult = registerMcp(ide, paths);
    if (!mcpResult.success && mcpResult.error) {
      console.warn(
        `[HooksRegistrar] MCP auto-config skipped for ${ide}: ${mcpResult.error}`,
      );
    } else if (mcpResult.action !== 'noop') {
      console.log(
        `[HooksRegistrar] MCP auto-config ${mcpResult.action} for ${ide} → ${mcpResult.configPath}`,
      );
    }
  } catch (err) {
    console.warn(`[HooksRegistrar] MCP auto-config threw for ${ide}:`, err);
  }
  return result;
}

/**
 * App 启动时的静默升级：仅在已部署 OpenClaw plugin 但版本落后时自动重写。
 * 不会因任何异常阻塞调用方。
 */
export function ensureOpenClawUpToDate(): boolean {
  try {
    return ensureOpenClawPluginUpToDate(getConfig().port || 3847);
  } catch {
    return false;
  }
}

export function unregister(ide: DesktopIntegrationType): UnregisterResult {
  if (ide === 'openclaw') {
    return unregisterOpenClaw();
  }
  const result = unregisterShared(ide);
  if (!result.success) {
    return result;
  }
  if (ide === 'codex') {
    const mcpResult = unregisterCodexMcp();
    if (!mcpResult.success) {
      return { success: false, message: mcpResult.message ?? 'Failed to update ~/.codex/mcp.json' };
    }
  }
  removeRegisteredIde(ide);
  // 2.1.0-beta.7+:hooks 反注册成功后,顺带从该 IDE mcp.json 移除 agentmem 两条。
  // 用户其他 MCP server 完全保留。失败仅 log。
  // codex 的 mcp 已经在上面走了 unregisterCodexMcp,这里 unregisterMcp 对 codex
  // 是 noop;对 cursor / claude / codebuddy* 才有实际清理动作。
  try {
    const mcpResult = unregisterMcp(ide);
    if (!mcpResult.success && mcpResult.error) {
      console.warn(
        `[HooksRegistrar] MCP auto-cleanup skipped for ${ide}: ${mcpResult.error}`,
      );
    }
  } catch (err) {
    console.warn(`[HooksRegistrar] MCP auto-cleanup threw for ${ide}:`, err);
  }
  return result;
}

/**
 * 启动兜底:升级路径上,beta.6 用户已经 register 过若干 IDE 但当时还没 MCP 自动配置。
 * 这里在 app 启动时为所有已 registered IDE 跑一遍 registerMcp,确保升级到 beta.7
 * 后老用户的 IDE mcp.json 也自动收到 agentmem 两条配置。幂等 — 已正确则 noop。
 *
 * 返回每个 IDE 的处理结果,供 main.ts 决定是否弹通知。
 */
export function ensureMcpConfiguredForRegisteredIdes(): MCPRegisterResult[] {
  const state = readSetupState();
  if (!state || !state.registeredIDEs?.length) return [];
  const results: MCPRegisterResult[] = [];
  const paths = getPaths();
  for (const ide of state.registeredIDEs) {
    try {
      if (ide === 'codex') {
        const result = registerCodexMcp(paths.nodePath, paths.mcpServerPath);
        const entries = readCodexHookTrustEntries();
        if (entries.length > 0) {
          trustCodexHookEntriesInConfig(entries);
        }
        results.push({
          success: result.success,
          ide,
          configPath: path.join(os.homedir(), '.codex', 'mcp.json'),
          action: result.success ? 'updated' : 'noop',
          error: result.message,
        });
        continue;
      }
      results.push(registerMcp(ide, paths));
    } catch (err) {
      results.push({
        success: false,
        ide,
        configPath: '',
        action: 'noop',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

/** Facade used by SetupWizard, SettingsWindow IPC, and main process lifecycle. */
export const HooksRegistrar = {
  detectIDEs,
  register,
  unregister,
  isFirstRun,
  hasNewUnregisteredIDEs,
  ensureOpenClawUpToDate,
  ensureMcpConfiguredForRegisteredIdes,
};
