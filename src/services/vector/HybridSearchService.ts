/**
 * HybridSearchService — 在 Worker 进程内执行混合检索。
 *
 * 流程:
 *   1. 并行: sqlite 分支 (AgentMemory Database 的 FTS5 search) + vector 分支 (sqlite-vec ANN)
 *   2. Score-based fusion (basic-memory 风格): per kind 分别融合
 *      max(v, f) + FUSION_BONUS * min(v, f), FUSION_BONUS = 0.3
 *      FTS bm25 分数取 abs 后归一到 [0,1];vector L2 距离按 1 - L2²/2 还原余弦相似度
 *   3. hydrate 全文 (AgentMemory Database 的 getById)
 *   4. 返回与 agentmem-hybrid-mcp HybridSearch 兼容的 shape,
 *      agentmem-hybrid-mcp 的 stdio MCP 调本服务后可以原封不动 return 给 IDE
 *
 * 算法变更说明:
 *   旧实现使用 Cormack 2009 加权 RRF (k=60, sqliteWeight=0.6, vectorWeight=0.4),
 *   只看排序不看分数。本版本切换到 basic-memory 上游的 score-based fusion,
 *   直接利用两路的连续相似度信号,paraphrase / concept 召回更稳定,
 *   双路命中通过 bonus 自然奖励一致性。MCP 输出 shape 不变。
 *
 * Graceful degradation:
 *   - embedder 没 ready → vector 分支返回 [],只走 sqlite
 *   - vec.db 空 → vector 分支返回 [],等同 sqlite-only
 *   - 任一分支抛异常 → 该分支吃掉,fellBack=true 标记
 *
 * 与 agentmem-hybrid-mcp/src/hybridSearch.ts 的差异:
 *   - sqlite 分支不再走 HTTP,直接调 AgentMemory 的 searchObservations / searchSummaries
 *   - hydrate 不再走 HTTP,直接调 getObservationsByIds / getSummariesByIds
 *   - 节省一次跨进程 HTTP 往返,延迟下降 ~5-10ms
 *
 * 依赖注入说明:
 *   sqlite 分支与 hydrate 默认走 module-level getDatabase() (生产 Worker 用法),
 *   也允许通过 deps.db 注入一个特定连接(测试 / 多 DB 场景)。注入时优先用直接
 *   prepare() 查询,绕过 module 全局 state。
 */
import type Database from 'better-sqlite3';
import type { EmbeddingService } from './EmbeddingService.js';
import type { VectorStore, DocKind, QueryFilter } from './VectorStore.js';
import {
  scoreFuse,
  FUSION_BONUS,
  FTS_GATE_THRESHOLD,
  type FtsScoreItem,
  type VectorScoreItem,
} from './ScoreFusion.js';
import { logger } from '../../utils/logger.js';
import { searchObservations, getObservationsByIds } from '../sqlite/observations.js';
import { searchSummaries, getSummariesByIds } from '../sqlite/summaries.js';
import type { ObservationSearchResult, SessionSummarySearchResult, ObservationRow, SessionSummaryRow } from '../../types/database.js';

const LOG_CAT = 'hybrid-search';

export interface HybridSearchInput {
  query: string;
  project?: string;
  limit?: number;
  obs_type?: string[];
  dateStart?: string;
  dateEnd?: string;
  mode?: 'sqlite' | 'vector' | 'hybrid';
}

export interface HybridSearchOutput {
  observations: Array<{
    id: number;
    score: number;
    rank: number;
    /** 每条命中在哪些分支中实际贡献了分数,score 为该分支归一化后的相似度 (0-1)。 */
    sources: Array<{ source: 'sqlite' | 'vector'; score: number }>;
    row?: ObservationRow | undefined;
  }>;
  summaries: Array<{
    id: number;
    score: number;
    rank: number;
    sources: Array<{ source: 'sqlite' | 'vector'; score: number }>;
    row?: SessionSummaryRow | undefined;
  }>;
  mode: 'sqlite' | 'vector' | 'hybrid';
  fellBack: boolean;
  /** 是否触发降级 (model 没就绪 / vec.db 空) */
  degraded?: boolean;
  degradedReason?: string;
  timings: { sqliteMs: number; vectorMs: number; hydrateMs: number; totalMs: number };
  counts: { sqlite: number; vector: number; fusedObs: number; fusedSum: number };
}

