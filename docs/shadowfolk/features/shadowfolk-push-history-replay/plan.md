# ShadowFolk Push History Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-workspace ShadowFolk push history ledger that records cursor ranges after successful uploads and lets users replay a selected range or fully repush one workspace.

**Architecture:** Add a small JSON-backed `PushHistoryStore` under the ShadowFolk service boundary. Extend `ShadowFolkUploader` so normal uploads produce `startCursor` / `endCursor`, replay uploads export `(startCursor, endCursor]`, and full repush uploads start from an empty cursor. Expose replay options through Worker APIs, proxy them through Settings IPC, and render a compact per-workspace replay control in the Settings plugin card.

**Tech Stack:** TypeScript, Node `fs/promises`, `better-sqlite3`, Electron IPC, Worker HTTP API, built-in Node test runner with `tsx`.

Do not commit during execution unless the user explicitly asks. Commit snippets in this plan are checkpoints only.

---

## File Structure

- Create `src/services/shadowfolk/PushHistoryStore.ts`: JSON ledger types, load/save, append, workspace filtering, corrupt-file recovery.
- Modify `src/services/shadowfolk/ShadowFolkUploader.ts`: cursor types, range export, history append after normal upload, replay and full-repush methods.
- Modify `src/services/worker/WorkerService.ts`: add `GET /api/shadowfolk/history` and `POST /api/shadowfolk/replay`, extend uploader test seam, reuse running lock.
- Modify `desktop/src/windows/SettingsWindow.ts`: add `shadowfolk:list-history` and `shadowfolk:replay` IPC handlers that proxy Worker APIs.
- Modify `desktop/src/preload-settings.ts`: expose the new Settings renderer APIs.
- Modify `desktop/src/windows/settings.html`: render a small replay row under each workspace entry.
- Create `tests/shadowfolk-history-store.test.ts`: focused tests for the JSON ledger.
- Modify `tests/shadowfolk-uploader.test.ts`: tests for normal history recording, range replay, full repush, and memory-only replay.
- Modify `tests/worker/worker-endpoints.test.ts`: tests for history options and replay endpoint routing.

---

### Task 1: Push History Store

**Files:**
- Create: `src/services/shadowfolk/PushHistoryStore.ts`
- Create: `tests/shadowfolk-history-store.test.ts`

- [ ] **Step 1: Write failing tests for empty, append, filter, and corrupt recovery**

Create `tests/shadowfolk-history-store.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  PushHistoryStore,
  type PushHistoryEntry,
} from '../src/services/shadowfolk/PushHistoryStore.js';

function tempFile(): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'sf-history-'));
  return { dir, file: path.join(dir, 'shadowfolk-push-history.json') };
}

function entry(overrides: Partial<PushHistoryEntry> = {}): PushHistoryEntry {
  return {
    id: 'hist_20260511_112955_aaaa',
    workspace: 'D:/GitHub/shadow-folk',
    gitRoot: 'D:/GitHub/shadow-folk',
    remote: 'https://github.com/c001estb0y/shadow-folk.git',
    branch: 'feat/plugin-system',
    mode: 'normal',
    startCursor: { commit: 'old', observationId: 1, summaryId: 2 },
    endCursor: { commit: 'new', observationId: 3, summaryId: 4 },
    batchId: 'batch-1',
    counts: { commits: 2, observations: 2, summaries: 2 },
    createdAt: '2026-05-11T11:29:55.605Z',
    ...overrides,
  };
}

test('PushHistoryStore returns empty history when file is missing', async () => {
  const { dir, file } = tempFile();
  try {
    const store = new PushHistoryStore(file);
    const entries = await store.listForGitRoot('D:/GitHub/shadow-folk');
    assert.deepEqual(entries, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PushHistoryStore appends entries and filters by normalized git root', async () => {
  const { dir, file } = tempFile();
  try {
    const store = new PushHistoryStore(file);
    await store.append(entry({ id: 'older', createdAt: '2026-05-10T11:00:00.000Z' }));
    await store.append(entry({
      id: 'newer',
      gitRoot: 'd:/github/shadow-folk',
      createdAt: '2026-05-11T11:00:00.000Z',
    }));
    await store.append(entry({
      id: 'other',
      workspace: 'E:/Github/agent-memory',
      gitRoot: 'E:/Github/agent-memory',
      createdAt: '2026-05-12T11:00:00.000Z',
    }));

    const entries = await store.listForGitRoot('D:/GitHub/shadow-folk');
    assert.deepEqual(entries.map(e => e.id), ['newer', 'older']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PushHistoryStore backs up corrupt JSON and recreates an empty ledger', async () => {
  const { dir, file } = tempFile();
  try {
    fs.writeFileSync(file, '{not-json', 'utf8');
    const store = new PushHistoryStore(file);
    const entries = await store.listForGitRoot('D:/GitHub/shadow-folk');

    assert.deepEqual(entries, []);
    const files = fs.readdirSync(dir);
    assert.ok(files.some(name => name.startsWith('shadowfolk-push-history.json.corrupt.')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node --import tsx --test tests/shadowfolk-history-store.test.ts
```

Expected: FAIL with module not found for `PushHistoryStore`.

