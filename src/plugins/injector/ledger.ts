/**
 * Injection ledger — records what was injected, where, which version, and the
 * pre-write backup so uninstall can restore. Plugin-owned SQLite table.
 *
 * Per project rule, the plugin does NOT import the core Database module; the
 * better-sqlite3 handle is injected via PluginContext. We type it structurally
 * to avoid a hard dependency.
 */
import type { LedgerRow } from './types.js';

/** Minimal structural type for the better-sqlite3 handle we need. */
export interface SqliteLike {
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export interface LedgerInsert {
  workspace: string;
  ide: string;
  injectable_id: string;
  version: string;
  target_path: string;
  mode: string;
  backup: string | null;
}

export function insertLedger(db: SqliteLike, row: LedgerInsert): number {
  const stmt = db.prepare(`
    INSERT INTO injector_ledger
      (workspace, ide, injectable_id, version, target_path, mode, backup)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const res = stmt.run(
    row.workspace,
    row.ide,
    row.injectable_id,
    row.version,
    row.target_path,
    row.mode,
    row.backup,
  );
  return Number(res.lastInsertRowid);
}

export function getLedger(db: SqliteLike, workspace?: string): LedgerRow[] {
  if (workspace) {
    return db
      .prepare('SELECT * FROM injector_ledger WHERE workspace = ? ORDER BY injected_at DESC, id DESC')
      .all(workspace) as LedgerRow[];
  }
  return db
    .prepare('SELECT * FROM injector_ledger ORDER BY injected_at DESC, id DESC')
    .all() as LedgerRow[];
}

export function getLedgerById(db: SqliteLike, id: number): LedgerRow | undefined {
  return db.prepare('SELECT * FROM injector_ledger WHERE id = ?').get(id) as LedgerRow | undefined;
}

/** All ledger rows for a given injectable in a workspace (for uninstall fan-out). */
export function getLedgerByInjectable(
  db: SqliteLike,
  workspace: string,
  injectableId: string,
): LedgerRow[] {
  return db
    .prepare('SELECT * FROM injector_ledger WHERE workspace = ? AND injectable_id = ?')
    .all(workspace, injectableId) as LedgerRow[];
}

export function deleteLedger(db: SqliteLike, id: number): void {
  db.prepare('DELETE FROM injector_ledger WHERE id = ?').run(id);
}

/** How many distinct injectables (in a workspace) reference this target path. */
export function refCountForPath(db: SqliteLike, workspace: string, targetPath: string): number {
  const rows = db
    .prepare('SELECT DISTINCT injectable_id FROM injector_ledger WHERE workspace = ? AND target_path = ?')
    .all(workspace, targetPath) as Array<{ injectable_id: string }>;
  return rows.length;
}
