import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getAdapter } from '../../adapters/registry.js';
import type { Integration, InstallOptions, InstallResult, IntegrationStatus, IntegrationMechanism } from './types.js';

export abstract class BaseHooksInstaller implements Integration {
  abstract id: string;
  abstract displayName: string;
  mechanism: IntegrationMechanism = 'hooks';

  protected get adapter() {
    const a = getAdapter(this.id);
    if (!a) throw new Error(`Adapter "${this.id}" not found in registry`);
    return a;
  }

  protected backupDir(): string {
    return join(homedir(), '.agent-memory', 'backups', this.id);
  }

  async detect(): Promise<boolean> {
    return existsSync(this.adapter.configDir);
  }

  async install(opts: InstallOptions): Promise<InstallResult> {
    const adapter = this.adapter;
    const result: InstallResult = { success: false, filesWritten: [], filesBackedUp: [], warnings: [] };

    const configDir = adapter.configDir;
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = join(this.backupDir(), timestamp);
    mkdirSync(backupDir, { recursive: true });

    if (adapter.hooksConfigFile) {
      const hooksPath = join(configDir, adapter.hooksConfigFile);
      if (existsSync(hooksPath)) {
        const backupPath = join(backupDir, adapter.hooksConfigFile);
        copyFileSync(hooksPath, backupPath);
        result.filesBackedUp.push(backupPath);
      }
      const hooksConfig = adapter.generateHooksConfig(opts.hooksCliPath, process.platform);
      const existing = this.readJsonSafe(hooksPath);
      const merged = this.deepMerge(existing, hooksConfig);
      writeFileSync(hooksPath, JSON.stringify(merged, null, 2), 'utf8');
      result.filesWritten.push(hooksPath);
    }

    if (adapter.mcpConfigFile) {
      const mcpPath = join(configDir, adapter.mcpConfigFile);
      if (adapter.mcpConfigFile !== adapter.hooksConfigFile) {
        if (existsSync(mcpPath)) {
          const backupPath = join(backupDir, adapter.mcpConfigFile);
          copyFileSync(mcpPath, backupPath);
          result.filesBackedUp.push(backupPath);
        }
      }
      const mcpConfig = adapter.generateMcpConfig(opts.mcpServerPath);
      const existing = this.readJsonSafe(mcpPath);
      const merged = this.deepMerge(existing, mcpConfig);
      writeFileSync(mcpPath, JSON.stringify(merged, null, 2), 'utf8');
      if (!result.filesWritten.includes(mcpPath)) {
        result.filesWritten.push(mcpPath);
      }
    }

    result.success = true;
    return result;
  }

  async uninstall(): Promise<InstallResult> {
    return { success: true, filesWritten: [], filesBackedUp: [], warnings: ['Uninstall: manual removal of hooks/MCP entries recommended'] };
  }

  async status(): Promise<IntegrationStatus> {
    const detected = await this.detect();
    const adapter = this.adapter;
    const configPath = adapter.hooksConfigFile
      ? join(adapter.configDir, adapter.hooksConfigFile)
      : null;

    let installed = false;
    if (configPath && existsSync(configPath)) {
      try {
        const content = readFileSync(configPath, 'utf8');
        installed = content.includes('agent-memory') || content.includes('hooks-cli');
      } catch { /* not installed */ }
    }

    return { installed, detected, configPath };
  }

  protected readJsonSafe(filePath: string): any {
    if (!existsSync(filePath)) return {};
    try {
      return JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
      return {};
    }
  }

  protected deepMerge(base: any, override: any): any {
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
}
