/**
 * CRUD operations for the evolved_rules table.
 */
import { getDatabase } from '../../../services/sqlite/Database.js';
import { normalizeProjectPath } from '../../../types/database.js';
import { EvolvedRuleRow, PendingItem } from '../types.js';

export function insertRule(
  rule: Omit<EvolvedRuleRow, 'id' | 'created_at' | 'updated_at'>
): number {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO evolved_rules (
      workspace, title, content, category, slug, paths_glob,
      source_session_id, evidence, status, rule_type,
      quality_score, feedback, audit_status, review_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    normalizeProjectPath(rule.workspace),
    rule.title,
    rule.content,
    rule.category ?? 'general',
    rule.slug ?? null,
    rule.paths_glob ?? null,
    rule.source_session_id ?? null,
    rule.evidence ?? null,
    rule.status ?? 'active',
    rule.rule_type ?? 'user_evolved',
    rule.quality_score ?? null,
    rule.feedback ?? null,
    rule.audit_status ?? 'pending',
    rule.review_status ?? 'manual',
  );
  return result.lastInsertRowid as number;
}

export function upsertRule(
  rule: Omit<EvolvedRuleRow, 'id' | 'created_at' | 'updated_at'>
): number {
  const db = getDatabase();
  const existing = db.prepare(
    'SELECT id FROM evolved_rules WHERE workspace = ? AND title = ?'
  ).get(normalizeProjectPath(rule.workspace), rule.title) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE evolved_rules
      SET content = ?, category = ?, slug = ?, paths_glob = ?,
          source_session_id = ?, evidence = ?, status = ?,
          quality_score = ?, feedback = ?, audit_status = ?, review_status = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ?
    `).run(
      rule.content,
      rule.category ?? 'general',
      rule.slug ?? null,
      rule.paths_glob ?? null,
      rule.source_session_id ?? null,
      rule.evidence ?? null,
      rule.status ?? 'active',
      rule.quality_score ?? null,
      rule.feedback ?? null,
      rule.audit_status ?? 'pending',
      rule.review_status ?? 'manual',
      existing.id,
    );
    return existing.id;
  }
  return insertRule(rule);
}

export function getRulesByWorkspace(
  workspace: string,
  opts: { status?: string; audit_status?: string; category?: string; limit?: number } = {}
): EvolvedRuleRow[] {
  const db = getDatabase();
  const ws = normalizeProjectPath(workspace);
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (ws) { conditions.push('workspace = ?'); params.push(ws); }
  if (opts.status) { conditions.push('status = ?'); params.push(opts.status); }
  if (opts.audit_status) { conditions.push('audit_status = ?'); params.push(opts.audit_status); }
  if (opts.category) { conditions.push('category = ?'); params.push(opts.category); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit ?? 500;
  return db.prepare(
    `SELECT * FROM evolved_rules ${where} ORDER BY updated_at DESC LIMIT ?`
  ).all(...params, limit) as EvolvedRuleRow[];
}

export function getRuleById(id: number): EvolvedRuleRow | undefined {
  return getDatabase().prepare('SELECT * FROM evolved_rules WHERE id = ?').get(id) as EvolvedRuleRow | undefined;
}

export function getPendingRules(workspace: string): PendingItem[] {
  const db = getDatabase();
  const ws = normalizeProjectPath(workspace);
  const rows = db.prepare(
    `SELECT id, 'rule' as type, title, content, workspace, source_session_id, quality_score, created_at
     FROM evolved_rules WHERE workspace = ? AND audit_status = 'pending'
     ORDER BY created_at DESC`
  ).all(ws) as PendingItem[];
  return rows;
}

export function approveRule(id: number): void {
  getDatabase().prepare(
    `UPDATE evolved_rules SET audit_status = 'approved', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`
  ).run(id);
}

export function rejectRule(id: number, reason: string): void {
  getDatabase().prepare(
    `UPDATE evolved_rules SET audit_status = 'rejected', feedback = ?, status = 'rejected',
     updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`
  ).run(reason, id);
}

export function updateRuleQuality(id: number, score: number, feedback: string): void {
  getDatabase().prepare(
    `UPDATE evolved_rules SET quality_score = ?, feedback = ?,
     updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`
  ).run(score, feedback, id);
}

export function countRulesByWorkspace(workspace: string): number {
  const result = getDatabase().prepare(
    `SELECT COUNT(*) as n FROM evolved_rules WHERE workspace = ? AND status = 'active'`
  ).get(normalizeProjectPath(workspace)) as { n: number };
  return result.n;
}
