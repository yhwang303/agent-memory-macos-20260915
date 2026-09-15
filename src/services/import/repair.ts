/**
 * Repair already-imported summary rows whose project column is a
 * `unknown:<adapterId>` placeholder. Re-runs the adapter's multi-tier cwd
 * recovery on the original transcript path and UPDATEs the project column
 * in place when a real project is now derivable. Used after upgrading
 * from a build with weaker recovery — those orphan rows would otherwise
 * stay unknown forever (the fingerprint dedup blocks re-import).
 *
 * Idempotent: safe to call repeatedly; rows that still can't be recovered
 * are left untouched and counted in `stillUnknown`.
 *
 * Currently only handles codebuddy-ide because that's the only adapter
 * where cwd recovery can fail. Other adapters always have a cwd from
 * jsonl-line content or workspace decode.
 */

import { logger } from '../../utils/logger.js';
import { getDatabase } from '../sqlite/Database.js';
import { CodeBuddyIdeAdapter } from './adapters/codebuddy-ide.js';
import { normalizeProjectPath } from '../../types/database.js';

export interface RepairResult {
  scanned: number;
  updated: number;
  stillUnknown: number;
  details: Array<{
    id: number;
    oldProject: string;
    newProject: string | null;
    notes: string;
  }>;
}

export async function repairImportedProjects(): Promise<RepairResult> {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT id, project, notes
       FROM session_summaries
       WHERE source_ide = 'imported:codebuddy-ide' AND project LIKE 'unknown:%'`,
    )
    .all() as Array<{ id: number; project: string; notes: string | null }>;

  if (rows.length === 0) {
    return { scanned: 0, updated: 0, stillUnknown: 0, details: [] };
  }

  // Run discovery once to populate the wsHash → project map.
  const adapter = new CodeBuddyIdeAdapter();
  const discovery = await adapter.discoverSessions();
  // Build (filePath → file) lookup so we can pull cwd by the original_path
  // recorded in notes.
  const byFilePath = new Map<string, string | null>();
  for (const f of discovery.files) {
    byFilePath.set(f.filePath, f.cwd);
  }

  const result: RepairResult = {
    scanned: rows.length,
    updated: 0,
    stillUnknown: 0,
    details: [],
  };

  const update = db.prepare(
    'UPDATE session_summaries SET project = ? WHERE id = ?',
  );

  for (const row of rows) {
    const originalPath = extractOriginalPath(row.notes);
    let newCwd: string | null = null;
    if (originalPath && byFilePath.has(originalPath)) {
      newCwd = byFilePath.get(originalPath) ?? null;
    }
    if (!newCwd) {
      result.stillUnknown += 1;
      result.details.push({
        id: row.id,
        oldProject: row.project,
        newProject: null,
        notes: 'cwd recovery still failed (likely empty conversation)',
      });
      continue;
    }
    // Run the same basename → full-path substitution as the live insert
    // path so repaired rows merge into existing project entries.
    let project = normalizeProjectPath(newCwd);
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
    update.run(project, row.id);
    result.updated += 1;
    result.details.push({
      id: row.id,
      oldProject: row.project,
      newProject: project,
      notes: 'updated via multi-tier cwd recovery',
    });
  }

  logger.info('IMPORT_API', 'repair-projects complete', {
    scanned: result.scanned,
    updated: result.updated,
    stillUnknown: result.stillUnknown,
  });
  return result;
}

/** Pull `original_path=<absPath>` substring out of the notes column. */
function extractOriginalPath(notes: string | null): string | null {
  if (!notes) return null;
  const m = /original_path=([^;]+)(?:;|$)/.exec(notes);
  if (!m) return null;
  return m[1].trim();
}
