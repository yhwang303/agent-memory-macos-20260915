import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  authorLogArgs,
  parseNumstatOutput,
  resolveAuthorPattern,
} from '../src/services/shadowfolk/gitAuthorFilter.js';
import { ShadowFolkUploader } from '../src/services/shadowfolk/ShadowFolkUploader.js';

const noopHistoryStore = { append: async () => {} } as any;

function makeEmptyMemoryDb(): Database.Database {
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
  return db;
}

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

function createCommit(
  dir: string,
  message: string,
  fileContent: string,
  parent?: string,
  author?: { name: string; email: string },
): string {
  const blob = gitInput(['hash-object', '-w', '--stdin'], dir, fileContent);
  const tree = gitInput(['mktree'], dir, `100644 blob ${blob}\trange.txt\n`);
  const args = ['commit-tree', tree, '-m', message];
  if (parent) args.push('-p', parent);
  const env = author
    ? {
        ...process.env,
        GIT_CONFIG_GLOBAL: 'NUL',
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
      }
    : { ...process.env, GIT_CONFIG_GLOBAL: 'NUL' };
  const commit = execFileSync('git', args, { cwd: dir, encoding: 'utf8', env }).trim();
  git(['update-ref', 'refs/heads/master', commit], dir);
  return commit;
}

function initRepoWithAuthor(name: string, email: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sf-author-filter-'));
  git(['init', '--initial-branch=master'], dir);
  git(['config', 'user.email', email], dir);
  git(['config', 'user.name', name], dir);
  return dir;
}

test('resolveAuthorPattern prefers email over name', () => {
  assert.equal(resolveAuthorPattern({ name: 'Alice', email: 'alice@example.com' }), 'alice@example.com');
  assert.equal(resolveAuthorPattern({ name: 'Alice', email: '' }), 'Alice');
  assert.equal(resolveAuthorPattern({ name: '', email: '' }), null);
});

test('authorLogArgs returns git author flag when pattern exists', () => {
  assert.deepEqual(authorLogArgs('alice@example.com'), ['--author', 'alice@example.com']);
  assert.deepEqual(authorLogArgs(null), []);
});

test('parseNumstatOutput aggregates insertions and unique files', () => {
  const output = [
    '1\t0\tREADME.md',
    '2\t1\tsrc/app.ts',
  ].join('\n');
  assert.deepEqual(parseNumstatOutput(output), {
    files_changed: 2,
    insertions: 3,
    deletions: 1,
  });
});

test('ShadowFolkUploader excludes commits from other authors', async () => {
  const workspace = initRepoWithAuthor('Test User', 'test@example.com');
  const requests: Array<{ path: string; body?: any }> = [];
  const db = makeEmptyMemoryDb();

  try {
    const first = createCommit(workspace, 'mine-first', 'v1\n');
    createCommit(
      workspace,
      'other-commit',
      'v2\n',
      first,
      { name: 'Other Dev', email: 'other@example.com' },
    );
    createCommit(workspace, 'mine-second', 'v3\n', git(['rev-parse', 'HEAD'], workspace));

    const uploader = new ShadowFolkUploader({
      db,
      server: 'http://shadowfolk.local',
      apiToken: 'sf_test',
      historyStore: { append: async () => {} } as any,
      fetchImpl: async (url, init) => {
        const parsed = new URL(String(url));
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ path: parsed.pathname, body });
        if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'GET') {
          return new Response(JSON.stringify({ record: { last_commit_hash: first } }), { status: 200 });
        }
        if (parsed.pathname === '/api/push/raw') {
          return new Response(JSON.stringify({ batch_id: 'author-filter-batch' }), { status: 201 });
        }
        if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'PUT') {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
      },
    });

    await uploader.pushWorkspace(workspace);

    const raw = requests.find(r => r.path === '/api/push/raw');
    assert.ok(raw, 'expected raw push request');
    assert.equal(raw!.body.git.commits.length, 1);
    assert.equal(raw!.body.git.commits[0].message, 'mine-second');
    assert.equal(raw!.body.git.commits[0].author, 'Test User');
    assert.ok(!raw!.body.git.commits.some((c: { message: string }) => c.message === 'other-commit'));
  } finally {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('ShadowFolkUploader diff stats ignore other authors changes', async () => {
  const workspace = initRepoWithAuthor('Test User', 'test@example.com');
  const requests: Array<{ path: string; body?: any }> = [];
  const db = makeEmptyMemoryDb();

  try {
    const first = createCommit(workspace, 'mine-first', 'v1\n');
    createCommit(
      workspace,
      'other-big-change',
      'v2\n'.repeat(20),
      first,
      { name: 'Other Dev', email: 'other@example.com' },
    );
    createCommit(workspace, 'mine-small-change', 'v3\n', git(['rev-parse', 'HEAD'], workspace));

    const uploader = new ShadowFolkUploader({
      db,
      server: 'http://shadowfolk.local',
      apiToken: 'sf_test',
      historyStore: { append: async () => {} } as any,
      fetchImpl: async (url, init) => {
        const parsed = new URL(String(url));
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ path: parsed.pathname, body });
        if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'GET') {
          return new Response(JSON.stringify({ record: { last_commit_hash: first } }), { status: 200 });
        }
        if (parsed.pathname === '/api/push/raw') {
          return new Response(JSON.stringify({ batch_id: 'author-stats-batch' }), { status: 201 });
        }
        if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'PUT') {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
      },
    });

    await uploader.pushWorkspace(workspace);

    const raw = requests.find(r => r.path === '/api/push/raw');
    assert.ok(raw, 'expected raw push request');
    assert.equal(raw!.body.git.stats.insertions, 1);
    assert.equal(raw!.body.git.stats.deletions, 20);
  } finally {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
