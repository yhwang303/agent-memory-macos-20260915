/**
 * Codex only runs user hooks after trust is persisted under hooks.state in
 * ~/.codex/config.toml. The trust identity mirrors codex-rs hook hashing.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CodexHookTrustEntry {
  eventName: string;
  groupIndex: number;
  hookIndex: number;
  command: string;
  timeout: number;
}

function canonicalJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalJson);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = canonicalJson(obj[key]);
  }
  return sorted;
}

/** Mirrors codex-rs `version_for_toml` (TomlValue -> canonical JSON -> sha256). */
export function versionForTomlIdentity(identity: Record<string, unknown>): string {
  const serialized = JSON.stringify(canonicalJson(identity));
  const hex = crypto.createHash('sha256').update(serialized).digest('hex');
  return `sha256:${hex}`;
}

export function codexHookTrustedHash(eventName: string, command: string, timeoutSec = 30): string {
  return versionForTomlIdentity({
    event_name: eventName.toLowerCase(),
    hooks: [
      {
        type: 'command',
        async: false,
        command,
        timeout: timeoutSec,
      },
    ],
  });
}

/** Backward-compatible alias for older tests/call sites. */
export function codexStopHookTrustedHash(command: string, timeoutSec = 30): string {
  return codexHookTrustedHash('Stop', command, timeoutSec);
}

export function codexHookStateKey(
  hooksJsonPath: string,
  eventName: string,
  groupIndex: number,
  hookIndex: number,
): string {
  return `${hooksJsonPath}:${eventName.toLowerCase()}:${groupIndex}:${hookIndex}`;
}

/** Backward-compatible alias for older tests/call sites. */
export function codexStopHookStateKey(hooksJsonPath: string): string {
  return codexHookStateKey(hooksJsonPath, 'Stop', 0, 0);
}

function escapeTomlKey(key: string): string {
  return `"${key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function readHookStateBlocks(configText: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const re = /\[hooks\.state\."((?:\\.|[^"\\])+)"\]([\s\S]*?)(?=\n\[|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(configText)) !== null) {
    const key = match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    blocks.set(key, match[2]);
  }
  return blocks;
}

function upsertHookStateBlocks(existing: string, hooksJsonPath: string, entries: CodexHookTrustEntry[]): string {
  let next = existing;
  for (const entry of entries) {
    const hookKey = codexHookStateKey(hooksJsonPath, entry.eventName, entry.groupIndex, entry.hookIndex);
    const trustedHash = codexHookTrustedHash(entry.eventName, entry.command, entry.timeout);
    const sectionHeader = `[hooks.state.${escapeTomlKey(hookKey)}]`;
    const body = `${sectionHeader}\ntrusted_hash = "${trustedHash}"\n`;
    const escapedKey = escapeTomlKey(hookKey).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const blockRe = new RegExp(`\\[hooks\\.state\\.${escapedKey}\\][\\s\\S]*?(?=\\n\\[|$)`);
    next = blockRe.test(next)
      ? next.replace(blockRe, body.trimEnd() + '\n\n')
      : (next.endsWith('\n') || next === '' ? next : next + '\n') + '\n' + body;
  }
  return next;
}

export function codexHookEntriesTrustedInConfig(entries: CodexHookTrustEntry[]): boolean {
  const codexHome = path.join(os.homedir(), '.codex');
  const hooksJsonPath = path.join(codexHome, 'hooks.json');
  const configPath = path.join(codexHome, 'config.toml');
  if (!fs.existsSync(hooksJsonPath) || entries.length === 0) return false;

  let existing = '';
  try {
    existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  } catch {
    return false;
  }

  const blocks = readHookStateBlocks(existing);
  return entries.every((entry) => {
    const hookKey = codexHookStateKey(hooksJsonPath, entry.eventName, entry.groupIndex, entry.hookIndex);
    const expected = codexHookTrustedHash(entry.eventName, entry.command, entry.timeout);
    const block = blocks.get(hookKey);
    const escapedHash = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !!block && new RegExp(`trusted_hash\\s*=\\s*"${escapedHash}"`).test(block);
  });
}

export function trustCodexHookEntriesInConfig(entries: CodexHookTrustEntry[]): boolean {
  const codexHome = path.join(os.homedir(), '.codex');
  const hooksJsonPath = path.join(codexHome, 'hooks.json');
  const configPath = path.join(codexHome, 'config.toml');
  if (!fs.existsSync(hooksJsonPath) || entries.length === 0) return false;

  let existing = '';
  try {
    if (fs.existsSync(configPath)) {
      existing = fs.readFileSync(configPath, 'utf8');
    }
  } catch {
    return false;
  }

  try {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(configPath, upsertHookStateBlocks(existing, hooksJsonPath, entries), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Backward-compatible helper for a single Stop command hook. */
export function trustCodexStopHookInConfig(command: string, timeoutSec = 30): boolean {
  return trustCodexHookEntriesInConfig([{
    eventName: 'Stop',
    groupIndex: 0,
    hookIndex: 0,
    command,
    timeout: timeoutSec,
  }]);
}

/** Read all AgentMemory Codex command hooks from ~/.codex/hooks.json. */
export function readCodexHookTrustEntries(): CodexHookTrustEntry[] {
  const hooksPath = path.join(os.homedir(), '.codex', 'hooks.json');
  try {
    const raw = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string; timeout?: number }> }>>;
    };
    const result: CodexHookTrustEntry[] = [];
    for (const [eventName, groups] of Object.entries(raw.hooks ?? {})) {
      if (!Array.isArray(groups)) continue;
      groups.forEach((group, groupIndex) => {
        (group.hooks ?? []).forEach((hook, hookIndex) => {
          if (
            typeof hook.command === 'string'
            && (hook.command.includes('agentmemory-codex') || hook.command.includes('cbmem-codex'))
          ) {
            result.push({
              eventName,
              groupIndex,
              hookIndex,
              command: hook.command,
              timeout: typeof hook.timeout === 'number' ? hook.timeout : 30,
            });
          }
        });
      });
    }
    return result;
  } catch {
    return [];
  }
}

/** Read the first Stop hook command from ~/.codex/hooks.json (prefers agentmemory-codex). */
export function readCodexStopHookCommand(): string | null {
  const stopEntry = readCodexHookTrustEntries().find((entry) => entry.eventName === 'stop' || entry.eventName === 'Stop');
  if (stopEntry) return stopEntry.command;

  const hooksPath = path.join(os.homedir(), '.codex', 'hooks.json');
  try {
    const raw = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as {
      hooks?: {
        stop?: Array<{ hooks?: Array<{ command?: string }> }>;
        Stop?: Array<{ hooks?: Array<{ command?: string }> }>;
      };
    };
    const groups = raw.hooks?.stop ?? raw.hooks?.Stop;
    if (!Array.isArray(groups)) return null;
    for (const group of groups) {
      for (const h of group.hooks ?? []) {
        if (typeof h.command === 'string') return h.command;
      }
    }
  } catch {
    return null;
  }
  return null;
}
