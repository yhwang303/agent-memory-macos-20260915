/**
 * Idempotency layer for the history import feature (per-session granularity).
 *
 * Wraps the `import_history_fingerprints` table created in
 * `services/sqlite/Database.ts:initializeTables`. Schema columns kept as-is
 * for backward compatibility with the per-turn era; `turn_index` is no longer
 * meaningful at session granularity and is written as 0.
 *
 * Lookup key is the `fingerprint` column = sha256(adapterId|sessionId), so
 * "have I already imported this IDE session?" is a single primary-key read.
 *
 * The orchestrator uses this once per session:
 *
 *   if (skipFingerprinted && hasFingerprint(session.fingerprint)) continue;
 *   const summaryId = insertSummary(...);
 *   recordSessionFingerprint(session, summaryId);
 *
 * `--reset <adapter>` deletes both the fingerprints and the linked summary
 * rows for that adapter so the next run reimports from scratch.
 */

import { getDatabase } from '../sqlite/Database.js';
import type { ImportAdapterId, SessionData } from './types.js';

export interface FingerprintRow {
  fingerprint: string;
  adapter_id: ImportAdapterId;
  file_path: string;
  turn_index: number;        // legacy column; always 0 at session granularity
  summary_id: number | null;
  imported_at: number;
}

/** Returns true iff a row with this fingerprint already exists. */
export function hasFingerprint(fingerprint: string): boolean {
  const db = getDatabase();
  const row = db
    .prepare(
      'SELECT 1 FROM import_history_fingerprints WHERE fingerprint = ?',
    )
    .get(fingerprint);
  return !!row;
}

/**
 * Bulk-fetch which of `fingerprints` already exist. Used by the orchestrator
 * to pre-filter a discovered SessionTask[] in one round-trip instead of N reads.
 */
