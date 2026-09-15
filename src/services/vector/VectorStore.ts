/**
 * VectorStore — sqlite-vec 向量库封装。
 *
 * 表结构:
 *   docs(rowid PK, kind TEXT, sqlite_id INTEGER, project TEXT, obs_type TEXT,
 *        created_at_ms INTEGER, UNIQUE(kind, sqlite_id))
 *   vec_docs USING vec0(vec FLOAT[<dim>])  -- rowid 隐式,与 docs.rowid 同步
 *
 * 为什么需要 docs 映射表?
 *   sqlite-vec 的 vec0 虚表只接受整数 rowid,且不支持自定义 PK。我们要用
 *   (kind, sqlite_id) 这种业务主键查询,所以另开 docs 表存元数据,用 rowid
 *   关联。upsert 在单事务里同步两边。
 *
 * 这个文件是从 agentmem-hybrid-mcp/src/vectorStore.ts 移植的,主要差异:
 *   - logger 改用 AgentMemory 的 src/utils/logger.ts (category-based API)
 *   - dbPath 由调用方决定(典型: ~/.agent-memory/vec.db)
 *   - 其它逻辑保持一致(已经过 spike 验证)
 */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../../utils/logger.js';

const LOG_CAT = 'hybrid-vec-store';

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
  /** L2 距离;归一化向量下 L2 ≈ sqrt(2 - 2*cos)。RRF 只看 rank,具体值不影响排序。 */
  distance: number;
}

export class VectorStore {
  private db: Database.Database;
  private readonly dim: number;
  private upsertDocStmt!: Database.Statement;
  private deleteDocStmt!: Database.Statement;
  private deleteVecStmt!: Database.Statement;
  private getRowidStmt!: Database.Statement;

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
    logger.info(LOG_CAT, 'VectorStore initialized', {
      path: opts.dbPath,
      dim: this.dim,
      sqliteVecVersion: v.v,
    });

