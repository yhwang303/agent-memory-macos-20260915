import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HybridSearchStrategy,
  rrfScore,
} from '../../../src/services/worker/search/HybridSearchStrategy.js';

test('rrfScore formula: 1 / (k + rank)', () => {
  assert.equal(rrfScore(0, 60), 1 / 60);
  assert.equal(rrfScore(1, 60), 1 / 61);
  assert.equal(rrfScore(9, 60), 1 / 69);
});

test('HybridSearchStrategy ranks items using RRF (k=60, equal weights)', async () => {
  // SQLite returns [A=1, B=2, C=3]; Chroma returns [C=3, B=2, D=4].
  // Weights 1:1, k=60:
  //   A: 1/60
  //   B: 1/61 + 1/61
  //   C: 1/62 + 1/60
  //   D: 1/62
  // Expected order: C (largest), B, A, D.

  const sqliteStrategy = {
    name: 'sqlite' as const,
    async search() {
      return {
        observations: [
          { row: { id: 1 }, score: 0.9, rank: 0, source: 'sqlite' as const },
          { row: { id: 2 }, score: 0.8, rank: 1, source: 'sqlite' as const },
          { row: { id: 3 }, score: 0.7, rank: 2, source: 'sqlite' as const },
        ],
        summaries: [],
        mode: 'sqlite' as const,
        fellBack: false,
      };
    },
  };
  const chromaStrategy = {
    name: 'chroma' as const,
    async search() {
      return {
        observations: [
          { row: { id: 3 }, score: 0.9, rank: 0, source: 'chroma' as const },
          { row: { id: 2 }, score: 0.7, rank: 1, source: 'chroma' as const },
          { row: { id: 4 }, score: 0.5, rank: 2, source: 'chroma' as const },
        ],
        summaries: [],
        mode: 'chroma' as const,
        fellBack: false,
      };
    },
  };

  const hybrid = new HybridSearchStrategy(sqliteStrategy as any, chromaStrategy as any, {
    k: 60,
    sqliteWeight: 1,
    chromaWeight: 1,
  });
  const results = await hybrid.search({ query: 'x', limit: 10 });
  const ids = results.observations.map(r => r.row.id);
  assert.deepEqual(ids, [3, 2, 1, 4]);
  assert.equal(results.mode, 'hybrid');
  // Ranks re-numbered 0..n-1
  results.observations.forEach((r, i) => assert.equal(r.rank, i));
  // source tagged as hybrid
  results.observations.forEach(r => assert.equal(r.source, 'hybrid'));
});

test('HybridSearchStrategy: weight 0 disables a side', async () => {
  const sqlite = {
    name: 'sqlite' as const,
    async search() {
      return {
        observations: [{ row: { id: 1 }, score: 1, rank: 0, source: 'sqlite' as const }],
        summaries: [],
        mode: 'sqlite' as const,
        fellBack: false,
      };
    },
  };
  const chroma = {
    name: 'chroma' as const,
    async search() {
      return {
        observations: [{ row: { id: 999 }, score: 1, rank: 0, source: 'chroma' as const }],
        summaries: [],
        mode: 'chroma' as const,
        fellBack: false,
      };
    },
  };
  const hybrid = new HybridSearchStrategy(sqlite as any, chroma as any, {
    k: 60, sqliteWeight: 1, chromaWeight: 0,
  });
  const results = await hybrid.search({ query: 'x', limit: 10 });
  assert.equal(results.observations.length, 1);
  assert.equal(results.observations[0].row.id, 1);
});

test('HybridSearchStrategy: propagates fellBack when either side falls back', async () => {
  const sqlite = {
    name: 'sqlite' as const,
    async search() {
      return { observations: [], summaries: [], mode: 'sqlite' as const, fellBack: false };
    },
  };
  const chroma = {
    name: 'chroma' as const,
    async search() {
      return { observations: [], summaries: [], mode: 'chroma' as const, fellBack: true };
    },
  };
  const hybrid = new HybridSearchStrategy(sqlite as any, chroma as any);
  const results = await hybrid.search({ query: 'x' });
  assert.equal(results.fellBack, true);
});

test('HybridSearchStrategy: does not throw if a strategy rejects', async () => {
  const sqlite = {
    name: 'sqlite' as const,
    async search() {
      return {
        observations: [{ row: { id: 1 }, score: 1, rank: 0, source: 'sqlite' as const }],
        summaries: [],
        mode: 'sqlite' as const,
        fellBack: false,
      };
    },
  };
  const chroma = {
    name: 'chroma' as const,
    async search() { throw new Error('chroma boom'); },
  };
  const hybrid = new HybridSearchStrategy(sqlite as any, chroma as any);
  const results = await hybrid.search({ query: 'x' });
  // Falls back to sqlite-only, marks fellBack
  assert.equal(results.fellBack, true);
  assert.equal(results.observations.length, 1);
  assert.equal(results.observations[0].row.id, 1);
});

test('HybridSearchStrategy: summaries merged independently of observations', async () => {
  const sqlite = {
    name: 'sqlite' as const,
    async search() {
      return {
        observations: [],
        summaries: [
          { row: { id: 10 }, score: 1, rank: 0, source: 'sqlite' as const },
          { row: { id: 20 }, score: 0.9, rank: 1, source: 'sqlite' as const },
        ],
        mode: 'sqlite' as const,
        fellBack: false,
      };
    },
  };
  const chroma = {
    name: 'chroma' as const,
    async search() {
      return {
        observations: [],
        summaries: [
          { row: { id: 20 }, score: 1, rank: 0, source: 'chroma' as const },
          { row: { id: 30 }, score: 0.5, rank: 1, source: 'chroma' as const },
        ],
        mode: 'chroma' as const,
        fellBack: false,
      };
    },
  };
  const hybrid = new HybridSearchStrategy(sqlite as any, chroma as any, { k: 60, sqliteWeight: 1, chromaWeight: 1 });
  const results = await hybrid.search({ query: 'x', limit: 10 });
  const ids = results.summaries.map(r => r.row.id);
  // ids 20 appears in both at rank 1 (sqlite) and 0 (chroma) → 1/61 + 1/60 = top
  assert.equal(ids[0], 20);
});

test('HybridSearchStrategy: respects limit across merged list', async () => {
  const sqlite = {
    name: 'sqlite' as const,
    async search() {
      return {
        observations: Array.from({ length: 10 }, (_, i) => ({
          row: { id: i }, score: 1 / (i + 1), rank: i, source: 'sqlite' as const,
        })),
        summaries: [],
        mode: 'sqlite' as const,
        fellBack: false,
      };
    },
  };
  const chroma = {
    name: 'chroma' as const,
    async search() {
      return { observations: [], summaries: [], mode: 'chroma' as const, fellBack: false };
    },
  };
  const hybrid = new HybridSearchStrategy(sqlite as any, chroma as any);
  const results = await hybrid.search({ query: 'x', limit: 3 });
  assert.equal(results.observations.length, 3);
});
