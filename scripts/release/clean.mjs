#!/usr/bin/env node
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..', '..');

function remove(path) {
  rmSync(path, { recursive: true, force: true });
  console.log(`[release:clean] removed ${path}`);
}

remove(join(rootDir, 'release-artifacts'));
remove(join(rootDir, 'desktop', 'release5'));

for (const entry of readdirSync(rootDir)) {
  if (entry.endsWith('.tgz') || entry === 'pack-info.json') {
    remove(join(rootDir, entry));
  }
}

const releaseDir = join(rootDir, 'release');
if (existsSync(releaseDir)) remove(releaseDir);

console.log('[release:clean] OK');
