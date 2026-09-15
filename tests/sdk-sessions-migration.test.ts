import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { updateSessionField } from '../src/services/sqlite/sessions.js';
import { ensureMissingColumns } from '../src/services/sqlite/Database.js';

// Minimal schema matching Database.ts initializeTables for sdk_sessions,
// including the NEW columns we expect Task 2 to add.
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sdk_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT NOT NULL UNIQUE,
      memory_session_id TEXT,
      project TEXT NOT NULL,
      user_prompt TEXT,
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL,
      completed_at TEXT,
      completed_at_epoch INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      worker_port INTEGER,
      prompt_counter INTEGER DEFAULT 0,
      last_assistant_message TEXT,
      transcript_path TEXT
    )
  `);
  return db;
}

test('ensureMissingColumns adds new columns to old-schema sdk_sessions', () => {
  const dbPath = join(tmpdir(), `m1-migration-${Date.now()}-${Math.random()}.db`);
  const db = new Database(dbPath);
  try {
    // Older schema: without the two new columns
    db.exec(`
      CREATE TABLE sdk_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL UNIQUE,
        memory_session_id TEXT,
        project TEXT NOT NULL,
        user_prompt TEXT,
        started_at TEXT NOT NULL,
        started_at_epoch INTEGER NOT NULL,
        completed_at TEXT,
        completed_at_epoch INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        worker_port INTEGER,
        prompt_counter INTEGER DEFAULT 0
      )
    `);
    // Run the migration
    ensureMissingColumns(db);
    // Verify
    const cols = db.prepare('PRAGMA table_info(sdk_sessions)').all() as any[];
    const names = new Set(cols.map(c => c.name));
    assert.ok(names.has('last_assistant_message'), 'last_assistant_message should be added');
    assert.ok(names.has('transcript_path'), 'transcript_path should be added');
    // Idempotent: running again is a no-op
    ensureMissingColumns(db);
    const cols2 = db.prepare('PRAGMA table_info(sdk_sessions)').all() as any[];
    assert.equal(cols2.length, cols.length, 'second run should not add new columns');
  } finally {
    db.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  }
});

test('updateSessionField writes last_assistant_message by content_session_id', () => {
  const db = makeDb();
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch)
     VALUES ('s1', 'p', '2026-04-21', 0)`
  ).run();
  updateSessionField('s1', 'last_assistant_message', 'hello', db);
  const row = db.prepare('SELECT last_assistant_message FROM sdk_sessions WHERE content_session_id = ?').get('s1') as any;
  assert.equal(row.last_assistant_message, 'hello');
});

test('updateSessionField writes transcript_path by memory_session_id', () => {
  const db = makeDb();
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
     VALUES ('c1', 'm1', 'p', '2026-04-21', 0)`
  ).run();
  updateSessionField('m1', 'transcript_path', '/tmp/t.jsonl', db);
  const row = db.prepare('SELECT transcript_path FROM sdk_sessions WHERE memory_session_id = ?').get('m1') as any;
  assert.equal(row.transcript_path, '/tmp/t.jsonl');
});

test('updateSessionField rejects disallowed field', () => {
  const db = makeDb();
  assert.throws(() => updateSessionField('s1', 'status', 'bad', db), /disallowed/);
});
