import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { ShadowFolkUploader } from '../src/services/shadowfolk/ShadowFolkUploader.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: 'NUL' } }).trim();
}

function gitInput(args: string[], cwd: string, input: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: 'NUL' },
    input,
  }).trim();
}

function initRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sf-uploader-'));
  initGitRepo(dir);
  return dir;
}

function initGitRepo(dir: string): void {
  git(['init', '--initial-branch=master'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test User'], dir);
}

function createCommit(dir: string, message: string, fileContent: string, parent?: string): string {
  const blob = gitInput(['hash-object', '-w', '--stdin'], dir, fileContent);
  const tree = gitInput(['mktree'], dir, `100644 blob ${blob}\trange.txt\n`);
  const args = ['commit-tree', tree, '-m', message];
  if (parent) args.push('-p', parent);
  const commit = git(args, dir);
  git(['update-ref', 'refs/heads/master', commit], dir);
  return commit;
}

const noopHistoryStore = { append: async () => {} } as any;

function makeMemoryDb(...projects: string[]): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      text TEXT,
      type TEXT NOT NULL,
      title TEXT,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    );
    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      request TEXT,
      learned TEXT,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    );
  `);
  const insertObservation = db.prepare(`
    INSERT INTO observations (memory_session_id, project, text, type, title, created_at, created_at_epoch)
    VALUES (?, ?, ?, 'insight', 'Work', '2026-05-07T00:00:00.000Z', ?)
  `);
  const insertSummary = db.prepare(`
    INSERT INTO session_summaries (memory_session_id, project, request, learned, created_at, created_at_epoch)
    VALUES (?, ?, 'ship feature', 'learned things', '2026-05-07T00:00:01.000Z', ?)
  `);
  projects.forEach((project, index) => {
    const normalizedProject = project.replace(/\\/g, '/').toLowerCase();
    const id = index + 1;
    insertObservation.run(`mem-${id}`, normalizedProject, `observed work ${id}`, id);
    insertSummary.run(`mem-${id}`, normalizedProject, id);
  });
  return db;
}

test('validateWorkspace returns git root for a repository child directory', async () => {
  const workspace = initRepo();
  const child = path.join(workspace, 'nested');
  mkdirSync(child);
  const db = makeMemoryDb(workspace);

  const uploader = new ShadowFolkUploader({
    db,
    server: 'http://shadowfolk.local',
    apiToken: 'sf_test',
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });

  try {
    const result = await uploader.validateWorkspace(child);

    assert.equal(result.valid, true);
    assert.match(result.gitRoot.replace(/\\/g, '/'), /sf-uploader-/);
  } finally {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('validateWorkspace rejects a non-git directory', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'sf-uploader-plain-'));
  const db = makeMemoryDb();

  const uploader = new ShadowFolkUploader({
    db,
    server: 'http://shadowfolk.local',
    apiToken: 'sf_test',
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });

  try {
    const result = await uploader.validateWorkspace(workspace);

    assert.equal(result.valid, false);
    assert.match(result.error || '', /不是 Git 工作区/);
  } finally {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('validateWorkspace accepts a recorded memory project when its local path does not exist', async () => {
  const workspace = 'D:/mem-distillation';
  const db = makeMemoryDb(workspace);
  const uploader = new ShadowFolkUploader({
    db,
    server: 'http://shadowfolk.local',
    apiToken: 'sf_test',
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });

  try {
    const result = await uploader.validateWorkspace(workspace);

    assert.equal(result.valid, true);
    assert.equal(result.mode, 'memory');
    assert.equal(result.gitRoot, 'd:/mem-distillation');
    assert.equal(result.error, null);

    const parentResult = await uploader.validateWorkspace('D:/');
    assert.equal(parentResult.valid, false, 'a parent path without its own memory must not select every child project');
  } finally {
    db.close();
  }
});

test('pushWorkspaces uploads recorded memory without reading a local git repository', async () => {
  const workspace = 'D:/mem-distillation';
  const requests: Array<{ method: string; path: string; body?: any }> = [];
  const db = makeMemoryDb(workspace);
  const uploader = new ShadowFolkUploader({
    db,
    server: 'http://shadowfolk.local',
    apiToken: 'sf_test',
    historyStore: noopHistoryStore,
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method: init?.method || 'GET', path: parsed.pathname, body });
      if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'GET') {
        return new Response(JSON.stringify({ record: { last_observation_id: 0, last_summary_id: 0 } }), { status: 200 });
      }
      if (parsed.pathname === '/api/push/raw') {
        return new Response(JSON.stringify({ batch_id: 'memory-batch' }), { status: 201 });
      }
      if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'PUT') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    },
  });

  try {
    const result = await uploader.pushWorkspaces([workspace]);

    assert.equal(result.pushed, true);
    assert.equal(result.workspaces, 1);
    assert.equal(result.observations, 1);
    assert.equal(result.summaries, 1);
    assert.equal(result.commits, 0);

    const raw = requests.find(r => r.path === '/api/push/raw');
    assert.ok(raw, 'expected raw push request');
    assert.equal(raw!.body.git.root, 'd:/mem-distillation');
    assert.equal(raw!.body.git.branch, 'memory');
    assert.equal(raw!.body.git.remote, 'agentmemory://d%3A%2Fmem-distillation');
    assert.deepEqual(raw!.body.git.commits, []);
    assert.equal(raw!.body.memory.scope, 'd:/mem-distillation');
    assert.equal(raw!.body.memory.observations[0].project, 'd:/mem-distillation');

    const putRecord = requests.find(r => r.method === 'PUT' && r.path.startsWith('/api/push/push-records/'));
    assert.ok(putRecord, 'expected push-record update');
    assert.equal(decodeURIComponent(putRecord!.path.replace('/api/push/push-records/', '')), 'd:/mem-distillation');
    assert.equal(putRecord!.body.last_commit_hash, '');
    assert.equal(putRecord!.body.last_observation_id, 1);
    assert.equal(putRecord!.body.last_summary_id, 1);
  } finally {
    db.close();
  }
});

test('pushWorkspaces uploads only explicit workspace list', async () => {
  const workspaceA = initRepo();
  const workspaceB = initRepo();
  const requests: Array<{ method: string; path: string; body?: any }> = [];
  const db = makeMemoryDb(workspaceA, workspaceB);

  const uploader = new ShadowFolkUploader({
    db,
    server: 'http://shadowfolk.local',
    apiToken: 'sf_test',
    historyStore: noopHistoryStore,
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method: init?.method || 'GET', path: parsed.pathname, body });
      if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'GET') {
        return new Response(JSON.stringify({ record: { last_observation_id: 0, last_summary_id: 0 } }), { status: 200 });
      }
      if (parsed.pathname === '/api/push/raw') {
        return new Response(JSON.stringify({ batch_id: 'batch-1' }), { status: 201 });
      }
      if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'PUT') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    },
  });

  try {
    const result = await uploader.pushWorkspaces([workspaceA]);

    assert.equal(result.pushed, true);
    assert.equal(result.workspaces, 1);
    assert.equal(result.observations, 1);

    const raw = requests.find(r => r.path === '/api/push/raw');
    assert.ok(raw, 'expected raw push request');
    assert.equal(raw!.body.memory.observations.length, 1);
    assert.equal(raw!.body.memory.observations[0].project, workspaceA.replace(/\\/g, '/').toLowerCase());
    assert.notEqual(raw!.body.memory.observations[0].project, workspaceB.replace(/\\/g, '/').toLowerCase());
  } finally {
    db.close();
    rmSync(workspaceA, { recursive: true, force: true });
    rmSync(workspaceB, { recursive: true, force: true });
  }
});

test('pushWorkspaces exports memories from configured old memory roots while keeping new git root identity', async () => {
  const workspace = initRepo();
  const gitRoot = git(['rev-parse', '--show-toplevel'], workspace);
  const oldMemoryRoot = path.join(path.dirname(workspace), 'old-repo-path');
  const requests: Array<{ method: string; path: string; body?: any }> = [];
  const db = makeMemoryDb(workspace, oldMemoryRoot);

  const uploader = new ShadowFolkUploader({
    db,
    server: 'http://shadowfolk.local',
    apiToken: 'sf_test',
    historyStore: noopHistoryStore,
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method: init?.method || 'GET', path: parsed.pathname, body });
      if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'GET') {
        return new Response(JSON.stringify({ record: { last_observation_id: 0, last_summary_id: 0 } }), { status: 200 });
      }
      if (parsed.pathname === '/api/push/raw') {
        return new Response(JSON.stringify({ batch_id: 'batch-1' }), { status: 201 });
      }
      if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'PUT') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    },
  });

  try {
    const result = await uploader.pushWorkspaces([{ workspace, memoryRoots: [oldMemoryRoot] }]);

    assert.equal(result.pushed, true);
    assert.equal(result.observations, 2);
    assert.equal(result.summaries, 2);

    const raw = requests.find(r => r.path === '/api/push/raw');
    assert.ok(raw, 'expected raw push request');
    assert.equal(raw!.body.git.root.replace(/\\/g, '/').toLowerCase(), gitRoot.replace(/\\/g, '/').toLowerCase());
    assert.equal(raw!.body.memory.scope.replace(/\\/g, '/').toLowerCase(), gitRoot.replace(/\\/g, '/').toLowerCase());
    assert.deepEqual(
      raw!.body.memory.observations.map((row: any) => row.project).sort(),
      [workspace, oldMemoryRoot].map(p => p.replace(/\\/g, '/').toLowerCase()).sort(),
    );

    const putRecord = requests.find(r => r.method === 'PUT' && r.path.startsWith('/api/push/push-records/'));
    assert.ok(putRecord, 'expected push-record update');
    assert.equal(decodeURIComponent(putRecord!.path.replace('/api/push/push-records/', '')).replace(/\\/g, '/').toLowerCase(), gitRoot.replace(/\\/g, '/').toLowerCase());
  } finally {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('pushWorkspaces excludes records that only share a path prefix', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'sf-uploader-prefix-'));
  const workspace = path.join(parent, 'repo');
  const sharedPrefix = path.join(parent, 'repo-other');
  mkdirSync(workspace);
  const requests: Array<{ method: string; path: string; body?: any }> = [];
  initGitRepo(workspace);
  const db = makeMemoryDb(workspace, sharedPrefix);

  const uploader = new ShadowFolkUploader({
    db,
    server: 'http://shadowfolk.local',
    apiToken: 'sf_test',
    historyStore: noopHistoryStore,
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method: init?.method || 'GET', path: parsed.pathname, body });
      if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'GET') {
        return new Response(JSON.stringify({ record: { last_observation_id: 0, last_summary_id: 0 } }), { status: 200 });
      }
      if (parsed.pathname === '/api/push/raw') {
        return new Response(JSON.stringify({ batch_id: 'batch-1' }), { status: 201 });
      }
      if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'PUT') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    },
  });

  try {
    const result = await uploader.pushWorkspaces([workspace]);

    assert.equal(result.pushed, true);
    assert.equal(result.observations, 1);
    assert.equal(result.summaries, 1);

    const raw = requests.find(r => r.path === '/api/push/raw');
    assert.ok(raw, 'expected raw push request');
    const uploadedObservationProjects = raw!.body.memory.observations.map((row: any) => row.project);
    const uploadedSummaryProjects = raw!.body.memory.session_summaries.map((row: any) => row.project);
    assert.deepEqual(uploadedObservationProjects, [workspace.replace(/\\/g, '/').toLowerCase()]);
    assert.deepEqual(uploadedSummaryProjects, [workspace.replace(/\\/g, '/').toLowerCase()]);
    assert.ok(!uploadedObservationProjects.includes(sharedPrefix.replace(/\\/g, '/').toLowerCase()));
    assert.ok(!uploadedSummaryProjects.includes(sharedPrefix.replace(/\\/g, '/').toLowerCase()));
  } finally {
    db.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test('pushWorkspaces excludes observations from nested git repositories', async () => {
  const parent = initRepo();
  const nested = path.join(parent, 'nested-repo');
  mkdirSync(nested);
  initGitRepo(nested);
  const parentGitRoot = git(['rev-parse', '--show-toplevel'], parent);
  const nestedGitRoot = git(['rev-parse', '--show-toplevel'], nested);
  const requests: Array<{ method: string; path: string; body?: any }> = [];
  const db = makeMemoryDb(parentGitRoot, nestedGitRoot);

  const uploader = new ShadowFolkUploader({
    db,
    server: 'http://shadowfolk.local',
    apiToken: 'sf_test',
    historyStore: noopHistoryStore,
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method: init?.method || 'GET', path: parsed.pathname, body });
      if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'GET') {
        return new Response(JSON.stringify({ record: { last_observation_id: 0, last_summary_id: 0 } }), { status: 200 });
      }
      if (parsed.pathname === '/api/push/raw') {
        return new Response(JSON.stringify({ batch_id: 'batch-1' }), { status: 201 });
      }
      if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'PUT') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    },
  });

  try {
    const result = await uploader.pushWorkspaces([parent]);

    assert.equal(result.pushed, true);
    assert.equal(result.observations, 1);

    const raw = requests.find(r => r.path === '/api/push/raw');
    assert.ok(raw, 'expected raw push request');
    const uploadedObservationProjects = raw!.body.memory.observations.map((row: any) => row.project);
    assert.deepEqual(uploadedObservationProjects, [parentGitRoot.replace(/\\/g, '/').toLowerCase()]);
    assert.ok(!uploadedObservationProjects.includes(nestedGitRoot.replace(/\\/g, '/').toLowerCase()));
  } finally {
    db.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test('ShadowFolkUploader pushes workspace payload and updates push record', async () => {
  const workspace = initRepo();
  const requests: Array<{ method: string; path: string; body?: any }> = [];
  const db = makeMemoryDb(workspace);

  const uploader = new ShadowFolkUploader({
    db,
    server: 'http://shadowfolk.local',
    apiToken: 'sf_test',
    historyStore: noopHistoryStore,
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method: init?.method || 'GET', path: parsed.pathname, body });
      assert.equal(init?.headers && (init.headers as any).Authorization, 'Bearer sf_test');
      if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'GET') {
        return new Response(JSON.stringify({ record: { last_observation_id: 0, last_summary_id: 0 } }), { status: 200 });
      }
      if (parsed.pathname === '/api/push/raw') {
        return new Response(JSON.stringify({ batch_id: 'batch-1', observations_count: 1, summaries_count: 1 }), { status: 201 });
      }
      if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'PUT') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    },
  });

  try {
    const result = await uploader.pushWorkspace(workspace);

    assert.equal(result.pushed, true);
    assert.equal(result.observations, 1);
    assert.equal(result.summaries, 1);

    const raw = requests.find(r => r.path === '/api/push/raw');
    assert.ok(raw, 'expected raw push request');
    assert.match(raw!.body.git.root.replace(/\\/g, '/'), /sf-uploader-/);
    assert.equal(raw!.body.memory.observations.length, 1);
    assert.equal(raw!.body.memory.session_summaries.length, 1);

    const update = requests.find(r => r.method === 'PUT');
    assert.ok(update, 'expected push record update');
    assert.equal(update!.body.task_id, 'batch-1');
    assert.equal(update!.body.last_observation_id, 1);
    assert.equal(update!.body.last_summary_id, 1);
  } finally {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('pushWorkspace accepts workspace config with memory roots', async () => {
  const workspace = initRepo();
  const gitRoot = git(['rev-parse', '--show-toplevel'], workspace);
  const oldMemoryRoot = path.join(path.dirname(workspace), 'old-repo-path');
  const requests: Array<{ method: string; path: string; body?: any }> = [];
  const historyEntries: any[] = [];
  const db = makeMemoryDb(workspace, oldMemoryRoot);

  const uploader = new ShadowFolkUploader({
    db,
    server: 'http://shadowfolk.local',
    apiToken: 'sf_test',
    historyStore: { append: async (entry: any) => { historyEntries.push(entry); } } as any,
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method: init?.method || 'GET', path: parsed.pathname, body });
      if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'GET') {
        return new Response(JSON.stringify({ record: { last_observation_id: 0, last_summary_id: 0 } }), { status: 200 });
      }
      if (parsed.pathname === '/api/push/raw') {
        return new Response(JSON.stringify({ batch_id: 'direct-alias-batch' }), { status: 201 });
      }
      if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'PUT') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    },
  });

  try {
    const result = await uploader.pushWorkspace({ workspace, memoryRoots: [oldMemoryRoot] });

    assert.equal(result.pushed, true);
    assert.equal(result.workspace, workspace);
    assert.equal(result.gitRoot.replace(/\\/g, '/').toLowerCase(), gitRoot.replace(/\\/g, '/').toLowerCase());
    assert.equal(result.observations, 2);
    assert.equal(result.summaries, 2);

    const raw = requests.find(r => r.path === '/api/push/raw');
    assert.ok(raw, 'expected raw push request');
    assert.equal(raw!.body.git.root.replace(/\\/g, '/').toLowerCase(), gitRoot.replace(/\\/g, '/').toLowerCase());
    assert.equal(raw!.body.memory.scope.replace(/\\/g, '/').toLowerCase(), gitRoot.replace(/\\/g, '/').toLowerCase());
    assert.deepEqual(
      raw!.body.memory.observations.map((row: any) => row.project).sort(),
      [workspace, oldMemoryRoot].map(p => p.replace(/\\/g, '/').toLowerCase()).sort(),
    );

    const putRecord = requests.find(r => r.method === 'PUT' && r.path.startsWith('/api/push/push-records/'));
    assert.ok(putRecord, 'expected push-record update');
    assert.equal(decodeURIComponent(putRecord!.path.replace('/api/push/push-records/', '')).replace(/\\/g, '/').toLowerCase(), gitRoot.replace(/\\/g, '/').toLowerCase());
    assert.deepEqual(historyEntries[0].memoryRoots, [oldMemoryRoot]);
  } finally {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

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
      writeHistory: false,
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

test('pushWorkspaceRange exports configured old memory roots while keeping canonical git root identity', async () => {
  const workspace = initRepo();
  const gitRoot = git(['rev-parse', '--show-toplevel'], workspace);
  const oldMemoryRoot = path.join(path.dirname(workspace), 'old-repo-path');
  const requests: Array<{ method: string; path: string; body?: any }> = [];
  const historyEntries: any[] = [];
  const db = makeMemoryDb(workspace, oldMemoryRoot);

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
        return new Response(JSON.stringify({ batch_id: 'range-alias-batch' }), { status: 201 });
      }
      if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'PUT') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    },
  });

  try {
    const result = await uploader.pushWorkspaceRange({ workspace, memoryRoots: [oldMemoryRoot] }, {
      mode: 'replay',
      startCursor: { commit: '', observationId: 0, summaryId: 0 },
      endCursor: { commit: '', observationId: 2, summaryId: 2 },
    });

    assert.equal(result.pushed, true);
    assert.equal(result.workspace, workspace);
    assert.equal(result.gitRoot.replace(/\\/g, '/').toLowerCase(), gitRoot.replace(/\\/g, '/').toLowerCase());
    assert.equal(result.observations, 2);
    assert.equal(result.summaries, 2);

    const raw = requests.find(r => r.path === '/api/push/raw');
    assert.ok(raw, 'expected raw push request');
    assert.equal(raw!.body.git.root.replace(/\\/g, '/').toLowerCase(), gitRoot.replace(/\\/g, '/').toLowerCase());
    assert.equal(raw!.body.memory.scope.replace(/\\/g, '/').toLowerCase(), gitRoot.replace(/\\/g, '/').toLowerCase());
    assert.deepEqual(
      raw!.body.memory.observations.map((row: any) => row.project).sort(),
      [workspace, oldMemoryRoot].map(p => p.replace(/\\/g, '/').toLowerCase()).sort(),
    );

    assert.equal(historyEntries.length, 1);
    assert.deepEqual(historyEntries[0].memoryRoots, [oldMemoryRoot]);
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
      writeHistory: false,
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

test('pushWorkspaceRange rejects missing start commits before raw upload', async () => {
  const workspace = initRepo();
  const end = createCommit(workspace, 'end', 'one\n');
  const missingStart = '1111111111111111111111111111111111111111';
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
        return new Response(JSON.stringify({ batch_id: 'unexpected-batch' }), { status: 201 });
      }
      if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'PUT') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    },
  });

  try {
    await assert.rejects(() => uploader.pushWorkspaceRange(workspace, {
      mode: 'replay',
      startCursor: { commit: missingStart, observationId: 0, summaryId: 0 },
      endCursor: { commit: end, observationId: 1, summaryId: 1 },
      writeHistory: false,
    }));

    assert.ok(!requests.some(r => r.path === '/api/push/raw'), 'raw push must not run for invalid range');
  } finally {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('pushWorkspaceRange stats end at the selected commit instead of HEAD', async () => {
  const workspace = initRepo();
  const first = createCommit(workspace, 'first', 'one\n');
  const second = createCommit(workspace, 'second', 'one\ntwo\n', first);
  createCommit(workspace, 'third', 'one\ntwo\nthree\n', second);
  const requests: Array<{ method: string; path: string; body?: any }> = [];
  const db = makeMemoryDb();

  const uploader = new ShadowFolkUploader({
    db,
    server: 'http://shadowfolk.local',
    apiToken: 'sf_test',
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method: init?.method || 'GET', path: parsed.pathname, body });
      if (parsed.pathname === '/api/push/raw') {
        return new Response(JSON.stringify({ batch_id: 'stats-range-batch' }), { status: 201 });
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
      startCursor: { commit: first, observationId: 0, summaryId: 0 },
      endCursor: { commit: second, observationId: 0, summaryId: 0 },
      writeHistory: false,
    });

    assert.equal(result.pushed, true);
    assert.equal(result.commits, 1);
    const raw = requests.find(r => r.path === '/api/push/raw');
    assert.ok(raw, 'expected raw push request');
    assert.equal(raw!.body.git.stats.files_changed, 1);
    assert.equal(raw!.body.git.stats.insertions, 1);
  } finally {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

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

test('repushWorkspaceFull exports configured old memory roots and records full history aliases', async () => {
  const workspace = initRepo();
  const gitRoot = git(['rev-parse', '--show-toplevel'], workspace);
  const oldMemoryRoot = path.join(path.dirname(workspace), 'old-repo-path');
  const historyEntries: any[] = [];
  const requests: Array<{ method: string; path: string; body?: any }> = [];
  const db = makeMemoryDb(workspace, oldMemoryRoot);
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
        return new Response(JSON.stringify({ batch_id: 'full-alias-batch' }), { status: 201 });
      }
      if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'PUT') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    },
  });

  try {
    const result = await uploader.repushWorkspaceFull({ workspace, memoryRoots: [oldMemoryRoot] });

    assert.equal(result.pushed, true);
    assert.equal(result.gitRoot.replace(/\\/g, '/').toLowerCase(), gitRoot.replace(/\\/g, '/').toLowerCase());
    assert.equal(result.observations, 2);
    assert.equal(result.summaries, 2);

    const raw = requests.find(r => r.path === '/api/push/raw');
    assert.ok(raw, 'expected raw push request');
    assert.equal(raw!.body.git.root.replace(/\\/g, '/').toLowerCase(), gitRoot.replace(/\\/g, '/').toLowerCase());
    assert.equal(raw!.body.memory.scope.replace(/\\/g, '/').toLowerCase(), gitRoot.replace(/\\/g, '/').toLowerCase());
    assert.deepEqual(
      raw!.body.memory.observations.map((row: any) => row.project).sort(),
      [workspace, oldMemoryRoot].map(p => p.replace(/\\/g, '/').toLowerCase()).sort(),
    );
    assert.equal(historyEntries[0].mode, 'full');
    assert.deepEqual(historyEntries[0].memoryRoots, [oldMemoryRoot]);
  } finally {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('repushWorkspaceFull supports a memory-only project with no local path', async () => {
  const workspace = 'D:/mem-distillation';
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
        return new Response(JSON.stringify({ batch_id: 'memory-full-batch' }), { status: 201 });
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
    assert.equal(result.commits, 0);
    assert.equal(result.observations, 1);
    assert.equal(result.summaries, 1);
    assert.equal(historyEntries[0].mode, 'full');
    assert.equal(historyEntries[0].branch, 'memory');
    const raw = requests.find(r => r.path === '/api/push/raw');
    assert.ok(raw, 'expected raw push request');
    assert.equal(raw!.body.git.branch, 'memory');
    assert.deepEqual(raw!.body.git.commits, []);
  } finally {
    db.close();
  }
});

test('listPushHistory uses canonical git root even when memory roots are configured', async () => {
  const workspace = initRepo();
  const gitRoot = git(['rev-parse', '--show-toplevel'], workspace);
  const oldMemoryRoot = path.join(path.dirname(workspace), 'old-repo-path');
  const queriedRoots: string[] = [];
  const db = makeMemoryDb(workspace, oldMemoryRoot);
  const uploader = new ShadowFolkUploader({
    db,
    server: 'http://shadowfolk.local',
    apiToken: 'sf_test',
    historyStore: {
      listForGitRoot: async (root: string) => {
        queriedRoots.push(root);
        return [{ id: 'hist-1', gitRoot: root, workspace, memoryRoots: [oldMemoryRoot], createdAt: '2026-05-07T00:00:00.000Z' }];
      },
    } as any,
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  });

  try {
    const entries = await uploader.listPushHistory({ workspace, memoryRoots: [oldMemoryRoot] });

    assert.equal(entries.length, 1);
    assert.deepEqual(queriedRoots.map(root => root.replace(/\\/g, '/').toLowerCase()), [gitRoot.replace(/\\/g, '/').toLowerCase()]);
  } finally {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('replayHistoryEntry supports a memory-only project with no local path', async () => {
  const workspace = 'D:/mem-distillation';
  const requests: Array<{ method: string; path: string; body?: any }> = [];
  const historyEntries: any[] = [];
  const db = makeMemoryDb(workspace);
  const historyEntry = {
    id: 'memory-history',
    workspace: 'd:/mem-distillation',
    gitRoot: 'd:/mem-distillation',
    memoryRoots: [],
    remote: 'agentmemory://d%3A%2Fmem-distillation',
    branch: 'memory',
    mode: 'normal',
    startCursor: { commit: '', observationId: 0, summaryId: 0 },
    endCursor: { commit: '', observationId: 1, summaryId: 1 },
    batchId: 'original-memory-batch',
    counts: { commits: 0, observations: 1, summaries: 1 },
    createdAt: '2026-05-07T00:00:00.000Z',
  };
  const uploader = new ShadowFolkUploader({
    db,
    server: 'http://shadowfolk.local',
    apiToken: 'sf_test',
    historyStore: {
      getById: async () => historyEntry,
      append: async (entry: any) => { historyEntries.push(entry); },
    } as any,
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method: init?.method || 'GET', path: parsed.pathname, body });
      if (parsed.pathname === '/api/push/raw') {
        return new Response(JSON.stringify({ batch_id: 'memory-replay-batch' }), { status: 201 });
      }
      if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'PUT') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    },
  });

  try {
    const result = await uploader.replayHistoryEntry(workspace, historyEntry.id);

    assert.equal(result.pushed, true);
    assert.equal(result.commits, 0);
    assert.equal(result.observations, 1);
    assert.equal(result.summaries, 1);
    assert.equal(historyEntries[0].mode, 'replay');
    assert.equal(historyEntries[0].branch, 'memory');
    const raw = requests.find(r => r.path === '/api/push/raw');
    assert.ok(raw, 'expected raw push request');
    assert.equal(raw!.body.git.branch, 'memory');
    assert.deepEqual(raw!.body.git.commits, []);
  } finally {
    db.close();
  }
});

test('replayHistoryEntry prefers current memory roots over history aliases', async () => {
  const workspace = initRepo();
  const gitRoot = git(['rev-parse', '--show-toplevel'], workspace);
  const historicalMemoryRoot = path.join(path.dirname(workspace), 'historical-old-path');
  const currentMemoryRoot = path.join(path.dirname(workspace), 'current-old-path');
  const requests: Array<{ method: string; path: string; body?: any }> = [];
  const historyEntries: any[] = [];
  const db = makeMemoryDb(workspace, historicalMemoryRoot, currentMemoryRoot);
  const historyEntry = {
    id: 'hist-replay',
    workspace,
    gitRoot,
    memoryRoots: [historicalMemoryRoot],
    remote: '',
    branch: 'master',
    mode: 'normal',
    startCursor: { commit: '', observationId: 0, summaryId: 0 },
    endCursor: { commit: '', observationId: 3, summaryId: 3 },
    batchId: 'original-batch',
    counts: { commits: 0, observations: 3, summaries: 3 },
    createdAt: '2026-05-07T00:00:00.000Z',
  };
  const uploader = new ShadowFolkUploader({
    db,
    server: 'http://shadowfolk.local',
    apiToken: 'sf_test',
    historyStore: {
      getById: async () => historyEntry,
      append: async (entry: any) => { historyEntries.push(entry); },
    } as any,
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method: init?.method || 'GET', path: parsed.pathname, body });
      if (parsed.pathname === '/api/push/raw') {
        return new Response(JSON.stringify({ batch_id: 'replay-alias-batch' }), { status: 201 });
      }
      if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'PUT') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    },
  });

  try {
    const result = await uploader.replayHistoryEntry({ workspace, memoryRoots: [currentMemoryRoot] }, historyEntry.id);

    assert.equal(result.pushed, true);
    assert.equal(result.observations, 2);
    assert.equal(result.summaries, 2);

    const raw = requests.find(r => r.path === '/api/push/raw');
    assert.ok(raw, 'expected raw push request');
    assert.deepEqual(
      raw!.body.memory.observations.map((row: any) => row.project).sort(),
      [workspace, currentMemoryRoot].map(p => p.replace(/\\/g, '/').toLowerCase()).sort(),
    );
    assert.ok(!raw!.body.memory.observations.some((row: any) => row.project === historicalMemoryRoot.replace(/\\/g, '/').toLowerCase()));
    assert.equal(historyEntries[0].mode, 'replay');
    assert.deepEqual(historyEntries[0].memoryRoots, [currentMemoryRoot]);
  } finally {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('replayHistoryEntry falls back to history memory roots when current config has none', async () => {
  const workspace = initRepo();
  const gitRoot = git(['rev-parse', '--show-toplevel'], workspace);
  const historyMemoryRoot = path.join(path.dirname(workspace), 'history-old-path');
  const requests: Array<{ method: string; path: string; body?: any }> = [];
  const historyEntries: any[] = [];
  const db = makeMemoryDb(workspace, historyMemoryRoot);
  const historyEntry = {
    id: 'hist-replay-fallback',
    workspace,
    gitRoot,
    memoryRoots: [historyMemoryRoot],
    remote: '',
    branch: 'master',
    mode: 'normal',
    startCursor: { commit: '', observationId: 0, summaryId: 0 },
    endCursor: { commit: '', observationId: 2, summaryId: 2 },
    batchId: 'original-batch',
    counts: { commits: 0, observations: 2, summaries: 2 },
    createdAt: '2026-05-07T00:00:00.000Z',
  };
  const uploader = new ShadowFolkUploader({
    db,
    server: 'http://shadowfolk.local',
    apiToken: 'sf_test',
    historyStore: {
      getById: async () => historyEntry,
      append: async (entry: any) => { historyEntries.push(entry); },
    } as any,
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method: init?.method || 'GET', path: parsed.pathname, body });
      if (parsed.pathname === '/api/push/raw') {
        return new Response(JSON.stringify({ batch_id: 'replay-fallback-batch' }), { status: 201 });
      }
      if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'PUT') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    },
  });

  try {
    const result = await uploader.replayHistoryEntry({ workspace }, historyEntry.id);

    assert.equal(result.pushed, true);
    assert.equal(result.observations, 2);
    assert.equal(result.summaries, 2);

    const raw = requests.find(r => r.path === '/api/push/raw');
    assert.ok(raw, 'expected raw push request');
    assert.deepEqual(
      raw!.body.memory.observations.map((row: any) => row.project).sort(),
      [workspace, historyMemoryRoot].map(p => p.replace(/\\/g, '/').toLowerCase()).sort(),
    );
    assert.deepEqual(
      raw!.body.memory.session_summaries.map((row: any) => row.project).sort(),
      [workspace, historyMemoryRoot].map(p => p.replace(/\\/g, '/').toLowerCase()).sort(),
    );
    assert.equal(historyEntries[0].mode, 'replay');
    assert.deepEqual(historyEntries[0].memoryRoots, [historyMemoryRoot]);
  } finally {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
