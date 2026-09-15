/**
 * Database write helper for the history import feature.
 *
 * Lives separately from `services/sqlite/summaries.ts` so the live
 * (hook-captured) summary insert path stays untouched. The imported row
 * is shaped identically except it also stamps the `source_ide` column
 * (e.g. `imported:claude`), which is what later lets search and dashboards
 * tell apart "live" rows from "retroactively imported" ones.
 */

import { getDatabase } from '../sqlite/Database.js';
import {
  normalizeProjectPath,
  normalizeTimestamp,
} from '../../types/database.js';
import type { ParsedSummary } from '../../sdk/parser.js';
import type { ImportAdapterId } from './types.js';
import { buildSourceIdeTag } from './turn-utils.js';

export interface ImportedSummaryInput {
  /** Synthetic session id, e.g. `imp:claude:<sessionId>` (per-session granularity). */
  memorySessionId: string;
  /** Project / cwd label (will be lowercased + normalized for storage). */
  project: string;
  /** Adapter that produced this summary; stamped to source_ide. */
  adapterId: ImportAdapterId;
  /** AI-parsed summary fields (any may be null). */
  parsed: ParsedSummary;
  /** Original transcript file absolute path — appended to <notes> for lineage. */
  originalPath: string;
  /**
   * Session "created_at" timestamp in epoch ms. We stamp this on the row's
   * `created_at_epoch` column so the hook-overlap window check (in future
   * runs / on the same DB) treats imported rows as occupying their *original*
   * time slot, not the time we ran the import.
   */
  startedAtMs: number;
}

/**
 * Insert an imported summary row.
 *
 * Identical column set to the live `insertSummary` path PLUS source_ide.
 * The `notes` field gets a trailing `; original_path=<abs>` appended so
 * even if `source_ide` is later cleared the lineage survives.
 *
 * Returns the new row id, or null if the insert was rejected (e.g.
 * placeholder content). Callers can pair this with recordFingerprint().
 */
export function insertImportedSummary(input: ImportedSummaryInput): number {
  const db = getDatabase();
  const { isoString, epoch } = normalizeTimestamp(new Date(input.startedAtMs));
  const sourceIde = buildSourceIdeTag(input.adapterId, input.originalPath);
  let project = normalizeProjectPath(input.project);

  // Project-basename merge: when the adapter could only recover a basename
  // (e.g. codebuddy-ide returns `agent-memory` from genie-cache, with no
  // drive letter or absolute path), try to match it against the existing
  // distinct project values in session_summaries. If there's exactly one
  // project that ends with `/<basename>` (or equals it), substitute. This
  // keeps imported codebuddy-ide rows merged into the user's existing
  // project entries instead of spawning a parallel `agent-memory` entry
  // alongside `d:/agent-memory` in the project dropdown.
  if (project && !project.includes('/') && !project.startsWith('unknown:')) {
    const matches = db
      .prepare(
        `SELECT DISTINCT project FROM session_summaries
         WHERE project IS NOT NULL AND project <> ''
           AND (project = ? OR lower(replace(project, '\\', '/')) LIKE ?)`,
      )
      .all(project, '%/' + project) as Array<{ project: string }>;
    if (matches.length === 1) {
      project = matches[0].project;
    }
  }

  // Append original_path to notes for permanent provenance, in case the
  // source_ide column ever gets cleared.
  const baseNotes = input.parsed.notes ?? '';
  const augmentedNotes = baseNotes
    ? `${baseNotes}; original_path=${input.originalPath}`
    : `imported_from=${input.adapterId}; original_path=${input.originalPath}`;

  const stmt = db.prepare(
    `INSERT INTO session_summaries (
       memory_session_id, project, request, investigated, learned,
       media_context, meta_intent, completed, next_steps,
       files_read, files_edited, notes,
       prompt_number, discovery_tokens,
       created_at, created_at_epoch,
       source_ide
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const result = stmt.run(
    input.memorySessionId,
    project,
    input.parsed.request,
    input.parsed.investigated,
    input.parsed.learned,
    input.parsed.media_context,
    input.parsed.meta_intent,
    input.parsed.completed,
    input.parsed.next_steps,
    null, // files_read — not derivable from a transcript without observations
    null, // files_edited — same
    augmentedNotes,
    0, // prompt_number — n/a for imports
    0, // discovery_tokens
    isoString,
    epoch,
    sourceIde,
  );

  return result.lastInsertRowid as number;
}
