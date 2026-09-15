/**
 * One-shot cleanup for the dev tester's machine: delete imported summary rows
 * that duplicate an online (hook-captured) summary for the same project, when
 * the buggy ±5min hook-overlap window in beta.8 mid-development missed them.
 *
 * Why this exists: in beta.8 the hook-overlap pre-filter used a symmetric
 * ±5min window around `turn.startedAt`. But hook fires AFTER the assistant
 * finishes responding, so its `created_at_epoch` ≈ end-of-turn — the gap
 * between start-of-turn and hook-time = "agent processing time" can be
 * 30+ minutes for a long tool-using turn. A tight ±5min window misses the
 * hook row sitting at end-of-turn → duplicate summaries.
 *
 * The fix landed in turn-boundary-aware orchestrator + audit. This script
 * cleans up the rows that were already mis-imported on the dev tester's
 * machine before the fix shipped, so a re-run of import doesn't re-process
 * those turns.
 *
 * Detection: for each `imported:*` row, look for a NON-imported row in the
 * same project (case-insensitive, slash-normalized) with `created_at_epoch`
 * in [imported.created_at_epoch - 60s, imported.created_at_epoch + 2h].
 * If any exists, the imported row is treated as a duplicate of that hook
 * row and removed (plus its fingerprint + its vec.db entry).
 *
 * The 2h right-bound matches the session-level dedup tolerance the
 * orchestrator uses for flat-timestamp adapters; conservative enough that
 * normal agent processing time fits, narrow enough that two unrelated
 * sessions for the same project don't false-positive.
 *
 * NOT shipped with the product. Only the original dev tester machine has
 * pre-fix imported rows; fresh installs of the new build produce correct
 * dedup directly.
 *
 * Usage (run from D:\agent-memory):
 *   node scripts/cleanup-duplicate-imports.mjs                     # dry-run, prints what would be deleted
 *   node scripts/cleanup-duplicate-imports.mjs --apply             # delete same-project matches only
 *   node scripts/cleanup-duplicate-imports.mjs --cross-project     # dry-run incl. cross-project preview
 *   node scripts/cleanup-duplicate-imports.mjs --apply --cross-project   # delete same-project + cross-project (review the preview first!)
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

const apply = process.argv.includes('--apply');
/**
 * Cross-project pass is opt-in to avoid accidentally deleting unrelated
 * import rows that happened to land within 2h of a hook row in another
 * project. Pass `--cross-project` to enable. The dry-run output always
 * shows what WOULD be matched cross-project so the user can decide.
 */
const includeCrossProject = process.argv.includes('--cross-project');
const dataDir = join(homedir(), '.agent-memory');
const dbPath = join(dataDir, 'agent-memory.db');
const vecPath = join(dataDir, 'vec.db');

const LEFT_PAD_MS = 60 * 1000;            // -60s tolerance to the left
const RIGHT_BOUND_MS = 2 * 60 * 60 * 1000; // +2h to the right (project match)
/**
 * For the project-AGNOSTIC fallback pass we previously used 10 minutes,
 * but that turned out to be too tight for long agentic turns where the
 * agent processes for 10–30+ minutes between user message and Stop hook.
 * Bump to the same 2h ceiling as the project-matched pass — relying on
 * the temporal coincidence to be the strong signal. False positives
 * (two unrelated conversations in different projects starting within 2h
 * of each other) are bounded by the per-turn fingerprint never
 * re-running the same import twice.
 */
const PROJECT_AGNOSTIC_RIGHT_MS = 2 * 60 * 60 * 1000;

// ─── Phase 1: identify dup imported rows ───────────────────────────────
const db = new Database(dbPath);
const importedRows = db
  .prepare(
    `SELECT id, memory_session_id, project, source_ide, created_at_epoch
     FROM session_summaries
     WHERE source_ide LIKE 'imported:%'
     ORDER BY id ASC`,
  )
  .all();

const findHookHitProject = db.prepare(
  `SELECT id, project, created_at_epoch FROM session_summaries
   WHERE (source_ide IS NULL OR source_ide NOT LIKE 'imported:%')
     AND created_at_epoch BETWEEN ? AND ?
     AND lower(replace(project, '\\', '/')) LIKE ?
   LIMIT 1`,
);

// Project-agnostic version: any hook row in a tight window. Catches the
// "import wrote a different cwd than hook" case that the project-match
// query misses.
const findHookHitAnyProject = db.prepare(
  `SELECT id, project, created_at_epoch FROM session_summaries
   WHERE (source_ide IS NULL OR source_ide NOT LIKE 'imported:%')
     AND created_at_epoch BETWEEN ? AND ?
   LIMIT 1`,
);

