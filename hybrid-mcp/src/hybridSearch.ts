/**
 * HybridSearch — the actual orchestrator that drives `search` tool when
 * mode='hybrid' (the default).
 *
 * Pipeline:
 *   1. parallel: sqlite branch (HTTP GET AgentMemory /api/search?mode=sqlite)
 *                vector branch (embed query + sqlite-vec ANN)
 *   2. RRF fuse the two ID ranklists per-kind (observations vs summaries)
 *   3. hydrate full rows via AgentMemory /api/observations/batch and /api/summaries/batch
 *   4. assemble the final response in AgentMemory-compatible shape so existing
 *      agent prompts (which expect AgentMemory's response schema) keep working.
 *
 * Graceful degradation:
 *   - If the model isn't ready yet → vector branch returns []; we still
 *     return sqlite results so search keeps working.
 *   - If AgentMemory Worker is unreachable → return vector-only results from
 *     local hydrate (which we don't currently have — fall back to "no
 *     results" with isError=false but with a clear note).
 *   - If vec.db is empty (no reindex done) → vector branch returns [];
 *     equivalent to sqlite-only mode.
 */
import type { AgentMemoryClient } from './agentMemoryClient.js';
import type { ModelStore } from './modelStore.js';
import type { VectorStore, DocKind } from './vectorStore.js';
import { rrfFuse, type RankItem } from './rrf.js';
import { logger } from './logger.js';

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
  /** Observations sorted by fused score (descending). */
  observations: Array<{
    id: number;
    score: number;
    rank: number;
    sources: Array<{ source: string; rank: number }>;
    /** Hydrated row from AgentMemory (full content). May be null if hydrate failed. */
    row?: unknown;
  }>;
  /** Same shape as observations. */
  summaries: Array<{
    id: number;
    score: number;
    rank: number;
    sources: Array<{ source: string; rank: number }>;
    row?: unknown;
  }>;
  /** Effective mode actually used (may differ from input if branches degraded). */
  mode: 'sqlite' | 'vector' | 'hybrid';
  /** True if any branch fell back. */
  fellBack: boolean;
  /** Per-branch latency for observability. */
  timings: { sqliteMs: number; vectorMs: number; hydrateMs: number; totalMs: number };
  /** Counts per branch before fusion */
  counts: { sqlite: number; vector: number; fusedObs: number; fusedSum: number };
}

export interface HybridSearchDeps {
  agentMemory: AgentMemoryClient;
  model?: ModelStore;
  vec?: VectorStore;
  /** RRF tuning. Sensible defaults baked in. */
  rrfK?: number;
  sqliteWeight?: number;
  vectorWeight?: number;
}

interface SqliteHit {
  id: number;
  kind: DocKind;
  score?: number;
  rank: number;
}

interface VectorHit {
  id: number;
  kind: DocKind;
  distance: number;
  rank: number;
}

const DEFAULTS = {
  rrfK: 60,
  // Cormack 2009 RRF with weighted variant. We give sqlite a higher weight
  // because BM25/FTS5 is the precision branch (returns the exact answer
  // when keywords match), while dense vector is the recall branch (rescues
  // paraphrase / concept queries). This is consistent with the literature
  // finding that "BM25 is hard to beat on lexical-match queries"
  // (Lin et al. 2021, Pyserini docs).
  sqliteWeight: 0.6,
  vectorWeight: 0.4,
};

export class HybridSearch {
  constructor(private deps: HybridSearchDeps) {}

