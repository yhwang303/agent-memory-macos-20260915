import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordPreCompactSnapshot } from '../src/hooks/pre-compact.js';

function writeTranscript(lines: string[]): string {
  const dir = join(tmpdir(), 'm1-pc-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 't.jsonl');
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

function makeClient() {
  const observations: any[] = [];
  const fieldUpdates: Array<{ sid: string; f: string; v: string }> = [];
  return {
    observations,
    fieldUpdates,
    addObservation: async (o: any) => { observations.push(o); return { success: true }; },
    updateSessionField: async (sid: string, f: string, v: string) => {
      fieldUpdates.push({ sid, f, v });
    },
  };
}

test('records pre_compact_snapshot with trigger=manual', async () => {
  const p = writeTranscript([
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'pre-compact content' }] } }),
  ]);
  const client = makeClient();
  const ok = await recordPreCompactSnapshot(
    { session_id: 's1', transcript_path: p, trigger: 'manual' },
    { client, projectPath: '/p', adapterId: 'claude-code', now: () => 1700000000000 }
  );
  assert.equal(ok, true);
  const snap = client.observations[0];
  assert.equal(snap.toolName, 'pre_compact_snapshot');
  assert.equal(snap.toolInput.trigger, 'manual');
  assert.equal(snap.toolInput.source, 'transcript');
  assert.match(snap.toolOutput.response, /pre-compact content/);
  assert.equal(snap.timestamp, 1700000000000);
});

test('defaults trigger to unknown when missing', async () => {
  const p = writeTranscript([
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }),
  ]);
  const client = makeClient();
  await recordPreCompactSnapshot(
    { session_id: 's1', transcript_path: p },
    { client, projectPath: '/p', adapterId: 'claude-code' }
  );
  assert.equal(client.observations[0].toolInput.trigger, 'unknown');
});

test('records snapshot for cursor adapter (M3: now transcript-capable)', async () => {
  const p = writeTranscript([
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }),
  ]);
  const client = makeClient();
  const ok = await recordPreCompactSnapshot(
    { session_id: 's1', transcript_path: p },
    { client, projectPath: '/p', adapterId: 'cursor' }
  );
  assert.equal(ok, true);
  assert.equal(client.observations.length, 1);
});

test('returns false when transcript missing', async () => {
  const client = makeClient();
  const ok = await recordPreCompactSnapshot(
    { session_id: 's1' },
    { client, projectPath: '/p', adapterId: 'claude-code' }
  );
  assert.equal(ok, false);
});

test('truncates to 16000 chars in observation (larger than Stop hook)', async () => {
  const long = 'x'.repeat(30000);
  const p = writeTranscript([
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: long }] } }),
  ]);
  const client = makeClient();
  await recordPreCompactSnapshot(
    { session_id: 's1', transcript_path: p },
    { client, projectPath: '/p', adapterId: 'claude-code' }
  );
  assert.ok(client.observations[0].toolOutput.response.length <= 16005);
  assert.ok(client.fieldUpdates[0].v.length <= 4005);
});

test('accepts claude-internal adapter', async () => {
  const p = writeTranscript([
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }),
  ]);
  const client = makeClient();
  const ok = await recordPreCompactSnapshot(
    { session_id: 's1', transcript_path: p },
    { client, projectPath: '/p', adapterId: 'claude-internal' }
  );
  assert.equal(ok, true);
});

test('continues when updateSessionField throws', async () => {
  const p = writeTranscript([
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
  ]);
  const client = {
    observations: [] as any[],
    addObservation: async function (o: any) { this.observations.push(o); return { success: true }; },
    updateSessionField: async () => { throw new Error('server down'); },
  };
  const ok = await recordPreCompactSnapshot(
    { session_id: 's1', transcript_path: p },
    { client: client as any, projectPath: '/p', adapterId: 'claude-code' }
  );
  assert.equal(ok, true);
  assert.equal(client.observations.length, 1);
});