- [ ] **Step 3: Implement `PushHistoryStore`**

Create `src/services/shadowfolk/PushHistoryStore.ts`:

```ts
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
    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PushHistoryFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
        throw new Error('invalid push history shape');
      }
      return { version: 1, entries: parsed.entries };
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return { version: 1, entries: [] };
      }
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
    } catch {
      // If the file vanished between read and backup, the empty ledger is still safe.
    }
  }
}
```

- [ ] **Step 4: Run store tests to verify green**

Run:

```bash
node --import tsx --test tests/shadowfolk-history-store.test.ts
```

Expected: PASS.

---

### Task 2: Cursor Range Export In Uploader

**Files:**
- Modify: `src/services/shadowfolk/ShadowFolkUploader.ts`
- Modify: `tests/shadowfolk-uploader.test.ts`

- [ ] **Step 1: Add failing tests for explicit replay range and memory-only range**

Append to `tests/shadowfolk-uploader.test.ts`:

```ts
test('pushWorkspaceRange exports only rows inside the selected cursor interval', async () => {
  const workspace = initRepo();
  const requests: Array<{ method: string; path: string; body?: any }> = [];
  const db = makeMemoryDb(workspace, workspace, workspace);

  const uploader = new ShadowFolkUploader({
    db,
    server: 'http://shadowfolk.local',
    apiToken: 'sf_test',
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method: init?.method || 'GET', path: parsed.pathname, body });
      if (parsed.pathname === '/api/push/raw') {
        return new Response(JSON.stringify({ batch_id: 'range-batch' }), { status: 201 });
      }
      if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'PUT') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    },
  });

  try {
    const result = await uploader.pushWorkspaceRange(workspace, {
      mode: 'replay',
      startCursor: { commit: '', observationId: 1, summaryId: 1 },
      endCursor: { commit: '', observationId: 2, summaryId: 2 },
    });

    assert.equal(result.pushed, true);
    assert.equal(result.observations, 1);
    assert.equal(result.summaries, 1);
    const raw = requests.find(r => r.path === '/api/push/raw');
    assert.ok(raw, 'expected raw push request');
    assert.deepEqual(raw!.body.memory.observations.map((row: any) => row.id), [2]);
    assert.deepEqual(raw!.body.memory.session_summaries.map((row: any) => row.id), [2]);
  } finally {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('pushWorkspaceRange accepts memory-only ranges with empty commit cursors', async () => {
  const workspace = initRepo();
  const requests: Array<{ method: string; path: string; body?: any }> = [];
  const db = makeMemoryDb(workspace);

  const uploader = new ShadowFolkUploader({
    db,
    server: 'http://shadowfolk.local',
    apiToken: 'sf_test',
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method: init?.method || 'GET', path: parsed.pathname, body });
      if (parsed.pathname === '/api/push/raw') {
        return new Response(JSON.stringify({ batch_id: 'memory-only-batch' }), { status: 201 });
      }
      if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'PUT') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    },
  });

  try {
    const result = await uploader.pushWorkspaceRange(workspace, {
      mode: 'replay',
      startCursor: { commit: '', observationId: 0, summaryId: 0 },
      endCursor: { commit: '', observationId: 1, summaryId: 1 },
    });

    assert.equal(result.pushed, true);
    assert.equal(result.commits, 0);
    const raw = requests.find(r => r.path === '/api/push/raw');
    assert.ok(raw, 'expected raw push request');
    assert.equal(raw!.body.git.commit_range_start, '');
    assert.equal(raw!.body.git.commit_range_end, '');
  } finally {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run uploader tests to verify red**

Run:

```bash
node --import tsx --test tests/shadowfolk-uploader.test.ts
```

Expected: FAIL because `pushWorkspaceRange` does not exist.

- [ ] **Step 3: Import history cursor types and add range options**

In `src/services/shadowfolk/ShadowFolkUploader.ts`, add imports and interfaces near the existing type declarations:

```ts
import {
  PushHistoryStore,
  createHistoryId,
  type PushHistoryEntry,
  type PushHistoryMode,
  type ShadowFolkCursor,
} from './PushHistoryStore.js';

export interface PushWorkspaceRangeOptions {
  mode: PushHistoryMode;
  startCursor: ShadowFolkCursor;
  endCursor: ShadowFolkCursor;
  sourceHistoryId?: string;
  writeHistory?: boolean;
}
```

- [ ] **Step 4: Add an optional history store to uploader options**

Update `ShadowFolkUploaderOptions`:

```ts
export interface ShadowFolkUploaderOptions {
  db: Database.Database;
  server: string;
  apiToken: string;
  fetchImpl?: FetchImpl;
  historyStore?: PushHistoryStore;
}
```

Update the class fields and constructor:

```ts
  private historyStore: PushHistoryStore;

  constructor(options: ShadowFolkUploaderOptions) {
    this.db = options.db;
    this.server = options.server.replace(/\/+$/, '');
    this.apiToken = options.apiToken;
    this.fetchImpl = options.fetchImpl || fetch;
    this.historyStore = options.historyStore || new PushHistoryStore();
  }
