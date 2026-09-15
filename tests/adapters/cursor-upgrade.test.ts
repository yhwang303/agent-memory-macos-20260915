import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CursorAdapter } from '../../src/adapters/cursor.js';
import { adapterEmitsTranscript } from '../../src/hooks/transcript-observation-common.js';

const adapter = new CursorAdapter();

// --- CursorAdapter event mapping ---

test('cursor: mapEventName returns identity for known events', () => {
  assert.equal(adapter.mapEventName('beforeSubmitPrompt'), 'beforeSubmitPrompt');
  assert.equal(adapter.mapEventName('afterShellExecution'), 'afterShellExecution');
  assert.equal(adapter.mapEventName('stop'), 'stop');
  assert.equal(adapter.mapEventName('sessionStart'), 'sessionStart');
  assert.equal(adapter.mapEventName('afterFileEdit'), 'afterFileEdit');
});

test('cursor: mapEventName returns null for unknown events', () => {
  assert.equal(adapter.mapEventName('UnknownEvent'), null);
  assert.equal(adapter.mapEventName('PostToolUse'), null);
});

// --- CursorAdapter.normalizeInput transcript coalescing ---

test('cursor: normalizeInput coalesces transcript_path on stop', () => {
  const out = adapter.normalizeInput('stop', { session_id: 's1', transcript_path: '/tmp/t.jsonl' });
  assert.equal(out.transcript_path, '/tmp/t.jsonl');
});

test('cursor: normalizeInput accepts transcriptPath alias on stop', () => {
  const out = adapter.normalizeInput('stop', { session_id: 's1', transcriptPath: '/tmp/t.jsonl' });
  assert.equal(out.transcript_path, '/tmp/t.jsonl');
});

test('cursor: normalizeInput pass-through for non-stop events', () => {
  const raw = { session_id: 's1', foo: 'bar' };
  const out = adapter.normalizeInput('beforeSubmitPrompt', raw);
  assert.deepEqual(out, raw);
  assert.equal(out, raw);
});

// --- adapterEmitsTranscript gate ---

test('adapterEmitsTranscript: cursor returns true', () => {
  assert.equal(adapterEmitsTranscript('cursor'), true);
});

test('adapterEmitsTranscript: claude-code returns true', () => {
  assert.equal(adapterEmitsTranscript('claude-code'), true);
});

test('adapterEmitsTranscript: claude-internal returns true', () => {
  assert.equal(adapterEmitsTranscript('claude-internal'), true);
});

test('adapterEmitsTranscript: gemini-cli returns true', () => {
  assert.equal(adapterEmitsTranscript('gemini-cli'), true);
});

test('adapterEmitsTranscript: codex-cli returns true', () => {
  assert.equal(adapterEmitsTranscript('codex-cli'), true);
});

test('adapterEmitsTranscript: opencode returns true', () => {
  assert.equal(adapterEmitsTranscript('opencode'), true);
});

test('adapterEmitsTranscript: windsurf returns false (not transcript-capable yet)', () => {
  assert.equal(adapterEmitsTranscript('windsurf'), false);
});

test('adapterEmitsTranscript: unknown-thing returns false', () => {
  assert.equal(adapterEmitsTranscript('unknown-thing'), false);
});
