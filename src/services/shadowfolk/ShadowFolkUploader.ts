import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { normalizeProjectPath } from '../../types/database.js';
import {
  PushHistoryStore,
  createHistoryId,
  type PushHistoryEntry,
  type PushHistoryMode,
  type ShadowFolkCursor,
} from './PushHistoryStore.js';
import {
  authorLogArgs,
  parseNumstatOutput,
  resolveAuthorPattern,
  type GitUserIdentity,
} from './gitAuthorFilter.js';

const execFileAsync = promisify(execFile);
const DEFAULT_SERVER = 'http://localhost:3000';
const SHADOW_CONFIG_PATH = path.join(os.homedir(), '.shadow', 'config.json');

type FetchImpl = typeof fetch;

export interface ShadowFolkConfig {
  server: string;
  apiToken: string;
}

export interface ShadowFolkWorkspaceConfig {
  workspace: string;
  memoryRoots?: string[];
}

type ShadowFolkWorkspaceInput = string | ShadowFolkWorkspaceConfig;
type ShadowFolkWorkspaceMode = 'git' | 'memory';

interface ResolvedWorkspaceContext {
  mode: ShadowFolkWorkspaceMode;
  gitRoot: string;
  remote: string;
  branch: string;
  nestedRepos: string[];
}

export interface PushWorkspaceResult {
  workspace: string;
  gitRoot: string;
  pushed: boolean;
  batchId?: string;
  observations: number;
  summaries: number;
  commits: number;
}

export interface PushWorkspaceRangeOptions {
  mode: PushHistoryMode;
  startCursor: ShadowFolkCursor;
  endCursor: ShadowFolkCursor;
  sourceHistoryId?: string;
  writeHistory?: boolean;
  memoryRoots?: string[];
}

export interface WorkspaceValidationResult {
  input: string;
  valid: boolean;
  gitRoot: string;
  error: string | null;
  mode?: ShadowFolkWorkspaceMode;
}

export interface PushAllResult {
  pushed: boolean;
  workspaces: number;
  observations: number;
  summaries: number;
  commits: number;
  results: PushWorkspaceResult[];
  failures: Array<{ workspace: string; error: string }>;
}

export interface ShadowFolkUploaderOptions {
  db: Database.Database;
  server: string;
  apiToken: string;
  fetchImpl?: FetchImpl;
  historyStore?: PushHistoryStore;
}

export function loadShadowFolkConfig(configPath = SHADOW_CONFIG_PATH): ShadowFolkConfig | null {
  if (!fs.existsSync(configPath)) return null;
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  const apiToken = typeof raw.api_token === 'string' ? raw.api_token.trim() : '';
  if (!apiToken) return null;
  const server = (typeof raw.server === 'string' && raw.server.trim() ? raw.server : DEFAULT_SERVER).replace(/\/+$/, '');
  return { server, apiToken };
}

function normalizeGitPath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  return normalized.replace(/^\/([a-zA-Z])\//, (_m, drive: string) => `${drive.toLowerCase()}:/`);
}

function normalizeRootPrefix(value: string): string {
  return normalizeProjectPath(value).replace(/\/+$/, '');
}

function isWithinRoot(project: string, root: string): boolean {
  const p = normalizeProjectPath(project).replace(/\/+$/, '');
  const r = normalizeRootPrefix(root);
  return p === r || p.startsWith(`${r}/`);
}

function normalizeMemoryRoots(roots: unknown): string[] {
  if (!Array.isArray(roots)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const root of roots) {
    if (typeof root !== 'string') continue;
    const trimmed = root.trim();
    if (!trimmed) continue;
    const key = normalizeRootPrefix(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizeWorkspaceInput(input: ShadowFolkWorkspaceInput): ShadowFolkWorkspaceConfig {
  if (typeof input === 'string') {
    return { workspace: input.trim(), memoryRoots: [] };
  }
  return {
    workspace: String(input.workspace || '').trim(),
    memoryRoots: normalizeMemoryRoots(input.memoryRoots),
  };
}

export async function validateGitWorkspace(workspace: string): Promise<WorkspaceValidationResult> {
  const input = workspace.trim();
  if (!input) return { input, valid: false, gitRoot: '', error: '请先输入工作区路径' };
  if (!fs.existsSync(input)) return { input, valid: false, gitRoot: '', error: '路径不存在' };
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: input, encoding: 'utf8' });
    return { input, valid: true, gitRoot: normalizeGitPath(stdout.trim()), error: null, mode: 'git' };
  } catch {
    return { input, valid: false, gitRoot: '', error: '该路径不是 Git 工作区或其子目录' };
  }
}