```

- [ ] **Step 5: Add bounded commit and row helpers**

In `ShadowFolkUploader`, add these private helpers near `getCommits()` and `exportRows()`:

```ts
  private async getCommitsInRange(gitRoot: string, startHash: string, endHash: string): Promise<Array<Record<string, string>>> {
    if (!endHash) return [];
    const range = startHash ? `${startHash}..${endHash}` : endHash;
    const output = await this.git(['log', range, '--pretty=format:%H|||%an|||%aI|||%s'], gitRoot).catch(() => '');
    if (!output) return [];
    return output.split('\n').map(line => {
      const [hash, author, date, message] = line.split('|||');
      return { hash, author, date, message };
    }).filter(c => c.hash && c.author && c.date && c.message);
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
```

- [ ] **Step 6: Add `pushWorkspaceRange()`**

Add this public method in `ShadowFolkUploader` after `pushWorkspace()`:

```ts
  async pushWorkspaceRange(workspace: string, options: PushWorkspaceRangeOptions): Promise<PushWorkspaceResult> {
    const gitRoot = await this.getGitRoot(workspace);
    const remote = await this.git(['remote', 'get-url', 'origin'], gitRoot).catch(() => '');
    const branch = await this.git(['branch', '--show-current'], gitRoot).then(v => v || 'HEAD').catch(() => 'HEAD');
    const nestedRepos = await this.findNestedRepos(gitRoot);
    const roots = [gitRoot, workspace];

    if (options.endCursor.commit) {
      await this.git(['rev-parse', '--verify', `${options.endCursor.commit}^{commit}`], gitRoot);
    }

    const commits = await this.getCommitsInRange(gitRoot, options.startCursor.commit, options.endCursor.commit);
    const stats = options.endCursor.commit
      ? await this.getDiffStats(gitRoot, options.startCursor.commit || undefined)
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
      return { workspace, gitRoot, pushed: false, observations: 0, summaries: 0, commits: 0 };
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
      workspace,
      gitRoot,
      pushed: true,
      batchId,
      observations: observations.length,
      summaries: sessionSummaries.length,
      commits: commits.length,
    };

    if (options.writeHistory !== false) {
      await this.historyStore.append({
        id: createHistoryId(batchId),
        workspace,
        gitRoot,
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
      });
    }

    return pushed;
  }