export function getExistingFingerprints(fingerprints: string[]): Set<string> {
  if (fingerprints.length === 0) return new Set();
  const db = getDatabase();
  // Chunk to stay under SQLite's variable-count default (~999).
  const out = new Set<string>();
  const CHUNK = 500;
  for (let i = 0; i < fingerprints.length; i += CHUNK) {
    const chunk = fingerprints.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT fingerprint FROM import_history_fingerprints WHERE fingerprint IN (${placeholders})`,
      )
      .all(...chunk) as Array<{ fingerprint: string }>;
    for (const r of rows) out.add(r.fingerprint);
  }
  return out;
}

/**
 * Record a successful session import. `summaryId` is the row id from
 * `insertImportedSummary()` so we can later cascade-delete on `--reset`.
 */
export function recordSessionFingerprint(
  session: SessionData,
  summaryId: number | null,
): void {
  const db = getDatabase();
  db.prepare(
    `INSERT OR REPLACE INTO import_history_fingerprints
       (fingerprint, adapter_id, file_path, turn_index, summary_id, imported_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    session.fingerprint,
    session.adapterId,
    session.filePath,
    0,
    summaryId,
    Date.now(),
  );
}

/**
 * Record a successful per-turn import. `summaryId` is the row id from
 * `insertImportedSummary()`. Per-turn granularity (v1.1) stores one row
 * per turn so each AI-generated summary has its own fingerprint slot,
 * matching online hook behavior (1 stop event = 1 fingerprint).
 */
export function recordTurnFingerprint(
  turn: import('./types.js').Turn,
  summaryId: number | null,
): void {
  const db = getDatabase();
  db.prepare(
    `INSERT OR REPLACE INTO import_history_fingerprints
       (fingerprint, adapter_id, file_path, turn_index, summary_id, imported_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    turn.fingerprint,
    turn.adapterId,
    turn.filePath,
    turn.turnIndex,
    summaryId,
    Date.now(),
  );
}

/** Count fingerprints for one adapter (or all). */
export function countFingerprints(adapterId?: ImportAdapterId): number {
  const db = getDatabase();
  if (adapterId) {
    const row = db
      .prepare(
        'SELECT COUNT(*) AS n FROM import_history_fingerprints WHERE adapter_id = ?',
      )
      .get(adapterId) as { n: number };
    return row.n;
  }
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM import_history_fingerprints')
    .get() as { n: number };
  return row.n;
}

/**
 * Reset one adapter's import state: delete its fingerprints AND any linked
 * summary rows. Used by `agent-memory import-history --reset <adapter>`.
 *
 * Returns counts for diagnostic reporting.
 */
export function resetAdapter(adapterId: ImportAdapterId): {
  fingerprintsDeleted: number;
  summariesDeleted: number;
} {
  const db = getDatabase();
  const tx = db.transaction((id: ImportAdapterId) => {
    // Capture summary ids first so we can delete the linked rows even though
    // there's no real foreign key.
    const summaryIds = db
      .prepare(
        `SELECT summary_id FROM import_history_fingerprints
         WHERE adapter_id = ? AND summary_id IS NOT NULL`,
      )
      .all(id) as Array<{ summary_id: number }>;

    let summariesDeleted = 0;
    if (summaryIds.length > 0) {
      const stmt = db.prepare('DELETE FROM session_summaries WHERE id = ?');
      for (const r of summaryIds) {
        const res = stmt.run(r.summary_id);
        summariesDeleted += res.changes;
      }
    }

    const fpRes = db
      .prepare(
        'DELETE FROM import_history_fingerprints WHERE adapter_id = ?',
      )
      .run(id);
    return {
      fingerprintsDeleted: fpRes.changes,
      summariesDeleted,
    };
  });
  return tx(adapterId);
}

/**
 * Compute the hook coverage window: the [MIN, MAX] timestamp range of
 * non-imported session_summaries rows. Sessions whose `lastTurnAtMs` falls
 * inside this window are likely to have been captured by the online Stop
 * hook already, so we skip them by default.
 *
 * Returns null when there are no hook-captured rows yet (e.g. fresh AgentMemory
 * install) — caller treats that as "no overlap, import everything".
 */
export function getHookCoverageWindow(): {
  minMs: number;
  maxMs: number;
  count: number;
} | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT
         MIN(created_at_epoch) AS min_ms,
         MAX(created_at_epoch) AS max_ms,
         COUNT(*) AS n
       FROM session_summaries
       WHERE source_ide IS NULL OR source_ide NOT LIKE 'imported:%'`,
    )
    .get() as { min_ms: number | null; max_ms: number | null; n: number };
  if (!row || row.n === 0 || row.min_ms == null || row.max_ms == null) {
    return null;
  }
  return { minMs: row.min_ms, maxMs: row.max_ms, count: row.n };
}

/**
 * Look up whether the hook coverage window contains any row for the same
 * project, within ±toleranceMs of the given timestamp. We use this when the
 * lastTurnAtMs of a transcript falls inside the global coverage window — to
 * confirm that hook actually captured *this specific session's project*
 * around *this specific time*, not just "some session somewhere".
 *
 * The project match is path-family aware (case-insensitive, normalized
 * slashes): exact matches, hook parent -> imported child, and imported
 * parent -> hook child all count as the same project. This is important for
 * Codex App, whose live hook may store `~/Documents/Codex` while historical
 * transcript import derives `~/Documents/Codex/<date>/<slug>`.
 */
export function hasHookSummaryNear(
  project: string | null,
  atMs: number,
  toleranceMs = 4 * 60 * 60 * 1000, // ±4 hours
): boolean {
  if (!project) return false;
  return hasHookSummaryInRange(project, atMs - toleranceMs, atMs + toleranceMs);
}

export function normalizeProjectForOverlap(project: string | null | undefined): string {
  return (project ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/+$/g, '')
    .toLowerCase();
}

export function projectsOverlapForImport(
  hookProject: string | null | undefined,
  importProject: string | null | undefined,
): boolean {
  const hook = normalizeProjectForOverlap(hookProject);
  const imported = normalizeProjectForOverlap(importProject);
  if (!hook || !imported) return false;
  return (
    hook === imported ||
    hook.startsWith(imported + '/') ||
    imported.startsWith(hook + '/')
  );
}

/**
 * Asymmetric / explicit-range version of `hasHookSummaryNear`. Use this when
 * you know the actual turn boundaries.
 *
 * Why this exists (the bug we fixed): the online Stop hook fires AFTER the
 * assistant finishes responding, so its `created_at_epoch` ≈ end-of-turn.
 * Imports use `turn.startedAt` (start-of-turn) as the row timestamp. The gap
 * between them = "agent processing time", which can easily be 30+ minutes
 * for a long tool-using turn. A symmetric ±5min window around start-of-turn
 * misses the hook row sitting at end-of-turn → duplicate summaries.
 *
 * Correct semantics: for a turn starting at t_i and ending around t_{i+1},
 * any hook summary in the inclusive range [t_i - epsilon, t_{i+1} + epsilon]
 * for the same project is the SAME conversation captured online. Caller
 * supplies fromMs / toMs computed from neighbor turns (see orchestrator).
 */
export function hasHookSummaryInRange(
  project: string | null,
  fromMs: number,
  toMs: number,
): boolean {
  if (!project) return false;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return false;
  const db = getDatabase();
  const normalized = normalizeProjectForOverlap(project);
  if (!normalized) return false;
  const rows = db
    .prepare(
      `SELECT project FROM session_summaries
       WHERE (source_ide IS NULL OR source_ide NOT LIKE 'imported:%')
         AND created_at_epoch BETWEEN ? AND ?
         AND project IS NOT NULL
         AND (
           lower(rtrim(replace(project, '\\', '/'), '/')) = ?
           OR lower(rtrim(replace(project, '\\', '/'), '/')) LIKE ?
           OR ? LIKE lower(rtrim(replace(project, '\\', '/'), '/')) || '/%'
         )
       LIMIT 1`,
    )
    .all(fromMs, toMs, normalized, normalized + '/%', normalized) as Array<{ project: string | null }>;
  return rows.some((row) => projectsOverlapForImport(row.project, normalized));
}

/**
 * Project-agnostic version of `hasHookSummaryInRange`. Used as a defence-in-
 * depth pass for the case where the import's cwd diverges from what hook
 * captured (e.g. claude `/cwd` drift mid-session — the per-line `cwd` field
 * we read for the import differs from the OS process cwd hook saw, so a
 * project-matched query misses the duplicate).
 *
 * Window must be tight to avoid false positives — two genuinely different
 * conversations starting in different projects within ±10 min are rare but
 * possible. Caller decides the bound; orchestrator uses ±10 min.
 */
export function hasHookSummaryInRangeAnyProject(
  fromMs: number,
  toMs: number,
): boolean {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return false;
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT 1 FROM session_summaries
       WHERE (source_ide IS NULL OR source_ide NOT LIKE 'imported:%')
         AND created_at_epoch BETWEEN ? AND ?
       LIMIT 1`,
    )
    .get(fromMs, toMs);
  return !!row;
}
