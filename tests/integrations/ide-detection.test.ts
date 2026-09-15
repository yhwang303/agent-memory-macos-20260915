import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDE_DETECTION_TABLE, detectInstalledIDEs } from '../../src/services/integrations/ide-detection.js';

test('IDE_DETECTION_TABLE has 16 entries', () => {
  assert.equal(IDE_DETECTION_TABLE.length, 16);
});

test('Each entry has id, displayName, and at least one detection method', () => {
  for (const entry of IDE_DETECTION_TABLE) {
    assert.ok(entry.id, `missing id`);
    assert.ok(entry.displayName, `missing displayName for ${entry.id}`);
    assert.ok(
      entry.configDirs.length > 0 || entry.binaries.length > 0,
      `${entry.id} has no configDirs or binaries`,
    );
  }
});

test('All platform IDs in the table are unique', () => {
  const ids = IDE_DETECTION_TABLE.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('detectInstalledIDEs returns an array of correct length', async () => {
  const results = await detectInstalledIDEs();
  assert.ok(Array.isArray(results));
  assert.equal(results.length, IDE_DETECTION_TABLE.length);
});

test('Each detection result has id, detected (boolean), method', async () => {
  const results = await detectInstalledIDEs();
  for (const r of results) {
    assert.ok(r.id, 'missing id');
    assert.equal(typeof r.detected, 'boolean', `${r.id} detected is not boolean`);
    assert.ok(
      ['config_dir', 'binary', 'none'].includes(r.method),
      `${r.id} has unexpected method: ${r.method}`,
    );
  }
});

test('Non-detected entries have method "none"', async () => {
  const results = await detectInstalledIDEs();
  for (const r of results) {
    if (!r.detected) {
      assert.equal(r.method, 'none', `${r.id} not detected but method is "${r.method}"`);
    }
  }
});
