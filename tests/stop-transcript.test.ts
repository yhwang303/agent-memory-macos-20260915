import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordStopTranscript } from '../src/hooks/stop-transcript.js';

function writeTranscript(name: string, lines: string[]): string {
  const dir = join(tmpdir(), 'm1-stop-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
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

test('records agent_response + updates session field for claude-code', async () => {
  const path = writeTranscript('t.jsonl', [
    JSON.stringify({ type: 'user', message: { content: 'question' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'The screenshot shows a TypeError at line 42.' }] } }),
  ]);
  const client = makeClient();
  const ok = await recordStopTranscript(
    { session_id: 's1', transcript_path: path, reason: 'stop' },
    { client, projectPath: '/proj', adapterId: 'claude-code', now: () => 1700000000000 }
  );
  assert.equal(ok, true);
  assert.equal(client.observations.length, 1);
  const obs = client.observations[0];
  assert.equal(obs.type, 'agent_response');
  assert.equal(obs.toolName, 'agent_response');
  assert.equal(obs.toolInput.source, 'transcript');
  assert.match(obs.toolOutput.response, /TypeError/);
  assert.equal(obs.sessionId, 's1');
  assert.equal(obs.projectPath, '/proj');
  assert.equal(obs.timestamp, 1700000000000);
  // 现在 Stop 会同时回填 last_assistant_message 与 user_prompt（当轮用户消息）
  assert.equal(client.fieldUpdates.length, 2);
  const lastMsg = client.fieldUpdates.find((u: any) => u.f === 'last_assistant_message');
  assert.ok(lastMsg, 'last_assistant_message update should exist');
  assert.equal(lastMsg.sid, 's1');
  assert.match(lastMsg.v, /TypeError/);
  const userPrompt = client.fieldUpdates.find((u: any) => u.f === 'user_prompt');
  assert.ok(userPrompt, 'user_prompt update should exist');
  assert.equal(userPrompt.sid, 's1');
  assert.equal(userPrompt.v, 'question');
});

test('works for claude-internal adapter', async () => {
  const path = writeTranscript('t.jsonl', [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }),
  ]);
  const client = makeClient();
  const ok = await recordStopTranscript(
    { session_id: 's1', transcript_path: path },
    { client, projectPath: '/p', adapterId: 'claude-internal' }
  );
  assert.equal(ok, true);
  assert.equal(client.observations.length, 1);
});

test('records transcript for cursor adapter (M3: now transcript-capable)', async () => {
  const path = writeTranscript('t.jsonl', [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }),
  ]);
  const client = makeClient();
  const ok = await recordStopTranscript(
    { session_id: 's1', transcript_path: path },
    { client, projectPath: '/p', adapterId: 'cursor' }
  );
  assert.equal(ok, true);
  assert.equal(client.observations.length, 1);
});

test('can update transcript fields without recording duplicate observation', async () => {
  const path = writeTranscript('t.jsonl', [
    JSON.stringify({ type: 'user', message: { content: 'question' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'final answer' }] } }),
  ]);
  const client = makeClient();
  const ok = await recordStopTranscript(
    { session_id: 's1', transcript_path: path, reason: 'stop' },
    { client, projectPath: '/p', adapterId: 'cursor' },
    { recordObservation: false }
  );
  assert.equal(ok, true);
  assert.equal(client.observations.length, 0);
  assert.ok(client.fieldUpdates.find((u: any) => u.f === 'last_assistant_message'));
  assert.ok(client.fieldUpdates.find((u: any) => u.f === 'user_prompt'));
});

test('returns false when transcript_path missing', async () => {
  const client = makeClient();
  const ok = await recordStopTranscript(
    { session_id: 's1' },
    { client, projectPath: '/p', adapterId: 'claude-code' }
  );
  assert.equal(ok, false);
  assert.equal(client.observations.length, 0);
});

test('returns false when transcript file missing', async () => {
  const client = makeClient();
  const ok = await recordStopTranscript(
    { session_id: 's1', transcript_path: '/absolutely/nowhere.jsonl' },
    { client, projectPath: '/p', adapterId: 'claude-code' }
  );
  assert.equal(ok, false);
});

test('returns false when assistant text is empty', async () => {
  const path = writeTranscript('t.jsonl', [
    JSON.stringify({ type: 'user', message: { content: 'only user' } }),
  ]);
  const client = makeClient();
  const ok = await recordStopTranscript(
    { session_id: 's1', transcript_path: path },
    { client, projectPath: '/p', adapterId: 'claude-code' }
  );
  assert.equal(ok, false);
});

test('returns false without session_id or conversation_id', async () => {
  const path = writeTranscript('t.jsonl', [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }),
  ]);
  const client = makeClient();
  const ok = await recordStopTranscript(
    { transcript_path: path },
    { client, projectPath: '/p', adapterId: 'claude-code' }
  );
  assert.equal(ok, false);
});

test('falls back to conversation_id when session_id missing', async () => {
  const path = writeTranscript('t.jsonl', [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }),
  ]);
  const client = makeClient();
  const ok = await recordStopTranscript(
    { conversation_id: 'c1', transcript_path: path },
    { client, projectPath: '/p', adapterId: 'claude-code' }
  );
  assert.equal(ok, true);
  assert.equal(client.observations[0].sessionId, 'c1');
});

test('truncates long assistant text to 8000 chars in observation', async () => {
  const longText = 'x'.repeat(20000);
  const path = writeTranscript('t.jsonl', [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: longText }] } }),
  ]);
  const client = makeClient();
  await recordStopTranscript(
    { session_id: 's1', transcript_path: path },
    { client, projectPath: '/p', adapterId: 'claude-code' }
  );
  assert.ok(client.observations[0].toolOutput.response.length <= 8005); // 8000 + '...'
  assert.ok(client.fieldUpdates[0].v.length <= 4005);
});

test('continues even when updateSessionField throws (observation still recorded)', async () => {
  const path = writeTranscript('t.jsonl', [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }),
  ]);
  const client = {
    observations: [] as any[],
    addObservation: async function (o: any) { this.observations.push(o); return { success: true }; },
    updateSessionField: async () => { throw new Error('server down'); },
  };
  const ok = await recordStopTranscript(
    { session_id: 's1', transcript_path: path },
    { client: client as any, projectPath: '/p', adapterId: 'claude-code' }
  );
  assert.equal(ok, true);
  assert.equal(client.observations.length, 1);
});

test('image_refs capped at 10', async () => {
  const imgs = Array.from({ length: 15 }, (_, i) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png' } }));
  const path = writeTranscript('t.jsonl', [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'seen' }, ...imgs] } }),
  ]);
  const client = makeClient();
  await recordStopTranscript(
    { session_id: 's1', transcript_path: path },
    { client, projectPath: '/p', adapterId: 'claude-code' }
  );
  assert.ok(client.observations[0].toolInput.image_refs.length <= 10);
  assert.equal(client.observations[0].toolInput.has_images, true);
});

test('accepts any adapter whose id starts with claude- (future-proof)', async () => {
  const path = writeTranscript('t.jsonl', [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
  ]);
  const client = makeClient();
  const ok = await recordStopTranscript(
    { session_id: 's1', transcript_path: path },
    { client, projectPath: '/p', adapterId: 'claude-enterprise-fork' }
  );
  assert.equal(ok, true);
  assert.equal(client.observations.length, 1);
});
