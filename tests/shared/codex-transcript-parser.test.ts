import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLastAssistantMessage } from '../../src/shared/transcript-parser.js';

test('readLastAssistantMessage parses Codex rollout response_item lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rollout-'));
  const file = path.join(dir, 'rollout.jsonl');
  const lines = [
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'hello from codex' }],
      },
    }),
  ];
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  const msg = readLastAssistantMessage(file);
  assert.equal(msg?.text, 'hello from codex');
  fs.rmSync(dir, { recursive: true, force: true });
});
