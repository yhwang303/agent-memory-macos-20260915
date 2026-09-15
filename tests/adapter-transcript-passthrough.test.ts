import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeCodeAdapter, ClaudeInternalAdapter } from '../src/adapters/claude-code.js';
import { CodeBuddyIDEAdapter } from '../src/adapters/codebuddy-ide.js';

test('claude-code: EVENT_MAP maps PreCompact to beforePreCompact', () => {
  const a = new ClaudeCodeAdapter();
  assert.equal(a.mapEventName('PreCompact'), 'beforePreCompact');
});

test('claude-code: generateHooksConfig registers PreCompact with 30s timeout', () => {
  const a = new ClaudeCodeAdapter();
  const cfg = a.generateHooksConfig('/path/to/cli.js', 'linux') as any;
  // cfg.hooks is an object keyed by event name in Claude Code settings format
  const hooks = cfg.hooks ?? cfg;
  const preCompact = hooks['PreCompact'];
  assert.ok(preCompact, 'PreCompact key should exist');
  // The shape depends on existing hooks structure; minimally verify registration
  const json = JSON.stringify(preCompact);
  assert.match(json, /30000/, 'timeout should be 30s');
});

test('claude-code: normalizeInput passes transcript_path through for Stop', () => {
  const a = new ClaudeCodeAdapter();
  const out = a.normalizeInput('stop', {
    session_id: 's1',
    reason: 'stop',
    transcript_path: '/tmp/t.jsonl',
    stop_hook_active: true,
  });
  assert.equal(out.transcript_path, '/tmp/t.jsonl');
  assert.equal(out.stop_hook_active, true);
});

test('claude-code: normalizeInput accepts transcriptPath alias', () => {
  const a = new ClaudeCodeAdapter();
  const out = a.normalizeInput('stop', { session_id: 's1', transcriptPath: '/tmp/t.jsonl' });
  assert.equal(out.transcript_path, '/tmp/t.jsonl');
});

test('claude-code: normalizeInput accepts transcript alias', () => {
  const a = new ClaudeCodeAdapter();
  const out = a.normalizeInput('stop', { session_id: 's1', transcript: '/tmp/t.jsonl' });
  assert.equal(out.transcript_path, '/tmp/t.jsonl');
});

test('claude-code: normalizeInput passes through for beforePreCompact', () => {
  const a = new ClaudeCodeAdapter();
  const out = a.normalizeInput('beforePreCompact', {
    session_id: 's1',
    transcript_path: '/tmp/t.jsonl',
    trigger: 'manual',
  });
  assert.equal(out.transcript_path, '/tmp/t.jsonl');
  assert.equal(out.trigger, 'manual');
});

test('claude-internal: inherits PreCompact mapping', () => {
  const a = new ClaudeInternalAdapter();
  assert.equal(a.mapEventName('PreCompact'), 'beforePreCompact');
});

test('claude-code: all three aliases present — snake_case wins', () => {
  const a = new ClaudeCodeAdapter();
  const out = a.normalizeInput('stop', {
    transcript_path: '/a', transcriptPath: '/b', transcript: '/c',
  });
  assert.equal(out.transcript_path, '/a');
});

test('codebuddy-ide: normalizeInput coalesces transcript_path for Stop', () => {
  const a = new CodeBuddyIDEAdapter();
  const out = a.normalizeInput('stop', { session_id: 's1', transcript_path: '/tmp/t.jsonl' });
  assert.equal(out.transcript_path, '/tmp/t.jsonl');
});

test('codebuddy-ide: normalizeInput accepts transcriptPath alias', () => {
  const a = new CodeBuddyIDEAdapter();
  const out = a.normalizeInput('stop', { transcriptPath: '/tmp/t.jsonl' });
  assert.equal(out.transcript_path, '/tmp/t.jsonl');
});

test('codebuddy-ide: normalizeInput accepts transcript alias', () => {
  const a = new CodeBuddyIDEAdapter();
  const out = a.normalizeInput('stop', { transcript: '/tmp/t.jsonl' });
  assert.equal(out.transcript_path, '/tmp/t.jsonl');
});
