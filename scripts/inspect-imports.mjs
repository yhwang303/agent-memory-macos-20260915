/**
 * Read-only inspector: lists every `imported:*` row in
 * `~/.agent-memory/agent-memory.db` with IDE, timestamp, and project
 * (working directory at import time).
 *
 * Use this AFTER running cleanup-duplicate-imports.mjs to see what's left,
 * before deciding whether to nuke them all with purge-all-imports.mjs.
 *
 * Usage (PowerShell from anywhere):
 *   node D:\agent-memory\scripts\inspect-imports.mjs
 *   node D:\agent-memory\scripts\inspect-imports.mjs --limit 200
 *   node D:\agent-memory\scripts\inspect-imports.mjs --by-project
 */

import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) || 100 : 0; // 0 = no limit
const byProject = args.includes('--by-project');

const dbPath = join(homedir(), '.agent-memory', 'agent-memory.db');
const db = new Database(dbPath, { readonly: true });

const rows = db
  .prepare(
    `SELECT id, source_ide, project, created_at, created_at_epoch,
            memory_session_id, request, notes
     FROM session_summaries
     WHERE source_ide LIKE 'imported:%'
     ORDER BY created_at_epoch DESC`,
  )
  .all();

console.log(`\nTotal imported rows in AgentMemory: ${rows.length}`);

if (rows.length === 0) {
  console.log('  (nothing to clean — AgentMemory has no imported rows.)');
  process.exit(0);
}

// Per-IDE and per-project tallies
const byIde = new Map();
const byProj = new Map();
for (const r of rows) {
  byIde.set(r.source_ide, (byIde.get(r.source_ide) ?? 0) + 1);
  byProj.set(r.project ?? '(null)', (byProj.get(r.project ?? '(null)') ?? 0) + 1);
}

console.log('\nBy IDE:');
for (const [ide, n] of [...byIde.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${ide.padEnd(28)} ${String(n).padStart(5)}`);
}

console.log('\nBy project (cwd that import wrote):');
for (const [proj, n] of [...byProj.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${proj}`);
}

if (byProject) {
  // Compact mode: counts only.
  process.exit(0);
}

console.log('\nRows (newest first):');
const slice = limit > 0 ? rows.slice(0, limit) : rows;
for (const r of slice) {
  // Try to extract original_path from notes for additional context.
  const m = (r.notes ?? '').match(/original_path=([^;]+)/);
  const origFile = m ? basename(m[1].trim()) : '';
  const reqShort = (r.request ?? '').replace(/\s+/g, ' ').slice(0, 70);
  console.log(
    `  #${String(r.id).padStart(5)} ${r.source_ide.padEnd(20)} ${r.created_at}  ${(r.project ?? '').padEnd(40)}  ${origFile}`,
  );
  if (reqShort) console.log(`         req: ${reqShort}${reqShort.length === 70 ? '…' : ''}`);
}
if (limit > 0 && rows.length > limit) {
  console.log(`\n  ... ${rows.length - limit} more rows hidden. Pass --limit 0 (or higher) to see all.`);
}

console.log(`\nIf you want to wipe ALL ${rows.length} of these and re-import after reinstalling:`);
console.log(`  node ${process.argv[1].replace('inspect-imports', 'purge-all-imports')} --apply\n`);

db.close();