```

- [ ] **Step 7: Run uploader tests to verify range behavior**

Run:

```bash
node --import tsx --test tests/shadowfolk-uploader.test.ts
```

Expected: PASS for the newly added range tests. Existing tests may still pass without history recording; Task 3 covers normal upload history.

---

### Task 3: History Recording For Normal Uploads And Full Repush

**Files:**
- Modify: `src/services/shadowfolk/ShadowFolkUploader.ts`
- Modify: `tests/shadowfolk-uploader.test.ts`

- [ ] **Step 1: Add failing tests for normal history append and full repush**

Append to `tests/shadowfolk-uploader.test.ts`:

```ts
test('pushWorkspace records start and end cursors after a successful normal upload', async () => {
  const workspace = initRepo();
  const historyEntries: any[] = [];
  const db = makeMemoryDb(workspace);
  const uploader = new ShadowFolkUploader({
    db,
    server: 'http://shadowfolk.local',
    apiToken: 'sf_test',
    historyStore: { append: async (entry: any) => { historyEntries.push(entry); } } as any,
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'GET') {
        return new Response(JSON.stringify({
          record: { last_commit_hash: 'old-hash', last_observation_id: 0, last_summary_id: 0 },
        }), { status: 200 });
      }
      if (parsed.pathname === '/api/push/raw') {
        return new Response(JSON.stringify({ batch_id: 'normal-batch' }), { status: 201 });
      }
      if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'PUT') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    },
  });

  try {
    await uploader.pushWorkspace(workspace);
    assert.equal(historyEntries.length, 1);
    assert.equal(historyEntries[0].mode, 'normal');
    assert.equal(historyEntries[0].startCursor.commit, 'old-hash');
    assert.equal(historyEntries[0].startCursor.observationId, 0);
    assert.equal(historyEntries[0].endCursor.observationId, 1);
    assert.equal(historyEntries[0].batchId, 'normal-batch');
  } finally {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('repushWorkspaceFull uploads from empty cursors and records full mode', async () => {
  const workspace = initRepo();
  const historyEntries: any[] = [];
  const requests: Array<{ method: string; path: string; body?: any }> = [];
  const db = makeMemoryDb(workspace);
  const uploader = new ShadowFolkUploader({
    db,
    server: 'http://shadowfolk.local',
    apiToken: 'sf_test',
    historyStore: { append: async (entry: any) => { historyEntries.push(entry); } } as any,
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method: init?.method || 'GET', path: parsed.pathname, body });
      if (parsed.pathname === '/api/push/raw') {
        return new Response(JSON.stringify({ batch_id: 'full-batch' }), { status: 201 });
      }
      if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'PUT') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    },
  });

  try {
    const result = await uploader.repushWorkspaceFull(workspace);
    assert.equal(result.pushed, true);
    assert.equal(historyEntries[0].mode, 'full');
    assert.deepEqual(historyEntries[0].startCursor, { commit: '', observationId: 0, summaryId: 0 });
    const update = requests.find(r => r.method === 'PUT');
    assert.ok(update, 'expected push record update');
    assert.equal(update!.body.last_observation_id, 1);
    assert.equal(update!.body.last_summary_id, 1);
  } finally {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run uploader tests to verify red**

Run:

```bash
node --import tsx --test tests/shadowfolk-uploader.test.ts
```

Expected: FAIL because `pushWorkspace()` does not append history and `repushWorkspaceFull()` does not exist.

- [ ] **Step 3: Add cursor helpers**

In `ShadowFolkUploader`, add:

```ts
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
```

- [ ] **Step 4: Update `pushWorkspace()` to append normal history**

Inside `pushWorkspace()`, replace the separate `lastCommit`, `lastObservationId`, and `lastSummaryId` variables with:

```ts
    const record = await this.getPushRecord(gitRoot);
    const startCursor = this.cursorFromRecord(record);

    const commits = await this.getCommits(gitRoot, startCursor.commit || undefined);
    const stats = await this.getDiffStats(gitRoot, startCursor.commit || undefined);
    const roots = projectRoots || [gitRoot, workspace];
    const observations = this.exportRows('observations', roots, nestedRepos, startCursor.observationId);
    const sessionSummaries = this.exportRows('session_summaries', roots, nestedRepos, startCursor.summaryId);
```

After the raw upload succeeds, replace cursor update calculation with:

```ts
    const endCursor = this.cursorFromExport(startCursor, commits, observations, sessionSummaries);

    await this.request('PUT', `/api/push/push-records/${encodeURIComponent(gitRoot)}`, {
      last_commit_hash: endCursor.commit,
      task_id: batchId,
      last_observation_id: endCursor.observationId,
      last_summary_id: endCursor.summaryId,
    });

    await this.historyStore.append({
      id: createHistoryId(batchId),
      workspace,
      gitRoot,
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
```

Keep the existing early return for no changes before raw upload, so empty uploads do not write history.

- [ ] **Step 5: Implement `repushWorkspaceFull()`**

Add this method after `pushWorkspaceRange()`:

```ts
  async repushWorkspaceFull(workspace: string): Promise<PushWorkspaceResult> {
    const gitRoot = await this.getGitRoot(workspace);
    const nestedRepos = await this.findNestedRepos(gitRoot);
    const roots = [gitRoot, workspace];
    const observations = this.exportRows('observations', roots, nestedRepos, 0);
    const sessionSummaries = this.exportRows('session_summaries', roots, nestedRepos, 0);
    const commits = await this.getCommits(gitRoot, undefined);
    const endCursor: ShadowFolkCursor = {
      commit: commits[0]?.hash || '',
      observationId: Math.max(0, ...observations.map((r: any) => Number(r.id || 0))),
      summaryId: Math.max(0, ...sessionSummaries.map((r: any) => Number(r.id || 0))),
    };

    return this.pushWorkspaceRange(workspace, {
      mode: 'full',
      startCursor: { commit: '', observationId: 0, summaryId: 0 },
      endCursor,
    });
  }
```

- [ ] **Step 6: Run focused uploader tests**

Run:

```bash
node --import tsx --test tests/shadowfolk-uploader.test.ts tests/shadowfolk-history-store.test.ts
```

Expected: PASS.

---

### Task 4: Worker History And Replay APIs

**Files:**
- Modify: `src/services/worker/WorkerService.ts`
- Modify: `tests/worker/worker-endpoints.test.ts`

- [ ] **Step 1: Add failing Worker endpoint tests**

Append before the `/stream` tests in `tests/worker/worker-endpoints.test.ts`:

```ts
test('GET /api/shadowfolk/history returns full option plus workspace history', async () => {
  const worker = new WorkerService({
    port: 0,
    host: '127.0.0.1',
    loadSettings: disabledSettings,
    shadowfolk: {
      enabled: true,
      dailyTime: '23:30',
      workspaces: ['D:/GitHub/shadow-folk'],
      createUploader: () => ({
        validateWorkspace: async () => ({ valid: true, gitRoot: 'D:/GitHub/shadow-folk' }),
        listPushHistory: async () => ([{
          id: 'hist-1',
          createdAt: '2026-05-11T11:29:55.605Z',
          counts: { commits: 2, observations: 62, summaries: 7 },
        }]),
        pushWorkspaces: async () => ({ pushed: false, workspaces: 0, observations: 0, summaries: 0, commits: 0 }),
      }),
    },
  } as any);
  const req = makeReq({
    method: 'GET',
    url: '/api/shadowfolk/history?workspace=D%3A%2FGitHub%2Fshadow-folk',
  });
  const { res, captured } = makeRes();

  await (worker as any).handleRequest(req, res);

  assert.equal(captured.status, 200);
  const body = JSON.parse(captured.body!);
  assert.equal(body.success, true);
  assert.equal(body.options[0].kind, 'full');
  assert.equal(body.options[1].kind, 'history');
  assert.equal(body.options[1].historyId, 'hist-1');
});

test('POST /api/shadowfolk/replay routes full repush to uploader', async () => {
  let calledWorkspace = '';
  const worker = new WorkerService({
    port: 0,
    host: '127.0.0.1',
    loadSettings: disabledSettings,
    shadowfolk: {
      enabled: true,
      dailyTime: '23:30',
      workspaces: ['D:/GitHub/shadow-folk'],
      createUploader: () => ({
        repushWorkspaceFull: async (workspace: string) => {
          calledWorkspace = workspace;
          return { workspace, gitRoot: workspace, pushed: true, observations: 1, summaries: 1, commits: 1, batchId: 'full-batch' };
        },
        pushWorkspaces: async () => ({ pushed: false, workspaces: 0, observations: 0, summaries: 0, commits: 0 }),
      }),
    },
  } as any);
  const req = makeReq({ method: 'POST', url: '/api/shadowfolk/replay' });
  const { res, captured } = makeRes();

  const promise = (worker as any).handleRequest(req, res);
  req.emit('data', Buffer.from(JSON.stringify({ workspace: 'D:/GitHub/shadow-folk', kind: 'full' })));
  req.emit('end');
  await promise;

  assert.equal(calledWorkspace, 'D:/GitHub/shadow-folk');
  assert.equal(captured.status, 200);
  assert.equal(JSON.parse(captured.body!).mode, 'full');
});

test('POST /api/shadowfolk/replay routes history replay to uploader', async () => {
  let calledHistoryId = '';
  const worker = new WorkerService({
    port: 0,
    host: '127.0.0.1',
    loadSettings: disabledSettings,
    shadowfolk: {
      enabled: true,
      dailyTime: '23:30',
      workspaces: ['D:/GitHub/shadow-folk'],
      createUploader: () => ({
        replayHistoryEntry: async (workspace: string, historyId: string) => {
          calledHistoryId = historyId;
          return { workspace, gitRoot: workspace, pushed: true, observations: 62, summaries: 7, commits: 2, batchId: 'replay-batch' };
        },
        pushWorkspaces: async () => ({ pushed: false, workspaces: 0, observations: 0, summaries: 0, commits: 0 }),
      }),
    },
  } as any);
  const req = makeReq({ method: 'POST', url: '/api/shadowfolk/replay' });
  const { res, captured } = makeRes();

  const promise = (worker as any).handleRequest(req, res);
  req.emit('data', Buffer.from(JSON.stringify({
    workspace: 'D:/GitHub/shadow-folk',
    kind: 'history',
    historyId: 'hist-1',
  })));
  req.emit('end');
  await promise;

  assert.equal(calledHistoryId, 'hist-1');
  assert.equal(captured.status, 200);
  assert.equal(JSON.parse(captured.body!).mode, 'history');
});
```

- [ ] **Step 2: Run Worker tests to verify red**

Run:

```bash
node --import tsx --test tests/worker/worker-endpoints.test.ts
```

Expected: FAIL because history and replay endpoints do not exist.

- [ ] **Step 3: Extend Worker uploader seam**

In `WorkerService.ts`, update `ShadowFolkUploaderLike`:

```ts
type ShadowFolkUploaderLike = {
  validateWorkspace?: (workspace: string) => Promise<any>;
  listPushHistory?: (workspace: string) => Promise<any[]>;
  repushWorkspaceFull?: (workspace: string) => Promise<any>;
  replayHistoryEntry?: (workspace: string, historyId: string) => Promise<any>;
  pushWorkspaces: (workspaces: string[]) => Promise<PushAllResult>;
};
```

- [ ] **Step 4: Add routes**

In `handleRequest()`, add these cases near the other ShadowFolk routes:

```ts
      } else if (path === '/api/shadowfolk/history' && req.method === 'GET') {
        await this.handleShadowFolkHistory(url, res);
      } else if (path === '/api/shadowfolk/replay' && req.method === 'POST') {
        await this.handleShadowFolkReplay(req, res);
```

- [ ] **Step 5: Add history option formatting**

Add helpers in `WorkerService` near the existing ShadowFolk handlers:

```ts
  private formatShadowFolkHistoryLabel(entry: any): string {
    const when = entry.createdAt ? new Date(entry.createdAt).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }) : '未知时间';
    const counts = entry.counts || {};
    return `${when} · ${counts.commits || 0} commits · ${counts.observations || 0} obs · ${counts.summaries || 0} summaries`;
  }
```

- [ ] **Step 6: Implement `handleShadowFolkHistory()`**

Add:

```ts
  private async handleShadowFolkHistory(url: URL, res: http.ServerResponse): Promise<void> {
    const workspace = String(url.searchParams.get('workspace') || '').trim();
    if (!workspace) {
      res.statusCode = 400;
      res.end(JSON.stringify({ success: false, error: 'workspace is required' }));
      return;
    }

    const uploader = this.createShadowFolkUploader();
    if (!uploader) {
      res.statusCode = 400;
      res.end(JSON.stringify({ success: false, error: 'ShadowFolk 未配置' }));
      return;
    }

    const validation = uploader.validateWorkspace
      ? await uploader.validateWorkspace(workspace)
      : await validateGitWorkspace(workspace);
    if (!validation.valid) {
      res.statusCode = 400;
      res.end(JSON.stringify({ success: false, error: validation.error || '工作区无效' }));
      return;
    }

    const entries = uploader.listPushHistory ? await uploader.listPushHistory(validation.gitRoot) : [];
    const options = [
      { kind: 'full', label: '全量重推' },
      ...entries.map((entry: any) => ({
        kind: 'history',
        historyId: entry.id,
        label: this.formatShadowFolkHistoryLabel(entry),
      })),
    ];

    res.statusCode = 200;
    res.end(JSON.stringify({
      success: true,
      workspace,
      gitRoot: validation.gitRoot,
      options,
    }));
  }
```

- [ ] **Step 7: Implement `handleShadowFolkReplay()`**

Add:

```ts
  private async handleShadowFolkReplay(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.shadowfolkStatus.running) {
      res.statusCode = 400;
      res.end(JSON.stringify({ success: false, error: 'ShadowFolk 上传正在运行' }));
      return;
    }

    const body = await this.parseBody(req);
    const workspace = String(body.workspace || '').trim();
    const kind = String(body.kind || '').trim();
    const historyId = String(body.historyId || '').trim();
    if (!workspace) {
      res.statusCode = 400;
      res.end(JSON.stringify({ success: false, error: 'workspace is required' }));
      return;
    }
    if (kind !== 'full' && kind !== 'history') {
      res.statusCode = 400;
      res.end(JSON.stringify({ success: false, error: 'kind must be full or history' }));
      return;
    }
    if (kind === 'history' && !historyId) {
      res.statusCode = 400;
      res.end(JSON.stringify({ success: false, error: 'historyId is required' }));
      return;
    }

    const uploader = this.createShadowFolkUploader();
    if (!uploader) {
      res.statusCode = 400;
      res.end(JSON.stringify({ success: false, error: 'ShadowFolk 未配置' }));
      return;
    }

    this.shadowfolkStatus.running = true;
    this.shadowfolkStatus.lastRunAt = new Date().toISOString();
    this.shadowfolkStatus.lastError = null;
    try {
      const result = kind === 'full'
        ? await uploader.repushWorkspaceFull!(workspace)
        : await uploader.replayHistoryEntry!(workspace, historyId);
      this.shadowfolkStatus.lastSuccessAt = new Date().toISOString();
      this.shadowfolkStatus.lastResult = {
        pushed: !!result.pushed,
        workspaces: 1,
        observations: result.observations || 0,
        summaries: result.summaries || 0,
        commits: result.commits || 0,
        results: [result],
        failures: [],
      };
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, mode: kind, result }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.shadowfolkStatus.lastError = message;
      res.statusCode = 400;
      res.end(JSON.stringify({ success: false, error: message }));
    } finally {
      this.shadowfolkStatus.running = false;
    }
  }
```

- [ ] **Step 8: Add real uploader methods used by Worker**

In `ShadowFolkUploader`, add:

```ts
  async listPushHistory(workspace: string): Promise<PushHistoryEntry[]> {
    const gitRoot = await this.getGitRoot(workspace);
    return this.historyStore.listForGitRoot(gitRoot);
  }

  async replayHistoryEntry(workspace: string, historyId: string): Promise<PushWorkspaceResult> {
    const gitRoot = await this.getGitRoot(workspace);
    const entry = await this.historyStore.getById(historyId);
    if (!entry) {
      throw new Error('历史记录不存在');
    }
    if (normalizeRootPrefix(entry.gitRoot) !== normalizeRootPrefix(gitRoot)) {
      throw new Error('历史记录不属于该工作区');
    }
    return this.pushWorkspaceRange(workspace, {
      mode: 'replay',
      startCursor: entry.startCursor,
      endCursor: entry.endCursor,
      sourceHistoryId: entry.id,
    });
  }
```

- [ ] **Step 9: Run Worker and ShadowFolk tests**

Run:

```bash
node --import tsx --test tests/worker/worker-endpoints.test.ts tests/shadowfolk-uploader.test.ts tests/shadowfolk-history-store.test.ts
```

Expected: PASS.

---

### Task 5: Settings IPC And Preload APIs

**Files:**
- Modify: `desktop/src/windows/SettingsWindow.ts`
- Modify: `desktop/src/preload-settings.ts`

- [ ] **Step 1: Add IPC handlers in SettingsWindow**

In `desktop/src/windows/SettingsWindow.ts`, after `shadowfolk:push-now`, add:

```ts
    ipcMain.handle('shadowfolk:list-history', async (_event, workspace: string) => {
      const query = encodeURIComponent(String(workspace || ''));
      const r = await workerRequestWithRetry('GET', `/api/shadowfolk/history?workspace=${query}`, 15000, 6000);
      if (r.status === 0) return { success: false, error: 'worker 没响应', options: [] };
      if (r.status < 200 || r.status >= 300) {
        const body = r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? r.body : {};
        return {
          success: false,
          status: r.status,
          options: [],
          ...body,
          error: typeof body.error === 'string' ? body.error : '读取重推历史失败',
        };
      }
      return r.body || { success: false, options: [] };
    });

    ipcMain.handle('shadowfolk:replay', async (_event, data: Record<string, unknown>) => {
      const r = await workerRequestWithRetry('POST', '/api/shadowfolk/replay', 120000, 120000, data);
      if (r.status === 0) return { success: false, error: 'worker 没响应' };
      return r.body || { success: false };
    });
```

- [ ] **Step 2: Remove IPC handlers on destroy**

In `SettingsWindow.destroy()`, add:

```ts
    ipcMain.removeHandler('shadowfolk:list-history');
    ipcMain.removeHandler('shadowfolk:replay');
```

- [ ] **Step 3: Expose preload methods**

In `desktop/src/preload-settings.ts`, add to `settingsAPI`:

```ts
  listShadowfolkPushHistory: (workspace: string) => ipcRenderer.invoke('shadowfolk:list-history', workspace),
  shadowfolkReplay: (data: Record<string, unknown>) => ipcRenderer.invoke('shadowfolk:replay', data),
```

- [ ] **Step 4: Run desktop TypeScript build**

Run:

```bash
npm --prefix desktop run build:ts
```

Expected: PASS, unless the renderer task has not yet consumed the new preload methods. If type checking is renderer-aware and fails on unused API shape, continue to Task 6 and rerun.

---

### Task 6: Per-Workspace Replay UI

**Files:**
- Modify: `desktop/src/windows/settings.html`

- [ ] **Step 1: Add renderer state**

In the ShadowFolk script state area near `shadowfolkWorkspaces`, add:

```js
    const shadowfolkReplayState = new Map();
```

- [ ] **Step 2: Replace workspace row rendering**

In `renderShadowfolkWorkspaces()`, replace the per-workspace row construction with this version:

```js
      shadowfolkWorkspaces.forEach((workspace, index) => {
        const item = document.createElement('div');
        item.style.display = 'flex';
        item.style.flexDirection = 'column';
        item.style.gap = '6px';
        item.style.padding = '6px 8px';
        item.style.border = '1px solid #e0f3ee';
        item.style.borderRadius = '6px';
        item.style.background = 'rgba(255,255,255,0.72)';

        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.justifyContent = 'space-between';
        row.style.gap = '8px';

        const code = document.createElement('code');
        code.textContent = workspace;
        code.style.flex = '1';
        code.style.minWidth = '0';
        code.style.wordBreak = 'break-all';

        const actions = document.createElement('div');
        actions.style.display = 'flex';
        actions.style.gap = '6px';
        actions.style.flexShrink = '0';

        const replayToggle = document.createElement('button');
        replayToggle.type = 'button';
        replayToggle.className = 'btn btn-secondary';
        replayToggle.textContent = '重推';
        replayToggle.style.fontSize = '12px';
        replayToggle.style.padding = '4px 10px';
        replayToggle.addEventListener('click', async () => {
          const state = shadowfolkReplayState.get(workspace) || { expanded: false, options: [] };
          state.expanded = !state.expanded;
          shadowfolkReplayState.set(workspace, state);
          renderShadowfolkWorkspaces();
          if (state.expanded && !state.loaded) {
            await loadShadowfolkReplayOptions(workspace);
          }
        });

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn btn-secondary';
        removeBtn.textContent = '移除';
        removeBtn.style.fontSize = '12px';
        removeBtn.style.padding = '4px 10px';
        removeBtn.addEventListener('click', () => {
          shadowfolkWorkspaces.splice(index, 1);
          shadowfolkReplayState.delete(workspace);
          renderShadowfolkWorkspaces();
        });

        actions.appendChild(replayToggle);
        actions.appendChild(removeBtn);
        row.appendChild(code);
        row.appendChild(actions);
        item.appendChild(row);

        const state = shadowfolkReplayState.get(workspace);
        if (state && state.expanded) {
          item.appendChild(renderShadowfolkReplayControls(workspace, state));
        }

        list.appendChild(item);
      });
```

- [ ] **Step 3: Add replay controls renderer**

Add below `renderShadowfolkWorkspaces()`:

```js
    function renderShadowfolkReplayControls(workspace, state) {
      const wrap = document.createElement('div');
      wrap.style.display = 'flex';
      wrap.style.gap = '6px';
      wrap.style.alignItems = 'center';
      wrap.style.paddingLeft = '10px';

      const label = document.createElement('span');
      label.textContent = '范围';
      label.style.fontSize = '12px';
      label.style.color = '#536476';

      const select = document.createElement('select');
      select.style.flex = '1';
      select.style.minWidth = '0';
      select.disabled = !!state.loading;
      const options = state.options && state.options.length
        ? state.options
        : [{ kind: 'full', label: state.loading ? '正在读取历史...' : '全量重推' }];
      options.forEach((option) => {
        const value = option.kind === 'history' ? `history:${option.historyId}` : 'full';
        select.appendChild(new Option(option.label, value));
      });
      if (state.selected) select.value = state.selected;
      select.addEventListener('change', () => {
        state.selected = select.value;
        shadowfolkReplayState.set(workspace, state);
      });

      const start = document.createElement('button');
      start.type = 'button';
      start.className = 'btn btn-secondary';
      start.textContent = '开始';
      start.style.fontSize = '12px';
      start.style.padding = '4px 10px';
      start.disabled = !!state.loading || !!state.running;
      start.addEventListener('click', async () => {
        await replayShadowfolkWorkspace(workspace, select.value || 'full');
      });

      wrap.appendChild(label);
      wrap.appendChild(select);
      wrap.appendChild(start);
      return wrap;
    }
```

- [ ] **Step 4: Add option loading**

Add:

```js
    async function loadShadowfolkReplayOptions(workspace) {
      const state = shadowfolkReplayState.get(workspace) || { expanded: true, options: [] };
      state.loading = true;
      shadowfolkReplayState.set(workspace, state);
      renderShadowfolkWorkspaces();
      try {
        const result = await window.settingsAPI.listShadowfolkPushHistory(workspace);
        if (!result || !result.success) {
          setShadowfolkStatus((result && result.error) || '读取重推历史失败', 'err');
          state.options = [{ kind: 'full', label: '全量重推' }];
        } else {
          state.options = Array.isArray(result.options) ? result.options : [{ kind: 'full', label: '全量重推' }];
        }
        state.loaded = true;
        state.selected = state.selected || 'full';
      } catch (e) {
        setShadowfolkStatus('读取重推历史出错：' + (e && e.message || e), 'err');
        state.options = [{ kind: 'full', label: '全量重推' }];
      } finally {
        state.loading = false;
        shadowfolkReplayState.set(workspace, state);
        renderShadowfolkWorkspaces();
      }
    }
```

- [ ] **Step 5: Add replay action**

Add:

```js
    async function replayShadowfolkWorkspace(workspace, selected) {
      const isHistory = selected && selected.startsWith('history:');
      const confirmed = confirm(isHistory ? '确认重推所选历史区间？' : '确认全量重推该工作区？');
      if (!confirmed) return;

      const state = shadowfolkReplayState.get(workspace) || { expanded: true, options: [] };
      state.running = true;
      shadowfolkReplayState.set(workspace, state);
      renderShadowfolkWorkspaces();
      setShadowfolkProgress(30, isHistory ? '正在重推历史区间...' : '正在全量重推...');
      try {
        const result = await window.settingsAPI.shadowfolkReplay(isHistory
          ? { workspace, kind: 'history', historyId: selected.slice('history:'.length) }
          : { workspace, kind: 'full' });
        if (!result || !result.success) {
          setShadowfolkStatus((result && result.error) || '重推失败', 'err');
          setShadowfolkProgress(0, (result && result.error) || '重推失败', 'err');
          return;
        }
        const r = result.result || {};
        setShadowfolkProgress(100, '重推完成', 'ok');
        setShadowfolkStatus(`重推完成：${r.observations || 0} 条 observation，${r.summaries || 0} 条 summary，${r.commits || 0} 个 commit`, 'ok');
        state.loaded = false;
        state.options = [];
        await loadShadowfolkReplayOptions(workspace);
        await refreshShadowfolkStatus({ updateProgress: false });
      } catch (e) {
        setShadowfolkStatus('重推出错：' + (e && e.message || e), 'err');
        setShadowfolkProgress(0, '重推出错', 'err');
      } finally {
        state.running = false;
        shadowfolkReplayState.set(workspace, state);
        renderShadowfolkWorkspaces();
      }
    }
```

- [ ] **Step 6: Run desktop build**

Run:

```bash
npm --prefix desktop run build:ts
```

Expected: PASS.

---

### Task 7: Final Verification

**Files:**
- Verify all modified files.

- [ ] **Step 1: Run focused ShadowFolk tests**

Run:

```bash
node --import tsx --test tests/shadowfolk-history-store.test.ts tests/shadowfolk-uploader.test.ts tests/shadowfolk-schedule.test.ts tests/worker/worker-endpoints.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run root typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run desktop TypeScript build**

Run:

```bash
npm --prefix desktop run build:ts
```

Expected: PASS.

- [ ] **Step 4: Manual UI verification**

Open Settings → Plugins and verify:

1. Each workspace row shows `重推` and `移除`.
2. Clicking `重推` expands a compact `范围` select and `开始` button under that workspace only.
3. The first option is `全量重推`.
4. Existing history entries for that workspace appear below full repush, newest first.
5. Starting a history replay asks `确认重推所选历史区间？`.
6. Starting a full repush asks `确认全量重推该工作区？`.
7. Success updates the status area with replay counts.

---

## Self-Review

- Spec coverage: Tasks 1-3 implement the local cursor ledger, normal upload recording, history range replay, full repush, memory-only range handling, and current cursor updates. Tasks 4-6 expose Worker APIs, IPC, preload, and the per-workspace compact UI. Task 7 covers verification.
- Placeholder scan: This plan contains no missing sections, no unspecified files, and no open-ended validation instructions.
- Type consistency: Cursor fields are consistently named `commit`, `observationId`, and `summaryId`; replay modes are consistently `normal`, `replay`, and `full`; Worker request kinds are consistently `history` and `full`.
- Scope check: The plan keeps full repush single-workspace only, does not save full payloads, and does not add server-side delete or overwrite behavior.
