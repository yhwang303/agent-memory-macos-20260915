/**
 * Indexer — pipe AgentMemoryDb → ModelStore → VectorStore.
 *
 * Two entry points:
 *   - reindexAll: fresh full pass per kind (or just one project).
 *   - syncIncremental: pick up ids > watermark.
 *
 * Both share the same per-batch loop:
 *   page from AgentMemory (200 rows) → embedBatch → upsertBatch into vec.db → advance watermark.
 *
 * Idempotent: upsert by (kind, sqliteId) means re-running is safe and cheap
 * for already-indexed rows (cost is re-embed; ~30ms/row on CPU).
 */
import type { ModelStore } from './modelStore.js';
import type { VectorStore, UpsertItem } from './vectorStore.js';
import type { AgentMemoryDb, AgentMemoryKind } from './agentMemoryDb.js';
import { logger } from './logger.js';

export type IndexerStatus = 'idle' | 'running' | 'failed';

export interface IndexerProgress {
  status: IndexerStatus;
  startedAt?: string;
  finishedAt?: string;
  observations: { processed: number; embedded: number; total?: number };
  summaries: { processed: number; embedded: number; total?: number };
  lastError?: string;
  /** Optional project scope of the most recent run. */
  scope?: string;
}

export interface ReindexOptions {
  project?: string;
  pageSize?: number;
  /** If true, do not skip rows that already have a vector. Default false. */
  force?: boolean;
}

export class Indexer {
  private status: IndexerStatus = 'idle';
  private progress: IndexerProgress;
  private currentRun?: Promise<void>;

  // sync daemon
  private daemonTimer?: ReturnType<typeof setInterval>;
  private daemonRunning = false;
  private daemonLastRunAt?: string;
  private daemonLastNewDocs = 0;
  private daemonRunCount = 0;
  /**
   * Baseline watermarks captured when the daemon starts. The daemon only
   * embeds rows whose id is GREATER than this baseline — i.e., true new
   * writes since the daemon came online.
   *
   * Why: if vec.db is far behind AgentMemory main DB (e.g. user never ran a full
   * reindex), the gap is "missing history", not "new increment". Auto-
   * embedding it could be a 15-min CPU storm. We require the user to call
   * the `reindex` tool explicitly for history; the daemon's job is purely
   * to keep up with new writes.
   */
  private daemonBaselineObsId = 0;
  private daemonBaselineSumId = 0;

  constructor(
    private model: ModelStore,
    private vec: VectorStore,
    private agentMemory: AgentMemoryDb
  ) {
    this.progress = {
      status: 'idle',
      observations: { processed: 0, embedded: 0 },
      summaries: { processed: 0, embedded: 0 },
    };
  }

  getProgress(): IndexerProgress {
    return { ...this.progress };
  }

  /** Daemon stats for index_status. */
  getDaemonStatus(): {
    running: boolean;
    intervalMs: number | null;
    lastRunAt?: string;
    lastNewDocs: number;
    runCount: number;
  } {
    return {
      running: this.daemonRunning,
      intervalMs: this.daemonTimer ? this.currentIntervalMs ?? null : null,
      lastRunAt: this.daemonLastRunAt,
      lastNewDocs: this.daemonLastNewDocs,
      runCount: this.daemonRunCount,
    };
  }

  private currentIntervalMs?: number;

