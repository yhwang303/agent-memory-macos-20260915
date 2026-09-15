import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adapterEmitsTranscript,
  truncate,
  recordTranscriptObservation,
  MAX_IMAGE_REFS,
  SESSION_FIELD_MAX_CHARS,
} from '../src/hooks/transcript-observation-common.js';

test('adapterEmitsTranscript: claude- prefix', () => {
  assert.equal(adapterEmitsTranscript('claude-code'), true);
  assert.equal(adapterEmitsTranscript('claude-internal'), true);
  assert.equal(adapterEmitsTranscript('claude-fork-xyz'), true);
  assert.equal(adapterEmitsTranscript('cursor'), true);
  assert.equal(adapterEmitsTranscript('codebuddy-ide'), true);
  assert.equal(adapterEmitsTranscript(''), false);
});

test('truncate: appends ellipsis when over limit', () => {
  assert.equal(truncate('hello', 10), 'hello');
  assert.equal(truncate('hello world', 5), 'hello...');
});

test('shared caps are the expected values', () => {
  assert.equal(MAX_IMAGE_REFS, 10);
  assert.equal(SESSION_FIELD_MAX_CHARS, 4000);
});

function makeMockClient() {
  const observations: any[] = [];
  const sessionFieldUpdates: Array<{ sid: string; field: string; value: string }> = [];
  return {
    observations,
    sessionFieldUpdates,
    addObservation: async (o: any) => {
      observations.push(o);
      return { success: true };
    },
    updateSessionField: async (sid: string, field: any, value: string) => {
      sessionFieldUpdates.push({ sid, field, value });
    },
  };
}

function writeTranscript(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), 't-obs-'));
  const path = join(dir, 't.jsonl');
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
  return path;
}

test('recordTranscriptObservation: has_images=true only when USER turn has image', async () => {
  const transcriptPath = writeTranscript([
    {
      role: 'user',
      message: {
        content: [
          { type: 'text', text: '[Image]\n<image_files>\n1. C:\\imgs\\a.png\n</image_files>\n<user_query>\n描述这张图\n</user_query>' },
        ],
      },
    },
    {
      role: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'This screenshot shows a Cursor chat interface.' },
        ],
      },
    },
  ]);

  const client = makeMockClient();
  const recorded = await recordTranscriptObservation(
    { session_id: 's1', transcript_path: transcriptPath },
    { client, projectPath: '/tmp/p', adapterId: 'cursor' },
    { toolName: 'stop_transcript', observationMaxChars: 2000, buildExtraInput: () => ({}) }
  );

  assert.equal(recorded, true);
  assert.equal(client.observations.length, 1, 'only one observation (agent_response)');
  const obs = client.observations[0];
  assert.equal(obs.type, 'agent_response');
  assert.equal(obs.toolInput.has_images, true, 'has_images true when user posted image');
});

test('recordTranscriptObservation: has_images=false when no images in user turn', async () => {
  const transcriptPath = writeTranscript([
    { role: 'user', message: { content: [{ type: 'text', text: '帮我修 bug' }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: '已修复 null 指针' }] } },
  ]);

  const client = makeMockClient();
  await recordTranscriptObservation(
    { session_id: 's1', transcript_path: transcriptPath },
    { client, projectPath: '/tmp/p', adapterId: 'cursor' },
    { toolName: 'stop_transcript', observationMaxChars: 2000, buildExtraInput: () => ({}) }
  );

  assert.equal(client.observations.length, 1);
  assert.equal(client.observations[0].toolInput.has_images, false, 'has_images false when no user image');
});

