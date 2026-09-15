/**
 * Verify import-history dedup: list any duplicate pairs of
 *   - hook-captured row (source_ide IS NULL or not 'imported:%')
 *   - imported row     (source_ide LIKE 'imported:%')
 * that share the same first-30-char request prefix.
 *
 * Empty list = dedup is working. Non-empty list = there are still
 * conversations recorded twice (once by hook, once by import) and
 * we need to dig further.
 *
 * Usage (PowerShell, copy-paste safe):
 *   node D:\agent-memory\scripts\check-dup-imports.mjs
 *   node D:\agent-memory\scripts\check-dup-imports.mjs --limit 50
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) || 20 : 20;

const dbPath = join(homedir(), '.agent-memory', 'agent-memory.db');
if (!existsSync(dbPath)) {
  console.error(`AgentMemory main DB not found at ${dbPath}.`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

const rows = db
  .prepare(
    `SELECT
       h.id   AS hook_id,
       i.id   AS imp_id,
       h.created_at AS hook_at,
       i.created_at AS imp_at,
       h.project    AS hook_proj,
       i.project    AS imp_proj,
       substr(h.request, 1, 50) AS req
     FROM session_summaries h
     JOIN session_summaries i
       ON substr(h.request, 1, 30) = substr(i.request, 1, 30)
      AND h.id <> i.id
     WHERE (h.source_ide IS NULL OR h.source_ide NOT LIKE 'imported:%')
       AND i.source_ide LIKE 'imported:%'
     ORDER BY h.created_at_epoch DESC
     LIMIT ?`,
  )
  .all(limit);

console.log(`\nDuplicate (hook, imported) pairs found: ${rows.length}`);
if (rows.length === 0) {
  console.log('  ✅ No duplicates — dedup is working as expected.\n');
  db.close();
  process.exit(0);
}

console.log(
  '  ❌ Each row below = same conversation captured twice (hook + import).\n',
);
for (const r of rows) {
  console.log(
    `  hook #${String(r.hook_id).padStart(5)} (${r.hook_at})  ` +
      `imp #${String(r.imp_id).padStart(5)} (${r.imp_at})`,
  );
  console.log(`    proj h=${r.hook_proj}  i=${r.imp_proj}`);
  console.log(`    req: ${r.req}`);
}

db.close();
