/**
 * One-shot cleanup for the dev tester's machine: delete legacy
 * session-level imported summary rows that the buggy mid-development
 * build wrote, so the new per-turn build can re-import the same source
 * transcripts cleanly.
 *
 * Also prunes any orphan vector rows in vec.db whose target summary
 * has been deleted (here or by any other source) — without this, vector
 * search returns ghost hits that fail to join back to session_summaries.
 *
 * NOT shipped with the product — fresh installs of beta.8 never had the
 * session-level era and don't need this. Only the original dev tester
 * runs it, once, before letting auto-import kick in for the per-turn era.
 *
 * Detection: `imported:*` rows whose memory_session_id is `imp:<a>:<id>`
 * with NO `:t<N>` suffix are session-level legacy. Per-turn rows have
 * the `:t<N>` suffix.
 *
 * Usage (run from D:\agent-memory):
 *   node scripts/cleanup-old-session-level-imports.mjs           # dry-run, prints what would be deleted
 *   node scripts/cleanup-old-session-level-imports.mjs --apply   # actually deletes
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

const apply = process.argv.includes('--apply');
const dataDir = join(homedir(), '.agent-memory');
const dbPath = join(dataDir, 'agent-memory.db');
const vecPath = join(dataDir, 'vec.db');

// ─── Phase 1: legacy session-level imported summaries ─────────────────
const db = new Database(dbPath);
const legacyRows = db
  .prepare(
    `SELECT id, memory_session_id, project, source_ide, created_at FROM session_summaries
     WHERE source_ide LIKE 'imported:%'
       AND memory_session_id LIKE 'imp:%'
       AND memory_session_id NOT GLOB '*:t[0-9]*'`,
  )
  .all();

console.log(`Phase 1 — legacy session-level imported summaries: ${legacyRows.length} rows`);
for (const r of legacyRows) {
  console.log(`  id=${r.id} ${r.source_ide.padEnd(28)} ${(r.project ?? '').padEnd(30)} ${r.created_at}`);
}

// ─── Phase 2: orphan vector rows ──────────────────────────────────────
// Compute orphans = vec.db `docs` rows whose (kind, sqlite_id) no longer
// exists in main DB. Two scopes: kind='session_summary' joins against
// session_summaries.id; kind='observation' joins against observations.id.
let orphanSummaries = [];
let orphanObservations = [];
let vecExists = existsSync(vecPath);
if (vecExists) {
  const vec = new Database(vecPath, { readonly: !apply });
  sqliteVec.load(vec);
  // Attach main DB so we can JOIN.
  vec.exec(`ATTACH DATABASE '${dbPath.replace(/\\/g, '/')}' AS main_db`);
  orphanSummaries = vec
    .prepare(
      `SELECT d.sqlite_id AS id, d.rowid AS vec_rowid
       FROM docs d
       WHERE d.kind = 'session_summary'
         AND NOT EXISTS (SELECT 1 FROM main_db.session_summaries s WHERE s.id = d.sqlite_id)`,
    )
    .all();
  orphanObservations = vec
    .prepare(
      `SELECT d.sqlite_id AS id, d.rowid AS vec_rowid
       FROM docs d
       WHERE d.kind = 'observation'
         AND NOT EXISTS (SELECT 1 FROM main_db.observations o WHERE o.id = d.sqlite_id)`,
    )
    .all();
  vec.close();
}

console.log(`Phase 2 — orphan vector rows in vec.db:`);
console.log(`  vec.db exists: ${vecExists}`);
console.log(`  orphan summary embeddings:     ${orphanSummaries.length}`);
console.log(`  orphan observation embeddings: ${orphanObservations.length}`);

if (!apply) {
  console.log(`\nDry-run only. To actually delete: node ${process.argv[1]} --apply`);
  process.exit(0);
}

// ─── Apply ────────────────────────────────────────────────────────────
const tx1 = db.transaction(() => {
  let fpDeleted = 0;
  const fpDel = db.prepare('DELETE FROM import_history_fingerprints WHERE summary_id = ?');
  for (const r of legacyRows) fpDeleted += fpDel.run(r.id).changes;

  const ids = legacyRows.map((r) => r.id);
  let sumDeleted = 0;
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    sumDeleted = db.prepare(`DELETE FROM session_summaries WHERE id IN (${placeholders})`).run(...ids).changes;
  }
  return { sumDeleted, fpDeleted };
});

const phase1 = tx1();
console.log(`\nPhase 1 done: deleted ${phase1.sumDeleted} summaries + ${phase1.fpDeleted} fingerprints`);

// Phase 2: prune vec.db orphans (incl. ones we just created above by deleting legacy rows).
if (vecExists) {
  const vec = new Database(vecPath);
  sqliteVec.load(vec);
  // Re-query orphans now that legacy rows are gone (they'll show up here too).
  vec.exec(`ATTACH DATABASE '${dbPath.replace(/\\/g, '/')}' AS main_db`);
  const stillOrphanSum = vec
    .prepare(
      `SELECT d.sqlite_id AS id, d.rowid AS vec_rowid
       FROM docs d
       WHERE d.kind = 'session_summary'
         AND NOT EXISTS (SELECT 1 FROM main_db.session_summaries s WHERE s.id = d.sqlite_id)`,
    )
    .all();
  const stillOrphanObs = vec
    .prepare(
      `SELECT d.sqlite_id AS id, d.rowid AS vec_rowid
       FROM docs d
       WHERE d.kind = 'observation'
         AND NOT EXISTS (SELECT 1 FROM main_db.observations o WHERE o.id = d.sqlite_id)`,
    )
    .all();
  const txVec = vec.transaction(() => {
    const delDoc = vec.prepare('DELETE FROM docs WHERE kind = ? AND sqlite_id = ?');
    const delVec = vec.prepare('DELETE FROM vec_docs WHERE rowid = ?');
    let n = 0;
    for (const o of stillOrphanSum) {
      delVec.run(BigInt(o.vec_rowid));
      delDoc.run('session_summary', o.id);
      n += 1;
    }
    for (const o of stillOrphanObs) {
      delVec.run(BigInt(o.vec_rowid));
      delDoc.run('observation', o.id);
      n += 1;
    }
    return n;
  });
  const removed = txVec();
  console.log(`Phase 2 done: pruned ${removed} orphan vector rows (${stillOrphanSum.length} summary, ${stillOrphanObs.length} observation)`);
  vec.close();
}

console.log('\nNext steps:');
console.log('  1. Quit AgentMemory (right-click tray → 退出) so the new exe can install cleanly.');
console.log('  2. Install D:\\agent-memory\\desktop\\release5\\AgentMemory-Setup-2.1.0-beta.8.exe');
console.log('  3. Worker auto-detect will re-import these sessions at per-turn granularity, then auto-reindex.');
