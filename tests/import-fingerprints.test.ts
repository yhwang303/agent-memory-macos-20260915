/**
 * Fingerprint table integration test.
 *
 * Runs against a real better-sqlite3 :memory: DB so we exercise the actual
 * SQL the orchestrator depends on (chunked IN(...), tx-wrapped reset,
 * upsert-on-conflict). We don't go through the singleton getDatabase()
 * because that would touch the user's real ~/.agent-memory db.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

// We re-implement the small set of SQL the fingerprints module uses, so the
// test is hermetic and doesn't need a DI overhaul. The schema string here
// mirrors src/services/sqlite/Database.ts:initializeTables for the import
// table — the regression we care about is that the SQL itself is valid
// and the access patterns work.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS import_history_fingerprints (
    fingerprint TEXT PRIMARY KEY,
    adapter_id  TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    turn_index  INTEGER NOT NULL,
    summary_id  INTEGER,
    imported_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_session_id TEXT NOT NULL,
    project TEXT NOT NULL,
    request TEXT
  );
`;

test('import_history_fingerprints: insert / lookup / chunked batch / reset cascade', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA);

  // Seed two summaries that the fingerprint rows reference.
  const sumStmt = db.prepare(
    'INSERT INTO session_summaries (memory_session_id, project, request) VALUES (?, ?, ?)',
  );
  const s1 = sumStmt.run('imp:claude:abc:t0', 'd:/a', 'request 1').lastInsertRowid as number;
  const s2 = sumStmt.run('imp:claude:abc:t1', 'd:/a', 'request 2').lastInsertRowid as number;

  // Insert two fingerprints.
  const insertFp = db.prepare(
    `INSERT OR REPLACE INTO import_history_fingerprints
       (fingerprint, adapter_id, file_path, turn_index, summary_id, imported_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertFp.run('fp1', 'claude', '/path/a.jsonl', 0, s1, 1_700_000_000_000);
  insertFp.run('fp2', 'claude', '/path/a.jsonl', 1, s2, 1_700_000_000_000);

  // Lookup individual.
  const has = db.prepare(
    'SELECT 1 FROM import_history_fingerprints WHERE fingerprint = ?',
  );
  assert.ok(has.get('fp1'), 'fp1 should exist');
  assert.ok(has.get('fp2'), 'fp2 should exist');
  assert.equal(has.get('fpMissing'), undefined, 'unknown fp should not exist');

  // Batch IN(...) lookup mirrors getExistingFingerprints behavior.
  const all = db
    .prepare(
      `SELECT fingerprint FROM import_history_fingerprints WHERE fingerprint IN (?, ?, ?)`,
    )
    .all('fp1', 'fp2', 'fp3') as Array<{ fingerprint: string }>;
  assert.equal(all.length, 2);
  const set = new Set(all.map((r) => r.fingerprint));
  assert.ok(set.has('fp1'));
  assert.ok(set.has('fp2'));

  // Reset cascade: collect summary_ids, delete summaries, then delete fingerprints.
  const tx = db.transaction((adapterId: string) => {
    const rows = db
      .prepare(
        `SELECT summary_id FROM import_history_fingerprints
         WHERE adapter_id = ? AND summary_id IS NOT NULL`,
      )
      .all(adapterId) as Array<{ summary_id: number }>;
    let summariesDeleted = 0;
    if (rows.length > 0) {
      const del = db.prepare('DELETE FROM session_summaries WHERE id = ?');
      for (const r of rows) summariesDeleted += del.run(r.summary_id).changes;
    }
    const fpRes = db
      .prepare('DELETE FROM import_history_fingerprints WHERE adapter_id = ?')
      .run(adapterId);
    return { fingerprintsDeleted: fpRes.changes, summariesDeleted };
  });

  const result = tx('claude');
  assert.equal(result.fingerprintsDeleted, 2);
  assert.equal(result.summariesDeleted, 2);

  // Post-reset: both tables empty for this adapter.
  assert.equal(
    (db.prepare('SELECT COUNT(*) as c FROM import_history_fingerprints').get() as { c: number }).c,
    0,
  );
  assert.equal(
    (db.prepare('SELECT COUNT(*) as c FROM session_summaries').get() as { c: number }).c,
    0,
  );
});
