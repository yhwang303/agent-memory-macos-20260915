import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChromaSearchStrategy } from '../../../src/services/worker/search/ChromaSearchStrategy.js';

function makeMockSync(queryResult: {
  sqlite_ids: number[];
  doc_types: string[];
  distances: number[];
}) {
  return {
    queryResult,
    async query(_text: string, _n: number, _filter?: any) {
      return this.queryResult;
    },
  };
}

test('ChromaSearchStrategy.name === "chroma"', () => {
  const s = new ChromaSearchStrategy(makeMockSync({ sqlite_ids: [], doc_types: [], distances: [] }) as any);
  assert.equal(s.name, 'chroma');
});

test('ChromaSearchStrategy returns empty when Chroma returns nothing', async () => {
  const sync = makeMockSync({ sqlite_ids: [], doc_types: [], distances: [] });
  const strategy = new ChromaSearchStrategy(sync as any);
  const results = await strategy.search({ query: 'anything' });
  assert.equal(results.mode, 'chroma');
  assert.equal(results.observations.length, 0);
  assert.equal(results.summaries.length, 0);
  assert.equal(results.fellBack, false);
});

test('ChromaSearchStrategy splits results by doc_type and hydrates rows', async () => {
  const sync = makeMockSync({
    sqlite_ids: [10, 20, 5],
    doc_types: ['observation', 'observation', 'session_summary'],
    distances: [0.1, 0.3, 0.2],
  });

  const deps = {
    getObservationsByIds: (ids: number[]) => ids.map(id => ({ id, title: `obs ${id}` } as any)),
    getSummariesByIds: (ids: number[]) => ids.map(id => ({ id, request: `sum ${id}` } as any)),
  };
  const strategy = new ChromaSearchStrategy(sync as any, deps);
  const results = await strategy.search({ query: 'x' });
  assert.equal(results.observations.length, 2);
  assert.equal(results.summaries.length, 1);

  // Observations preserve chroma order, rank 0,1
  assert.equal(results.observations[0].row.id, 10);
  assert.equal(results.observations[0].rank, 0);
  assert.equal(results.observations[0].source, 'chroma');
  assert.equal(results.observations[1].row.id, 20);
  assert.equal(results.observations[1].rank, 1);

  // Summary rank re-starts at 0 for its own list
  assert.equal(results.summaries[0].row.id, 5);
  assert.equal(results.summaries[0].rank, 0);

  // Score is 1 - distance (higher = better); closer vectors get higher scores
  assert.ok(results.observations[0].score > results.observations[1].score);
});

test('ChromaSearchStrategy returns fellBack=true on query error', async () => {
  const sync = { async query() { throw new Error('chroma down'); } };
  const strategy = new ChromaSearchStrategy(sync as any);
  const results = await strategy.search({ query: 'x' });
  assert.equal(results.fellBack, true);
  assert.equal(results.observations.length, 0);
  assert.equal(results.summaries.length, 0);
  assert.equal(results.mode, 'chroma');
});

test('ChromaSearchStrategy respects limit (passes limit*2 to Chroma for filtering headroom, truncates to limit)', async () => {
  // Chroma returns 10 obs with descending distances
  const ids = Array.from({ length: 10 }, (_, i) => 100 + i);
  const sync = makeMockSync({
    sqlite_ids: ids,
    doc_types: ids.map(() => 'observation'),
    distances: ids.map((_, i) => i * 0.05),
  });
  const deps = {
    getObservationsByIds: (want: number[]) => want.map(id => ({ id })) as any[],
    getSummariesByIds: () => [] as any[],
  };
  const strategy = new ChromaSearchStrategy(sync as any, deps);
  const results = await strategy.search({ query: 'x', limit: 5 });
  assert.equal(results.observations.length, 5);
  // Top 5 should be the closest (lowest distance) items
  assert.equal(results.observations[0].row.id, 100);
});

test('ChromaSearchStrategy passes project/type filters to sync.query', async () => {
  const calls: any[] = [];
  const sync = {
    async query(text: string, n: number, filter?: any) {
      calls.push({ text, n, filter });
      return { sqlite_ids: [], doc_types: [], distances: [] };
    },
  };
  const strategy = new ChromaSearchStrategy(sync as any);
  await strategy.search({ query: 'q', project: 'proj', obs_type: ['bugfix', 'feature'], limit: 5 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, 'q');
  assert.equal(calls[0].filter?.project, 'proj');
  assert.deepEqual(calls[0].filter?.type, ['bugfix', 'feature']);
});

test('ChromaSearchStrategy handles row hydration misses (fewer rows than ids)', async () => {
  // Chroma says 3 observations; hydrator returns only 2 (one was deleted from SQLite)
  const sync = makeMockSync({
    sqlite_ids: [1, 2, 3],
    doc_types: ['observation', 'observation', 'observation'],
    distances: [0.1, 0.2, 0.3],
  });
  const deps = {
    getObservationsByIds: (ids: number[]) => ids.filter(id => id !== 2).map(id => ({ id })) as any[],
    getSummariesByIds: () => [] as any[],
  };
  const strategy = new ChromaSearchStrategy(sync as any, deps);
  const results = await strategy.search({ query: 'x' });
  assert.equal(results.observations.length, 2);
  // No observation with id 2
  assert.ok(!results.observations.some(o => o.row.id === 2));
});
