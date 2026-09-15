/**
 * CRUD operations for the natural_selection table.
 * Natural selections are user-defined constraints that guide the evolution engine.
 */
import { getDatabase } from '../../../services/sqlite/Database.js';
import { NaturalSelectionRow } from '../types.js';

export function insertNaturalSelection(
  entry: Omit<NaturalSelectionRow, 'id' | 'created_at'>
): number {
  const db = getDatabase();
  const result = db.prepare(`
    INSERT INTO natural_selection (title, content, scope, type, enabled)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    entry.title,
    entry.content,
    entry.scope ?? 'all',
    entry.type ?? 'append',
    entry.enabled ?? 1,
  );
  return result.lastInsertRowid as number;
}

export function getAllNaturalSelections(enabledOnly = true): NaturalSelectionRow[] {
  const db = getDatabase();
  if (enabledOnly) {
    return db.prepare(
      'SELECT * FROM natural_selection WHERE enabled = 1 ORDER BY id ASC'
    ).all() as NaturalSelectionRow[];
  }
  return db.prepare(
    'SELECT * FROM natural_selection ORDER BY id ASC'
  ).all() as NaturalSelectionRow[];
}

export function getNaturalSelectionById(id: number): NaturalSelectionRow | undefined {
  return getDatabase().prepare(
    'SELECT * FROM natural_selection WHERE id = ?'
  ).get(id) as NaturalSelectionRow | undefined;
}

export function updateNaturalSelection(
  id: number,
  patch: Partial<Pick<NaturalSelectionRow, 'title' | 'content' | 'scope' | 'type' | 'enabled'>>
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
  db.prepare(`UPDATE natural_selection SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function deleteNaturalSelection(id: number): void {
  getDatabase().prepare('DELETE FROM natural_selection WHERE id = ?').run(id);
}

export function toggleNaturalSelection(id: number, enabled: boolean): void {
  getDatabase().prepare(
    'UPDATE natural_selection SET enabled = ? WHERE id = ?'
  ).run(enabled ? 1 : 0, id);
}
