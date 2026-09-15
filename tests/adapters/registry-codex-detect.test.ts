import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAdapterByEvent } from '../../src/adapters/registry.js';

test('detectAdapterByEvent: Stop without Codex fields matches claude-code first', () => {
  const claudeLike = {
    hook_event_name: 'Stop',
    session_id: 's1',
    transcript_path: '/tmp/t.jsonl',
  };
  const matched = detectAdapterByEvent('Stop', claudeLike);
  assert.equal(matched?.id, 'claude-code');
});
