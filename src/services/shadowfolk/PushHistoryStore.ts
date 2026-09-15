import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../../shared/paths.js';
import { normalizeProjectPath } from '../../types/database.js';

export interface ShadowFolkCursor {
  commit: string;
  observationId: number;
  summaryId: number;
}

export type PushHistoryMode = 'normal' | 'replay' | 'full';

export interface PushHistoryEntry {
  id: string;
  workspace: string;
  gitRoot: string;
  memoryRoots?: string[];
  remote: string;
  branch: string;
  mode: PushHistoryMode;
  startCursor: ShadowFolkCursor;
  endCursor: ShadowFolkCursor;
  batchId: string;
  counts: {
    commits: number;
    observations: number;
    summaries: number;
  };
  createdAt: string;
  sourceHistoryId?: string;
}

interface PushHistoryFile {
  version: 1;
  entries: PushHistoryEntry[];
}

function defaultHistoryPath(): string {
  return path.join(getDataDir(), 'shadowfolk-push-history.json');
}

function normalizeRoot(root: string): string {
  return normalizeProjectPath(root).replace(/\/+$/, '');
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

export function createHistoryId(batchId: string, date = new Date()): string {
  const stamp = date.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const suffix = batchId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'unknown';
  return `hist_${stamp}_${suffix}`;
}

export class PushHistoryStore {
  private filePath: string;

  constructor(filePath = defaultHistoryPath()) {
    this.filePath = filePath;
  }

  async append(entry: PushHistoryEntry): Promise<void> {
    const file = await this.load();
    file.entries.push(entry);
    await this.save(file);
  }

  async listForGitRoot(gitRoot: string): Promise<PushHistoryEntry[]> {
    const key = normalizeRoot(gitRoot);
    const file = await this.load();
    return file.entries
      .filter(entry => normalizeRoot(entry.gitRoot) === key)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getById(id: string): Promise<PushHistoryEntry | null> {
    const file = await this.load();
    return file.entries.find(entry => entry.id === id) || null;
  }

  private async load(): Promise<PushHistoryFile> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return { version: 1, entries: [] };
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<PushHistoryFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
        throw new Error('invalid push history shape');
      }
      return { version: 1, entries: parsed.entries };
    } catch {
      await this.backupCorruptFile();
      return { version: 1, entries: [] };
    }
  }

  private async save(file: PushHistoryFile): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.promises.writeFile(this.filePath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  }

  private async backupCorruptFile(): Promise<void> {
    try {
      const backup = `${this.filePath}.corrupt.${Date.now()}`;
      await fs.promises.rename(this.filePath, backup);
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error;
      }
    }
  }
}