  async search(opts: HybridSearchInput): Promise<HybridSearchOutput> {
    const totalT0 = Date.now();
    const limit = opts.limit ?? 20;
    const mode = opts.mode ?? 'hybrid';
    let fellBack = false;

    // ── decide which branches to run ──
    const wantSqlite = mode === 'sqlite' || mode === 'hybrid';
    const wantVector = mode === 'vector' || mode === 'hybrid';

    // Each branch fetches `limit` results — NOT 2x. Over-sampling vector
    // floods RRF with "topically similar but wrong" near-duplicates that
    // crowd out sqlite's precise top-1. The cost of capping at `limit` is
    // that hybrid can return at most ~limit unique docs; that's acceptable
    // because final output is also `limit`-bounded.
    const branchK = limit;

    // ── parallel branches ──
    const tSqlite = Date.now();
    const tVector = Date.now();
    const sqlitePromise = wantSqlite
      ? this.runSqlite(opts, branchK).catch((e) => {
          logger.warn('hybrid: sqlite branch failed', { error: String(e) });
          fellBack = true;
          return [] as SqliteHit[];
        })
      : Promise.resolve([] as SqliteHit[]);

    const vectorPromise = wantVector
      ? this.runVector(opts, branchK).catch((e) => {
          logger.warn('hybrid: vector branch failed', { error: String(e) });
          fellBack = true;
          return [] as VectorHit[];
        })
      : Promise.resolve([] as VectorHit[]);

    const [sqliteHits, vectorHits] = await Promise.all([sqlitePromise, vectorPromise]);
    const sqliteMs = wantSqlite ? Date.now() - tSqlite : 0;
    const vectorMs = wantVector ? Date.now() - tVector : 0;

    // If hybrid was requested but vector branch produced 0 (e.g. model not
    // ready or vec.db empty) AND sqlite worked, we silently degrade.
    if (mode === 'hybrid' && vectorHits.length === 0) {
      // Don't set fellBack just because vector returned 0 — that's expected
      // when vec.db is empty. Only error-paths set fellBack above.
    }

    // ── RRF fuse, separately per-kind ──
    const obsFused = this.fuseKind('observation', sqliteHits, vectorHits, mode, limit);
    const sumFused = this.fuseKind('session_summary', sqliteHits, vectorHits, mode, limit);

    // ── hydrate via AgentMemory HTTP (parallel) ──
    const tHydrate = Date.now();
    const [obsRows, sumRows] = await Promise.all([
      this.hydrateObservations(obsFused.map((f) => f.key)),
      this.hydrateSummaries(sumFused.map((f) => f.key)),
    ]);
    const hydrateMs = Date.now() - tHydrate;

    const observations = obsFused.map((f) => ({
      id: f.key,
      score: f.score,
      rank: f.rank,
      sources: f.perSource.filter((s) => s.rank >= 0).map((s) => ({ source: s.source, rank: s.rank })),
      row: obsRows.get(f.key),
    }));
    const summaries = sumFused.map((f) => ({
      id: f.key,
      score: f.score,
      rank: f.rank,
      sources: f.perSource.filter((s) => s.rank >= 0).map((s) => ({ source: s.source, rank: s.rank })),
      row: sumRows.get(f.key),
    }));

    const totalMs = Date.now() - totalT0;
    return {
      observations,
      summaries,
      mode,
      fellBack,
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

  private async runSqlite(opts: HybridSearchInput, k: number): Promise<SqliteHit[]> {
    const params: Record<string, unknown> = {
      query: opts.query,
      mode: 'sqlite',
      limit: k,
    };
    if (opts.project) params.project = opts.project;
    if (opts.obs_type && opts.obs_type.length > 0) params.obs_type = opts.obs_type;
    if (opts.dateStart) params.dateStart = opts.dateStart;
    if (opts.dateEnd) params.dateEnd = opts.dateEnd;

    const r = await this.deps.agentMemory.get('/api/search', params);
    if (!r.ok) {
      throw new Error(`AgentMemory /api/search returned HTTP ${r.status}`);
    }
    // AgentMemory response shape: { success, results, observations, summaries, count, mode, fellBack }
    // `results` is observations only in the canonical shape; observations and
    // summaries are also returned as separate arrays for some endpoints. We
    // try to handle both.
    const data = r.json as {
      observations?: Array<{ id: number; rank?: number }>;
      summaries?: Array<{ id: number; rank?: number }>;
      results?: Array<{ id: number; rank?: number }>;
    };

    const obs = data.observations ?? data.results ?? [];
    const sum = data.summaries ?? [];
    const hits: SqliteHit[] = [];
    obs.forEach((row, i) => {
      hits.push({ id: row.id, kind: 'observation', rank: typeof row.rank === 'number' ? row.rank : i });
    });
    sum.forEach((row, i) => {
      hits.push({ id: row.id, kind: 'session_summary', rank: typeof row.rank === 'number' ? row.rank : i });
    });
    return hits;
  }

  private async runVector(opts: HybridSearchInput, k: number): Promise<VectorHit[]> {
    if (!this.deps.model || !this.deps.vec) return [];
    const status = this.deps.model.getStatus();
    if (status.status !== 'ready') {
      logger.debug('vector branch: model not ready, skipping', { status: status.status });
      return [];
    }
    const queryVec = await this.deps.model.embed(opts.query);
    const filter: Parameters<VectorStore['query']>[2] = {};
    if (opts.project) filter.project = opts.project;
    if (opts.obs_type && opts.obs_type.length > 0) filter.obsType = opts.obs_type;
    if (opts.dateStart) filter.dateStartMs = Date.parse(opts.dateStart);
    if (opts.dateEnd) filter.dateEndMs = Date.parse(opts.dateEnd);

    const hits = this.deps.vec.query(queryVec, k, filter);
    return hits.map((h, i) => ({
      id: h.sqliteId,
      kind: h.kind,
      distance: h.distance,
      rank: i,
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

    // Re-rank within each branch (since we filtered by kind)
    const sqliteList: RankItem<number>[] = sqliteOfKind.map((h, i) => ({
      key: h.id,
      rank: i,
    }));
    const vectorList: RankItem<number>[] = vectorOfKind.map((h, i) => ({
      key: h.id,
      rank: i,
    }));

    const sw = mode === 'vector' ? 0 : (this.deps.sqliteWeight ?? DEFAULTS.sqliteWeight);
    const vw = mode === 'sqlite' ? 0 : (this.deps.vectorWeight ?? DEFAULTS.vectorWeight);

    // Plain RRF — the standard fusion algorithm (Cormack 2009).
    // No "guaranteed seats" hacks: with sqlite weight=0.6 and vector
    // weight=0.4, any sqlite top-K item's RRF score (≥ 0.6/79 ≈ 0.0076)
    // already exceeds any vector top-1 score (= 0.4/60 ≈ 0.0067), so
    // sparse precision is preserved purely by the weight ratio.
    // Per-branch over-fetch is capped at `limit` (already handled at
    // call site) to prevent vector noise dilution.
    return rrfFuse<number>(
      [
        { items: sqliteList, weight: sw, source: 'sqlite' },
        { items: vectorList, weight: vw, source: 'vector' },
      ],
      { k: this.deps.rrfK ?? DEFAULTS.rrfK, limit }
    );
  }

  private async hydrateObservations(ids: number[]): Promise<Map<number, unknown>> {
    const out = new Map<number, unknown>();
    if (ids.length === 0) return out;
    try {
      const r = await this.deps.agentMemory.postJson('/api/observations/batch', { ids });
      if (!r.ok) {
        logger.warn('hydrate observations: HTTP error', { status: r.status });
        return out;
      }
      const data = r.json as { observations?: Array<{ id: number;[k: string]: unknown }> };
      for (const row of data.observations ?? []) {
        out.set(row.id, row);
      }
    } catch (e) {
      logger.warn('hydrate observations failed', { error: String(e) });
    }
    return out;
  }

  private async hydrateSummaries(ids: number[]): Promise<Map<number, unknown>> {
    const out = new Map<number, unknown>();
    if (ids.length === 0) return out;
    try {
      const r = await this.deps.agentMemory.postJson('/api/summaries/batch', { ids });
      if (!r.ok) {
        logger.warn('hydrate summaries: HTTP error', { status: r.status });
        return out;
      }
      const data = r.json as { summaries?: Array<{ id: number;[k: string]: unknown }> };
      for (const row of data.summaries ?? []) {
        out.set(row.id, row);
      }
    } catch (e) {
      logger.warn('hydrate summaries failed', { error: String(e) });
    }
    return out;
  }
}
