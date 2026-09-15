import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { ensureMissingColumns } from '../src/services/sqlite/Database.js';
import { resolveSourceIdeForSummary } from '../src/services/worker/SDKAgent.js';

// ---------------------------------------------------------------------------
// resolveSourceIdeForSummary：末条非空 observation → session 兜底 → null
// ---------------------------------------------------------------------------

test('summary 取最后一条非空 observation 的 source_ide', () => {
  const obs = [
    { source_ide: 'cursor' },
    { source_ide: 'codex-cli' },
  ];
  assert.equal(resolveSourceIdeForSummary(obs, null), 'codex-cli');
});

test('summary 跳过末尾空值，取靠后的非空 observation', () => {
  const obs = [
    { source_ide: 'cursor' },
    { source_ide: null },
    { source_ide: '  ' },
  ];
  assert.equal(resolveSourceIdeForSummary(obs, null), 'cursor');
});

test('summary 在 observation 全空时回退到 session.source_ide', () => {
  const obs = [{ source_ide: null }, { source_ide: '' }];
  assert.equal(resolveSourceIdeForSummary(obs, { source_ide: 'claude-code' }), 'claude-code');
});

test('summary 在 observation 与 session 都为空时返回 null', () => {
  assert.equal(resolveSourceIdeForSummary([{ source_ide: null }], { source_ide: '' }), null);
  assert.equal(resolveSourceIdeForSummary([], null), null);
  assert.equal(resolveSourceIdeForSummary([], undefined), null);
});

test('summary 对 source_ide 做 trim', () => {
  assert.equal(resolveSourceIdeForSummary([{ source_ide: '  gemini-cli  ' }], null), 'gemini-cli');
});

test('summary hint 最优先，凌驾 observation 与 session（消除异步竞态）', () => {
  // observation 还没异步入库（全空）、session 也为空，但 hook 透传了 hint
  assert.equal(resolveSourceIdeForSummary([{ source_ide: null }], { source_ide: '' }, 'codex-cli'), 'codex-cli');
  // 即便 observation 有旧值，hint 仍优先（当前问答的权威 IDE）
  assert.equal(resolveSourceIdeForSummary([{ source_ide: 'cursor' }], null, 'codex-cli'), 'codex-cli');
  // hint 为空白则忽略，回退到 observation
  assert.equal(resolveSourceIdeForSummary([{ source_ide: 'cursor' }], null, '  '), 'cursor');
});

// ---------------------------------------------------------------------------
// 迁移：旧表自动补 source_ide 列，并可写入/读出
// ---------------------------------------------------------------------------

function createLegacyTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE sdk_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT NOT NULL,
      memory_session_id TEXT,
      project TEXT NOT NULL,
      user_prompt TEXT,
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL,
      status TEXT,
      worker_port INTEGER,
      prompt_counter INTEGER
    );
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
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
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    );
  `);
}

test('迁移：三张表自动补 source_ide 列并能写入读出', () => {
  const dbPath = join(tmpdir(), `source-ide-${Date.now()}-${Math.random()}.db`);
  const db = new Database(dbPath);
  try {
    createLegacyTables(db);
    ensureMissingColumns(db);

    for (const tbl of ['sdk_sessions', 'observations', 'session_summaries']) {
      const cols = db.prepare(`PRAGMA table_info(${tbl})`).all() as { name: string }[];
      const names = new Set(cols.map((c) => c.name));
      assert.ok(names.has('source_ide'), `${tbl} 应有 source_ide 列`);
    }

    db.prepare(`
      INSERT INTO observations (memory_session_id, project, type, title, source_ide, created_at, created_at_epoch)
      VALUES ('m', 'p', 'discovery', 't', 'codex-cli', '2026-01-01', 1)
    `).run();
    const row = db.prepare('SELECT source_ide FROM observations WHERE memory_session_id = ?').get('m') as { source_ide: string };
    assert.equal(row.source_ide, 'codex-cli');

    // 历史行（未带 source_ide）应为 NULL
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch)
      VALUES ('m2', 'p', 'discovery', 't', '2026-01-01', 2)
    `).run();
    const legacy = db.prepare('SELECT source_ide FROM observations WHERE memory_session_id = ?').get('m2') as { source_ide: string | null };
    assert.equal(legacy.source_ide, null);
  } finally {
    db.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  }
});