export interface HybridSearchDeps {
  embedder: EmbeddingService;
  vectorStore: VectorStore;
  /** 覆盖 basic-memory FUSION_BONUS,默认 0.3。仅供调试/评测。 */
  fusionBonus?: number;
  /** 覆盖 FTS gate 阈值,默认 0.0。归一化后小于此值的 FTS 分数视为 0。 */
  ftsGateThreshold?: number;
  /**
   * 可选: 注入显式 DB 连接,绕过 module-level getDatabase()。
   * 生产 Worker 不传(走默认 sqlite/observations.js / summaries.js 的全局连接);
   * 测试场景传入隔离的 DB。
   */
  db?: Database.Database;
}

interface SqliteHit {
  id: number;
  kind: DocKind;
  /** SQLite FTS5 bm25 raw score (通常为负数)。score-based fusion 会自行 abs+归一。 */
  score: number;
}

interface VectorHit {
  id: number;
  kind: DocKind;
  /** sqlite-vec L2 距离;score-based fusion 会按 1 - L2²/2 还原余弦相似度。 */
  distance: number;
}

const DEFAULTS = {
  // 直接对齐 basic-memory search_repository_base.py 顶部的两个常量。
  fusionBonus: FUSION_BONUS,
  ftsGateThreshold: FTS_GATE_THRESHOLD,
};

export class HybridSearchService {
  constructor(private deps: HybridSearchDeps) {}

  async search(opts: HybridSearchInput): Promise<HybridSearchOutput> {
    const totalT0 = Date.now();
    const limit = opts.limit ?? 20;
    const mode = opts.mode ?? 'hybrid';
    let fellBack = false;
    let degraded = false;
    let degradedReason: string | undefined;

    const wantSqlite = mode === 'sqlite' || mode === 'hybrid';
    const wantVector = mode === 'vector' || mode === 'hybrid';

    // 每分支拿 limit 条,不 over-sample
    const branchK = limit;

    // ── 并行执行两路分支 ──
    const tSqlite = Date.now();
    const tVector = Date.now();
    const sqlitePromise = wantSqlite
      ? Promise.resolve(this.runSqlite(opts, branchK)).catch((e) => {
          logger.warn(LOG_CAT, 'sqlite branch failed', { error: String(e) });
          fellBack = true;
          return [] as SqliteHit[];
        })
      : Promise.resolve([] as SqliteHit[]);

    const vectorPromise = wantVector
      ? this.runVector(opts, branchK).catch((e) => {
          logger.warn(LOG_CAT, 'vector branch failed', { error: String(e) });
          fellBack = true;
          return [] as VectorHit[];
        })
      : Promise.resolve([] as VectorHit[]);

    const [sqliteHits, vectorHits] = await Promise.all([sqlitePromise, vectorPromise]);
    const sqliteMs = wantSqlite ? Date.now() - tSqlite : 0;
    const vectorMs = wantVector ? Date.now() - tVector : 0;

    // 降级标记: hybrid 模式但向量分支没贡献(模型没就绪 / vec.db 空)
    if (mode === 'hybrid' && vectorHits.length === 0) {
      const stats = this.deps.vectorStore.stats();
      const modelStatus = this.deps.embedder.getStatus().status;
      if (stats.totalDocs === 0) {
        degraded = true;
        degradedReason = 'vector index empty (reindex in progress or not yet started)';
      } else if (modelStatus !== 'ready') {
        degraded = true;
        degradedReason = `embedder status: ${modelStatus}`;
      }
    }

    // ── Score-based fusion (per kind) ──
    const obsFused = this.fuseKind('observation', sqliteHits, vectorHits, mode, limit);
    const sumFused = this.fuseKind('session_summary', sqliteHits, vectorHits, mode, limit);

    // ── hydrate (直查主库) ──
    const tHydrate = Date.now();
    const obsRows = this.hydrateObservations(obsFused.map((f) => f.key), opts.project);
    const sumRows = this.hydrateSummaries(sumFused.map((f) => f.key), opts.project);
    const hydrateMs = Date.now() - tHydrate;

    const observations = obsFused.map((f) => ({
      id: f.key,
      score: f.score,
      rank: f.rank,
      // 只保留实际有贡献(score > 0)的分支,与旧 RRF 实现 rank>=0 的语义对齐:
      // 新算法没有 rank,但 score=0 等价于"未命中或被 gate 抑制"。
      sources: f.perSource
        .filter((s) => s.score > 0)
        .map((s) => ({ source: s.source, score: s.score })),
      row: obsRows.get(f.key),
    }));
    const summaries = sumFused.map((f) => ({
      id: f.key,
      score: f.score,
      rank: f.rank,
      sources: f.perSource
        .filter((s) => s.score > 0)
        .map((s) => ({ source: s.source, score: s.score })),
      row: sumRows.get(f.key),
    }));

    const totalMs = Date.now() - totalT0;
    return {
      observations,
      summaries,
      mode,
      fellBack,
      degraded: degraded || undefined,
      degradedReason,
      timings: { sqliteMs, vectorMs, hydrateMs, totalMs },
      counts: {
        sqlite: sqliteHits.length,
        vector: vectorHits.length,
        fusedObs: observations.length,
        fusedSum: summaries.length,
      },
    };
  }

