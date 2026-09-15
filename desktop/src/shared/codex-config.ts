import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const MCP_SERVER_KEY = 'agent-memory';
const LEGACY_CORE_MCP_KEYS = ['codebuddy-mem'] as const;
const MANAGED_NON_CORE_MCP_KEYS = ['agentmem-hybrid', 'cbm-hybrid', 'cbm-resume', 'agentmem-resume'] as const;

function codexHomeDir(): string {
  return path.join(os.homedir(), '.codex');
}

export function getCodexMcpJsonPath(): string {
  return path.join(codexHomeDir(), 'mcp.json');
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    let raw = fs.readFileSync(filePath, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const b = result[key];
    const o = override[key];
    if (
      b && typeof b === 'object' && !Array.isArray(b)
      && o && typeof o === 'object' && !Array.isArray(o)
    ) {
      result[key] = deepMerge(b as Record<string, unknown>, o as Record<string, unknown>);
    } else {
      result[key] = o;
    }
  }
  return result;
}

export function isCodexMcpRegistered(mcpPath: string): boolean {
  const cfg = readJson(mcpPath);
  const servers = cfg?.mcpServers as Record<string, unknown> | undefined;
  if (!servers || typeof servers !== 'object') return false;
  const entry = servers[MCP_SERVER_KEY];
  if (!entry || typeof entry !== 'object') return false;
  const args = (entry as Record<string, unknown>).args;
  if (!Array.isArray(args)) return false;
  const hasWorkerMcp = args.some((a) => typeof a === 'string' && a.includes('mcp-server'));
  return hasWorkerMcp;
}

export function registerCodexMcp(
  nodePath: string,
  mcpServerPath: string,
): { success: boolean; message?: string } {
  const dir = codexHomeDir();
  const mcpPath = getCodexMcpJsonPath();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const patch = {
      mcpServers: {
        [MCP_SERVER_KEY]: {
          command: nodePath,
          args: [mcpServerPath],
          env: {},
        },
      },
    };
    const existing = readJson(mcpPath) ?? {};
    const merged = deepMerge(existing, patch);
    const servers = merged.mcpServers as Record<string, unknown> | undefined;
    if (servers && typeof servers === 'object') {
      // This master-bugs-only build intentionally does not ship import-history,
      // embedding, or the hybrid MCP. Remove AgentMemory-managed hybrid leftovers from
      // earlier experimental installers while preserving user-owned servers.
      for (const key of MANAGED_NON_CORE_MCP_KEYS) delete servers[key];
      for (const key of LEGACY_CORE_MCP_KEYS) delete servers[key];
    }
    fs.writeFileSync(mcpPath, JSON.stringify(merged, null, 2), 'utf8');
    return { success: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, message: msg };
  }
}

export function unregisterCodexMcp(): { success: boolean; message?: string } {
  const mcpPath = getCodexMcpJsonPath();
  if (!fs.existsSync(mcpPath)) {
    return { success: true, message: 'mcp.json not found' };
  }
  const cfg = readJson(mcpPath);
  if (!cfg) {
    return { success: false, message: 'Invalid mcp.json' };
  }
  const servers = cfg.mcpServers as Record<string, unknown> | undefined;
  if (servers && typeof servers === 'object') {
    delete servers[MCP_SERVER_KEY];
    for (const key of LEGACY_CORE_MCP_KEYS) delete servers[key];
    for (const key of MANAGED_NON_CORE_MCP_KEYS) delete servers[key];
    if (Object.keys(servers).length === 0) {
      delete cfg.mcpServers;
    } else {
      cfg.mcpServers = servers;
    }
  }
  try {
    fs.writeFileSync(mcpPath, JSON.stringify(cfg, null, 2), 'utf8');
    return { success: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, message: msg };
  }
}

export function computeCodexFullyRegistered(
  hooksRegistered: boolean,
  mcpServerPath: string,
): boolean {
  return hooksRegistered && isCodexMcpRegistered(mcpServerPath);
}
