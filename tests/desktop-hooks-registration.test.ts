import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeIsRegistered, isCodebuddyMemHook } from '../desktop/src/shared/hooks-config.js';

const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PreCompact', 'SessionEnd'];
function config(command: string) {
  return { hooks: Object.fromEntries(events.map(event => [event, [
    { hooks: [{ type: 'command', command: `${command} ${event}` }] },
    { hooks: [{ type: 'command', command: 'python3 other-hook.py' }] },
  ]])) };
}

test('restored legacy Claude hooks are owned for cleanup but require re-registration', () => {
  const command = '"/missing/.codebuddy-mem/hooks/cbmem-claude-hook.sh"';
  assert.equal(isCodebuddyMemHook({ command }), true);
  assert.equal(computeIsRegistered('claude-code', config(command)), false);
});

test('registration tracks whether the configured wrapper can actually execute', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentmemory-registration-'));
  const wrapper = join(dir, 'agentmemory-claude-hook.sh');
  const settings = config(`"${wrapper}"`);
  try {
    assert.equal(computeIsRegistered('claude-code', settings), false);
    writeFileSync(wrapper, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    assert.equal(computeIsRegistered('claude-code', settings), true);
    if (process.platform !== 'win32') {
      chmodSync(wrapper, 0o644);
      assert.equal(computeIsRegistered('claude-code', settings), false);
      chmodSync(wrapper, 0o755);
    }
    delete (settings.hooks as Record<string, unknown>).Stop;
    assert.equal(computeIsRegistered('claude-code', settings), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a third-party command cannot make a dead memory hook look healthy', () => {
  const settings = config('"/missing/agentmemory-claude-hook.sh"');
  settings.hooks.Stop[0].hooks.push({ type: 'command', command: process.execPath });
  assert.equal(computeIsRegistered('claude-code', settings), false);
});
