/**
 * MCPConfigRegistrar — 跟随「关联 IDE」自动写入 mcp.json
 *
 * 同事新装一台机器、第一次关联某个 IDE 之后,
 * agentmem-hybrid 一条 MCP 自动出现在该 IDE 的 mcp.json 里,
 * 无需手动编辑配置文件。
 *
 * 设计原则:
 *   - **严格 merge,不破坏用户其他 MCP 条目**
 *     (iWiki / shadow-folk / cursor 自带的 gongfengStreamable 等)
 *   - 只 touch `mcpServers.agentmem-hybrid` 这一个 key
 *   - 失败不阻塞 hooks 注册主流程(catch + warn)
 *   - 写盘前先 .agentmemory-backup 备份原文件
 *   - 幂等:已正确则 noop
 *   - 顺手清理 2.1.0-beta.5 及更早残留的 cbm-hybrid / cbm-resume 旧名,
 *     以及 2.1.0-beta.8 之前打包的 agentmem-resume(resume MCP 已移除)
 *     (对全新用户无副作用 — 他们的 mcp.json 里没这些 key)
 *
 * 各 IDE 的 mcp.json 路径(实测):
 *   - codebuddy        ~/.gongfeng-copilot/mcp.json
 *   - codebuddy-ide    ~/.codebuddy/mcp.json
 *   - cursor           ~/.cursor/mcp.json
 *   - claude-code      ~/.claude.json           (HOME 根,不是 .claude/ 子目录)
 *   - claude-internal  ~/.claude-internal/.claude.json
 *
 * 5 种 IDE 的 mcp 配置格式都统一为 {mcpServers: {<name>: {command|url|args|...}}},
 * 所以一套 read-merge-write 流程通用。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HooksConfigPaths, IDEType } from '../shared/hooks-config';

const HYBRID_KEY = 'agentmem-hybrid';

type MCPRuntimePaths = Pick<HooksConfigPaths, 'nodePath' | 'hybridMcpServerPath'>;

function hybridEntry(paths: MCPRuntimePaths): { command: string; args: string[] } {
  return {
    command: paths.nodePath,
    args: [paths.hybridMcpServerPath],
  };
}

/**
 * 升级路径上需要清理的历史命名:
 *   - cbm-hybrid / cbm-resume: 2.1.0-beta.5 之前的旧命名
 *   - agentmem-resume: 2.1.0-beta.8 起 resume MCP 已从安装包移除,需要从老用户
 *     的 mcp.json 里清理,否则会留死配置(命令找不到 → IDE 显示 MCP error)
 * 全新装机不存在这些 key,这一步是 noop。
 */
const LEGACY_KEYS = ['cbm-hybrid', 'cbm-resume', 'agentmem-resume'] as const;

export interface MCPRegisterResult {
  success: boolean;
  ide: IDEType;
  configPath: string;
  /** 'created' = 新建文件, 'updated' = 修改文件, 'noop' = 已正确 */
  action: 'created' | 'updated' | 'noop';
  error?: string;
}

/**
 * 给定 IDE 返回其 mcp.json 真实路径。
 *
 * 注意 claude-code 的 mcp 配置在 HOME 根的 .claude.json 里,
 * 而不是 hooks 用的 ~/.claude/settings.json — 这是 Claude Code
 * 的设计,不要混淆。
 */
export function getMcpJsonPath(ide: IDEType): string {
  const home = os.homedir();
  switch (ide) {
    case 'codebuddy':
      return path.join(home, '.gongfeng-copilot', 'mcp.json');
    case 'codebuddy-ide':
      return path.join(home, '.codebuddy', 'mcp.json');
    case 'cursor':
      return path.join(home, '.cursor', 'mcp.json');
    case 'claude-code':
      return path.join(home, '.claude.json');
    case 'claude-internal':
      return path.join(home, '.claude-internal', '.claude.json');
    case 'codex':
      // codex 的 MCP 不走这套通用 read-merge-write,它由 master 引入的
      // registerCodexMcp 单独写入 ~/.codex/mcp.json (独立 schema)。
      // registerMcp/unregisterMcp 会针对 codex 提前 short-circuit。
      return path.join(home, '.codex', 'mcp.json');
    default: {
      // 编译期穷举保证;运行时兜底返回一个不会被误用的安全路径
      const _exhaustive: never = ide;
      throw new Error(`Unsupported IDE for MCP auto-config: ${String(_exhaustive)}`);
    }
  }
}

/**
 * 比较两个 entry 是否实质相等(只看 command 字段)。
 * 用户可能手动改过其他字段(如加 env / args),如果 command 已对就不动。
 */
function entryMatches(
  entry: unknown,
  expected: { command: string; args: string[] }
): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as { command?: unknown; args?: unknown };
  return e.command === expected.command
    && Array.isArray(e.args)
    && e.args.length === expected.args.length
    && e.args.every((arg, index) => arg === expected.args[index]);
}

