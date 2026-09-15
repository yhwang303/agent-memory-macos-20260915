import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordAttachmentsMetadata } from '../src/hooks/attachments.js';

test('attachments recorded as user_attachments observation', async () => {
  const observations: any[] = [];
  const client = {
    addObservation: async (o: any) => { observations.push(o); },
  };
  await recordAttachmentsMetadata(
    {
      session_id: 's1',
      attachments: [
        { type: 'image', name: 'err.png', size: 1234 },
        { mime_type: 'image/jpeg', filename: 'ui.jpg' },
      ],
    },
    { client, projectPath: '/proj' }
  );
  const ua = observations.find(o => o.toolName === 'user_attachments');
  assert.ok(ua, 'user_attachments observation should be recorded');
  assert.equal(ua.toolInput.attachments.length, 2);
  assert.equal(ua.toolInput.attachments[0].type, 'image');
  assert.equal(ua.toolInput.attachments[0].name, 'err.png');
  assert.equal(ua.toolInput.attachments[0].size, 1234);
  assert.equal(ua.toolInput.attachments[1].type, 'image/jpeg');
  assert.equal(ua.toolInput.attachments[1].name, 'ui.jpg');
  assert.equal(ua.toolOutput.count, 2);
  assert.equal(ua.type, 'agent_response');
  assert.equal(ua.sessionId, 's1');
  assert.equal(ua.projectPath, '/proj');
});

test('no observation when attachments empty array', async () => {
  const observations: any[] = [];
  const client = { addObservation: async (o: any) => { observations.push(o); } };
  await recordAttachmentsMetadata(
    { session_id: 's1', attachments: [] },
    { client, projectPath: '/proj' }
  );
  assert.equal(observations.length, 0);
});

test('no observation when attachments absent', async () => {
  const observations: any[] = [];
  const client = { addObservation: async (o: any) => { observations.push(o); } };
  await recordAttachmentsMetadata(
    { session_id: 's1' },
    { client, projectPath: '/proj' }
  );
  assert.equal(observations.length, 0);
});

test('no observation for Cursor workspace rule attachments', async () => {
  const observations: any[] = [];
  const client = { addObservation: async (o: any) => { observations.push(o); } };
  await recordAttachmentsMetadata(
    {
      session_id: 's1',
      attachments: [
        { type: 'rule', file_path: 'D:\\agent-memory\\CLAUDE.md' },
        { type: 'rule', file_path: 'D:\\agent-memory\\AGENTS.md' },
      ],
    },
    { client, projectPath: '/proj', sourceIDE: 'cursor' }
  );
  assert.equal(observations.length, 0);
});

test('rule attachments are filtered while user files are still recorded', async () => {
  const observations: any[] = [];
  const client = { addObservation: async (o: any) => { observations.push(o); } };
  await recordAttachmentsMetadata(
    {
      session_id: 's1',
      attachments: [
        { type: 'rule', file_path: 'D:\\agent-memory\\AGENTS.md' },
        { type: 'image', file_path: 'D:\\screens\\bug.png' },
      ],
    },
    { client, projectPath: '/proj', sourceIDE: 'cursor' }
  );
  assert.equal(observations.length, 1);
  assert.equal(observations[0].toolInput.attachments.length, 1);
  assert.equal(observations[0].toolInput.attachments[0].name, 'bug.png');
});

test('no observation when session_id missing', async () => {
  const observations: any[] = [];
  const client = { addObservation: async (o: any) => { observations.push(o); } };
  await recordAttachmentsMetadata(
    { attachments: [{ type: 'image', name: 'x.png' }] } as any,
    { client, projectPath: '/proj' }
  );
  assert.equal(observations.length, 0);
});

test('falls back to conversation_id when session_id absent', async () => {
  const observations: any[] = [];
  const client = { addObservation: async (o: any) => { observations.push(o); } };
  await recordAttachmentsMetadata(
    { conversation_id: 'c1', attachments: [{ type: 'image', name: 'a.png' }] } as any,
    { client, projectPath: '/proj' }
  );
  assert.equal(observations.length, 1);
  assert.equal(observations[0].sessionId, 'c1');
});

test('handles missing name/type with sensible defaults', async () => {
  const observations: any[] = [];
  const client = { addObservation: async (o: any) => { observations.push(o); } };
  await recordAttachmentsMetadata(
    { session_id: 's1', attachments: [{ blob: true }] },
    { client, projectPath: '/proj' }
  );
  assert.equal(observations[0].toolInput.attachments[0].type, 'unknown');
  assert.equal(observations[0].toolInput.attachments[0].name, 'unnamed');
  assert.equal(observations[0].toolInput.attachments[0].size, undefined);
});

test('malformed payload with binary data is NOT recorded (privacy)', async () => {
  const observations: any[] = [];
  const client = { addObservation: async (o: any) => { observations.push(o); } };
  await recordAttachmentsMetadata(
    {
      session_id: 's1',
      attachments: [{ data: 'base64-blob-AAAABBBBCCCC', type: 'image' }],
    } as any,
    { client, projectPath: '/proj' }
  );
  assert.equal(observations.length, 1);
  const att = observations[0].toolInput.attachments[0];
  assert.equal(att.type, 'image');
  assert.equal('data' in att, false, 'binary data must not leak into observation');
});

test('truncation cap: over-large attachments list is capped at maxAttachments', async () => {
  const observations: any[] = [];
  const client = { addObservation: async (o: any) => { observations.push(o); } };
  const big = Array.from({ length: 100 }, (_, i) => ({ type: 'image', name: `f${i}.png` }));
  await recordAttachmentsMetadata(
    { session_id: 's1', attachments: big },
    { client, projectPath: '/proj' }
  );
  assert.equal(observations.length, 1);
  assert.equal(observations[0].toolInput.attachments.length, 64);
  assert.equal(observations[0].toolOutput.count, 100);
  assert.equal(observations[0].toolOutput.recorded, 64);
  assert.equal(observations[0].toolOutput.truncated, true);
});