  /**
   * Start the periodic incremental-sync daemon. Idempotent — calling twice
   * does NOT spawn two timers.
   *
   * Each tick does the cheap path:
   *   1. ask AgentMemory for max(id), compare with our vec.db watermark
   *   2. if no new rows → return immediately (no embed cost)
   *   3. if new rows → syncIncremental() picks them up
   *
   * Skipped silently if a reindexAll is currently in flight.
   */
  startSyncDaemon(intervalMs = 30_000): void {
    if (this.daemonTimer) {
      logger.info('sync daemon already running, ignoring duplicate start');
      return;
    }
    this.currentIntervalMs = intervalMs;
    this.daemonRunning = true;

    // Snapshot AgentMemory main DB max ids — anything beyond these is "new since
    // daemon online" and is daemon's responsibility. Anything below is
    // "missing history" that requires explicit reindex.
    this.daemonBaselineObsId = this.agentMemory.maxId('observation');
    this.daemonBaselineSumId = this.agentMemory.maxId('session_summary');
    logger.info('sync daemon started', {
      intervalMs,
      baselineObsId: this.daemonBaselineObsId,
      baselineSumId: this.daemonBaselineSumId,
    });

    const tick = async () => {
      // Avoid stacking — if a previous run is in flight, skip this one.
      if (this.currentRun) {
        logger.debug('sync daemon: previous run in flight, skipping tick');
        return;
      }
      try {
        const obsMaxAgentMemory = this.agentMemory.maxId('observation');
        const sumMaxAgentMemory = this.agentMemory.maxId('session_summary');
        const obsMaxVec = this.vec.maxIndexedId('observation');
        const sumMaxVec = this.vec.maxIndexedId('session_summary');

        // After-id for each kind = MAX(baseline, what's already in vec.db).
        // Picking the larger of the two ensures:
        //   - We never re-embed history (afterId >= vec_max means existing
        //     vec rows are skipped by the > comparison in agentMemoryDb stream).
        //   - We never auto-process history that was missing at startup
        //     (afterId >= baseline).
        const obsAfter = Math.max(this.daemonBaselineObsId, obsMaxVec);
        const sumAfter = Math.max(this.daemonBaselineSumId, sumMaxVec);
        const obsBehind = Math.max(0, obsMaxAgentMemory - obsAfter);
        const sumBehind = Math.max(0, sumMaxAgentMemory - sumAfter);

        if (obsBehind === 0 && sumBehind === 0) {
          // Nothing new since daemon came up + above existing watermark.
          this.daemonRunCount++;
          this.daemonLastRunAt = new Date().toISOString();
          this.daemonLastNewDocs = 0;
          return;
        }

        logger.info('sync daemon: catching up new writes', {
          obsBehind, sumBehind,
          obsAfter, sumAfter,
        });
        const before = this.vec.stats().totalDocs;
        await this.runDaemonCatchup(obsAfter, sumAfter);
        const after = this.vec.stats().totalDocs;
        const newDocs = after - before;

        this.daemonRunCount++;
        this.daemonLastRunAt = new Date().toISOString();
        this.daemonLastNewDocs = newDocs;
        logger.info('sync daemon: tick done', { newDocs, totalDocs: after });
      } catch (e) {
        logger.warn('sync daemon: tick failed (will retry)', { error: String(e) });
      }
    };

    this.daemonTimer = setInterval(tick, intervalMs);
    if (typeof this.daemonTimer.unref === 'function') this.daemonTimer.unref();
  }

  /**
   * Daemon-only catchup: scoped by per-kind afterId so we ONLY process true
   * new writes, never historic gaps.
   */
  private async runDaemonCatchup(obsAfter: number, sumAfter: number): Promise<void> {
    if (this.currentRun) {
      await this.currentRun;
      return;
    }
    this.currentRun = (async () => {
      this.status = 'running';
      this.progress = {
        status: 'running',
        startedAt: new Date().toISOString(),
        observations: { processed: 0, embedded: 0 },
        summaries: { processed: 0, embedded: 0 },
      };
      try {
        await this.runOneKind('observation', { afterId: obsAfter });
        await this.runOneKind('session_summary', { afterId: sumAfter });
      } finally {
        this.status = 'idle';
        this.progress.status = 'idle';
        this.progress.finishedAt = new Date().toISOString();
      }
    })().finally(() => { this.currentRun = undefined; });
    await this.currentRun;
  }

  stopSyncDaemon(): void {
    if (this.daemonTimer) {
      clearInterval(this.daemonTimer);
      this.daemonTimer = undefined;
      this.daemonRunning = false;
      this.currentIntervalMs = undefined;
      logger.info('sync daemon stopped');
    }
  }

  /** Re-embed everything (or one project). Idempotent. */
  async reindexAll(opts: ReindexOptions = {}): Promise<IndexerProgress> {
    if (this.currentRun) {
      logger.info('reindexAll: another run in flight, returning current progress');
      await this.currentRun;
      return this.getProgress();
    }
    this.currentRun = this.doReindexAll(opts).catch((err) => {
      this.status = 'failed';
      this.progress.status = 'failed';
      this.progress.lastError = String(err);
      logger.error('reindexAll failed', { error: String(err), stack: (err as Error).stack });
      throw err;
    }).finally(() => {
      this.currentRun = undefined;
    });
    await this.currentRun;
    return this.getProgress();
  }

