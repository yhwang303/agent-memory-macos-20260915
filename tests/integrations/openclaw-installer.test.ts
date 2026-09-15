import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenClawInstaller } from '../../src/services/integrations/OpenClawInstaller.js';

test('OpenClawInstaller has correct id and displayName', () => {
  const installer = new OpenClawInstaller();
  assert.equal(installer.id, 'openclaw');
  assert.equal(installer.displayName, 'OpenClaw Gateway');
  assert.equal(installer.mechanism, 'plugin');
});

test('OpenClawInstaller implements Integration interface', () => {
  const installer = new OpenClawInstaller();
  assert.equal(typeof installer.detect, 'function');
  assert.equal(typeof installer.install, 'function');
  assert.equal(typeof installer.uninstall, 'function');
  assert.equal(typeof installer.status, 'function');
  assert.equal(typeof installer.ensureUpToDate, 'function');
});

test('OpenClawInstaller.detect returns boolean', async () => {
  const installer = new OpenClawInstaller();
  const result = await installer.detect();
  assert.equal(typeof result, 'boolean');
});

test('OpenClawInstaller.status returns valid IntegrationStatus', async () => {
  const installer = new OpenClawInstaller();
  const status = await installer.status();
  assert.equal(typeof status.installed, 'boolean');
  assert.equal(typeof status.detected, 'boolean');
});

/**
 * ensureUpToDate 行为锁定：
 * 通过临时 HOME 目录 + 显式注入 OPENCLAW_HOME 替代是不可行的（实现里直接读 homedir()），
 * 所以这里只验「插件未部署」与「插件已是最新」两种 no-op 路径。
 * 「过期需重写」路径在 desktop 端的等价测试已覆盖，且已在 npm 端通过 staticAssertion 间接验证。
 */
function withTempHome<T>(fn: (homeDir: string) => T): T {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalDisable = process.env.AGENT_MEMORY_DISABLE_OPENCLAW_CLI;
  const tmp = mkdtempSync(join(tmpdir(), 'openclaw-installer-test-'));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  // Don't let ensureUpToDate touch the real OpenClaw gateway during tests.
  process.env.AGENT_MEMORY_DISABLE_OPENCLAW_CLI = '1';
  try {
    return fn(tmp);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalDisable === undefined) delete process.env.AGENT_MEMORY_DISABLE_OPENCLAW_CLI;
    else process.env.AGENT_MEMORY_DISABLE_OPENCLAW_CLI = originalDisable;
  }
}

test('ensureUpToDate skips when plugin is not deployed', () => {
  withTempHome(() => {
    const installer = new OpenClawInstaller();
    assert.equal(installer.ensureUpToDate(), false);
  });
});

test('ensureUpToDate skips when deployed plugin already has current version tag', () => {
  withTempHome((home) => {
    const pluginDir = join(home, '.openclaw', 'plugins', 'agent-memory');
    mkdirSync(pluginDir, { recursive: true });
    const indexPath = join(pluginDir, 'index.js');
    const stamped = '// AGENT_MEMORY_PLUGIN_VERSION=v2-session-end\n// rest does not matter\n';
    writeFileSync(indexPath, stamped, 'utf8');

    const installer = new OpenClawInstaller();
    assert.equal(installer.ensureUpToDate(), false);
    assert.equal(readFileSync(indexPath, 'utf8'), stamped, 'should not rewrite when up-to-date');
  });
});

test('ensureUpToDate rewrites plugin files when version tag is missing', () => {
  withTempHome((home) => {
    const pluginDir = join(home, '.openclaw', 'plugins', 'agent-memory');
    mkdirSync(pluginDir, { recursive: true });
    const indexPath = join(pluginDir, 'index.js');
    writeFileSync(indexPath, '// stale plugin without version tag\n', 'utf8');

    const installer = new OpenClawInstaller();
    const upgraded = installer.ensureUpToDate();
    assert.equal(upgraded, true, 'should report upgrade performed');

    const rewritten = readFileSync(indexPath, 'utf8');
    assert.match(rewritten, /AGENT_MEMORY_PLUGIN_VERSION=v2-session-end/);
    assert.match(rewritten, /api\.on\('message_received'/);
    assert.match(rewritten, /api\.on\('message_sent'/);
    assert.match(rewritten, /\/api\/session\/end/);
    assert.ok(existsSync(join(pluginDir, 'package.json')));
    assert.ok(existsSync(join(pluginDir, 'openclaw.plugin.json')));
    assert.ok(existsSync(join(pluginDir, 'config.json')));
  });
});
