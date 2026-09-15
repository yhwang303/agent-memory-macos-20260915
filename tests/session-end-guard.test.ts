import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_END_STALE_DURATION_MS,
  shouldSummarizeOnSessionEnd,
} from '../src/hooks-cli.js';

test('skips low-confidence lifecycle sessionEnd reasons', () => {
  for (const reason of ['other', 'user_close', 'window_close', 'aborted', 'error']) {
    const gate = shouldSummarizeOnSessionEnd({ reason, final_status: 'completed' }, 'cursor');
    assert.equal(gate.summarize, false, reason);
  }
});

test('skips stale completed sessionEnd events', () => {
  const gate = shouldSummarizeOnSessionEnd({
    reason: 'completed',
    duration_ms: SESSION_END_STALE_DURATION_MS + 1,
  }, 'codebuddy-ide');

  assert.equal(gate.summarize, false);
});

test('allows explicit fresh completion as fallback', () => {
  const gate = shouldSummarizeOnSessionEnd({
    reason: 'completed',
    duration_ms: 30_000,
  }, 'claude-code');

  assert.equal(gate.summarize, true);
});

