import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';
import {
  readLastAssistantMessage,
  readLastImageTurnAssistantMessage,
  readLastUserMessage,
} from '../src/shared/transcript-parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FX = (name: string) => resolve(__dirname, 'fixtures/transcripts', name);

test('readLastAssistantMessage: plain text', () => {
  const msg = readLastAssistantMessage(FX('text-only.jsonl'));
  assert.ok(msg, 'should return message');
  assert.equal(msg!.text, 'Hi there! How can I help?');
  assert.equal(msg!.hasImages, false);
  assert.deepEqual(msg!.imageRefs, []);
  assert.deepEqual(msg!.toolUses, []);
});

test('readLastAssistantMessage: image-describing assistant turn', () => {
  const msg = readLastAssistantMessage(FX('with-images.jsonl'));
  assert.ok(msg);
  assert.match(msg!.text, /TypeError/);
  // assistant turn itself has no image block; user turn does — parser must only
  // look at ASSISTANT content for hasImages flag
  assert.equal(msg!.hasImages, false);
});

test('readLastUserMessage: detects image attachments from user turn', () => {
  const msg = readLastUserMessage(FX('with-images.jsonl'));
  assert.ok(msg);
  assert.match(msg!.text, /screenshot/);
  assert.equal(msg!.attachments.length, 1);
  assert.equal(msg!.attachments[0].type, 'image');
});

test('readLastAssistantMessage: tool_use extracted', () => {
  const msg = readLastAssistantMessage(FX('with-tool-use.jsonl'));
  assert.ok(msg);
  assert.equal(msg!.text, "I'll list them.");
  assert.equal(msg!.toolUses.length, 1);
  assert.equal(msg!.toolUses[0].name, 'Bash');
});

test('readLastAssistantMessage: skips corrupt lines', () => {
  const msg = readLastAssistantMessage(FX('corrupt.jsonl'));
  assert.ok(msg);
  assert.match(msg!.text, /Parsed despite/);
});

test('readLastAssistantMessage: empty file returns null', () => {
  const msg = readLastAssistantMessage(FX('empty.jsonl'));
  assert.equal(msg, null);
});

test('readLastAssistantMessage: missing file returns null', () => {
  const msg = readLastAssistantMessage(FX('nonexistent.jsonl'));
  assert.equal(msg, null);
});

test('readLastAssistantMessage: honors maxBytes cap', () => {
  // fixture is small; pass a tiny cap — parser should still return null or a valid shape
  const msg = readLastAssistantMessage(FX('text-only.jsonl'), { maxBytes: 10 });
  assert.ok(msg === null || typeof msg.text === 'string');
});

test('readLastAssistantMessage: handles UTF-8 BOM at file start', () => {
  const msg = readLastAssistantMessage(FX('bom.jsonl'));
  assert.ok(msg, 'should parse BOM-prefixed JSONL');
  assert.equal(msg!.text, 'bom ok');
});

test('readLastAssistantMessage: handles Windows-style backslash path', () => {
  // Build the fixture path with backslashes; Node should still resolve it on any platform
  // because forward-slash paths work everywhere and backslash is normalized on Windows.
  // On POSIX this test is essentially a smoke test ensuring no throw.
  const backslashPath = FX('text-only.jsonl').replace(/\//g, '\\');
  // On POSIX systems, backslashes are valid filename chars, so the file won't exist.
  // Guard: only assert the non-throw behavior. On Windows the msg should parse.
  let msg = null;
  try {
    msg = readLastAssistantMessage(backslashPath);
  } catch {
    assert.fail('readLastAssistantMessage should not throw on backslash path');
  }
  // If on Windows, msg will parse; if on POSIX, msg will be null — either is acceptable.
  assert.ok(msg === null || typeof msg.text === 'string');
});

test('readLastAssistantMessage: maxBytes truncation returns last complete JSON line only', () => {
  // Build a fixture with 3 lines; size is known; set maxBytes so that we only read
  // enough to cover the last line + trailing fragment of the middle line.
  const tmp = tmpdir();
  const path = join(tmp, 'm1-maxbytes-' + Date.now() + '.jsonl');
  const lineA = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } });
  const lineB = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'middle' }] } });
  const lineC = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'last' }] } });
  writeFileSync(path, `${lineA}\n${lineB}\n${lineC}\n`);

  // maxBytes sized to cover lineC + a truncated slice of lineB.
  // The parser must discard the truncated slice and return lineC's text.
  const maxBytes = lineC.length + 20; // ~20 bytes of middle-line remainder
  const msg = readLastAssistantMessage(path, { maxBytes });
  assert.ok(msg, 'should return a message');
  assert.equal(msg!.text, 'last', 'should return last complete line, not truncated middle');
});

test('readLastImageTurnAssistantMessage: returns assistant discussion after latest image user turn', () => {
  const tmp = tmpdir();
  const path = join(tmp, 'image-turn-' + Date.now() + '.jsonl');
  const lines = [
    { role: 'user', message: { content: [{ type: 'text', text: '[Image #5]\n<user_query>\n\n</user_query>' }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: '我看到了提交列表，作者是 minusjiang。' }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: '已完成 amend 和 push。' }] } },
  ];
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

  const turn = readLastImageTurnAssistantMessage(path);
  assert.ok(turn, 'should find latest image turn');
  assert.match(turn!.user.text, /\[Image #5\]/);
  assert.match(turn!.assistant.text, /提交列表，作者是 minusjiang/);
  assert.match(turn!.assistant.text, /已完成 amend 和 push/);
});