  // ────────────────── internals ──────────────────

  private runSqlite(opts: HybridSearchInput, k: number): SqliteHit[] {
    const hits: SqliteHit[] = [];

    // 注入了 db 时直接 prepare(),保证测试隔离;否则走 module-level 函数(生产用法)
    if (this.deps.db) {
      const obsRows = this.searchObsDirect(opts.query, opts.project, opts.obs_type, k);
      obsRows.forEach((row) => {
        hits.push({ id: row.id, kind: 'observation', score: row.score ?? 0 });
      });
      const sumRows = this.searchSumDirect(opts.query, opts.project, k);
      sumRows.forEach((row) => {
        hits.push({ id: row.id, kind: 'session_summary', score: row.score ?? 0 });
      });
      return hits;
    }

    // observations
    const obsRows = searchObservations(opts.query, {
      project: opts.project,
      type: opts.obs_type as string | string[] | undefined,
      limit: k,
      orderBy: 'relevance',
    }) as ObservationSearchResult[];
    obsRows.forEach((row) => {
      hits.push({ id: row.id, kind: 'observation', score: row.score ?? 0 });
    });

    // session_summaries
    try {
      const sumRows = searchSummaries(opts.query, {
        project: opts.project,
        limit: k,
        orderBy: 'relevance',
      }) as SessionSummarySearchResult[];
      sumRows.forEach((row) => {
        hits.push({ id: row.id, kind: 'session_summary', score: row.score ?? 0 });
      });
    } catch (err) {
      // session_summaries FTS 表可能在某些老版本不存在,容错
      logger.debug(LOG_CAT, 'searchSummaries failed (table may not exist)', { error: String(err) });
    }

    return hits;
  }

  /** 注入 db 时的直接 FTS 查询(observations) */
  private searchObsDirect(query: string, project: string | undefined, obsType: string[] | undefined, limit: number): Array<{ id: number; score: number }> {
    if (!this.deps.db) return [];
    try {
      let sql = `SELECT o.id, fts.rank as score FROM observations o
                 JOIN observations_fts fts ON o.id = fts.rowid
                 WHERE observations_fts MATCH ?`;
      const params: Array<string | number> = [query];
      if (project) { sql += ' AND o.project = ?'; params.push(project); }
      if (obsType && obsType.length) {
        sql += ` AND o.type IN (${obsType.map(() => '?').join(',')})`;
        params.push(...obsType);
      }
      sql += ' ORDER BY fts.rank LIMIT ?';
      params.push(limit);
      return this.deps.db.prepare(sql).all(...params) as Array<{ id: number; score: number }>;
    } catch (err) {
      // FTS 表可能不存在(空 DB / 测试环境)
      logger.debug(LOG_CAT, 'direct FTS observation query failed', { error: String(err) });
      return [];
    }
  }

  /** 注入 db 时的直接 FTS 查询(summaries) */
  private searchSumDirect(query: string, project: string | undefined, limit: number): Array<{ id: number; score: number }> {
    if (!this.deps.db) return [];
    try {
      let sql = `SELECT s.id, fts.rank as score FROM session_summaries s
                 JOIN session_summaries_fts fts ON s.id = fts.rowid
                 WHERE session_summaries_fts MATCH ?`;
      const params: Array<string | number> = [query];
      if (project) { sql += ' AND s.project = ?'; params.push(project); }
      sql += ' ORDER BY fts.rank LIMIT ?';
      params.push(limit);
      return this.deps.db.prepare(sql).all(...params) as Array<{ id: number; score: number }>;
    } catch (err) {
      logger.debug(LOG_CAT, 'direct FTS summary query failed', { error: String(err) });
      return [];
    }
  }

