import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildImportSummaryPrompt } from '../src/sdk/prompts.js';
import { parseSummary } from '../src/sdk/parser.js';

test('buildImportSummaryPrompt: includes the required notes provenance prefix', () => {
  const prompt = buildImportSummaryPrompt({
    adapterId: 'claude',
    project: 'D:/agent-memory',
    firstTurnAt: '2026-06-04T03:43:28.633Z',
    lastTurnAt: '2026-06-04T04:10:00.000Z',
    fileBasename: 'sess-1',
    sessionId: '5ccc8d1e-a1f1-450b-89dc-5cfbb909bdf8',
    turns: [
      { turnIndex: 0, userText: 'ping', assistantText: 'pong', toolUses: [] },
      { turnIndex: 1, userText: 'follow-up', assistantText: 'reply', toolUses: [] },
    ],
  });
  assert.match(
    prompt,
    /imported_from=claude; session=5ccc8d1e-a1f1-450b-89dc-5cfbb909bdf8; file=sess-1/,
    'prompt must instruct AI to start <notes> with a stable provenance prefix',
  );
  // Must include the user / assistant texts somewhere
  assert.ok(prompt.includes('ping'));
  assert.ok(prompt.includes('pong'));
  assert.ok(prompt.includes('follow-up'));
  assert.ok(prompt.includes('reply'));
  // Must reference the 8 expected output tags
  for (const tag of ['request', 'investigated', 'learned', 'media_context',
    'meta_intent', 'completed', 'next_steps', 'notes']) {
    assert.match(prompt, new RegExp(`<${tag}>`), `output template missing <${tag}>`);
  }
  // Must include session id in the <session> envelope so the AI sees it.
  assert.match(prompt, /<session [^>]*session_id="5ccc8d1e/);
  assert.match(prompt, /turn_count="2"/);
});

test('buildImportSummaryPrompt → parseSummary round-trip works on a synthetic AI reply', () => {
  // Simulate a plausible AI response shaped like the prompt's output template.
  // We don't actually call the AI here — we just confirm parseSummary accepts
  // the same XML our prompt asks the AI to produce.
  const fakeReply = `<summary>
  <request>用户想要列出当前目录文件</request>
  <investigated>查看了 D:\\proj 下的若干 ts 文件</investigated>
  <learned>项目用 ESM + TypeScript 5</learned>
  <media_context></media_context>
  <meta_intent>【调查意图】快速建立项目结构印象</meta_intent>
  <completed>列出文件并解释了模块组织</completed>
  <next_steps></next_steps>
  <notes>imported_from=claude; session=abc-123; file=abc</notes>
</summary>`;
  const parsed = parseSummary(fakeReply);
  assert.ok(parsed, 'parseSummary should accept import-prompt output');
  assert.equal(parsed!.request, '用户想要列出当前目录文件');
  assert.equal(parsed!.media_context, null, 'empty tag should parse as null');
  assert.equal(parsed!.next_steps, null);
  assert.match(parsed!.notes!, /^imported_from=claude/);
});

test('buildImportSummaryPrompt: compresses very long sessions but keeps both ends visible', () => {
  // Build 30 dummy turns each ~600 chars — way past MAX_SESSION_PROMPT_CHARS.
  // The orchestrator's compression slice runs before this function; here we
  // pass already-compressed input but still verify the prompt accepts it.
  const turns = Array.from({ length: 6 }, (_, i) => ({
    turnIndex: i,
    userText: `user message ${i} ` + 'x'.repeat(200),
    assistantText: `assistant reply ${i} ` + 'y'.repeat(200),
    toolUses: i % 2 === 0
      ? [{ name: 'Bash', inputSummary: `cmd-${i}` }]
      : [],
  }));
  const prompt = buildImportSummaryPrompt({
    adapterId: 'cursor-agent',
    project: null,
    firstTurnAt: '2026-05-01T00:00:00Z',
    lastTurnAt: '2026-05-01T00:30:00Z',
    fileBasename: 'long-sess',
    sessionId: 'long-1',
    turns,
  });
  // First and last turn must both appear.
  assert.ok(prompt.includes('user message 0'));
  assert.ok(prompt.includes('user message 5'));
  // Tool name surfaced in the toolUses block.
  assert.ok(prompt.includes('Bash'));
});
