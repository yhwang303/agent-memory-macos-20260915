/**
 * VectorStore — sqlite-vec backed vector index.
 *
 * Schema:
 *   docs (
 *     rowid          INTEGER PRIMARY KEY AUTOINCREMENT,
 *     kind           TEXT NOT NULL,    -- 'observation' | 'session_summary'
 *     sqlite_id      INTEGER NOT NULL, -- the AgentMemory main DB row id
 *     project        TEXT,
 *     obs_type       TEXT,             -- only for observations
 *     created_at_ms  INTEGER,
 *     UNIQUE(kind, sqlite_id)
 *   )
 *   vec0 USING vec0(vec FLOAT[<dim>])  -- rowid is implicit, MUST match docs.rowid
 *
 * Why a mapping table?
 *   sqlite-vec's vec0 virtual table refuses explicit non-integer PKs and we want
 *   to query by (kind, sqlite_id). The docs table holds business keys; vec0
 *   holds vectors keyed by the same rowid.
 *
 * The two are kept in sync inside a single transaction in upsert().
 */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from './logger.js';

export type DocKind = 'observation' | 'session_summary';

export interface UpsertItem {
  kind: DocKind;
  sqliteId: number;
  project?: string | null;
  obsType?: string | null;
  createdAtMs?: number | null;
  vector: Float32Array;
}

export interface QueryFilter {
  project?: string;
  kind?: DocKind | DocKind[];
  obsType?: string[];
  /** Lower bound for created_at_ms */
  dateStartMs?: number;
  /** Upper bound for created_at_ms */
  dateEndMs?: number;
}

export interface QueryHit {
  kind: DocKind;
  sqliteId: number;
  project: string | null;
  obsType: string | null;
  createdAtMs: number | null;
  /** Cosine distance (lower = closer). sqlite-vec returns L2 by default; we
   * normalize vectors before insert/query so L2 ≈ sqrt(2 - 2*cos). For our
   * RRF use case only the rank ordering matters. */
  distance: number;
}

export class VectorStore {
  private db: Database.Database;
  private readonly dim: number;
  private upsertDocStmt!: Database.Statement;
  private upsertVecStmt!: Database.Statement;
  private deleteDocStmt!: Database.Statement;
  private deleteVecStmt!: Database.Statement;
  private getRowidStmt!: Database.Statement;
  private statsStmt!: Database.Statement;

  constructor(opts: { dbPath: string; dim: number }) {
    this.dim = opts.dim;
    if (!existsSync(dirname(opts.dbPath))) {
      mkdirSync(dirname(opts.dbPath), { recursive: true });
    }
    this.db = new Database(opts.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    sqliteVec.load(this.db);
    const v = this.db.prepare('SELECT vec_version() as v').get() as { v: string };
    logger.info('VectorStore initialized', { path: opts.dbPath, dim: this.dim, sqliteVecVersion: v.v });

    this.initSchema();
    this.prepareStatements();
  }

  close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }

  /** Upsert: replace existing (kind,sqlite_id) → reuse same rowid. */
  upsert(item: UpsertItem): void {
    if (item.vector.length !== this.dim) {
      throw new Error(`Vector dim mismatch: expected ${this.dim}, got ${item.vector.length}`);
    }
    const tx = this.db.transaction((it: UpsertItem) => {
      // Try to find existing rowid for this (kind, sqlite_id)
      const existing = this.getRowidStmt.get(it.kind, it.sqliteId) as { rowid: number } | undefined;

      if (existing) {
        // Update doc metadata + delete old vec, then insert new vec at same rowid
        this.upsertDocStmt.run(
          it.kind,
          it.sqliteId,
          it.project ?? null,
          it.obsType ?? null,
          it.createdAtMs ?? null
        );
        this.deleteVecStmt.run(BigInt(existing.rowid));
        this.db.prepare('INSERT INTO vec_docs(rowid, vec) VALUES (?, ?)')
          .run(BigInt(existing.rowid), Buffer.from(it.vector.buffer));
      } else {
        const r = this.upsertDocStmt.run(
          it.kind,
          it.sqliteId,
          it.project ?? null,
          it.obsType ?? null,
          it.createdAtMs ?? null
        );
        const newRowid = r.lastInsertRowid;
        // sqlite-vec's vec0 table requires BigInt for explicit rowid binds.
        // Plain Number is treated as REAL and rejected with "Only integers
        // are allowed for primary key values".
        const rowidBig = typeof newRowid === 'bigint' ? newRowid : BigInt(newRowid);
        this.db.prepare('INSERT INTO vec_docs(rowid, vec) VALUES (?, ?)')
          .run(rowidBig, Buffer.from(it.vector.buffer));
      }
    });
    tx(item);
  }

  /** Bulk upsert — use one transaction for the whole batch. */
  upsertBatch(items: UpsertItem[]): void {
    const tx = this.db.transaction((batch: UpsertItem[]) => {
      for (const it of batch) this.upsert(it);
    });
    tx(items);
  }

  /** Delete a document by business key. */
  delete(kind: DocKind, sqliteId: number): void {
    const tx = this.db.transaction(() => {
      const existing = this.getRowidStmt.get(kind, sqliteId) as { rowid: number } | undefined;
      if (!existing) return;
      this.deleteVecStmt.run(BigInt(existing.rowid));
      this.deleteDocStmt.run(kind, sqliteId);
    });
    tx();
  }

