import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAllIntegrations } from '../../src/services/integrations/index.js';

test('getAllIntegrations returns 6 installers', () => {
  const integrations = getAllIntegrations();
  assert.equal(integrations.length, 6);
});

test('Each integration has id, displayName, mechanism', () => {
  for (const i of getAllIntegrations()) {
    assert.ok(i.id, `missing id`);
    assert.ok(i.displayName, `missing displayName for ${i.id}`);
    assert.ok(i.mechanism, `missing mechanism for ${i.id}`);
  }
});

test('Each integration has detect/install/uninstall/status methods', () => {
  for (const i of getAllIntegrations()) {
    assert.equal(typeof i.detect, 'function', `${i.id} missing detect`);
    assert.equal(typeof i.install, 'function', `${i.id} missing install`);
    assert.equal(typeof i.uninstall, 'function', `${i.id} missing uninstall`);
    assert.equal(typeof i.status, 'function', `${i.id} missing status`);
  }
});

test('Integration IDs are unique', () => {
  const ids = getAllIntegrations().map(i => i.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('Integration IDs match: codex-cli, cursor, gemini-cli, openclaw, opencode, windsurf', () => {
  const ids = getAllIntegrations().map(i => i.id).sort();
  assert.deepEqual(ids, ['codex-cli', 'cursor', 'gemini-cli', 'openclaw', 'opencode', 'windsurf']);
});

test('detect() returns boolean for each integration', async () => {
  for (const i of getAllIntegrations()) {
    const detected = await i.detect();
    assert.equal(typeof detected, 'boolean', `${i.id} detect returned non-boolean`);
  }
});

test('status() returns valid IntegrationStatus', async () => {
  for (const i of getAllIntegrations()) {
    const s = await i.status();
    assert.equal(typeof s.installed, 'boolean', `${i.id} status.installed not boolean`);
    assert.equal(typeof s.detected, 'boolean', `${i.id} status.detected not boolean`);
  }
});
