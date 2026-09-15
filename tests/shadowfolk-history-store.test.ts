import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  PushHistoryStore,
  type PushHistoryEntry,
} from '../src/services/shadowfolk/PushHistoryStore.js';

function tempFile(): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'sf-history-'));
  return { dir, file: path.join(dir, 'shadowfolk-push-history.json') };
}

function entry(overrides: Partial<PushHistoryEntry> = {}): PushHistoryEntry {
  return {
    id: 'hist_20260511_112955_aaaa',
    workspace: 'D:/GitHub/shadow-folk',
    gitRoot: 'D:/GitHub/shadow-folk',
    remote: 'https://github.com/c001estb0y/shadow-folk.git',
    branch: 'feat/plugin-system',
    mode: 'normal',
    startCursor: { commit: 'old', observationId: 1, summaryId: 2 },
    endCursor: { commit: 'new', observationId: 3, summaryId: 4 },
    batchId: 'batch-1',
    counts: { commits: 2, observations: 2, summaries: 2 },
    createdAt: '2026-05-11T11:29:55.605Z',
    ...overrides,
  };
}

test('PushHistoryStore returns empty history when file is missing', async () => {
  const { dir, file } = tempFile();
  try {
    const store = new PushHistoryStore(file);
    const entries = await store.listForGitRoot('D:/GitHub/shadow-folk');
    assert.deepEqual(entries, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PushHistoryStore appends entries and filters by normalized git root', async () => {
  const { dir, file } = tempFile();
  try {
    const store = new PushHistoryStore(file);
    await store.append(entry({ id: 'older', createdAt: '2026-05-10T11:00:00.000Z' }));
    await store.append(entry({
      id: 'newer',
      gitRoot: 'd:/github/shadow-folk',
      createdAt: '2026-05-11T11:00:00.000Z',
    }));
    await store.append(entry({
      id: 'other',
      workspace: 'E:/Github/agent-memory',
      gitRoot: 'E:/Github/agent-memory',
      createdAt: '2026-05-12T11:00:00.000Z',
    }));

    const entries = await store.listForGitRoot('D:/GitHub/shadow-folk');
    assert.deepEqual(entries.map(e => e.id), ['newer', 'older']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PushHistoryStore backs up corrupt JSON and recreates an empty ledger', async () => {
  const { dir, file } = tempFile();
  try {
    fs.writeFileSync(file, '{not-json', 'utf8');
    const store = new PushHistoryStore(file);
    const entries = await store.listForGitRoot('D:/GitHub/shadow-folk');

    assert.deepEqual(entries, []);
    const files = fs.readdirSync(dir);
    assert.ok(files.some(name => name.startsWith('shadowfolk-push-history.json.corrupt.')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PushHistoryStore rejects fs read errors without corrupt recovery', async () => {
  const { dir, file } = tempFile();
  try {
    fs.mkdirSync(file);
    const store = new PushHistoryStore(file);

    await assert.rejects(() => store.listForGitRoot('D:/GitHub/shadow-folk'));
    const files = fs.readdirSync(dir);
    assert.deepEqual(
      files.filter(name => name.startsWith('shadowfolk-push-history.json.corrupt.')),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