export class ShadowFolkUploader {
  private db: Database.Database;
  private server: string;
  private apiToken: string;
  private fetchImpl: FetchImpl;
  private historyStore: PushHistoryStore;

  constructor(options: ShadowFolkUploaderOptions) {
    this.db = options.db;
    this.server = options.server.replace(/\/+$/, '');
    this.apiToken = options.apiToken;
    this.fetchImpl = options.fetchImpl || fetch;
    this.historyStore = options.historyStore || new PushHistoryStore();
  }

  async validateWorkspace(workspace: string): Promise<WorkspaceValidationResult> {
    const gitValidation = await validateGitWorkspace(workspace);
    if (gitValidation.valid) return gitValidation;

    const input = workspace.trim();
    if (input && this.hasMemoryForWorkspace(input)) {
      return {
        input,
        valid: true,
        gitRoot: normalizeRootPrefix(input),
        error: null,
        mode: 'memory',
      };
    }

    return gitValidation;
  }

  async pushWorkspaces(workspaces: ShadowFolkWorkspaceInput[]): Promise<PushAllResult> {
    const seen = new Set<string>();
    const normalized: Array<{ input: string; gitRoot: string; memoryRoots: string[] }> = [];
    const failures: Array<{ workspace: string; error: string }> = [];

    for (const workspaceInput of workspaces) {
      const workspace = normalizeWorkspaceInput(workspaceInput);
      const validation = await this.validateWorkspace(workspace.workspace);
      if (!validation.valid) {
        failures.push({ workspace: workspace.workspace, error: validation.error || '工作区无效' });
        continue;
      }
      const key = normalizeRootPrefix(validation.gitRoot);
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push({ input: validation.input, gitRoot: validation.gitRoot, memoryRoots: workspace.memoryRoots || [] });
    }

    const results: PushWorkspaceResult[] = [];
    for (const workspace of normalized) {
      try {
        results.push(await this.pushWorkspace(workspace.gitRoot, [workspace.gitRoot, workspace.input, ...workspace.memoryRoots], workspace.memoryRoots));
      } catch (error) {
        failures.push({ workspace: workspace.gitRoot, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return {
      pushed: results.some(r => r.pushed),
      workspaces: results.length,
      observations: results.reduce((n, r) => n + r.observations, 0),
      summaries: results.reduce((n, r) => n + r.summaries, 0),
      commits: results.reduce((n, r) => n + r.commits, 0),
      results,
      failures,
    };
  }

  async pushWorkspace(workspace: ShadowFolkWorkspaceInput, projectRoots?: string[], memoryRoots: string[] = []): Promise<PushWorkspaceResult> {
    const input = normalizeWorkspaceInput(workspace);
    const context = await this.resolveWorkspace(input.workspace);
    const { mode, gitRoot, remote, branch, nestedRepos } = context;
    const normalizedMemoryRoots = normalizeMemoryRoots([
      ...normalizeMemoryRoots(input.memoryRoots),
      ...memoryRoots,
    ]);

    const record = await this.getPushRecord(gitRoot);
    const startCursor = this.cursorFromRecord(record);

    const commits = mode === 'git'
      ? await this.getCommits(gitRoot, startCursor.commit || undefined)
      : [];
    const stats = mode === 'git'
      ? await this.getDiffStats(gitRoot, startCursor.commit || undefined)
      : { files_changed: 0, insertions: 0, deletions: 0 };
    const roots = [gitRoot, ...(projectRoots || [input.workspace]), ...normalizedMemoryRoots];
    const observations = this.exportRows('observations', roots, nestedRepos, startCursor.observationId);
    const sessionSummaries = this.exportRows('session_summaries', roots, nestedRepos, startCursor.summaryId);

    if (commits.length === 0 && observations.length === 0 && sessionSummaries.length === 0) {
      return { workspace: input.workspace, gitRoot, pushed: false, observations: 0, summaries: 0, commits: 0 };
    }

    const payload = {
      git: {
        root: gitRoot,
        remote,
        branch,
        commit_range_start: startCursor.commit || (commits.at(-1)?.hash || ''),
        commit_range_end: commits[0]?.hash || '',
        commits,
        stats,
      },
      memory: {
        scope: gitRoot,
        excluded_prefixes: nestedRepos,
        observations,
        session_summaries: sessionSummaries,
      },
    };

    const result = await this.request('POST', '/api/push/raw', payload);
    const batchId = String(result.batch_id || 'unknown');
    const endCursor = this.cursorFromExport(startCursor, commits, observations, sessionSummaries);

    await this.request('PUT', `/api/push/push-records/${encodeURIComponent(gitRoot)}`, {
      last_commit_hash: endCursor.commit,
      task_id: batchId,
      last_observation_id: endCursor.observationId,
      last_summary_id: endCursor.summaryId,
    });

    await this.historyStore.append({
      id: createHistoryId(batchId),
      workspace: input.workspace,
      gitRoot,
      memoryRoots: normalizedMemoryRoots,
      remote,
      branch,
      mode: 'normal',
      startCursor,
      endCursor,
      batchId,
      counts: {
        commits: commits.length,
        observations: observations.length,
        summaries: sessionSummaries.length,
      },
      createdAt: new Date().toISOString(),
    });

    return {
      workspace: input.workspace,
      gitRoot,
      pushed: true,
      batchId,
      observations: observations.length,
      summaries: sessionSummaries.length,
      commits: commits.length,
    };
  }

  async pushWorkspaceRange(workspace: ShadowFolkWorkspaceInput, options: PushWorkspaceRangeOptions): Promise<PushWorkspaceResult> {
    const input = normalizeWorkspaceInput(workspace);
    const context = await this.resolveWorkspace(input.workspace);
    const { mode, gitRoot, remote, branch, nestedRepos } = context;
    const memoryRoots = normalizeMemoryRoots([
      ...(input.memoryRoots || []),
      ...normalizeMemoryRoots(options.memoryRoots),
    ]);
    const roots = [gitRoot, input.workspace, ...memoryRoots];

    if (mode === 'git' && options.startCursor.commit) {
      await this.git(['rev-parse', '--verify', `${options.startCursor.commit}^{commit}`], gitRoot);
    }
    if (mode === 'git' && options.endCursor.commit) {
      await this.git(['rev-parse', '--verify', `${options.endCursor.commit}^{commit}`], gitRoot);
    }

    const commits = mode === 'git'
      ? await this.getCommitsInRange(gitRoot, options.startCursor.commit, options.endCursor.commit)
      : [];
    const stats = mode === 'git' && options.endCursor.commit
      ? await this.getDiffStatsInRange(gitRoot, options.startCursor.commit, options.endCursor.commit)
      : { files_changed: 0, insertions: 0, deletions: 0 };
    const observations = this.exportRowsInRange(
      'observations',
      roots,
      nestedRepos,
      options.startCursor.observationId,
      options.endCursor.observationId,
    );
    const sessionSummaries = this.exportRowsInRange(
      'session_summaries',
      roots,
      nestedRepos,
      options.startCursor.summaryId,
      options.endCursor.summaryId,
    );

    if (commits.length === 0 && observations.length === 0 && sessionSummaries.length === 0) {
      return { workspace: input.workspace, gitRoot, pushed: false, observations: 0, summaries: 0, commits: 0 };
    }

    const payload = {
      git: {
        root: gitRoot,
        remote,
        branch,
        commit_range_start: options.startCursor.commit,
        commit_range_end: options.endCursor.commit,
        commits,
        stats,
      },
      memory: {
        scope: gitRoot,
        excluded_prefixes: nestedRepos,
        observations,
        session_summaries: sessionSummaries,
      },
    };

    const result = await this.request('POST', '/api/push/raw', payload);
    const batchId = String(result.batch_id || 'unknown');

    await this.request('PUT', `/api/push/push-records/${encodeURIComponent(gitRoot)}`, {
      last_commit_hash: options.endCursor.commit,
      task_id: batchId,
      last_observation_id: options.endCursor.observationId,
      last_summary_id: options.endCursor.summaryId,
    });

    const pushed: PushWorkspaceResult = {
      workspace: input.workspace,
      gitRoot,
      pushed: true,
      batchId,
      observations: observations.length,
      summaries: sessionSummaries.length,
      commits: commits.length,
    };

    if (options.writeHistory !== false) {
      const entry: PushHistoryEntry = {
        id: createHistoryId(batchId),
        workspace: input.workspace,
        gitRoot,
        memoryRoots,
        remote,
        branch,
        mode: options.mode,
        startCursor: options.startCursor,
        endCursor: options.endCursor,
        batchId,
        counts: {
          commits: commits.length,
          observations: observations.length,
          summaries: sessionSummaries.length,
        },
        createdAt: new Date().toISOString(),
        sourceHistoryId: options.sourceHistoryId,
      };
      await this.historyStore.append(entry);
    }

    return pushed;
  }

  async repushWorkspaceFull(workspace: string | ShadowFolkWorkspaceConfig): Promise<PushWorkspaceResult> {
    const input = normalizeWorkspaceInput(workspace);
    const context = await this.resolveWorkspace(input.workspace);
    const { mode, gitRoot, nestedRepos } = context;
    const roots = [gitRoot, input.workspace, ...(input.memoryRoots || [])];
    const observations = this.exportRows('observations', roots, nestedRepos, 0);
    const sessionSummaries = this.exportRows('session_summaries', roots, nestedRepos, 0);
    const commits = mode === 'git' ? await this.getCommits(gitRoot, undefined) : [];
    const endCursor: ShadowFolkCursor = {
      commit: commits[0]?.hash || '',
      observationId: Math.max(0, ...observations.map((r: any) => Number(r.id || 0))),
      summaryId: Math.max(0, ...sessionSummaries.map((r: any) => Number(r.id || 0))),
    };

    return this.pushWorkspaceRange(input, {
      mode: 'full',
      startCursor: { commit: '', observationId: 0, summaryId: 0 },
      endCursor,
      memoryRoots: input.memoryRoots,
    });
  }

  async listPushHistory(workspace: string | ShadowFolkWorkspaceConfig): Promise<PushHistoryEntry[]> {
    const input = normalizeWorkspaceInput(workspace);
    const context = await this.resolveWorkspace(input.workspace);
    return this.historyStore.listForGitRoot(context.gitRoot);
  }

  async replayHistoryEntry(workspace: string | ShadowFolkWorkspaceConfig, historyId: string): Promise<PushWorkspaceResult> {
    const input = normalizeWorkspaceInput(workspace);
    const context = await this.resolveWorkspace(input.workspace);
    const gitRoot = context.gitRoot;
    const entry = await this.historyStore.getById(historyId);
    if (!entry) {
      throw new Error('未找到推送历史记录');
    }
    if (normalizeRootPrefix(entry.gitRoot) !== normalizeRootPrefix(gitRoot)) {
      throw new Error('推送历史记录不属于当前工作区');
    }

    const currentMemoryRoots = normalizeMemoryRoots(input.memoryRoots);
    const memoryRoots = currentMemoryRoots.length ? currentMemoryRoots : normalizeMemoryRoots(entry.memoryRoots || []);
    return this.pushWorkspaceRange({ workspace: input.workspace, memoryRoots }, {
      mode: 'replay',
      startCursor: entry.startCursor,
      endCursor: entry.endCursor,
      sourceHistoryId: entry.id,
    });
  }

  /**
   * Legacy discovery helper retained for UI-assisted workspace discovery flows.
   * Worker uploads should call pushWorkspaces() with an explicit workspace list
   * instead of relying on this DB-wide discovery path.
   */
  async pushAll(): Promise<PushAllResult> {
    return this.pushWorkspaces(this.discoverWorkspaces());
  }

  private async getPushRecord(projectPath: string): Promise<Record<string, any> | null> {
    const res = await this.fetchImpl(`${this.server}/api/push/push-records/${encodeURIComponent(projectPath)}`, {
      method: 'GET',
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`ShadowFolk push record failed: ${res.status} ${await res.text()}`);
    const data = await res.json() as Record<string, any>;
    return data.record || data;
  }

  private async request(method: string, urlPath: string, body: Record<string, any>): Promise<Record<string, any>> {
    const res = await this.fetchImpl(`${this.server}${urlPath}`, {
      method,
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`ShadowFolk ${method} ${urlPath} failed: ${res.status} ${await res.text()}`);
    return (await res.json().catch(() => ({}))) as Record<string, any>;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    };
  }

  private hasMemoryForWorkspace(workspace: string): boolean {
    const workspaceKey = normalizeRootPrefix(workspace);
    const rows = this.db.prepare(`
      SELECT DISTINCT project FROM observations WHERE project IS NOT NULL AND project != ''
      UNION
      SELECT DISTINCT project FROM session_summaries WHERE project IS NOT NULL AND project != ''
    `).all() as Array<{ project: string }>;
    return rows.some(row => normalizeRootPrefix(row.project) === workspaceKey);
  }

  private async resolveWorkspace(workspace: string): Promise<ResolvedWorkspaceContext> {
    const validation = await this.validateWorkspace(workspace);
    if (!validation.valid) {
      throw new Error(validation.error || '工作区无效');
    }

    const gitRoot = validation.gitRoot;
    if (validation.mode === 'memory') {
      return {
        mode: 'memory',
        gitRoot,
        remote: `agentmemory://${encodeURIComponent(normalizeRootPrefix(gitRoot))}`,
        branch: 'memory',
        nestedRepos: [],
      };
    }

    return {
      mode: 'git',
      gitRoot,
      remote: await this.git(['remote', 'get-url', 'origin'], gitRoot).catch(() => ''),
      branch: await this.git(['branch', '--show-current'], gitRoot).then(v => v || 'HEAD').catch(() => 'HEAD'),
      nestedRepos: await this.findNestedRepos(gitRoot),
    };
  }

  private cursorFromRecord(record: Record<string, any> | null): ShadowFolkCursor {
    return {
      commit: typeof record?.last_commit_hash === 'string' ? record.last_commit_hash : '',
      observationId: Number(record?.last_observation_id || 0),
      summaryId: Number(record?.last_summary_id || 0),
    };
  }

  private cursorFromExport(
    previous: ShadowFolkCursor,
    commits: Array<Record<string, string>>,
    observations: any[],
    summaries: any[],
  ): ShadowFolkCursor {
    return {
      commit: commits[0]?.hash || previous.commit || '',
      observationId: Math.max(previous.observationId, ...observations.map((r: any) => Number(r.id || 0))),
      summaryId: Math.max(previous.summaryId, ...summaries.map((r: any) => Number(r.id || 0))),
    };
  }

  private async getGitUserIdentity(gitRoot: string): Promise<GitUserIdentity> {
    const name = await this.git(['config', 'user.name'], gitRoot).catch(() => '');
    const email = await this.git(['config', 'user.email'], gitRoot).catch(() => '');
    return { name: name.trim(), email: email.trim() };
  }

  private async getAuthorLogArgs(gitRoot: string): Promise<string[]> {
    const identity = await this.getGitUserIdentity(gitRoot);
    return authorLogArgs(resolveAuthorPattern(identity));
  }

  private async getCommits(gitRoot: string, sinceHash?: string): Promise<Array<Record<string, string>>> {
    const authorArgs = await this.getAuthorLogArgs(gitRoot);
    const args = sinceHash
      ? ['log', `${sinceHash}..HEAD`, ...authorArgs, '--pretty=format:%H|||%an|||%aI|||%s']
      : ['log', '--since=7 days ago', ...authorArgs, '--pretty=format:%H|||%an|||%aI|||%s'];
    const output = await this.git(args, gitRoot).catch(() => '');
    if (!output) return [];
    return output.split('\n').map(line => {
      const [hash, author, date, message] = line.split('|||');
      return { hash, author, date, message };
    }).filter(c => c.hash && c.author && c.date && c.message);
  }

  private async getCommitsInRange(gitRoot: string, startHash: string, endHash: string): Promise<Array<Record<string, string>>> {
    if (!endHash) return [];
    const authorArgs = await this.getAuthorLogArgs(gitRoot);
    const range = startHash ? `${startHash}..${endHash}` : endHash;
    const output = await this.git(['log', range, ...authorArgs, '--pretty=format:%H|||%an|||%aI|||%s'], gitRoot);
    if (!output) return [];
    return output.split('\n').map(line => {
      const [hash, author, date, message] = line.split('|||');
      return { hash, author, date, message };
    }).filter(c => c.hash && c.author && c.date && c.message);
  }

  private async getDiffStats(gitRoot: string, sinceHash?: string): Promise<Record<string, number>> {
    const authorArgs = await this.getAuthorLogArgs(gitRoot);
    const args = sinceHash
      ? ['log', `${sinceHash}..HEAD`, ...authorArgs, '--pretty=tformat:', '--numstat']
      : ['log', '-50', ...authorArgs, '--pretty=tformat:', '--numstat'];
    const output = await this.git(args, gitRoot).catch(() => '');
    return parseNumstatOutput(output);
  }

  private async getDiffStatsInRange(gitRoot: string, startHash: string, endHash: string): Promise<Record<string, number>> {
    if (!endHash) return { files_changed: 0, insertions: 0, deletions: 0 };
    const authorArgs = await this.getAuthorLogArgs(gitRoot);
    const range = startHash ? `${startHash}..${endHash}` : endHash;
    const output = await this.git(['log', range, ...authorArgs, '--pretty=tformat:', '--numstat'], gitRoot).catch(() => '');
    return parseNumstatOutput(output);
  }

  private async findNestedRepos(gitRoot: string): Promise<string[]> {
    const skipDirs = new Set(['.git', 'node_modules', 'dist', 'release-artifacts', 'release5', '.next', 'out']);
    const root = path.resolve(gitRoot);
    const nestedRepos: string[] = [];

    const scan = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      const hasGitEntry = entries.some(entry => entry.name === '.git');
      if (dir !== root && hasGitEntry) {
        const normalizedDir = normalizeGitPath(dir);
        nestedRepos.push(normalizedDir);
        try {
          const realDir = normalizeGitPath(await fs.promises.realpath(dir));
          if (normalizeRootPrefix(realDir) !== normalizeRootPrefix(normalizedDir)) {
            nestedRepos.push(realDir);
          }
        } catch {
          // The direct path is still usable for exclusion if realpath lookup fails.
        }
        return;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (skipDirs.has(entry.name)) continue;
        await scan(path.join(dir, entry.name));
      }
    };

    await scan(root);
    return nestedRepos;
  }

  private exportRows(table: 'observations' | 'session_summaries', projectRoots: string[], nestedRepos: string[], lastId: number): any[] {
    const roots = Array.from(new Set(projectRoots.map(normalizeRootPrefix)));
    const excluded = nestedRepos.map(normalizeRootPrefix);
    const rows = this.db.prepare(`SELECT * FROM ${table} WHERE id > ? ORDER BY id ASC`).all(lastId);
    return rows.filter((row: any) => {
      const project = normalizeProjectPath(row.project);
      return roots.some(root => isWithinRoot(project, root)) && !excluded.some(prefix => isWithinRoot(project, prefix));
    });
  }

  private exportRowsInRange(
    table: 'observations' | 'session_summaries',
    projectRoots: string[],
    nestedRepos: string[],
    startId: number,
    endId: number,
  ): any[] {
    const roots = Array.from(new Set(projectRoots.map(normalizeRootPrefix)));
    const excluded = nestedRepos.map(normalizeRootPrefix);
    const rows = this.db.prepare(`SELECT * FROM ${table} WHERE id > ? AND id <= ? ORDER BY id ASC`).all(startId, endId);
    return rows.filter((row: any) => {
      const project = normalizeProjectPath(row.project);
      return roots.some(root => isWithinRoot(project, root)) && !excluded.some(prefix => isWithinRoot(project, prefix));
    });
  }

  private discoverWorkspaces(): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT project FROM observations WHERE project IS NOT NULL AND project != ''
      UNION
      SELECT DISTINCT project FROM session_summaries WHERE project IS NOT NULL AND project != ''
      ORDER BY project ASC
    `).all() as Array<{ project: string }>;
    return rows.map(row => row.project).filter(Boolean);
  }

  private async git(args: string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8' });
    return stdout.trim();
  }
}
