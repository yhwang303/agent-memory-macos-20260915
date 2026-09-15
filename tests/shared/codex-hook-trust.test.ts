import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  codexHookEntriesTrustedInConfig,
  codexHookStateKey,
  codexHookTrustedHash,
  codexStopHookTrustedHash,
  readCodexHookTrustEntries,
  trustCodexHookEntriesInConfig,
  versionForTomlIdentity,
} from '../../src/shared/codex-hook-trust.js';

test('codexStopHookTrustedHash is stable for a fixed command', () => {
  const cmd = '"C:\\Users\\test\\.agent-memory\\hooks\\agentmemory-codex-hook.cmd" Stop';
  const h1 = codexStopHookTrustedHash(cmd, 30);
  const h2 = codexStopHookTrustedHash(cmd, 30);
  assert.equal(h1, h2);
  assert.match(h1, /^sha256:[a-f0-9]{64}$/);
  assert.equal(h1, 'sha256:c49e17b22f21de564f84823742ec018d13639e316b85ba23fa0b78125e628680');
});

test('versionForTomlIdentity sorts object keys', () => {
  const a = versionForTomlIdentity({ z: 1, event_name: 'stop', hooks: [] });
  const b = versionForTomlIdentity({ event_name: 'stop', hooks: [], z: 1 });
  assert.equal(a, b);
});

test('codexHookTrustedHash supports non-Stop Codex hooks', () => {
  const cmd = '"C:\\Users\\test\\.agent-memory\\hooks\\agentmemory-codex-hook.cmd" post_tool_use';
  const hash = codexHookTrustedHash('post_tool_use', cmd, 10);
  assert.match(hash, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(hash, codexStopHookTrustedHash(cmd, 10));
});

test('codexHookStateKey lowercases event names and preserves hook indexes', () => {
  assert.equal(
    codexHookStateKey('C:\\Users\\test\\.codex\\hooks.json', 'post_tool_use', 2, 1),
    'C:\\Users\\test\\.codex\\hooks.json:post_tool_use:2:1',
  );
});

test('codexHookEntriesTrustedInConfig detects stale hook indexes', () => {
  const originalUserProfile = process.env.USERPROFILE;
  const originalHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-trust-'));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    const codexHome = path.join(home, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    const hooksPath = path.join(codexHome, 'hooks.json');
    const command = '"C:\\Users\\test\\.agent-memory\\hooks\\agentmemory-codex-hook.cmd" post_tool_use';
    fs.writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        post_tool_use: [
          { hooks: [{ type: 'command', command: '"C:\\agent\\observation.exe" PostToolUse', timeout: 30 }] },
          { hooks: [{ type: 'command', command, timeout: 10 }] },
        ],
      },
    }), 'utf8');

    const entries = readCodexHookTrustEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].groupIndex, 1);
    assert.equal(codexHookEntriesTrustedInConfig(entries), false);

    assert.equal(trustCodexHookEntriesInConfig(entries), true);
    assert.equal(codexHookEntriesTrustedInConfig(entries), true);

    const configPath = path.join(codexHome, 'config.toml');
    const staleKey = codexHookStateKey(hooksPath, 'post_tool_use', 0, 0);
    const staleHash = codexHookTrustedHash('post_tool_use', command, 10);
    const escapedStaleKey = staleKey.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    fs.writeFileSync(
      configPath,
      `[hooks.state."${escapedStaleKey}"]\ntrusted_hash = "${staleHash}"\n`,
      'utf8',
    );
    assert.equal(codexHookEntriesTrustedInConfig(entries), false);
  } finally {
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
