import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getAdapter } from '../../adapters/registry.js';
import { readCodexHookTrustEntries, trustCodexHookEntriesInConfig } from '../../shared/codex-hook-trust.js';
import type { Integration, InstallOptions, InstallResult, IntegrationStatus, IntegrationMechanism } from './types.js';

export class CodexCliInstaller implements Integration {
  id = 'codex-cli';
  displayName = 'Codex App / CLI';
  mechanism: IntegrationMechanism = 'hooks';

  async detect(): Promise<boolean> {
    return existsSync(join(homedir(), '.codex'));
  }

  async install(opts: InstallOptions): Promise<InstallResult> {
    const result: InstallResult = { success: false, filesWritten: [], filesBackedUp: [], warnings: [] };
    const adapter = getAdapter('codex-cli');
    if (!adapter) { result.warnings.push('codex-cli adapter not found'); return result; }

    const configDir = adapter.configDir;
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });

    if (adapter.hooksConfigFile) {
      const hooksPath = join(configDir, adapter.hooksConfigFile);
      if (existsSync(hooksPath)) {
        const backupDir = join(homedir(), '.agent-memory', 'backups', 'codex-cli', new Date().toISOString().replace(/[:.]/g, '-'));
        mkdirSync(backupDir, { recursive: true });
        copyFileSync(hooksPath, join(backupDir, adapter.hooksConfigFile));
        result.filesBackedUp.push(join(backupDir, adapter.hooksConfigFile));
      }
      const hooksConfig = adapter.generateHooksConfig(opts.hooksCliPath, process.platform);
      let existing: any = {};
      if (existsSync(hooksPath)) {
        try { existing = JSON.parse(readFileSync(hooksPath, 'utf8')); } catch { existing = {}; }
      }
      const merged = this.mergeHooksConfig(existing, hooksConfig);
      writeFileSync(hooksPath, JSON.stringify(merged, null, 2), 'utf8');
      result.filesWritten.push(hooksPath);
    }

    if (adapter.mcpConfigFile) {
      const mcpPath = join(configDir, adapter.mcpConfigFile);
      if (existsSync(mcpPath)) {
        const backupDir = join(homedir(), '.agent-memory', 'backups', 'codex-cli', new Date().toISOString().replace(/[:.]/g, '-'));
        mkdirSync(backupDir, { recursive: true });
        copyFileSync(mcpPath, join(backupDir, adapter.mcpConfigFile));
        result.filesBackedUp.push(join(backupDir, adapter.mcpConfigFile));
      }
      const mcpConfig = adapter.generateMcpConfig(opts.mcpServerPath);
      let existing: any = {};
      if (existsSync(mcpPath)) {
        try { existing = JSON.parse(readFileSync(mcpPath, 'utf8')); } catch { existing = {}; }
      }
      const merged = this.deepMerge(existing, mcpConfig);
      writeFileSync(mcpPath, JSON.stringify(merged, null, 2), 'utf8');
      result.filesWritten.push(mcpPath);
    }

    const trustEntries = readCodexHookTrustEntries();
    if (trustEntries.length > 0) {
      trustCodexHookEntriesInConfig(trustEntries);
    }

    result.success = true;
    result.warnings.push('Codex App / CLI hooks installed for standard AgentMemory memory capture; MCP config written for passive query.');
    if (trustEntries.length === 0) {
      result.warnings.push('AgentMemory Codex hooks not found in hooks.json; hook trust was not auto-written.');
    }
    return result;
  }

  private mergeHooksConfig(existing: any, generated: any): any {
    const merged = this.deepMerge(existing, { ...generated, hooks: undefined });
    merged.hooks = {};
    for (const [eventName, groups] of Object.entries(existing?.hooks ?? {})) {
      if (!Array.isArray(groups)) {
        merged.hooks[eventName] = groups;
        continue;
      }
      const filtered = groups.filter((group: any) => {
        const handlers = Array.isArray(group?.hooks) ? group.hooks : [];
        return !handlers.some((hook: any) =>
          typeof hook?.command === 'string'
          && (hook.command.includes('agentmemory-codex') || hook.command.includes('hooks-cli'))
        );
      });
      if (filtered.length > 0) {
        merged.hooks[eventName] = filtered;
      }
    }
    const generatedHooks = generated?.hooks ?? {};
    for (const [eventName, groups] of Object.entries(generatedHooks)) {
      const existingGroups = Array.isArray(merged.hooks[eventName]) ? merged.hooks[eventName] : [];
      const generatedGroups = Array.isArray(groups) ? groups : [];
      if (existingGroups.length > 0 && generatedGroups.length > 0) {
        const firstExisting = existingGroups[0];
        const firstGenerated = generatedGroups[0] as any;
        if (Array.isArray(firstExisting?.hooks) && Array.isArray(firstGenerated?.hooks)) {
          merged.hooks[eventName] = [
            {
              ...firstExisting,
              hooks: [...firstExisting.hooks, ...firstGenerated.hooks],
            },
            ...existingGroups.slice(1),
            ...generatedGroups.slice(1),
          ];
          continue;
        }
      }
      merged.hooks[eventName] = [...existingGroups, ...generatedGroups];
    }
    return merged;
  }

  private deepMerge(base: any, override: any): any {
    if (!base || typeof base !== 'object') return override;
    if (!override || typeof override !== 'object') return override;
    const result = { ...base };
    for (const key of Object.keys(override)) {
      if (typeof result[key] === 'object' && typeof override[key] === 'object'
          && !Array.isArray(result[key]) && !Array.isArray(override[key])) {
        result[key] = this.deepMerge(result[key], override[key]);
      } else {
        result[key] = override[key];
      }
    }
    return result;
  }

  async uninstall(): Promise<InstallResult> {
    return { success: true, filesWritten: [], filesBackedUp: [], warnings: ['Manual MCP config removal recommended'] };
  }

  async status(): Promise<IntegrationStatus> {
    const detected = await this.detect();
    const adapter = getAdapter('codex-cli');
    const configPath = adapter?.mcpConfigFile ? join(adapter.configDir, adapter.mcpConfigFile) : null;
    let installed = false;
    if (configPath && existsSync(configPath)) {
      try { installed = readFileSync(configPath, 'utf8').includes('agent-memory'); } catch { /* ignore */ }
    }
    return { installed, detected, configPath };
  }
}