  /** Pick up rows added since last run. */
  async syncIncremental(): Promise<IndexerProgress> {
    if (this.currentRun) {
      await this.currentRun;
      return this.getProgress();
    }
    this.currentRun = this.doIncremental().catch((err) => {
      this.status = 'failed';
      this.progress.status = 'failed';
      this.progress.lastError = String(err);
      logger.error('syncIncremental failed', { error: String(err) });
    }).finally(() => {
      this.currentRun = undefined;
    });
    await this.currentRun;
    return this.getProgress();
  }

  // ────────────────── internals ──────────────────

  private async doReindexAll(opts: ReindexOptions): Promise<void> {
    await this.model.ensureReady();

    this.status = 'running';
    this.progress = {
      status: 'running',
      startedAt: new Date().toISOString(),
      observations: { processed: 0, embedded: 0 },
      summaries: { processed: 0, embedded: 0 },
      scope: opts.project,
    };

    const agentMemoryStats = this.agentMemory.stats();
    if (opts.project) {
      const p = agentMemoryStats.byProject.find((x) => x.project === opts.project);
      this.progress.observations.total = p?.observations ?? 0;
      this.progress.summaries.total = p?.summaries ?? 0;
    } else {
      this.progress.observations.total = agentMemoryStats.observations;
      this.progress.summaries.total = agentMemoryStats.summaries;
    }

    logger.info('reindexAll start', {
      scope: opts.project ?? '(all)',
      obsTotal: this.progress.observations.total,
      sumTotal: this.progress.summaries.total,
      force: !!opts.force,
    });

    // Watermark: if !force, skip ids ≤ what we've already indexed.
    const obsWatermark = opts.force ? 0 : this.vec.maxIndexedId('observation');
    const sumWatermark = opts.force ? 0 : this.vec.maxIndexedId('session_summary');

    await this.runOneKind('observation', {
      afterId: obsWatermark,
      project: opts.project,
      pageSize: opts.pageSize,
    });
    await this.runOneKind('session_summary', {
      afterId: sumWatermark,
      project: opts.project,
      pageSize: opts.pageSize,
    });

    this.status = 'idle';
    this.progress.status = 'idle';
    this.progress.finishedAt = new Date().toISOString();
    logger.info('reindexAll done', {
      obs: this.progress.observations,
      sum: this.progress.summaries,
    });
  }

  private async doIncremental(): Promise<void> {
    await this.model.ensureReady();
    this.status = 'running';
    this.progress = {
      status: 'running',
      startedAt: new Date().toISOString(),
      observations: { processed: 0, embedded: 0 },
      summaries: { processed: 0, embedded: 0 },
    };
    await this.runOneKind('observation', { afterId: this.vec.maxIndexedId('observation') });
    await this.runOneKind('session_summary', { afterId: this.vec.maxIndexedId('session_summary') });
    this.status = 'idle';
    this.progress.status = 'idle';
    this.progress.finishedAt = new Date().toISOString();
  }

  private async runOneKind(
    kind: AgentMemoryKind,
    opts: { afterId: number; project?: string; pageSize?: number }
  ): Promise<void> {
    const counter = kind === 'observation' ? this.progress.observations : this.progress.summaries;
    const stream = kind === 'observation'
      ? this.agentMemory.streamObservations(opts)
      : this.agentMemory.streamSummaries(opts);

    for (const page of stream) {
      counter.processed += page.length;
      // Skip rows whose text is empty (defensive).
      const indexable = page.filter((d) => d.text && d.text.trim().length > 0);
      if (indexable.length === 0) continue;

      const vectors = await this.model.embedBatch(indexable.map((d) => d.text));

      const items: UpsertItem[] = indexable.map((d, i) => ({
        kind: d.kind,
        sqliteId: d.sqliteId,
        project: d.project,
        obsType: d.obsType,
        createdAtMs: d.createdAtMs,
        vector: vectors[i],
      }));
      this.vec.upsertBatch(items);
      counter.embedded += items.length;

      logger.info('indexer batch', {
        kind,
        processed: counter.processed,
        embedded: counter.embedded,
        total: counter.total,
        lastId: page[page.length - 1].sqliteId,
      });
    }
  }
}