  private async runVector(opts: HybridSearchInput, k: number): Promise<VectorHit[]> {
    const status = this.deps.embedder.getStatus();
    if (status.status !== 'ready') {
      // EmbeddingService is intentionally lazy. The first vector/hybrid search
      // must perform that lazy initialization; otherwise a fully populated
      // vec.db returns zero results until an unrelated reindex happens to load
      // the model first.
      try {
        await this.deps.embedder.ensureReady();
      } catch (error) {
        logger.warn(LOG_CAT, 'vector branch: embedder failed to initialize', {
          status: this.deps.embedder.getStatus().status,
          error: String(error),
        });
        return [];
      }
    }
    const queryVec = await this.deps.embedder.embed(opts.query);
    const filter: QueryFilter = {};
    if (opts.project) filter.project = opts.project;
    if (opts.obs_type && opts.obs_type.length > 0) filter.obsType = opts.obs_type;
    if (opts.dateStart) filter.dateStartMs = Date.parse(opts.dateStart);
    if (opts.dateEnd) filter.dateEndMs = Date.parse(opts.dateEnd);

    const hits = this.deps.vectorStore.query(queryVec, k, filter);
    return hits.map((h) => ({
      id: h.sqliteId,
      kind: h.kind,
      distance: h.distance,
    }));
  }

  private fuseKind(
    kind: DocKind,
    sqliteHits: SqliteHit[],
    vectorHits: VectorHit[],
    mode: 'sqlite' | 'vector' | 'hybrid',
    limit: number
  ) {
    const sqliteOfKind = sqliteHits.filter((h) => h.kind === kind);
    const vectorOfKind = vectorHits.filter((h) => h.kind === kind);

    const ftsItems: FtsScoreItem<number>[] = sqliteOfKind.map((h) => ({ key: h.id, score: h.score }));
    const vecItems: VectorScoreItem<number>[] = vectorOfKind.map((h) => ({ key: h.id, distance: h.distance }));

    return scoreFuse<number>(ftsItems, vecItems, {
      limit,
      fusionBonus: this.deps.fusionBonus ?? DEFAULTS.fusionBonus,
      ftsGateThreshold: this.deps.ftsGateThreshold ?? DEFAULTS.ftsGateThreshold,
      includeFts: mode !== 'vector',
      includeVector: mode !== 'sqlite',
    });
  }

  private hydrateObservations(ids: number[], project?: string): Map<number, ObservationRow> {
    const out = new Map<number, ObservationRow>();
    if (ids.length === 0) return out;
    try {
      // 注入了 db 时直接查;否则走全局
      let rows: ObservationRow[];
      if (this.deps.db) {
        const placeholders = ids.map(() => '?').join(',');
        let sql = `SELECT * FROM observations WHERE id IN (${placeholders})`;
        const params: Array<number | string> = [...ids];
        if (project) { sql += ' AND project = ?'; params.push(project); }
        rows = this.deps.db.prepare(sql).all(...params) as ObservationRow[];
      } else {
        rows = getObservationsByIds(ids, project);
      }
      for (const row of rows) out.set(row.id, row);
    } catch (err) {
      logger.warn(LOG_CAT, 'hydrate observations failed', { error: String(err) });
    }
    return out;
  }

  private hydrateSummaries(ids: number[], project?: string): Map<number, SessionSummaryRow> {
    const out = new Map<number, SessionSummaryRow>();
    if (ids.length === 0) return out;
    try {
      let rows: SessionSummaryRow[];
      if (this.deps.db) {
        const placeholders = ids.map(() => '?').join(',');
        let sql = `SELECT * FROM session_summaries WHERE id IN (${placeholders})`;
        const params: Array<number | string> = [...ids];
        if (project) { sql += ' AND project = ?'; params.push(project); }
        rows = this.deps.db.prepare(sql).all(...params) as SessionSummaryRow[];
      } else {
        rows = getSummariesByIds(ids, project);
      }
      for (const row of rows) out.set(row.id, row);
    } catch (err) {
      logger.warn(LOG_CAT, 'hydrate summaries failed', { error: String(err) });
    }
    return out;
  }
}
