/**
 * CRUD operations for the evolution_log table.
 */
import { getDatabase } from '../../../services/sqlite/Database.js';
import { normalizeProjectPath } from '../../../types/database.js';
import { EvolutionLogRow } from '../types.js';

export function insertEvoLog(
  entry: Omit<EvolutionLogRow, 'id' | 'created_at'>
): number {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO evolution_log (
      memory_session_id, workspace, rules_added, rules_updated,
      skills_added, rejected_rules, rejected_skills,
      status, error_message, raw_output, duration_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    entry.memory_session_id,
    normalizeProjectPath(entry.workspace),
    entry.rules_added ?? 0,
    entry.rules_updated ?? 0,
    entry.skills_added ?? 0,
    entry.rejected_rules ?? 0,
    entry.rejected_skills ?? 0,
    entry.status,
    entry.error_message ?? null,
    entry.raw_output ?? null,
    entry.duration_ms ?? null,
  );
  return result.lastInsertRowid as number;
}

export function updateEvoLog(
  id: number,
  patch: Partial<Pick<EvolutionLogRow,
    'rules_added' | 'rules_updated' | 'skills_added' | 'rejected_rules' | 'rejected_skills' |
    'status' | 'error_message' | 'raw_output' | 'duration_ms'>>
): void {
  const db = getDatabase();
  const sets: string[] = [];
  const params: unknown[] = [];

  for (const [key, val] of Object.entries(patch)) {
    sets.push(`${key} = ?`);
    params.push(val);
  }
  if (sets.length === 0) return;

  params.push(id);
  db.prepare(`UPDATE evolution_log SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function getEvoLogBySession(memorySessionId: string): EvolutionLogRow | undefined {
  return getDatabase().prepare(
    'SELECT * FROM evolution_log WHERE memory_session_id = ? ORDER BY id DESC LIMIT 1'
  ).get(memorySessionId) as EvolutionLogRow | undefined;
}

export function getEvoLogByWorkspace(
  workspace: string,
  limit = 50
): EvolutionLogRow[] {
  const ws = normalizeProjectPath(workspace);
  if (ws) {
    return getDatabase().prepare(
      'SELECT * FROM evolution_log WHERE workspace = ? ORDER BY created_at DESC LIMIT ?'
    ).all(ws, limit) as EvolutionLogRow[];
  }
  return getDatabase().prepare(
    'SELECT * FROM evolution_log ORDER BY created_at DESC LIMIT ?'
  ).all(limit) as EvolutionLogRow[];
}

export function getRecentEvoLogs(limit = 20): EvolutionLogRow[] {
  return getDatabase().prepare(
    'SELECT * FROM evolution_log ORDER BY created_at DESC LIMIT ?'
  ).all(limit) as EvolutionLogRow[];
}

export function hasEvolvedSession(memorySessionId: string): boolean {
  const row = getDatabase().prepare(
    `SELECT id FROM evolution_log WHERE memory_session_id = ? AND status IN ('completed','skipped') LIMIT 1`
  ).get(memorySessionId);
  return row !== undefined;
}

export interface EvoLogStats {
  totalRulesAdded: number;
  totalSkillsAdded: number;
  totalRuns: number;
  lastRunAt: string | null;
}

export function getEvoStats(workspace: string): EvoLogStats {
  const db = getDatabase();
  const ws = normalizeProjectPath(workspace);
  const row = db.prepare(`
    SELECT
      SUM(rules_added) as totalRulesAdded,
      SUM(skills_added) as totalSkillsAdded,
      COUNT(*) as totalRuns,
      MAX(created_at) as lastRunAt
    FROM evolution_log WHERE workspace = ?
  `).get(ws) as EvoLogStats;
  return row;
}
