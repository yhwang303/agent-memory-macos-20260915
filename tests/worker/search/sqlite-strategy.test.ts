import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteSearchStrategy } from '../../../src/services/worker/search/SQLiteSearchStrategy.js';

test('SQLiteSearchStrategy.name === "sqlite"', () => {
  const s = new SQLiteSearchStrategy();
  assert.equal(s.name, 'sqlite');
});

test('SQLiteSearchStrategy returns empty for nonsense FTS query on empty project', async () => {
  const s = new SQLiteSearchStrategy();
  // Use a token that almost certainly has no matches. If FTS5 throws on bad
  // syntax, the strategy must catch and return an empty result.
  const results = await s.search({
    query: 'zxqwertynonexistenttoken',
    project: 'probably-empty-' + Date.now(),
    limit: 10,
  });
  assert.equal(results.mode, 'sqlite');
  assert.equal(results.observations.length, 0);
  assert.equal(results.summaries.length, 0);
  assert.equal(results.fellBack, false);
});

test('SQLiteSearchStrategy catches errors and returns empty, not throws', async () => {
  const s = new SQLiteSearchStrategy();
  // Pass a string that triggers FTS5 syntax errors (e.g., unbalanced quotes)
  const results = await s.search({ query: '"' , limit: 5 });
  // Must not throw; returns valid shape
  assert.equal(results.mode, 'sqlite');
  assert.ok(Array.isArray(results.observations));
  assert.ok(Array.isArray(results.summaries));
});

test('SQLiteSearchStrategy ranks are 0-indexed, source=sqlite', async () => {
  const s = new SQLiteSearchStrategy();
  const results = await s.search({ query: 'a', limit: 5 });
  results.observations.forEach((r, i) => {
    assert.equal(r.rank, i);
    assert.equal(r.source, 'sqlite');
    assert.ok(typeof r.score === 'number');
  });
  results.summaries.forEach((r, i) => {
    assert.equal(r.rank, i);
    assert.equal(r.source, 'sqlite');
  });
});

test('SQLiteSearchStrategy respects limit', async () => {
  const s = new SQLiteSearchStrategy();
  const results = await s.search({ query: 'a', limit: 3 });
  assert.ok(results.observations.length <= 3);
  assert.ok(results.summaries.length <= 3);
});
