/**
 * CRUD operations for the evolved_skills table.
 */
import { getDatabase } from '../../../services/sqlite/Database.js';
import { normalizeProjectPath } from '../../../types/database.js';
import { EvolvedSkillRow, PendingItem } from '../types.js';

export function insertSkill(
  skill: Omit<EvolvedSkillRow, 'id' | 'created_at' | 'updated_at'>
): number {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO evolved_skills (
      workspace, slug, name, trigger_scene, description, skill_kind,
      skill_md, manifest_json, source_session_id, evidence,
      status, quality_score, audit_status, review_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    normalizeProjectPath(skill.workspace),
    skill.slug,
    skill.name,
    skill.trigger_scene ?? null,
    skill.description ?? null,
    skill.skill_kind ?? 'markdown',
    skill.skill_md ?? null,
    skill.manifest_json ?? null,
    skill.source_session_id ?? null,
    skill.evidence ?? null,
    skill.status ?? 'active',
    skill.quality_score ?? null,
    skill.audit_status ?? 'pending',
    skill.review_status ?? 'manual',
  );
  return result.lastInsertRowid as number;
}

export function upsertSkill(
  skill: Omit<EvolvedSkillRow, 'id' | 'created_at' | 'updated_at'>
): number {
  const db = getDatabase();
  const ws = normalizeProjectPath(skill.workspace);
  const existing = db.prepare(
    'SELECT id FROM evolved_skills WHERE workspace = ? AND slug = ?'
  ).get(ws, skill.slug) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE evolved_skills
      SET name = ?, trigger_scene = ?, description = ?, skill_kind = ?,
          skill_md = ?, manifest_json = ?, source_session_id = ?, evidence = ?,
          status = ?, quality_score = ?, audit_status = ?, review_status = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?
    `).run(
      skill.name,
      skill.trigger_scene ?? null,
      skill.description ?? null,
      skill.skill_kind ?? 'markdown',
      skill.skill_md ?? null,
      skill.manifest_json ?? null,
      skill.source_session_id ?? null,
      skill.evidence ?? null,
      skill.status ?? 'active',
      skill.quality_score ?? null,
      skill.audit_status ?? 'pending',
      skill.review_status ?? 'manual',
      existing.id,
    );
    return existing.id;
  }
  return insertSkill(skill);
}

export function getSkillsByWorkspace(
  workspace: string,
  opts: { status?: string; audit_status?: string; limit?: number } = {}
): EvolvedSkillRow[] {
  const db = getDatabase();
  const ws = normalizeProjectPath(workspace);
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (ws) { conditions.push('workspace = ?'); params.push(ws); }
  if (opts.status) { conditions.push('status = ?'); params.push(opts.status); }
  if (opts.audit_status) { conditions.push('audit_status = ?'); params.push(opts.audit_status); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit ?? 500;
  return db.prepare(
    `SELECT * FROM evolved_skills ${where} ORDER BY updated_at DESC LIMIT ?`
  ).all(...params, limit) as EvolvedSkillRow[];
}

export function getSkillById(id: number): EvolvedSkillRow | undefined {
  return getDatabase().prepare('SELECT * FROM evolved_skills WHERE id = ?').get(id) as EvolvedSkillRow | undefined;
}

export function getSkillBySlug(workspace: string, slug: string): EvolvedSkillRow | undefined {
  return getDatabase().prepare(
    'SELECT * FROM evolved_skills WHERE workspace = ? AND slug = ?'
  ).get(normalizeProjectPath(workspace), slug) as EvolvedSkillRow | undefined;
}

export function getPendingSkills(workspace: string): PendingItem[] {
  const db = getDatabase();
  const ws = normalizeProjectPath(workspace);
  const rows = db.prepare(
    `SELECT id, 'skill' as type, name as title, skill_md as content, workspace, source_session_id, quality_score, created_at
     FROM evolved_skills WHERE workspace = ? AND audit_status = 'pending'
     ORDER BY created_at DESC`
  ).all(ws) as PendingItem[];
  return rows;
}

export function approveSkill(id: number): void {
  getDatabase().prepare(
    `UPDATE evolved_skills SET audit_status = 'approved', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`
  ).run(id);
}

export function rejectSkill(id: number): void {
  getDatabase().prepare(
    `UPDATE evolved_skills SET audit_status = 'rejected', status = 'rejected',
     updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`
  ).run(id);
}

export function updateSkillQuality(id: number, score: number): void {
  getDatabase().prepare(
    `UPDATE evolved_skills SET quality_score = ?,
     updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`
  ).run(score, id);
}

export function countSkillsByWorkspace(workspace: string): number {
  const result = getDatabase().prepare(
    `SELECT COUNT(*) as n FROM evolved_skills WHERE workspace = ? AND status = 'active'`
  ).get(normalizeProjectPath(workspace)) as { n: number };
  return result.n;
}
