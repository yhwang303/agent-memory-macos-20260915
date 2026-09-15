/**
 * Per-session import logic tests.
 *
 * Covers:
 *   - collectSession aggregating multiple turns into one SessionData
 *   - computeSessionFingerprint stability + adapter/sessionId scoping
 *   - getHookCoverageWindow + hasHookSummaryNear (hook-overlap dedup)
 *
 * Uses an in-memory better-sqlite3 to exercise the actual SQL and avoid
 * touching the user's real ~/.agent-memory db.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  collectSession,
  computeSessionFingerprint,
  isSessionSubstantive,
} from '../src/services/import/turn-utils.js';
import {
  projectsOverlapForImport,
} from '../src/services/import/fingerprints.js';
import type {
  ImportAdapter,
  TranscriptFile,
  Turn,
} from '../src/services/import/types.js';

// Tiny stub adapter that yields canned turns.
class StubAdapter implements ImportAdapter {
  readonly id = 'claude' as const;
  readonly displayName = 'Stub';
  constructor(private turns: Turn[]) {}
  roots(): string[] { return []; }
  async discoverSessions() {
    return { adapterId: this.id, probedRoots: [], files: [] };
  }
  async *iterateTurns(_file: TranscriptFile): AsyncIterable<Turn> {
    for (const t of this.turns) yield t;
  }
}

function mkTurn(overrides: Partial<Turn>): Turn {
  return {
    adapterId: 'claude',
    fingerprint: 'fp-stub',
    filePath: '/tmp/x.jsonl',
    sessionId: 'sess-1',
    turnIndex: 0,
    userText: 'u',
    assistantText: 'a'.repeat(60),
    toolUses: [],
    cwd: 'D:/proj',
    startedAt: 1_700_000_000_000,
    ...overrides,
  };
}

test('collectSession aggregates turns + picks earliest/latest timestamps', async () => {
  const turns = [
    mkTurn({ turnIndex: 0, startedAt: 1_700_000_000_000, userText: 'first' }),
    mkTurn({ turnIndex: 1, startedAt: 1_700_000_500_000, userText: 'middle' }),
    mkTurn({ turnIndex: 2, startedAt: 1_700_000_900_000, userText: 'last' }),
  ];
  const adapter = new StubAdapter(turns);
  const session = await collectSession(adapter, {
    adapterId: 'claude',
    filePath: '/tmp/x.jsonl',
    sessionId: 'sess-aggregate',
    cwd: 'D:/proj',
    mtimeMs: 0,
  });
  assert.ok(session, 'session should not be null');
  assert.equal(session!.turns.length, 3);
  assert.equal(session!.firstTurnAtMs, 1_700_000_000_000);
  assert.equal(session!.lastTurnAtMs, 1_700_000_900_000);
  assert.equal(session!.sessionId, 'sess-aggregate');
  assert.equal(session!.cwd, 'D:/proj');
});

test('collectSession returns null for empty transcripts', async () => {
  const adapter = new StubAdapter([]);
  const session = await collectSession(adapter, {
    adapterId: 'claude',
    filePath: '/tmp/empty.jsonl',
    sessionId: 'sess-empty',
    cwd: null,
    mtimeMs: 0,
  });
  assert.equal(session, null);
});

test('computeSessionFingerprint: stable + scoped by (adapter, sessionId)', () => {
  const fp1 = computeSessionFingerprint('claude', 'abc');
  const fp2 = computeSessionFingerprint('claude', 'abc');
  assert.equal(fp1, fp2, 'same input ⇒ same fingerprint');

  const fp3 = computeSessionFingerprint('claude', 'def');
  assert.notEqual(fp1, fp3, 'different sessionId ⇒ different fingerprint');

  const fp4 = computeSessionFingerprint('cursor-agent', 'abc');
  assert.notEqual(fp1, fp4, 'different adapter ⇒ different fingerprint');
});

test('isSessionSubstantive: rejects empty / trivially short assistant content', async () => {
  const turnsTrivial = [mkTurn({ assistantText: 'ok' })];
  const session = await collectSession(new StubAdapter(turnsTrivial), {
    adapterId: 'claude',
    filePath: '/tmp/x.jsonl',
    sessionId: 's',
    cwd: null,
    mtimeMs: 0,
  });
  assert.ok(session);
  assert.equal(isSessionSubstantive(session!), false);

  const turnsReal = [
    mkTurn({
      assistantText: 'this is a real reply with several words to summarize',
    }),
  ];
  const sessionReal = await collectSession(new StubAdapter(turnsReal), {
    adapterId: 'claude',
    filePath: '/tmp/x.jsonl',
    sessionId: 's2',
    cwd: null,
    mtimeMs: 0,
  });
  assert.ok(sessionReal);
  assert.equal(isSessionSubstantive(sessionReal!), true);
});

test('hook-overlap window SQL: MIN/MAX correctly excludes imported:* rows', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT,
      project TEXT,
      created_at TEXT,
      created_at_epoch INTEGER,
      source_ide TEXT
    );
  `);

  const insert = db.prepare(
    "INSERT INTO session_summaries (memory_session_id, project, created_at_epoch, source_ide) VALUES (?, ?, ?, ?)",
  );
  // Three hook-captured rows
  insert.run('mem-1', 'D:/p', 1_700_000_000_000, null);
  insert.run('mem-2', 'D:/p', 1_700_001_000_000, 'claude-code');
  insert.run('mem-3', 'D:/p', 1_700_002_000_000, 'cursor');
  // Two imported rows (must be excluded by the window)
  insert.run('imp:claude:s1', 'D:/p', 1_600_000_000_000, 'imported:claude');
  insert.run('imp:claude:s2', 'D:/p', 1_800_000_000_000, 'imported:claude');

  const row = db
    .prepare(
      `SELECT MIN(created_at_epoch) AS min_ms, MAX(created_at_epoch) AS max_ms, COUNT(*) AS n
       FROM session_summaries
       WHERE source_ide IS NULL OR source_ide NOT LIKE 'imported:%'`,
    )
    .get() as { min_ms: number; max_ms: number; n: number };

  assert.equal(row.n, 3, 'imported rows must be excluded from coverage count');
  assert.equal(row.min_ms, 1_700_000_000_000);
  assert.equal(row.max_ms, 1_700_002_000_000);
});

test('hook-overlap project match: time window + lower-cased + slash-normalized path family', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT,
      created_at_epoch INTEGER,
      source_ide TEXT
    );
  `);
  const insert = db.prepare(
    'INSERT INTO session_summaries (project, created_at_epoch, source_ide) VALUES (?, ?, ?)',
  );
  // hook row at t=1000s, project = d:/agent-memory (already normalized)
  insert.run('d:/agent-memory', 1_700_000_000_000, 'claude-code');

  // Imported transcript candidate: timestamp 1 minute later, project D:\agent-memory
  // (uppercase + backslash). The overlap query normalizes both sides and
  // treats exact project paths as the same path family.
  const t = 1_700_000_060_000;
  const project = 'D:\\agent-memory';
  const normalized = project.replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
  const found = db
    .prepare(
      `SELECT project FROM session_summaries
       WHERE (source_ide IS NULL OR source_ide NOT LIKE 'imported:%')
         AND created_at_epoch BETWEEN ? AND ?
         AND project IS NOT NULL
         AND (
           lower(rtrim(replace(project, '\\', '/'), '/')) = ?
           OR lower(rtrim(replace(project, '\\', '/'), '/')) LIKE ?
           OR ? LIKE lower(rtrim(replace(project, '\\', '/'), '/')) || '/%'
         )
       LIMIT 1`,
    )
    .get(t - 4 * 60 * 60 * 1000, t + 4 * 60 * 60 * 1000, normalized, normalized + '/%', normalized);
  assert.ok(found, 'should find a hook row when project + time window match');

  const childNormalized = 'd:/agent-memory/desktop';
  const parentFound = db
    .prepare(
      `SELECT project FROM session_summaries
       WHERE (source_ide IS NULL OR source_ide NOT LIKE 'imported:%')
         AND created_at_epoch BETWEEN ? AND ?
         AND project IS NOT NULL
         AND (
           lower(rtrim(replace(project, '\\', '/'), '/')) = ?
           OR lower(rtrim(replace(project, '\\', '/'), '/')) LIKE ?
           OR ? LIKE lower(rtrim(replace(project, '\\', '/'), '/')) || '/%'
         )
       LIMIT 1`,
    )
    .get(t - 4 * 60 * 60 * 1000, t + 4 * 60 * 60 * 1000, childNormalized, childNormalized + '/%', childNormalized);
  assert.ok(parentFound, 'should find a hook row when hook project is parent of imported project');

  // Now query with a project that's clearly different — should NOT match.
  const otherNormalized = 'd:/some-other-project';
  const notFound = db
    .prepare(
      `SELECT project FROM session_summaries
       WHERE (source_ide IS NULL OR source_ide NOT LIKE 'imported:%')
         AND created_at_epoch BETWEEN ? AND ?
         AND project IS NOT NULL
         AND (
           lower(rtrim(replace(project, '\\', '/'), '/')) = ?
           OR lower(rtrim(replace(project, '\\', '/'), '/')) LIKE ?
           OR ? LIKE lower(rtrim(replace(project, '\\', '/'), '/')) || '/%'
         )
       LIMIT 1`,
    )
    .get(t - 4 * 60 * 60 * 1000, t + 4 * 60 * 60 * 1000, otherNormalized, otherNormalized + '/%', otherNormalized);
  assert.equal(notFound, undefined);

  // Same project but timestamp far outside window — must not match.
  const farFuture = 1_900_000_000_000;
  const notFoundTime = db
    .prepare(
      `SELECT project FROM session_summaries
       WHERE (source_ide IS NULL OR source_ide NOT LIKE 'imported:%')
         AND created_at_epoch BETWEEN ? AND ?
         AND project IS NOT NULL
         AND (
           lower(rtrim(replace(project, '\\', '/'), '/')) = ?
           OR lower(rtrim(replace(project, '\\', '/'), '/')) LIKE ?
           OR ? LIKE lower(rtrim(replace(project, '\\', '/'), '/')) || '/%'
         )
       LIMIT 1`,
    )
    .get(farFuture - 4 * 60 * 60 * 1000, farFuture + 4 * 60 * 60 * 1000, normalized, normalized + '/%', normalized);
  assert.equal(notFoundTime, undefined);
});

test('hook-overlap project match treats Codex parent and transcript child as same project', () => {
  assert.equal(
    projectsOverlapForImport(
      'c:/users/milkwang/documents/codex',
      'c:/users/milkwang/documents/codex/2026-06-16/cbm-c-home-db-list-c',
    ),
    true,
  );
  assert.equal(
    projectsOverlapForImport(
      'C:\\Users\\milkwang\\Documents\\Codex\\',
      'c:/users/milkwang/documents/codex/2026-06-16/cbm-c-home-db-list-c',
    ),
    true,
  );
  assert.equal(
    projectsOverlapForImport(
      'c:/users/milkwang/documents/codex-other',
      'c:/users/milkwang/documents/codex/2026-06-16/cbm-c-home-db-list-c',
    ),
    false,
  );
});
