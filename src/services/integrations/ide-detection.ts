import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface IdeDetectionEntry {
  id: string;
  displayName: string;
  configDirs: string[];
  binaries: string[];
}

export const IDE_DETECTION_TABLE: IdeDetectionEntry[] = [
  { id: 'cursor', displayName: 'Cursor', configDirs: ['.cursor'], binaries: ['cursor'] },
  { id: 'claude-code', displayName: 'Claude Code', configDirs: ['.claude'], binaries: ['claude'] },
  { id: 'claude-internal', displayName: 'Claude Internal', configDirs: ['.claude-internal'], binaries: [] },
  { id: 'codebuddy', displayName: 'CodeBuddy', configDirs: ['.gongfeng-copilot'], binaries: [] },
  { id: 'codebuddy-ide', displayName: 'CodeBuddy IDE', configDirs: ['.codebuddy'], binaries: [] },
  { id: 'windsurf', displayName: 'Windsurf', configDirs: ['.windsurf'], binaries: ['windsurf'] },
  { id: 'gemini-cli', displayName: 'Gemini CLI', configDirs: ['.gemini'], binaries: ['gemini'] },
  { id: 'opencode', displayName: 'OpenCode', configDirs: ['.opencode'], binaries: ['opencode'] },
  { id: 'codex-cli', displayName: 'Codex App / CLI', configDirs: ['.codex'], binaries: ['codex'] },
  { id: 'copilot-cli', displayName: 'Copilot CLI', configDirs: ['.github-copilot'], binaries: ['github-copilot-cli'] },
  { id: 'antigravity', displayName: 'Antigravity', configDirs: ['.antigravity'], binaries: ['antigravity'] },
  { id: 'goose', displayName: 'Goose', configDirs: ['.config/goose'], binaries: ['goose'] },
  { id: 'crush', displayName: 'Crush', configDirs: ['.crush'], binaries: ['crush'] },
  { id: 'roo-code', displayName: 'Roo Code', configDirs: ['.roo-code'], binaries: ['roo-code'] },
  { id: 'warp', displayName: 'Warp', configDirs: ['.warp'], binaries: ['warp'] },
  { id: 'openclaw', displayName: 'OpenClaw Gateway', configDirs: ['.openclaw'], binaries: ['openclaw'] },
];

function configDirExists(relPath: string): boolean {
  return existsSync(join(homedir(), relPath));
}

function binaryExists(name: string): boolean {
  try {
    const cmd = process.platform === 'win32' ? `where ${name}` : `which ${name}`;
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export interface DetectionResult {
  id: string;
  displayName: string;
  detected: boolean;
  method: 'config_dir' | 'binary' | 'none';
}

export async function detectInstalledIDEs(): Promise<DetectionResult[]> {
  return IDE_DETECTION_TABLE.map((entry) => {
    const dirFound = entry.configDirs.some(configDirExists);
    if (dirFound) {
      return { id: entry.id, displayName: entry.displayName, detected: true, method: 'config_dir' as const };
    }
    const binFound = entry.binaries.some(binaryExists);
    if (binFound) {
      return { id: entry.id, displayName: entry.displayName, detected: true, method: 'binary' as const };
    }
    return { id: entry.id, displayName: entry.displayName, detected: false, method: 'none' as const };
  });
}