  /**
   * KNN query. Filters apply on the docs table; we intentionally over-fetch
   * candidates from vec0 then filter, because sqlite-vec doesn't support
   * predicate pushdown into vec MATCH.
   */
  query(queryVec: Float32Array, k: number, filter?: QueryFilter, candidatesK?: number): QueryHit[] {
    if (queryVec.length !== this.dim) {
      throw new Error(`Query dim mismatch: expected ${this.dim}, got ${queryVec.length}`);
    }
    // Over-fetch when filters are present so we still have k post-filter.
    const fetchK = candidatesK ?? (filter ? Math.min(k * 5, 1000) : k);

    const sql = `
      SELECT v.rowid as rowid, v.distance as distance,
             d.kind, d.sqlite_id, d.project, d.obs_type, d.created_at_ms
      FROM vec_docs v
      JOIN docs d ON d.rowid = v.rowid
      WHERE v.vec MATCH ? AND k = ?
      ORDER BY v.distance
    `;
    const rawRows = this.db.prepare(sql).all(Buffer.from(queryVec.buffer), fetchK) as Array<{
      rowid: number;
      distance: number;
      kind: DocKind;
      sqlite_id: number;
      project: string | null;
      obs_type: string | null;
      created_at_ms: number | null;
    }>;

    const filtered = rawRows.filter((r) => this.matchesFilter(r, filter)).slice(0, k);
    return filtered.map((r) => ({
      kind: r.kind,
      sqliteId: r.sqlite_id,
      project: r.project,
      obsType: r.obs_type,
      createdAtMs: r.created_at_ms,
      distance: r.distance,
    }));
  }

  /** Aggregate stats for index_status. */
  stats(): { totalDocs: number; observations: number; summaries: number; byProject: Record<string, number> } {
    const total = this.db.prepare('SELECT COUNT(*) as c FROM docs').get() as { c: number };
    const obs = this.db.prepare("SELECT COUNT(*) as c FROM docs WHERE kind = 'observation'").get() as { c: number };
    const sum = this.db.prepare("SELECT COUNT(*) as c FROM docs WHERE kind = 'session_summary'").get() as { c: number };
    const proj = this.db.prepare('SELECT project, COUNT(*) as c FROM docs WHERE project IS NOT NULL GROUP BY project').all() as Array<{ project: string; c: number }>;
    const byProject: Record<string, number> = {};
    for (const p of proj) byProject[p.project] = p.c;
    return { totalDocs: total.c, observations: obs.c, summaries: sum.c, byProject };
  }

  /** Highest sqlite_id we've indexed for a given kind. Used as the watermark for incremental sync. */
  maxIndexedId(kind: DocKind): number {
    const r = this.db.prepare('SELECT MAX(sqlite_id) as m FROM docs WHERE kind = ?').get(kind) as { m: number | null };
    return r.m ?? 0;
  }

  // ────────────────── internals ──────────────────

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        rowid          INTEGER PRIMARY KEY AUTOINCREMENT,
        kind           TEXT NOT NULL,
        sqlite_id      INTEGER NOT NULL,
        project        TEXT,
        obs_type       TEXT,
        created_at_ms  INTEGER,
        UNIQUE(kind, sqlite_id)
      );
      CREATE INDEX IF NOT EXISTS idx_docs_kind_id ON docs(kind, sqlite_id);
      CREATE INDEX IF NOT EXISTS idx_docs_project ON docs(project);
    `);
    // vec0 virtual table — dim is hard-coded at create time
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_docs USING vec0(vec FLOAT[${this.dim}])`);
  }

  private prepareStatements(): void {
    this.upsertDocStmt = this.db.prepare(`
      INSERT INTO docs(kind, sqlite_id, project, obs_type, created_at_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(kind, sqlite_id) DO UPDATE SET
        project = excluded.project,
        obs_type = excluded.obs_type,
        created_at_ms = excluded.created_at_ms
    `);
    this.upsertVecStmt = this.db.prepare('INSERT INTO vec_docs(rowid, vec) VALUES (?, ?)');
    this.deleteDocStmt = this.db.prepare('DELETE FROM docs WHERE kind = ? AND sqlite_id = ?');
    this.deleteVecStmt = this.db.prepare('DELETE FROM vec_docs WHERE rowid = ?');
    this.getRowidStmt = this.db.prepare('SELECT rowid FROM docs WHERE kind = ? AND sqlite_id = ?');
    this.statsStmt = this.db.prepare('SELECT COUNT(*) as c FROM docs');
  }

  private matchesFilter(row: { kind: DocKind; project: string | null; obs_type: string | null; created_at_ms: number | null }, f?: QueryFilter): boolean {
    if (!f) return true;
    if (f.project && row.project !== f.project) return false;
    if (f.kind) {
      const kinds = Array.isArray(f.kind) ? f.kind : [f.kind];
      if (!kinds.includes(row.kind)) return false;
    }
    if (f.obsType && f.obsType.length > 0) {
      if (!row.obs_type || !f.obsType.includes(row.obs_type)) return false;
    }
    if (typeof f.dateStartMs === 'number' && (row.created_at_ms ?? 0) < f.dateStartMs) return false;
    if (typeof f.dateEndMs === 'number' && (row.created_at_ms ?? Number.MAX_SAFE_INTEGER) > f.dateEndMs) return false;
    return true;
  }
}
