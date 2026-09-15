import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { ensureMissingColumns } from '../src/services/sqlite/Database.js';

// 旧版 observations 表（无 tier / signature 列）
function createLegacyObservations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      text TEXT,
      type TEXT NOT NULL,
      title TEXT,
      subtitle TEXT,
      meta_intent TEXT,
      facts TEXT,
      narrative TEXT,
      concepts TEXT,
      files_read TEXT,
      files_modified TEXT,
      prompt_number INTEGER,
      discovery_tokens INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    )
  `);
}

test('迁移：旧 observations 表自动补 tier(默认2) 与 signature 列，旧行 tier=2', () => {
  const dbPath = join(tmpdir(), `tier-migration-${Date.now()}-${Math.random()}.db`);
  const db = new Database(dbPath);
  try {
    createLegacyObservations(db);
    // 旧数据（无 tier）
    db.prepare(`
      INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch)
      VALUES ('m1', 'p', 'discovery', '历史记录', '2026-01-01', 0)
    `).run();

    ensureMissingColumns(db);

    const cols = db.prepare('PRAGMA table_info(observations)').all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    assert.ok(names.has('tier'), 'tier 列应被添加');
    assert.ok(names.has('signature'), 'signature 列应被添加');

    // 历史行默认为 tier=2（召回零影响）
    const old = db.prepare('SELECT tier FROM observations WHERE memory_session_id = ?').get('m1') as { tier: number };
    assert.equal(old.tier, 2);

    // 幂等：再次运行不重复添加
    ensureMissingColumns(db);
    const cols2 = db.prepare('PRAGMA table_info(observations)').all() as any[];
    assert.equal(cols2.length, cols.length);
  } finally {
    db.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  }
});

test('迁移后可写入 tier 0/1/2', () => {
  const dbPath = join(tmpdir(), `tier-write-${Date.now()}-${Math.random()}.db`);
  const db = new Database(dbPath);
  try {
    createLegacyObservations(db);
    ensureMissingColumns(db);

    const insert = db.prepare(`
      INSERT INTO observations (memory_session_id, project, type, title, tier, signature, created_at, created_at_epoch)
      VALUES (?, 'p', 'discovery', ?, ?, ?, '2026-01-01', ?)
    `);
    insert.run('m', 't0', 0, 'sig0', 1);
    insert.run('m', 't1', 1, 'sig1', 2);
    insert.run('m', 't2', 2, 'sig2', 3);

    const rows = db.prepare('SELECT tier, signature FROM observations ORDER BY created_at_epoch ASC').all() as { tier: number; signature: string }[];
    assert.deepEqual(rows.map((r) => r.tier), [0, 1, 2]);
    assert.deepEqual(rows.map((r) => r.signature), ['sig0', 'sig1', 'sig2']);
  } finally {
    db.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  }
});
