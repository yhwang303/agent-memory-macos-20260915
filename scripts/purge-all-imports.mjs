/**
 * Wipe ALL imported rows from AgentMemory and start over.
 *
 * Targets (in one transaction on the main DB):
 *   - session_summaries WHERE source_ide LIKE 'imported:%'
 *   - import_history_fingerprints  (entire table — every fingerprint row
 *     points at an imported summary, no other use)
 *   - summaries_fts entries auto-cascade via the existing AFTER DELETE trigger
 *
 * Then on vec.db:
 *   - Any vec_docs / docs row whose target session_summaries.id is now gone.
 *   - Uses sqlite-vec via the local node_modules so vec0 deletes work.
 *
 * Audit summary (sdk_sessions, observations) is NOT touched — only
 * the rows tagged as imports are removed.
 *
 * Usage (PowerShell from anywhere):
 *   node D:\agent-memory\scripts\purge-all-imports.mjs           # dry-run
 *   node D:\agent-memory\scripts\purge-all-imports.mjs --apply   # actually wipe
 *
 * After --apply: quit AgentMemory from the tray, install the new build, and let the
 * auto-import + auto-reindex chain re-process everything cleanly.
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

if (!existsSync(dbPath)) {
  console.error(`AgentMemory main DB not found at ${dbPath}. Has AgentMemory ever run on this machine?`);
  process.exit(1);
}

const db = new Database(dbPath);

// ─── Inspect current state ────────────────────────────────────────────
const importedCount = db
  .prepare(`SELECT COUNT(*) AS n FROM session_summaries WHERE source_ide LIKE 'imported:%'`)
  .get().n;
const fingerprintCount = db
  .prepare(`SELECT COUNT(*) AS n FROM import_history_fingerprints`)
  .get().n;

console.log(`\nWhat will be wiped:`);
console.log(`  session_summaries (source_ide LIKE 'imported:%'):   ${importedCount}`);
console.log(`  import_history_fingerprints (entire table):         ${fingerprintCount}`);

// Per-IDE breakdown for context
const byIde = db
  .prepare(
    `SELECT source_ide, COUNT(*) AS n FROM session_summaries
     WHERE source_ide LIKE 'imported:%' GROUP BY source_ide ORDER BY n DESC`,
  )
  .all();
if (byIde.length > 0) {
  console.log(`  by IDE:`);
  for (const r of byIde) console.log(`    ${r.source_ide.padEnd(28)} ${r.n}`);
}

let orphanSumPreview = 0;
let orphanObsPreview = 0;
if (existsSync(vecPath)) {
  // Connect read-only just to count what would become orphan AFTER the wipe.
  const probe = new Database(vecPath, { readonly: true });
  try {
    sqliteVec.load(probe);
    probe.exec(`ATTACH DATABASE '${dbPath.replace(/\\/g, '/')}' AS main_db`);
    // Simulating the post-wipe state: rows that are imported summaries OR
    // already orphan in main DB. Imported ones will all become orphans.
    orphanSumPreview = probe
      .prepare(
        `SELECT COUNT(*) AS n FROM docs d
         WHERE d.kind = 'session_summary'
           AND (
             NOT EXISTS (SELECT 1 FROM main_db.session_summaries s WHERE s.id = d.sqlite_id)
             OR EXISTS (SELECT 1 FROM main_db.session_summaries s WHERE s.id = d.sqlite_id AND s.source_ide LIKE 'imported:%')
           )`,
      )
      .get().n;
    orphanObsPreview = probe
      .prepare(
        `SELECT COUNT(*) AS n FROM docs d
         WHERE d.kind = 'observation'
           AND NOT EXISTS (SELECT 1 FROM main_db.observations o WHERE o.id = d.sqlite_id)`,
      )
      .get().n;
  } finally {
    try { probe.exec('DETACH DATABASE main_db'); } catch { /* noop */ }
    probe.close();
  }
  console.log(`  vec.db summary embeddings to prune (post-wipe):    ${orphanSumPreview}`);
  console.log(`  vec.db observation embeddings to prune (existing): ${orphanObsPreview}`);
} else {
  console.log(`  vec.db not found — nothing to prune there.`);
}

if (importedCount === 0 && fingerprintCount === 0 && orphanSumPreview === 0 && orphanObsPreview === 0) {
  console.log(`\nNothing to do — AgentMemory already has no imported rows.`);
  process.exit(0);
}

if (!apply) {
  console.log(`\nDry-run only. To actually wipe:`);
  console.log(`  node ${process.argv[1]} --apply`);
  process.exit(0);
}

// ─── Apply on main DB ─────────────────────────────────────────────────
const tx = db.transaction(() => {
  const sumRes = db
    .prepare(`DELETE FROM session_summaries WHERE source_ide LIKE 'imported:%'`)
    .run();
  const fpRes = db
    .prepare(`DELETE FROM import_history_fingerprints`)
    .run();
  return { summaries: sumRes.changes, fingerprints: fpRes.changes };
});

const purged = tx();
console.log(`\nMain DB wiped:`);
console.log(`  summaries deleted:    ${purged.summaries}`);
console.log(`  fingerprints deleted: ${purged.fingerprints}`);

// ─── Apply on vec.db (orphan prune) ───────────────────────────────────
if (existsSync(vecPath)) {
  const vec = new Database(vecPath);
  sqliteVec.load(vec);
  vec.exec(`ATTACH DATABASE '${dbPath.replace(/\\/g, '/')}' AS main_db`);
  const orphSum = vec
    .prepare(
      `SELECT d.sqlite_id AS id, d.rowid AS vec_rowid
       FROM docs d
       WHERE d.kind = 'session_summary'
         AND NOT EXISTS (SELECT 1 FROM main_db.session_summaries s WHERE s.id = d.sqlite_id)`,
    )
    .all();
  const orphObs = vec
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
    for (const o of orphSum) {
      delVec.run(BigInt(o.vec_rowid));
      delDoc.run('session_summary', o.id);
      n += 1;
    }
    for (const o of orphObs) {
      delVec.run(BigInt(o.vec_rowid));
      delDoc.run('observation', o.id);
      n += 1;
    }
    return n;
  });
  const removed = txVec();
  console.log(`vec.db pruned: ${removed} orphan rows (${orphSum.length} summary, ${orphObs.length} observation)`);
  vec.close();
}

console.log(`\nDone. Next steps:`);
console.log(`  1. Quit AgentMemory from the tray (right-click tray icon → 退出).`);
console.log(`  2. Install D:\\agent-memory\\desktop\\release5\\AgentMemory-Setup-2.1.0-beta.8.exe`);
console.log(`  3. The new build will auto-import + auto-reindex with the fixed cwd resolution.`);

db.close();
