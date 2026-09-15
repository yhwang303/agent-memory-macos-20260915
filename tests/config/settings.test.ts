import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, DEFAULT_SETTINGS } from '../../src/config/settings.js';

function tmpConfigDir(): string {
  const dir = join(tmpdir(), 'am-cfg-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('loadSettings returns defaults when no file exists', () => {
  const dir = tmpConfigDir();
  try {
    const s = loadSettings({ configDir: dir });
    assert.deepEqual(s.rag, DEFAULT_SETTINGS.rag);
    assert.equal(s.rag.embedding_model, 'bge-m3');
    assert.equal(s.rag.fallback_mode, 'sqlite-only');
    assert.equal(s.rag.enabled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSettings merges user overrides over defaults', () => {
  const dir = tmpConfigDir();
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      rag: { embedding_model: 'paraphrase-multilingual-MiniLM-L12-v2' }
    }));
    const s = loadSettings({ configDir: dir });
    assert.equal(s.rag.embedding_model, 'paraphrase-multilingual-MiniLM-L12-v2');
    assert.equal(s.rag.fallback_mode, 'sqlite-only');
    assert.deepEqual(s.rag.hybrid_weights, DEFAULT_SETTINGS.rag.hybrid_weights);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSettings handles corrupt JSON gracefully (returns defaults)', () => {
  const dir = tmpConfigDir();
  try {
    writeFileSync(join(dir, 'settings.json'), '{ not json');
    const s = loadSettings({ configDir: dir });
    assert.deepEqual(s, DEFAULT_SETTINGS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSettings partial hybrid_weights merges per-key', () => {
  const dir = tmpConfigDir();
  try {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      rag: { hybrid_weights: { chroma: 0.8 } }
    }));
    const s = loadSettings({ configDir: dir });
    assert.equal(s.rag.hybrid_weights.chroma, 0.8);
    assert.equal(s.rag.hybrid_weights.sqlite, DEFAULT_SETTINGS.rag.hybrid_weights.sqlite);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
