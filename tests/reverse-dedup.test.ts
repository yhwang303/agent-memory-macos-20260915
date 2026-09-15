/**
 * Reverse-dedup unit tests.
 *
 * Covers the hook-side cleanup that runs in WorkerService.handleSessionEnd
 * after a fresh hook summary is inserted. Hermetic: uses an in-memory
 * better-sqlite3 DB injected via the function's `db` param so we never
 * touch the user's real ~/.agent-memory store.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { reverseDedupAfterHookSummary } from '../src/services/import/reverse-dedup.js';

const SCHEMA = `
  CREATE TABLE session_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_session_id TEXT NOT NULL,
    project TEXT NOT NULL,
    request TEXT,
    created_at TEXT,
    created_at_epoch INTEGER,
    source_ide TEXT
  );
  CREATE TABLE import_history_fingerprints (
    fingerprint TEXT PRIMARY KEY,
    adapter_id  TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    turn_index  INTEGER NOT NULL,
    summary_id  INTEGER,
    imported_at INTEGER NOT NULL
  );
`;

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

function insertImportedRow(
  db: Database.Database,
  memId: string,
  project: string,
  createdAt: number,
  sourceIde = 'imported:claude',
  adapterId = 'claude',
): number {
  const res = db
    .prepare(
      `INSERT INTO session_summaries
       (memory_session_id, project, request, created_at, created_at_epoch, source_ide)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(memId, project, 'imported req', new Date(createdAt).toISOString(), createdAt, sourceIde);
  db.prepare(
    `INSERT INTO import_history_fingerprints
       (fingerprint, adapter_id, file_path, turn_index, summary_id, imported_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    `fp-${memId}`,
    adapterId,
    'fake.jsonl',
    Number(memId.split(':t')[1] ?? 0),
    res.lastInsertRowid,
    createdAt,
  );
  return res.lastInsertRowid as number;
}

function insertHookRow(
  db: Database.Database,
  memId: string,
  project: string,
  createdAt: number,
): number {
  const res = db
    .prepare(
      `INSERT INTO session_summaries
         (memory_session_id, project, request, created_at, created_at_epoch, source_ide)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    )
    .run(memId, project, 'hook req', new Date(createdAt).toISOString(), createdAt);
  return res.lastInsertRowid as number;
}

function makeJsonl(turnCount: number, sid = '00000000-0000-0000-0000-test1234abcd'): string {
  const dir = mkdtempSync(join(tmpdir(), 'rd-test-'));
  const file = join(dir, `${sid}.jsonl`);
  const lines: string[] = [];
  for (let i = 0; i < turnCount; i++) {
    lines.push(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: `prompt ${i}` },
      timestamp: new Date(1700000000000 + i * 60000).toISOString(),
      cwd: 'D:\\proj',
      sessionId: sid,
    }));
    lines.push(JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: `reply ${i}` }] },
      timestamp: new Date(1700000000000 + i * 60000 + 30000).toISOString(),
      cwd: 'D:\\proj',
      sessionId: sid,
    }));
  }
  writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

function makeCodexJsonl(turnCount: number, sid = '019ec9e6-3233-7e30-9dfb-b3916f23aad1'): string {
  const dir = mkdtempSync(join(tmpdir(), 'rd-test-codex-'));
  const file = join(dir, `rollout-2026-06-16T01-00-00-${sid}.jsonl`);
  const lines: string[] = [
    JSON.stringify({
      timestamp: '2026-06-16T01:00:00.000Z',
      type: 'session_meta',
      payload: { id: sid, timestamp: '2026-06-16T01:00:00.000Z', cwd: 'D:\\proj' },
    }),
  ];
  for (let i = 0; i < turnCount; i++) {
    lines.push(JSON.stringify({
      timestamp: new Date(1781571600000 + i * 60000).toISOString(),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `prompt ${i}` }],
      },
    }));
    lines.push(JSON.stringify({
      timestamp: new Date(1781571600000 + i * 60000 + 30000).toISOString(),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: `reply ${i}` }],
      },
    }));
  }
  writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

test('reverse-dedup: removes imported row matching last turn index when hook fires', () => {
  const db = freshDb();
  const sid = '00000000-0000-0000-0000-test1234abcd';
  const file = makeJsonl(3, sid);

  // Pre-existing imported row for THIS turn (the bug scenario)
  const importedId = insertImportedRow(db, `imp:claude:${sid}:t2`, 'D:/proj', 1700000120000);
  // Other imported rows for OTHER turns of same session — these must be preserved
  const survivor1 = insertImportedRow(db, `imp:claude:${sid}:t0`, 'D:/proj', 1700000000000);
  const survivor2 = insertImportedRow(db, `imp:claude:${sid}:t1`, 'D:/proj', 1700000060000);
  // Imported row for a totally different session — must be preserved
  const otherSid = insertImportedRow(db, 'imp:claude:OTHER-SID:t2', 'D:/proj', 1700000120000);
  // Hook just inserted its own row for this turn
  const hookId = insertHookRow(db, 'mem-12345-abc', 'D:/proj', 1700000180000);

  const result = reverseDedupAfterHookSummary({
    transcriptPath: file,
    hookSummaryId: hookId,
    db,
  });

  assert.deepEqual(result.deletedSummaryIds, [importedId],
    'should delete exactly the imported row matching last turn index');
  assert.equal(result.deletedFingerprints, 1, 'companion fingerprint cleaned');

  // Verify DB state
  const remaining = db
    .prepare('SELECT id FROM session_summaries ORDER BY id')
    .all()
    .map((r: any) => r.id);
  assert.deepEqual(remaining.sort((a, b) => a - b),
    [survivor1, survivor2, otherSid, hookId].sort((a, b) => a - b),
    'only the matching imported row should be deleted');

  // Fingerprint table state
  const fps = db
    .prepare('SELECT summary_id FROM import_history_fingerprints ORDER BY summary_id')
    .all()
    .map((r: any) => r.summary_id);
  assert.deepEqual(fps.sort((a, b) => a - b), [survivor1, survivor2, otherSid].sort((a, b) => a - b),
    'imported row\'s fingerprint should be gone, others preserved');

  rmSync(file, { force: true });
});

test('reverse-dedup: no-op when no transcript_path provided', () => {
  const db = freshDb();
  insertImportedRow(db, 'imp:claude:abc:t0', 'D:/proj', 1700000000000);
  const hookId = insertHookRow(db, 'mem-1', 'D:/proj', 1700000060000);

  const result = reverseDedupAfterHookSummary({
    transcriptPath: null,
    hookSummaryId: hookId,
    db,
  });

  assert.equal(result.deletedSummaryIds.length, 0);
  assert.equal(result.skipReason, 'no-transcript-path');
});

test('reverse-dedup: no-op for non-jsonl transcript path', () => {
  const db = freshDb();
  const hookId = insertHookRow(db, 'mem-1', 'D:/proj', 1700000060000);
  const result = reverseDedupAfterHookSummary({
    transcriptPath: 'C:/cb-ide/conv-1/index.json',
    hookSummaryId: hookId,
    db,
  });
  assert.equal(result.skipReason, 'unsupported-format');
});

test('reverse-dedup: no-op when transcript file missing', () => {
  const db = freshDb();
  const hookId = insertHookRow(db, 'mem-1', 'D:/proj', 1700000060000);
  const result = reverseDedupAfterHookSummary({
    transcriptPath: 'D:/does-not-exist-rd-test/nope.jsonl',
    hookSummaryId: hookId,
    db,
  });
  assert.equal(result.skipReason, 'file-missing');
});

test('reverse-dedup: no-op when no imported row matches', () => {
  const db = freshDb();
  const file = makeJsonl(2);
  const hookId = insertHookRow(db, 'mem-1', 'D:/proj', 1700000180000);
  const result = reverseDedupAfterHookSummary({
    transcriptPath: file,
    hookSummaryId: hookId,
    db,
  });
  assert.equal(result.skipReason, 'no-matching-imported-row');
  rmSync(file, { force: true });
});

test('reverse-dedup: removes Codex imported row using session_meta id, not rollout filename', () => {
  const db = freshDb();
  const sid = '019ec9e6-3233-7e30-9dfb-b3916f23aad1';
  const file = makeCodexJsonl(2, sid);

  const importedId = insertImportedRow(
    db,
    `imp:codex-cli:${sid}:t1`,
    'kepano-obsidian-skills-https-github-com',
    1781572513000,
    'imported:codex-cli',
    'codex-cli',
  );
  const survivor = insertImportedRow(
    db,
    `imp:codex-cli:${sid}:t0`,
    'D:/proj',
    1781571600000,
    'imported:codex-cli',
    'codex-cli',
  );
  const hookId = insertHookRow(db, 'mem-codex-live', 'D:/proj', 1781572729000);

  const result = reverseDedupAfterHookSummary({
    transcriptPath: file,
    hookSummaryId: hookId,
    db,
  });

  assert.deepEqual(result.deletedSummaryIds, [importedId]);
  assert.equal(result.deletedFingerprints, 1);

  const remaining = db
    .prepare('SELECT id FROM session_summaries ORDER BY id')
    .all()
    .map((r: any) => r.id);
  assert.deepEqual(remaining.sort((a, b) => a - b), [survivor, hookId].sort((a, b) => a - b));

  rmSync(file, { force: true });
});

test('reverse-dedup: skips meta lines when computing last turn index', () => {
  // If the jsonl has trailing isMeta / isCompactSummary lines, the last
  // REAL turn index must still be correctly computed. Locks the invariant
  // that reverse-dedup match criteria align with import-side turn indexing.
  const db = freshDb();
  const dir = mkdtempSync(join(tmpdir(), 'rd-test-meta-'));
  const sid = 'meta-sid';
  const file = join(dir, `${sid}.jsonl`);
  const lines = [
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'real prompt' },
      timestamp: '2026-06-09T07:08:41.554Z',
      sessionId: sid,
    }),
    // isMeta sidecar — must NOT count as a turn
    JSON.stringify({
      type: 'user',
      isMeta: true,
      message: { role: 'user', content: [{ type: 'text', text: '[Image: ...]' }] },
      timestamp: '2026-06-09T07:08:41.554Z',
      sessionId: sid,
    }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      timestamp: '2026-06-09T07:09:00.000Z',
      sessionId: sid,
    }),
  ];
  writeFileSync(file, lines.join('\n') + '\n', 'utf8');

  // Imported row was correctly written for turn 0 (single real turn)
  const importedId = insertImportedRow(db, `imp:claude:${sid}:t0`, 'D:/proj', 1700000000000);
  const hookId = insertHookRow(db, 'mem-1', 'D:/proj', 1700000060000);

  const result = reverseDedupAfterHookSummary({
    transcriptPath: file,
    hookSummaryId: hookId,
    db,
  });

  assert.deepEqual(result.deletedSummaryIds, [importedId],
    'last turn index should be 0 (meta line not counted), so imp:t0 matches and gets deleted');

  rmSync(file, { force: true });
});
