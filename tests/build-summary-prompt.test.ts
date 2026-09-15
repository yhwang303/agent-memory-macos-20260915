import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummaryPrompt } from '../src/sdk/prompts.js';

test('buildSummaryPrompt includes Agent Last Response when set', () => {
  const p = buildSummaryPrompt({
    id: 0, memory_session_id: 'm', project: 'p',
    user_prompt: 'fix the bug',
    last_assistant_message: 'The screenshot shows a TypeError at line 42.',
    observations: [],
  });
  assert.match(p, /Agent's Last Response/);
  assert.match(p, /TypeError at line 42/);
});

test('buildSummaryPrompt omits section when last_assistant_message empty', () => {
  const p = buildSummaryPrompt({
    id: 0, memory_session_id: 'm', project: 'p',
    user_prompt: 'fix the bug',
    observations: [],
  });
  assert.doesNotMatch(p, /Agent's Last Response/);
});

test('buildSummaryPrompt omits section when last_assistant_message is empty string', () => {
  const p = buildSummaryPrompt({
    id: 0, memory_session_id: 'm', project: 'p',
    user_prompt: 'fix',
    last_assistant_message: '',
    observations: [],
  });
  assert.doesNotMatch(p, /Agent's Last Response/);
});

test('buildSummaryPrompt truncates at 2000 chars', () => {
  const long = 'x'.repeat(5000);
  const p = buildSummaryPrompt({
    id: 0, memory_session_id: 'm', project: 'p',
    user_prompt: 'u', last_assistant_message: long,
    observations: [],
  });
  const m = p.match(/x+/);
  assert.ok(m);
  assert.ok(m![0].length <= 2000, `expected <=2000 x's, got ${m![0].length}`);
});

test('buildSummaryPrompt preserves existing sections (user request + observations)', () => {
  const p = buildSummaryPrompt({
    id: 0, memory_session_id: 'm', project: 'p',
    user_prompt: 'fix the auth bug',
    last_assistant_message: 'I identified the issue.',
    observations: [
      { id: 1, type: 'shell', title: 'Ran tests', narrative: 'all pass' } as any,
    ],
  });
  assert.match(p, /fix the auth bug/);
  assert.match(p, /Ran tests/);
  assert.match(p, /Agent's Last Response/);
});
