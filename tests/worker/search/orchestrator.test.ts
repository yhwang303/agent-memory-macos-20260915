import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SearchOrchestrator } from '../../../src/services/worker/search/SearchOrchestrator.js';
import { formatSearchResults } from '../../../src/services/worker/search/ResultFormatter.js';

function makeStub(name: 'sqlite' | 'chroma' | 'hybrid') {
  return {
    name,
    async search(_opts: any) {
      return {
        observations: [{ row: { id: 1, title: 't' }, score: 0.5, rank: 0, source: name }],
        summaries: [],
        mode: name,
        fellBack: false,
      };
    },
  };
}

test('orchestrator routes mode=sqlite to SQLiteStrategy', async () => {
  const o = new SearchOrchestrator({
    sqlite: makeStub('sqlite') as any,
    chroma: makeStub('chroma') as any,
    hybrid: makeStub('hybrid') as any,
  });
  const r = await o.search({ query: 'x', mode: 'sqlite' });
  assert.equal(r.mode, 'sqlite');
});

test('orchestrator routes mode=chroma to ChromaStrategy', async () => {
  const o = new SearchOrchestrator({
    sqlite: makeStub('sqlite') as any,
    chroma: makeStub('chroma') as any,
    hybrid: makeStub('hybrid') as any,
  });
  const r = await o.search({ query: 'x', mode: 'chroma' });
  assert.equal(r.mode, 'chroma');
});

test('orchestrator defaults to hybrid when mode omitted', async () => {
  const o = new SearchOrchestrator({
    sqlite: makeStub('sqlite') as any,
    chroma: makeStub('chroma') as any,
    hybrid: makeStub('hybrid') as any,
  });
  const r = await o.search({ query: 'x' });
  assert.equal(r.mode, 'hybrid');
});

test('orchestrator falls back to sqlite when hybrid unavailable', async () => {
  const o = new SearchOrchestrator({
    sqlite: makeStub('sqlite') as any,
    chroma: null,
    hybrid: null,
  });
  const r = await o.search({ query: 'x', mode: 'hybrid' });
  assert.equal(r.mode, 'sqlite');
  assert.equal(r.fellBack, true);
});

test('orchestrator falls back to sqlite when chroma explicitly requested but unavailable', async () => {
  const o = new SearchOrchestrator({
    sqlite: makeStub('sqlite') as any,
    chroma: null,
    hybrid: null,
  });
  const r = await o.search({ query: 'x', mode: 'chroma' });
  assert.equal(r.mode, 'sqlite');
  assert.equal(r.fellBack, true);
});

test('orchestrator.isChromaAvailable reflects chroma presence', () => {
  const o1 = new SearchOrchestrator({
    sqlite: makeStub('sqlite') as any,
    chroma: null,
    hybrid: null,
  });
  assert.equal(o1.isChromaAvailable(), false);

  const o2 = new SearchOrchestrator({
    sqlite: makeStub('sqlite') as any,
    chroma: makeStub('chroma') as any,
    hybrid: makeStub('hybrid') as any,
  });
  assert.equal(o2.isChromaAvailable(), true);
});

test('formatSearchResults normalizes observations and summaries to public shape', () => {
  const formatted = formatSearchResults({
    observations: [{
      row: {
        id: 7,
        memory_session_id: 'mid',
        project: 'p',
        type: 'bugfix',
        title: 'fixed it',
        subtitle: 'sub',
        created_at: '2026-04-21',
      } as any,
      score: 0.9,
      rank: 0,
      source: 'hybrid',
    }],
    summaries: [{
      row: {
        id: 3,
        memory_session_id: 'mid',
        project: 'p',
        request: 'req',
        learned: 'x',
        completed: 'y',
        created_at: '2026-04-21',
      } as any,
      score: 0.7,
      rank: 0,
      source: 'hybrid',
    }],
    mode: 'hybrid',
    fellBack: false,
  } as any);

  assert.equal(formatted.mode, 'hybrid');
  assert.equal(formatted.fellBack, false);
  assert.equal(formatted.observations[0].id, 7);
  assert.equal(formatted.observations[0].score, 0.9);
  assert.equal(formatted.observations[0].rank, 0);
  assert.equal(formatted.observations[0].source, 'hybrid');
  assert.equal(formatted.observations[0].title, 'fixed it');
  assert.equal(formatted.summaries[0].id, 3);
  assert.equal(formatted.summaries[0].request, 'req');
});
