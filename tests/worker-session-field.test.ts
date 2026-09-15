import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { repairFallbackSessionProject, updateSessionField } from '../src/services/sqlite/sessions.js';

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

test('updateSessionField writes by memory_session_id', () => {
  const db = makeDb();
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
     VALUES ('c1', 'm1', 'p', '2026-04-21', 0)`
  ).run();
  updateSessionField('m1', 'transcript_path', '/path/to.jsonl', db);
  const row = db.prepare('SELECT transcript_path FROM sdk_sessions WHERE memory_session_id = ?').get('m1') as any;
  assert.equal(row.transcript_path, '/path/to.jsonl');
});

test('updateSessionField accepts null value', () => {
  const db = makeDb();
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch, last_assistant_message)
     VALUES ('s1', 'p', '2026-04-21', 0, 'existing')`
  ).run();
  updateSessionField('s1', 'last_assistant_message', null, db);
  const row = db.prepare('SELECT last_assistant_message FROM sdk_sessions WHERE content_session_id = ?').get('s1') as any;
  assert.equal(row.last_assistant_message, null);
});

test('updateSessionField no-op for unknown session_id', () => {
  const db = makeDb();
  // Should not throw; just update 0 rows
  updateSessionField('nonexistent', 'last_assistant_message', 'x', db);
  const count = db.prepare('SELECT COUNT(*) as c FROM sdk_sessions').get() as any;
  assert.equal(count.c, 0);
});

test('repairFallbackSessionProject replaces only the confirmed root fallback project', () => {
  const db = makeDb();
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch)
     VALUES ('root-session', '/', '2026-04-21', 0),
            ('system-session', 'c:/windows/system32', '2026-04-21', 0),
            ('real-session', '/users/test/original', '2026-04-21', 0)`
  ).run();

  assert.equal(repairFallbackSessionProject('root-session', '/Users/Test/Agent-Memory', db), true);
  assert.equal(repairFallbackSessionProject('system-session', 'D:/Agent-Memory', db), false);
  assert.equal(repairFallbackSessionProject('real-session', '/Users/Test/Other', db), false);
  const rows = db.prepare('SELECT content_session_id, project FROM sdk_sessions ORDER BY content_session_id').all() as any[];
  assert.deepEqual(rows, [
    { content_session_id: 'real-session', project: '/users/test/original' },
    { content_session_id: 'root-session', project: '/users/test/agent-memory' },
    { content_session_id: 'system-session', project: 'c:/windows/system32' },
  ]);
});