    this.initSchema();
    this.prepareStatements();
  }

  close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }

  /**
   * 强制 WAL checkpoint, 把 -wal 文件中的事务合并回 main db file。
   *
   * 为什么需要: better-sqlite3 默认 WAL 模式 (journal_mode=WAL,
   * synchronous=NORMAL), 写入只先到 -wal, 不会立即合到主库。如果用户从
   * 托盘强杀进程, 而后台 antivirus / OneDrive 抢锁住 -wal 文件, 偶发会
   * 让下次启动看到的 vec.db 行数 < 实际已 embed 行数, 表现就是"重建从头开始"。
   *
   * 在每个 reindex page 完成后 + 进程 shutdown 前主动调一次, 确保数据持久化。
   * 失败 (DB busy/closed) 不抛, 只 warn — flush 是最佳努力。
   */
  flush(): void {
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err) {
      logger.warn(LOG_CAT, 'wal_checkpoint failed (non-fatal)', { error: String(err) });
    }
  }

  /** Upsert: 已存在 (kind,sqlite_id) 则复用同一 rowid。 */
  upsert(item: UpsertItem): void {
    if (item.vector.length !== this.dim) {
      throw new Error(`Vector dim mismatch: expected ${this.dim}, got ${item.vector.length}`);
    }
    const tx = this.db.transaction((it: UpsertItem) => {
      const existing = this.getRowidStmt.get(it.kind, it.sqliteId) as { rowid: number } | undefined;

      if (existing) {
        // 更新元数据 + 删除旧向量 + 同 rowid 插新向量
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
        // sqlite-vec vec0 表显式 rowid 必须是 BigInt;Number 会被当 REAL 拒绝。
        const rowidBig = typeof newRowid === 'bigint' ? newRowid : BigInt(newRowid);
        this.db.prepare('INSERT INTO vec_docs(rowid, vec) VALUES (?, ?)')
          .run(rowidBig, Buffer.from(it.vector.buffer));
      }
    });
    tx(item);
  }

  /** 批量 upsert,整批一个事务。 */
  upsertBatch(items: UpsertItem[]): void {
    const tx = this.db.transaction((batch: UpsertItem[]) => {
      for (const it of batch) this.upsert(it);
    });
    tx(items);
  }

  /** 按业务主键删除。 */
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
   * 删除 docs 表中那些 main DB 已不存在对应行的孤儿记录, 同时清掉 vec_docs 中
   * 对应的向量。返回清掉的总条数。
   *
   * 触发场景: 调用方从 main DB 删除了 session_summaries / observations 行后,
   * vec.db 里残留的 (kind, sqlite_id) 失去了 join 目标, 向量检索会"命中但回查空"
   * (幽灵卡片)。reindex 不会自己清, 因为 watermark 是按 max(sqlite_id) 推进的;
   * 中间被删的行会被遗漏。这个方法是显式补救入口。
   *
   * 实现: ATTACH 主库后用 NOT EXISTS 列出 main DB 已删的 (kind, sqlite_id),
   * 然后调 this.delete() 同时清 docs + vec_docs。廉价 (索引扫描, 无 embedding)。
   *
   * mainDbPath: main DB 的绝对路径, 必填——VectorStore 自己不知道主库在哪。
   */
  pruneOrphans(mainDbPath: string): number {
    const path = mainDbPath.replace(/\\/g, '/');
    try {
      this.db.exec(`ATTACH DATABASE '${path}' AS main_db`);
    } catch (err) {
      // 已 attach 过 → 忽略;其它错抛出。
      if (!String(err).includes('already in use')) throw err;
    }
    const orphanSum = this.db
      .prepare(
        `SELECT sqlite_id AS id FROM docs
         WHERE kind = 'session_summary'
           AND NOT EXISTS (SELECT 1 FROM main_db.session_summaries WHERE id = docs.sqlite_id)`,
      )
      .all() as Array<{ id: number }>;
    const orphanObs = this.db
      .prepare(
        `SELECT sqlite_id AS id FROM docs
         WHERE kind = 'observation'
           AND NOT EXISTS (SELECT 1 FROM main_db.observations WHERE id = docs.sqlite_id)`,
      )
      .all() as Array<{ id: number }>;
    let pruned = 0;
    const tx = this.db.transaction(() => {
      for (const o of orphanSum) {
        const existing = this.getRowidStmt.get('session_summary', o.id) as { rowid: number } | undefined;
        if (!existing) continue;
        this.deleteVecStmt.run(BigInt(existing.rowid));
        this.deleteDocStmt.run('session_summary', o.id);
        pruned += 1;
      }
      for (const o of orphanObs) {
        const existing = this.getRowidStmt.get('observation', o.id) as { rowid: number } | undefined;
        if (!existing) continue;
        this.deleteVecStmt.run(BigInt(existing.rowid));
        this.deleteDocStmt.run('observation', o.id);
        pruned += 1;
      }
    });
    tx();
    try { this.db.exec('DETACH DATABASE main_db'); } catch { /* noop */ }
    return pruned;
  }

  /**
   * KNN 查询。filter 在 docs 表上过滤,我们故意 over-fetch 候选再过滤,因为
   * sqlite-vec 不支持把 predicate 推到 vec MATCH 内部。
   */
  query(queryVec: Float32Array, k: number, filter?: QueryFilter, candidatesK?: number): QueryHit[] {
    if (queryVec.length !== this.dim) {
      throw new Error(`Query dim mismatch: expected ${this.dim}, got ${queryVec.length}`);
    }
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

  /** 聚合统计,供 index_status 用。 */
  stats(): { totalDocs: number; observations: number; summaries: number; byProject: Record<string, number> } {
    const total = this.db.prepare('SELECT COUNT(*) as c FROM docs').get() as { c: number };
    const obs = this.db.prepare("SELECT COUNT(*) as c FROM docs WHERE kind = 'observation'").get() as { c: number };
    const sum = this.db.prepare("SELECT COUNT(*) as c FROM docs WHERE kind = 'session_summary'").get() as { c: number };
    const proj = this.db.prepare('SELECT project, COUNT(*) as c FROM docs WHERE project IS NOT NULL GROUP BY project').all() as Array<{ project: string; c: number }>;
    const byProject: Record<string, number> = {};
    for (const p of proj) byProject[p.project] = p.c;
    return { totalDocs: total.c, observations: obs.c, summaries: sum.c, byProject };
  }

  /** 已索引的最大 sqlite_id。增量同步水位线用。 */
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
    this.deleteDocStmt = this.db.prepare('DELETE FROM docs WHERE kind = ? AND sqlite_id = ?');
    this.deleteVecStmt = this.db.prepare('DELETE FROM vec_docs WHERE rowid = ?');
    this.getRowidStmt = this.db.prepare('SELECT rowid FROM docs WHERE kind = ? AND sqlite_id = ?');
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
