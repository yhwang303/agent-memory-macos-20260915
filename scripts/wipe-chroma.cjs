#!/usr/bin/env node
/**
 * Wipes the Chroma data directory so the next worker start rebuilds embeddings from SQLite.
 * Chroma is always rebuildable — SQLite remains the source of truth.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const dataDir = process.env.AGENT_MEMORY_DATA_DIR || path.join(os.homedir(), '.agent-memory');
const chromaDir = path.join(dataDir, 'chroma');

if (fs.existsSync(chromaDir)) {
  const before = fs.readdirSync(chromaDir);
  console.log(`Wiping ${chromaDir} (${before.length} items)...`);
  fs.rmSync(chromaDir, { recursive: true, force: true });
  console.log('Done. Chroma will rebuild from SQLite on next worker restart.');
} else {
  console.log(`Chroma directory does not exist (${chromaDir}), nothing to wipe.`);
}
