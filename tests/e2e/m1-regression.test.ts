import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureMissingColumns } from '../../src/services/sqlite/Database.js';
import { updateSessionField } from '../../src/services/sqlite/sessions.js';
import { buildSummaryPrompt } from '../../src/sdk/prompts.js';
import { recordStopTranscript } from '../../src/hooks/stop-transcript.js';

/**
 * Black-box regression: simulate a Claude Code session with an image-describing
 * assistant turn. Ensure handleStop → buildSummaryPrompt preserves the image
 * semantics end-to-end.
 */

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  // Old-schema sdk_sessions (without the two new columns)
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
  // Run the auto-migration to add the new columns
  ensureMissingColumns(db);
  return db;
}

function writeTranscript(content: string): string {
  const dir = join(tmpdir(), 'm1-e2e-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'session.jsonl');
  writeFileSync(p, content);
  return p;
}

test('E2E: Claude Code image-describing session flows through to summary prompt', async () => {
  const db = makeDb();
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, user_prompt, started_at, started_at_epoch)
     VALUES ('s1', 'm1', 'proj', 'why is this error here', '2026-04-21', 0)`
  ).run();

  const transcriptPath = writeTranscript(
    `{"type":"user","message":{"content":[{"type":"text","text":"what does this error mean"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}}]}}\n` +
    `{"type":"assistant","message":{"content":[{"type":"text","text":"The screenshot shows \\"TypeError: cannot read property length of undefined\\" at index.ts line 42."}]}}\n`
  );

  // Capture-only client that ALSO writes to the test db for the session field
  const observations: any[] = [];
  const client = {
    addObservation: async (o: any) => { observations.push(o); return { success: true }; },
    updateSessionField: async (
      sid: string,
      f: 'last_assistant_message' | 'transcript_path',
      v: string
    ) => {
      updateSessionField(sid, f, v, db);
    },
  };

  // Simulate the T5 Stop-hook flow
  const recorded = await recordStopTranscript(
    { session_id: 'm1', transcript_path: transcriptPath, reason: 'stop' },
    { client, projectPath: '/proj', adapterId: 'claude-code' }
  );

  // 1. transcript path fired — observation recorded
  assert.equal(recorded, true);
  const ar = observations.find(o => o.type === 'agent_response' && o.toolName === 'agent_response');
  assert.ok(ar, 'agent_response observation should be recorded');
  assert.match(ar.toolOutput.response, /TypeError/);

  // 2. session row updated
  const row = db.prepare('SELECT last_assistant_message FROM sdk_sessions WHERE memory_session_id = ?').get('m1') as any;
  assert.ok(row.last_assistant_message, 'last_assistant_message should be populated');
  assert.match(row.last_assistant_message, /TypeError/);

  // 3. buildSummaryPrompt surfaces it
  const prompt = buildSummaryPrompt({
    id: 0,
    memory_session_id: 'm1',
    project: 'proj',
    user_prompt: 'why is this error here',
    last_assistant_message: row.last_assistant_message,
    observations: [],
  });
  assert.match(prompt, /Agent's Last Response/);
  assert.match(prompt, /TypeError/);
  assert.match(prompt, /index\.ts line 42/);
});

test('E2E: Cursor adapter now records transcript (M3 upgrade)', async () => {
  const transcriptPath = writeTranscript(
    `{"type":"assistant","message":{"content":[{"type":"text","text":"cursor transcript content"}]}}\n`
  );
  const observations: any[] = [];
  const client = {
    addObservation: async (o: any) => { observations.push(o); return { success: true }; },
    updateSessionField: async () => {},
  };
  const recorded = await recordStopTranscript(
    { session_id: 's2', transcript_path: transcriptPath },
    { client, projectPath: '/proj', adapterId: 'cursor' }
  );
  assert.equal(recorded, true);
  assert.equal(observations.length, 1);
  assert.match(observations[0].toolOutput.response, /cursor transcript content/);
});

test('E2E: Corrupt transcript + graceful fallback (no throw, no record)', async () => {
  const transcriptPath = writeTranscript('not json at all\nstill not json\n');
  const observations: any[] = [];
  const client = {
    addObservation: async (o: any) => { observations.push(o); },
    updateSessionField: async () => {},
  };
  const recorded = await recordStopTranscript(
    { session_id: 's3', transcript_path: transcriptPath },
    { client, projectPath: '/proj', adapterId: 'claude-code' }
  );
  assert.equal(recorded, false);
  assert.equal(observations.length, 0);
});

test('E2E: codebuddy-ide adapter is gated out even when transcript_path is present', async () => {
  // codebuddy-ide passes transcript_path through normalizeInput per §3.3,
  // but adapterEmitsTranscript('codebuddy-ide') returns false because its
  // transcript format is not guaranteed to be Claude Code JSONL. This test
  // pins that intentional behavior.
  const transcriptPath = writeTranscript(
    `{"type":"assistant","message":{"content":[{"type":"text","text":"should not be used"}]}}\n`
  );
  const observations: any[] = [];
  const client = {
    addObservation: async (o: any) => { observations.push(o); },
    updateSessionField: async () => {},
  };
  const recorded = await recordStopTranscript(
    { session_id: 's4', transcript_path: transcriptPath },
    { client, projectPath: '/proj', adapterId: 'codebuddy-ide' }
  );
  assert.equal(recorded, false);
  assert.equal(observations.length, 0);
});

test('E2E: Migration on old-schema DB adds new columns without data loss', () => {
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
      status TEXT NOT NULL DEFAULT 'active'
    )
  `);
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, project, user_prompt, started_at, started_at_epoch)
     VALUES ('existing', 'p', 'existing user prompt', '2026-04-21', 0)`
  ).run();

  ensureMissingColumns(db);

  // Old data preserved
  const row = db.prepare('SELECT * FROM sdk_sessions WHERE content_session_id = ?').get('existing') as any;
  assert.equal(row.user_prompt, 'existing user prompt');
  assert.equal(row.last_assistant_message, null);
  assert.equal(row.transcript_path, null);

  // New columns writable
  updateSessionField('existing', 'last_assistant_message', 'added after migration', db);
  const row2 = db.prepare('SELECT last_assistant_message FROM sdk_sessions WHERE content_session_id = ?').get('existing') as any;
  assert.equal(row2.last_assistant_message, 'added after migration');
});