const dupIds = [];
const dupReports = [];
const crossProjectPreview = []; // shown but only deleted with --cross-project
for (const r of importedRows) {
  if (!r.created_at_epoch) continue;
  let hit = null;
  let matchKind = '';
  // Pass A: same project, generous +2h right window.
  if (r.project) {
    const normalized = r.project.replace(/\\/g, '/').toLowerCase();
    hit = findHookHitProject.get(
      r.created_at_epoch - LEFT_PAD_MS,
      r.created_at_epoch + RIGHT_BOUND_MS,
      '%' + normalized + '%',
    );
    if (hit) matchKind = 'same-project';
  }
  // Pass B: project-agnostic. Always evaluated for the dry-run preview;
  // only added to the delete set when --cross-project is passed, since
  // false positives (different conversations in different projects within
  // 2h) would be lossy without an explicit opt-in.
  if (!hit) {
    const cross = findHookHitAnyProject.get(
      r.created_at_epoch - LEFT_PAD_MS,
      r.created_at_epoch + PROJECT_AGNOSTIC_RIGHT_MS,
    );
    if (cross) {
      const entry = {
        importedId: r.id,
        hookId: cross.id,
        matchKind: 'cross-project',
        impProject: r.project,
        hookProject: cross.project,
        gapMin: ((cross.created_at_epoch - r.created_at_epoch) / 60000).toFixed(1),
        memSession: r.memory_session_id,
      };
      crossProjectPreview.push(entry);
      if (includeCrossProject) {
        hit = cross;
        matchKind = 'cross-project';
      }
    }
  }
  if (hit) {
    dupIds.push(r.id);
    dupReports.push({
      importedId: r.id,
      hookId: hit.id,
      matchKind,
      impProject: r.project,
      hookProject: hit.project,
      gapMin: ((hit.created_at_epoch - r.created_at_epoch) / 60000).toFixed(1),
      memSession: r.memory_session_id,
    });
  }
}

console.log(`Phase 1 — duplicate imported rows: ${dupIds.length} of ${importedRows.length}`);
const sameProj = dupReports.filter((d) => d.matchKind === 'same-project').length;
const crossProj = dupReports.filter((d) => d.matchKind === 'cross-project').length;
console.log(`  same-project matches (always purged): ${sameProj}`);
if (includeCrossProject) {
  console.log(`  cross-project matches (purged because --cross-project): ${crossProj}`);
} else {
  console.log(`  cross-project candidates (NOT purged — pass --cross-project to include): ${crossProjectPreview.length}`);
}
for (const d of dupReports.slice(0, 20)) {
  const tag = d.matchKind === 'cross-project' ? '⚡' : ' ';
  console.log(`  ${tag} imp#${d.importedId} ↔ hook#${d.hookId}  Δ=${d.gapMin}min  imp=${d.impProject}  hook=${d.hookProject}`);
}
if (dupReports.length > 20) console.log(`  ... and ${dupReports.length - 20} more`);
if (!includeCrossProject && crossProjectPreview.length > 0) {
  console.log(`\nCross-project preview (would be purged with --cross-project):`);
  for (const d of crossProjectPreview.slice(0, 10)) {
    console.log(`  ⚡ imp#${d.importedId} ↔ hook#${d.hookId}  Δ=${d.gapMin}min  imp=${d.impProject}  hook=${d.hookProject}`);
  }
  if (crossProjectPreview.length > 10) {
    console.log(`  ... and ${crossProjectPreview.length - 10} more`);
  }
}

if (!apply) {
  console.log(`\nDry-run only. To actually delete: node ${process.argv[1]} --apply`);
  process.exit(0);
}

// ─── Apply: delete summaries + fingerprints ────────────────────────────
const tx = db.transaction(() => {
  let summariesDeleted = 0;
  let fingerprintsDeleted = 0;
  if (dupIds.length === 0) return { summariesDeleted, fingerprintsDeleted };
  // Delete in chunks to stay under SQLite's bind-var limit.
  const CHUNK = 500;
  for (let i = 0; i < dupIds.length; i += CHUNK) {
    const chunk = dupIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    fingerprintsDeleted += db
      .prepare(`DELETE FROM import_history_fingerprints WHERE summary_id IN (${placeholders})`)
      .run(...chunk).changes;
    summariesDeleted += db
      .prepare(`DELETE FROM session_summaries WHERE id IN (${placeholders})`)
      .run(...chunk).changes;
  }
  return { summariesDeleted, fingerprintsDeleted };
});

const r = tx();
console.log(`\nPhase 1 done: deleted ${r.summariesDeleted} summaries + ${r.fingerprintsDeleted} fingerprints`);

// ─── Phase 2: prune vec.db orphans (incl. ones we just created) ────────
if (existsSync(vecPath)) {
  const vec = new Database(vecPath);
  sqliteVec.load(vec);
  vec.exec(`ATTACH DATABASE '${dbPath.replace(/\\/g, '/')}' AS main_db`);
  const orphanSum = vec
    .prepare(
      `SELECT d.sqlite_id AS id, d.rowid AS vec_rowid
       FROM docs d
       WHERE d.kind = 'session_summary'
         AND NOT EXISTS (SELECT 1 FROM main_db.session_summaries s WHERE s.id = d.sqlite_id)`,
    )
    .all();
  const orphanObs = vec
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
    for (const o of orphanSum) {
      delVec.run(BigInt(o.vec_rowid));
      delDoc.run('session_summary', o.id);
      n += 1;
    }
    for (const o of orphanObs) {
      delVec.run(BigInt(o.vec_rowid));
      delDoc.run('observation', o.id);
      n += 1;
    }
    return n;
  });
  const removed = txVec();
  console.log(`Phase 2 done: pruned ${removed} orphan vector rows (${orphanSum.length} summary, ${orphanObs.length} observation)`);
  vec.close();
} else {
  console.log('Phase 2 skipped: vec.db not found (no vector index yet)');
}

console.log('\nNext steps:');
console.log('  1. Re-run import: it will skip already-correctly-imported turns and pick up the rest with the fixed hook-overlap window.');
console.log('  2. Re-run reindex if vec.db count changed.');
