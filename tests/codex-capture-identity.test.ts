import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

test('native Codex hook and suffixed rollout watcher share one observation and summary', async (t) => {
  const dir = mkdtempSync(join(os.tmpdir(), 'codex-capture-identity-'));
  const homeMock = t.mock.method(os, 'homedir', () => dir);
  syncBuiltinESMExports();
  const { CodexTranscriptWatcher } = await import('../desktop/src/services/CodexTranscriptWatcher.js');
  const { SDKAgent } = await import('../src/services/worker/SDKAgent.js');
  const { getDatabase, closeDatabase } = await import('../src/services/sqlite/Database.js');
  const { createSession, getSessionByContentId } = await import('../src/services/sqlite/Sessions.js');
  try {
    const sid = '019ec9e6-3233-7e30-9dfb-b3916f23aad1';
    const file = join(dir, `rollout-2026-09-23T20-00-00-${sid}_another-thread.jsonl`);
    writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: sid } }) + '\n');
    const watcher = new CodexTranscriptWatcher({} as any) as any;
    const agent = new SDKAgent();
    let calls = 0;
    t.mock.method(agent as any, 'callAI', async () => {
      calls++;
      // Yield so both capture paths reach the guards before any row is stored.
      await new Promise(resolve => setImmediate(resolve));
      return '<observation><type>discovery</type><title>Hook lifecycle</title>'
        + '<narrative>The hooks record the completed assistant response.</narrative></observation>'
        + '<summary><request>Explain the hook lifecycle.</request>'
        + '<completed>Explained when capture events occur.</completed></summary>';
    });
    const ensureSession = (contentId: string) => {
      if (!getSessionByContentId(contentId)) {
        createSession({ content_session_id: contentId, memory_session_id: `mem-${contentId}`,
          project: '/test/codex', user_prompt: 'Explain the hook lifecycle.',
          started_at: new Date().toISOString(), status: 'active', source_ide: 'codex-cli',
        } as any);
      }
      return getSessionByContentId(contentId)!.memory_session_id!;
    };
    const mids = [ensureSession(sid), ensureSession(watcher.sessionIdFromTranscript(file))];
    const record = (memorySessionId: string) => agent.processObservation({
      memorySessionId, project: '/test/codex', toolName: 'agent_response',
      toolInput: { source: 'transcript' },
      toolOutput: { response: 'The hooks capture the completed assistant response and store it in memory.' },
      observationType: 'agent_response', sourceIde: 'codex-cli',
    });
    await Promise.all(mids.map(record));
    await Promise.all(mids.map(mid => agent.generateSummary(mid, '/test/codex', 'codex-cli')));
    // Replay after the first calls have completed must remain idempotent.
    await record(mids[1]);
    await agent.generateSummary(mids[1], '/test/codex', 'codex-cli');
    const db = getDatabase();
    for (const table of ['sdk_sessions', 'observations', 'session_summaries']) {
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n, 1, table);
    }
    assert.equal(calls, 2, 'one observation extraction and one summary generation');
    // A different real session is still distinct, even if its filename has a suffix.
    const other = join(dir, 'renamed.jsonl');
    writeFileSync(other, JSON.stringify({ type: 'session_meta', payload: { id: 'other-session' } }) + '\n');
    assert.notEqual(watcher.sessionIdFromTranscript(other), sid);
  } finally {
    closeDatabase();
    homeMock.mock.restore();
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});
