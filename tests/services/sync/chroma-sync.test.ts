import { test } from 'node:test';
import assert from 'node:assert/strict';

class MockMcp {
  public calls: Array<{ method: string; args: any }> = [];
  public queryResult: any = { ids: [], distances: [], metadatas: [] };
  isConnected() { return true; }
  async createCollection(name: string) { this.calls.push({ method: 'createCollection', args: { name } }); }
  async addDocuments(collection: string, ids: string[], documents: string[], metadatas: any[]) {
    this.calls.push({ method: 'addDocuments', args: { collection, ids, documents, metadatas } });
  }
  async query(collection: string, text: string, nResults: number) {
    this.calls.push({ method: 'query', args: { collection, text, nResults } });
    return this.queryResult;
  }
  async deleteDocuments(collection: string, ids: string[]) {
    this.calls.push({ method: 'deleteDocuments', args: { collection, ids } });
  }
  async close() {}
}

import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';

test('ChromaSync.ensureCollection creates expected collection', async () => {
  const mcp = new MockMcp() as any;
  const sync = new ChromaSync(mcp, 'my-project', 'am_my_project');
  await sync.ensureCollection();
  const call = mcp.calls.find((c: any) => c.method === 'createCollection');
  assert.ok(call);
  assert.equal(call.args.name, 'am_my_project');
});

test('ChromaSync.query returns parallel arrays', async () => {
  const mcp = new MockMcp() as any;
  mcp.queryResult = {
    ids: ['obs:10', 'sum:3'],
    distances: [0.2, 0.4],
    metadatas: [
      { sqlite_id: 10, doc_type: 'observation' },
      { sqlite_id: 3, doc_type: 'session_summary' },
    ],
  };
  const sync = new ChromaSync(mcp, 'p');
  const r = await sync.query('hello world', 5);
  assert.deepEqual(r.sqlite_ids, [10, 3]);
  assert.deepEqual(r.doc_types, ['observation', 'session_summary']);
  assert.deepEqual(r.distances, [0.2, 0.4]);
});

test('ChromaSync derives sanitized collection name from project with Chinese chars', async () => {
  const mcp = new MockMcp() as any;
  const sync = new ChromaSync(mcp, '我的-项目/foo');
  await sync.ensureCollection();
  const call = mcp.calls.find((c: any) => c.method === 'createCollection');
  assert.ok(call);
  // Should begin with am_ and match chroma allowed chars
  assert.match(call.args.name, /^am_[a-zA-Z0-9._-]+$/);
  assert.ok(call.args.name.length >= 3 && call.args.name.length <= 63);
});

test('ChromaSync.query skips rows with missing metadata', async () => {
  const mcp = new MockMcp() as any;
  mcp.queryResult = {
    ids: ['obs:1', 'obs:2', 'obs:3'],
    distances: [0.1, 0.2, 0.3],
    metadatas: [
      { sqlite_id: 1, doc_type: 'observation' },
      null,
      { sqlite_id: 3, doc_type: 'observation' },
    ],
  };
  const sync = new ChromaSync(mcp, 'p');
  const r = await sync.query('q', 3);
  assert.deepEqual(r.sqlite_ids, [1, 3]);
  assert.deepEqual(r.doc_types, ['observation', 'observation']);
  assert.deepEqual(r.distances, [0.1, 0.3]);
});

test('ChromaSync.deleteObservation calls deleteDocuments with obs: prefix', async () => {
  const mcp = new MockMcp() as any;
  const sync = new ChromaSync(mcp, 'p', 'am_p');
  await sync.deleteObservation(42);
  const call = mcp.calls.find((c: any) => c.method === 'deleteDocuments');
  assert.ok(call);
  assert.deepEqual(call.args.ids, ['obs:42']);
});

test('ChromaSync.deleteSummary calls deleteDocuments with sum: prefix', async () => {
  const mcp = new MockMcp() as any;
  const sync = new ChromaSync(mcp, 'p', 'am_p');
  await sync.deleteSummary(7);
  const call = mcp.calls.find((c: any) => c.method === 'deleteDocuments');
  assert.ok(call);
  assert.deepEqual(call.args.ids, ['sum:7']);
});

test('ChromaSync satisfies ChromaSyncLike contract (type check)', async () => {
  // Type-level compatibility check — ensures we don't drift from the strategy's
  // expected shape without knowing it.
  type ChromaQueryResult = {
    sqlite_ids: number[];
    doc_types: string[];
    distances: number[];
  };
  type ChromaSyncLike = {
    query(
      text: string,
      nResults: number,
      filter?: { project?: string; type?: string[] }
    ): Promise<ChromaQueryResult>;
  };
  const mcp = new MockMcp() as any;
  const sync: ChromaSyncLike = new ChromaSync(mcp, 'p');
  assert.ok(sync);
});