interface MutableConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

function readConfigSafe(filePath: string): { ok: true; cfg: MutableConfig; raw: string }
                                           | { ok: false; reason: string } {
  if (!fs.existsSync(filePath)) {
    return { ok: true, cfg: {}, raw: '' };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return { ok: true, cfg: {}, raw };
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'top-level value is not a JSON object' };
    }
    return { ok: true, cfg: parsed as MutableConfig, raw };
  } catch (err) {
    return { ok: false, reason: `parse error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function backupOnce(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const backupPath = filePath + '.agentmemory-backup';
  try {
    fs.copyFileSync(filePath, backupPath);
  } catch {
    /* 备份失败不致命,继续主流程 */
  }
}

/**
 * 在指定 IDE 的 mcp.json 里 upsert agentmem-hybrid,
 * 同时清理历史 cbm-* / agentmem-resume 残留。其他 server 完全保留。幂等。
 */
export function registerMcp(ide: IDEType, paths: MCPRuntimePaths): MCPRegisterResult {
  // codex 由 master 的 registerCodexMcp 专门负责;这里短路避免与之竞争写 ~/.codex/mcp.json。
  if (ide === 'codex') {
    return { success: true, ide, configPath: getMcpJsonPath(ide), action: 'noop' };
  }
  const configPath = getMcpJsonPath(ide);

  const read = readConfigSafe(configPath);
  if (!read.ok) {
    return {
      success: false,
      ide,
      configPath,
      action: 'noop',
      error: `mcp.json invalid (${read.reason}); not modifying user file`,
    };
  }

  const cfg = read.cfg;
  if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object' || Array.isArray(cfg.mcpServers)) {
    cfg.mcpServers = {};
  }
  const servers = cfg.mcpServers as Record<string, unknown>;
  const expectedEntry = hybridEntry(paths);

  let changed = false;

  if (!entryMatches(servers[HYBRID_KEY], expectedEntry)) {
    servers[HYBRID_KEY] = expectedEntry;
    changed = true;
  }

  // 升级清理:
  //   - beta.5 及之前的 cbm-hybrid / cbm-resume 替换为新名后,旧 key 应删除
  //   - beta.8 起 resume MCP 已移除,老用户的 agentmem-resume 死配置必须清掉,
  //     否则 IDE 启动 MCP 时找不到 agentmem-resume-mcp 命令会显示 error
  // 全新装机不存在这些 key,这几步是 noop。
  for (const legacyKey of LEGACY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(servers, legacyKey)) {
      delete servers[legacyKey];
      changed = true;
    }
  }

  if (!changed) {
    return { success: true, ide, configPath, action: 'noop' };
  }

  const wasNew = !fs.existsSync(configPath);
  if (!wasNew) backupOnce(configPath);

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // 保持原有缩进风格难度不大,这里统一 2 空格,跟 IDE 自己写的格式一致。
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    return { success: true, ide, configPath, action: wasNew ? 'created' : 'updated' };
  } catch (err) {
    return {
      success: false,
      ide,
      configPath,
      action: 'noop',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 解关联 IDE 时调用:仅删 agentmem-hybrid 与历史残留 (cbm-* 与 agentmem-resume),
 * 不动其他。不创建文件;若文件不存在或无 mcpServers,直接 noop。
 */
export function unregisterMcp(ide: IDEType): MCPRegisterResult {
  if (ide === 'codex') {
    return { success: true, ide, configPath: getMcpJsonPath(ide), action: 'noop' };
  }
  const configPath = getMcpJsonPath(ide);

  if (!fs.existsSync(configPath)) {
    return { success: true, ide, configPath, action: 'noop' };
  }

  const read = readConfigSafe(configPath);
  if (!read.ok) {
    return {
      success: false,
      ide,
      configPath,
      action: 'noop',
      error: `mcp.json invalid (${read.reason}); not modifying user file`,
    };
  }

  const cfg = read.cfg;
  if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object' || Array.isArray(cfg.mcpServers)) {
    return { success: true, ide, configPath, action: 'noop' };
  }
  const servers = cfg.mcpServers as Record<string, unknown>;

  let changed = false;
  for (const key of [HYBRID_KEY, ...LEGACY_KEYS]) {
    if (Object.prototype.hasOwnProperty.call(servers, key)) {
      delete servers[key];
      changed = true;
    }
  }

  if (!changed) {
    return { success: true, ide, configPath, action: 'noop' };
  }

  backupOnce(configPath);
  try {
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    return { success: true, ide, configPath, action: 'updated' };
  } catch (err) {
    return {
      success: false,
      ide,
      configPath,
      action: 'noop',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