test('recordTranscriptObservation: has_images=false when only assistant mentions image vocab but user has no image', async () => {
  const transcriptPath = writeTranscript([
    { role: 'user', message: { content: [{ type: 'text', text: '帮我改一下代码' }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: '这张截图展示了一个架构图' }] } },
  ]);

  const client = makeMockClient();
  await recordTranscriptObservation(
    { session_id: 's1', transcript_path: transcriptPath },
    { client, projectPath: '/tmp/p', adapterId: 'cursor' },
    { toolName: 'stop_transcript', observationMaxChars: 2000, buildExtraInput: () => ({}) }
  );

  assert.equal(client.observations.length, 1);
  assert.equal(client.observations[0].toolInput.has_images, false,
    'has_images must be false — only user-posted images count');
});

test('recordTranscriptObservation: [USER_POSTED_IMAGE] prefix added when user turn has image', async () => {
  const transcriptPath = writeTranscript([
    {
      role: 'user',
      message: {
        content: [
          { type: 'text', text: '[Image]\n<image_files>\n1. a.png\n</image_files>\n<user_query>\n看下\n</user_query>' },
        ],
      },
    },
    { role: 'assistant', message: { content: [{ type: 'text', text: '好的' }] } },
  ]);

  const client = makeMockClient();
  await recordTranscriptObservation(
    { session_id: 's1', transcript_path: transcriptPath },
    { client, projectPath: '/tmp/p', adapterId: 'cursor' },
    { toolName: 'stop_transcript', observationMaxChars: 2000, buildExtraInput: () => ({}) }
  );

  const update = client.sessionFieldUpdates.find(u => u.field === 'last_assistant_message');
  assert.ok(update, 'session field update should exist');
  assert.ok(
    update!.value.startsWith('[USER_POSTED_IMAGE]\n\n'),
    'must prepend marker when user turn has image'
  );
});

test('recordTranscriptObservation: no prefix when user turn has no image', async () => {
  const transcriptPath = writeTranscript([
    { role: 'user', message: { content: [{ type: 'text', text: 'hi' }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
  ]);

  const client = makeMockClient();
  await recordTranscriptObservation(
    { session_id: 's1', transcript_path: transcriptPath },
    { client, projectPath: '/tmp/p', adapterId: 'cursor' },
    { toolName: 'stop_transcript', observationMaxChars: 2000, buildExtraInput: () => ({}) }
  );

  const update = client.sessionFieldUpdates.find(u => u.field === 'last_assistant_message');
  assert.ok(update, 'session field update should exist');
  assert.ok(
    !update!.value.includes('[USER_POSTED_IMAGE]'),
    'marker must NOT be present without user image'
  );
});

test('recordTranscriptObservation: image context uses assistant discussion after image, not only final assistant message', async () => {
  const transcriptPath = writeTranscript([
    {
      role: 'user',
      message: {
        content: [
          {
            type: 'text',
            text: '[Image]\n<image_files>\n1. commits.png\n</image_files>\n<user_query>\n\n</user_query>',
          },
        ],
      },
    },
    {
      role: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: '我看到了，历史提交列表里很多提交作者都是 minusjiang，用来确认提交身份。',
          },
        ],
      },
    },
    {
      role: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: '已完成提交并推送到远端，图片信息链路已验收 2.0.6。',
          },
        ],
      },
    },
  ]);

  const client = makeMockClient();
  await recordTranscriptObservation(
    { session_id: 's1', transcript_path: transcriptPath },
    { client, projectPath: '/tmp/p', adapterId: 'cursor' },
    { toolName: 'stop_transcript', observationMaxChars: 2000, buildExtraInput: () => ({}) }
  );

  const update = client.sessionFieldUpdates.find(u => u.field === 'last_assistant_message');
  assert.ok(update, 'session field update should exist');
  assert.ok(update!.value.startsWith('[USER_POSTED_IMAGE]\n\n'));
  assert.match(
    update!.value,
    /历史提交列表里很多提交作者都是 minusjiang/,
    'image context should include the assistant text that described what was seen in the image'
  );
  assert.match(
    client.observations[0].toolOutput.response,
    /历史提交列表里很多提交作者都是 minusjiang/,
    'observation raw response should also preserve image-related assistant discussion'
  );
});
