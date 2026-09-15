import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HEADER = `/*!
 * agent-memory — AGPL-3.0
 * Copyright (C) 2026 agent-memory contributors
 * See LICENSE and NOTICE for details.
 */
`;

function findTsFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...findTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results;
}

const root = join(import.meta.dirname, '..');
const files = findTsFiles(join(root, 'src'));
let updated = 0;

for (const file of files) {
  const content = readFileSync(file, 'utf8');
  if (content.startsWith('/*!')) continue;
  writeFileSync(file, HEADER + content, 'utf8');
  updated++;
}

console.log(`Added license header to ${updated} files (${files.length} total .ts files scanned)`);
