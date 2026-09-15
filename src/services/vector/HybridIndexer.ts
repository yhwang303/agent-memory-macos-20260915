/**
 * HybridIndexer — 把 AgentMemory 主库 observations / session_summaries 表的内容索引进 vec.db。
 *
 * 两个工作模式:
 *
 *  1. **reindexAll**: 全量(或按项目)重建。首次启动 vec.db 为空时调用一次。
 *     单事务批量(每 200 行一批)、idempotent、有进度回调。
 *
 *  2. **enqueue(kind, id)**: 增量入队。Worker 监听 'new_observation' /
 *     'new_summary' EventBus 事件,事件处理函数调这个方法把 id 入队。
 *     队列每 500ms drain 一次,batch embed,batch upsert。
 *
 * 防重入: currentRun 互斥锁保证 reindexAll 跟 drain 不会同时跑同一批数据。
 *
 * 错误隔离: drain 内部 try/catch,单条 embed 失败只 log 不抛,不阻塞主流程。
 *
 * 与 agentmem-hybrid-mcp/src/indexer.ts 的差异:
 *   - 删除 sync daemon (Worker 已经在监听 EventBus 事件,daemon 是冗余)
 *   - reindexAll 直接用 Database.Database (Worker 进程内,主库是同一份)
 *   - 增加 enqueue + drain 队列(给 EventBus 事件处理用)
 */
import type Database from 'better-sqlite3';
import type { EmbeddingService } from './EmbeddingService.js';
import type { VectorStore, UpsertItem, DocKind } from './VectorStore.js';
import { logger } from '../../utils/logger.js';

const LOG_CAT = 'hybrid-indexer';

export type IndexerStatus = 'idle' | 'running' | 'failed';

export interface IndexerProgress {
  status: IndexerStatus;
  startedAt?: string;
  finishedAt?: string;
  observations: { processed: number; embedded: number; total?: number; previouslyEmbedded?: number };
  summaries: { processed: number; embedded: number; total?: number; previouslyEmbedded?: number };
  lastError?: string;
  scope?: string;
  /** beta.8: 用户在托盘里点了暂停按钮; runOneKind 会卡在 gate 上直到 resume */
  paused?: boolean;
}

export interface ReindexOptions {
  /** 限定项目 */
  project?: string;
  /** 每批多少行,默认 50 (beta.8 从 200 降到 50, 让进度更平滑、单批阻塞更短) */
  pageSize?: number;
  /** 强制重新嵌入已有的 vec 行,默认 false */
  force?: boolean;
  /**
   * 每批结束后 sleep 多少 ms 再继续, 让 CPU 让步给前台进程。
   * 默认 50ms (eco 档)。fast 档可以传 0。
   */
  batchDelayMs?: number;
  /** 进度回调,每完成一批触发 */
  onProgress?: (progress: IndexerProgress) => void;
}

export interface HybridIndexerDeps {
  /** Worker 主 DB 连接(只读用法) */
  db: Database.Database;
  embedder: EmbeddingService;
  vectorStore: VectorStore;
  /** drain 触发间隔,默认 500ms */
  drainIntervalMs?: number;
}

interface PendingItem {
  kind: DocKind;
  id: number;
  retries: number;
}

/**
 * 内部 doc 抽象 — 把 AgentMemory 主库的两类行规范化成同一个结构,送给 embedder。
 */
interface IndexableDoc {
  kind: DocKind;
  sqliteId: number;
  project: string | null;
  obsType: string | null;
  createdAtMs: number | null;
  text: string;
}

export class HybridIndexer {
  private status: IndexerStatus = 'idle';
  private progress: IndexerProgress = {
    status: 'idle',
    observations: { processed: 0, embedded: 0 },
    summaries: { processed: 0, embedded: 0 },
    paused: false,
  };
  private currentRun?: Promise<void>;

  // 增量队列: Set 自动去重(同一 id 短时间内多次入队只算一次)
  private pendingObs = new Set<number>();
  private pendingSum = new Set<number>();
  private drainTimer?: ReturnType<typeof setTimeout>;
  private drainInProgress = false;
  private readonly drainIntervalMs: number;

  // 失败重试桶: id -> retryCount。超过 3 次放弃。
  private failedObs = new Map<number, number>();
  private failedSum = new Map<number, number>();
  private readonly MAX_RETRIES = 3;

  // beta.8: 暂停 / 恢复闸门。runOneKind 每个 page 处理前 await 一次 gate。
  // pause() 把 gate 替换为新的未 resolve Promise; resume() 调 resolveGate。
  // 默认 gate 已 resolved, 没人调用 pause 就不会阻塞。
  private gate: Promise<void> = Promise.resolve();
  private resolveGate: () => void = () => {};
  private paused = false;

  constructor(private deps: HybridIndexerDeps) {
    this.drainIntervalMs = deps.drainIntervalMs ?? 500;
  }

  getProgress(): IndexerProgress {
    return { ...this.progress, paused: this.paused };
  }

  /**
   * 暂停后续的 reindex page 处理。当前正在跑的 page 会跑完, 然后在下一个
   * page 开始前阻塞在 gate 上。增量 drain 也会跳过 (currentRun 在 reindex
   * 期间持有, 此时 drain 走重新 schedule 分支)。
   */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.gate = new Promise<void>((resolve) => { this.resolveGate = resolve; });
    this.progress.paused = true;
    logger.info(LOG_CAT, 'reindex paused');
  }

  /** 恢复处理。已暂停时唤醒 gate; 未暂停时 noop。 */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.resolveGate();
    this.gate = Promise.resolve();
    this.progress.paused = false;
    logger.info(LOG_CAT, 'reindex resumed');
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** 增量入队。立即返回,异步处理。线程安全(单线程 JS)。 */
  enqueue(kind: DocKind, id: number): void {
    if (kind === 'observation') {
      this.pendingObs.add(id);
    } else {
      this.pendingSum.add(id);
    }
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainTimer) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      this.drainQueue().catch((err) => {
        logger.error(LOG_CAT, 'drain failed (will retry on next event)', { error: String(err) });
      });
    }, this.drainIntervalMs);
    if (typeof this.drainTimer.unref === 'function') this.drainTimer.unref();
  }

  /** 把队列里的待处理 id 一次性 embed 入库。reindex 在跑时跳过。 */
  private async drainQueue(): Promise<void> {
    if (this.drainInProgress) return;
    if (this.currentRun) {
      // 全量 reindex 在跑,等它跑完再 drain。重新 schedule。
      this.scheduleDrain();
      return;
    }
    if (this.pendingObs.size === 0 && this.pendingSum.size === 0) return;

    this.drainInProgress = true;
    try {
      // 取一份当前快照,允许新事件继续写入 set
      const obsIds = [...this.pendingObs];
      const sumIds = [...this.pendingSum];
      this.pendingObs.clear();
      this.pendingSum.clear();

      await this.deps.embedder.ensureReady();

      if (obsIds.length > 0) {
        await this.indexByIds('observation', obsIds);
      }
      if (sumIds.length > 0) {
        await this.indexByIds('session_summary', sumIds);
      }
    } catch (err) {
      logger.error(LOG_CAT, 'drainQueue threw', { error: String(err) });
    } finally {
      this.drainInProgress = false;
    }

    // 如果 drain 期间又有新事件进来,再 schedule 一次
    if (this.pendingObs.size > 0 || this.pendingSum.size > 0) {
      this.scheduleDrain();
    }
  }

  private async indexByIds(kind: DocKind, ids: number[]): Promise<void> {
    const failedMap = kind === 'observation' ? this.failedObs : this.failedSum;
    const docs = this.fetchDocsByIds(kind, ids);
    const indexable = docs.filter((d) => d.text && d.text.trim().length > 0);
    if (indexable.length === 0) return;

    try {
      const vectors = await this.deps.embedder.embedBatch(indexable.map((d) => d.text));
      const items: UpsertItem[] = indexable.map((d, i) => ({
        kind: d.kind,
        sqliteId: d.sqliteId,
        project: d.project,
        obsType: d.obsType,
        createdAtMs: d.createdAtMs,
        vector: vectors[i],
      }));
      this.deps.vectorStore.upsertBatch(items);
      logger.debug(LOG_CAT, 'incremental indexed', { kind, count: items.length });

      // 成功的 id 从失败桶里清掉
      for (const it of items) failedMap.delete(it.sqliteId);
    } catch (err) {
      logger.warn(LOG_CAT, 'incremental embed failed; will retry', {
        kind,
        count: indexable.length,
        error: String(err),
      });
      for (const d of indexable) {
        const cur = failedMap.get(d.sqliteId) ?? 0;
        if (cur + 1 < this.MAX_RETRIES) {
          failedMap.set(d.sqliteId, cur + 1);
          // 重新入队
          if (kind === 'observation') this.pendingObs.add(d.sqliteId);
          else this.pendingSum.add(d.sqliteId);
        } else {
          logger.error(LOG_CAT, 'incremental: giving up after max retries', {
            kind,
            id: d.sqliteId,
            retries: cur + 1,
          });
          failedMap.delete(d.sqliteId);
        }
      }
    }
  }

  /** 全量(或按项目)重建索引。idempotent。 */
  async reindexAll(opts: ReindexOptions = {}): Promise<IndexerProgress> {
    if (this.currentRun) {
      logger.info(LOG_CAT, 'reindexAll: another run in flight, awaiting it');
      await this.currentRun;
      return this.getProgress();
    }
    this.currentRun = this.doReindexAll(opts).catch((err) => {
      this.status = 'failed';
      this.progress.status = 'failed';
      this.progress.lastError = String(err);
      logger.error(LOG_CAT, 'reindexAll failed', { error: String(err) });
      throw err;
    }).finally(() => {
      this.currentRun = undefined;
    });
    await this.currentRun;
    return this.getProgress();
  }

  // ────────────────── internals ──────────────────

  private async doReindexAll(opts: ReindexOptions): Promise<void> {
    await this.deps.embedder.ensureReady();

    // 算"之前已 embed 数", 用作进度起点。watermark 续建时不算白干 —
    // UI 显示 (alreadyDone + processed) / total, 体感不再"从 0 开始"。
    const alreadyObs = opts.force ? 0 : this.countAlreadyEmbedded('observation');
    const alreadySum = opts.force ? 0 : this.countAlreadyEmbedded('session_summary');

    this.status = 'running';
    this.progress = {
      status: 'running',
      startedAt: new Date().toISOString(),
      observations: { processed: 0, embedded: 0, previouslyEmbedded: alreadyObs },
      summaries: { processed: 0, embedded: 0, previouslyEmbedded: alreadySum },
      scope: opts.project,
      paused: this.paused,
    };

    // 计算总数
    this.progress.observations.total = this.countByKind('observation', opts.project);
    this.progress.summaries.total = this.countByKind('session_summary', opts.project);

    logger.info(LOG_CAT, 'reindexAll start', {
      scope: opts.project ?? '(all)',
      obsTotal: this.progress.observations.total,
      obsAlreadyEmbedded: alreadyObs,
      sumTotal: this.progress.summaries.total,
      sumAlreadyEmbedded: alreadySum,
      pageSize: opts.pageSize ?? 50,
      batchDelayMs: opts.batchDelayMs ?? 50,
      force: !!opts.force,
    });

    const obsAfter = opts.force ? 0 : this.deps.vectorStore.maxIndexedId('observation');
    const sumAfter = opts.force ? 0 : this.deps.vectorStore.maxIndexedId('session_summary');

    // Prune orphan vec rows BEFORE re-indexing. An "orphan" is a vec.db
    // entry whose target (kind, sqlite_id) no longer exists in the main
    // DB — happens when summaries/observations get deleted (manual SQL,
    // legacy-import cleanup, future delete features). Without this prune,
    // vector search returns ghost hits that fail to JOIN back to main DB
    // (= empty cards in the viewer / silent zero-results in MCP search).
    // Cheap: one EXISTS-LEFT-JOIN scan, no embedding work.
    const prunedOrphans = await this.pruneOrphanVecRows();
    if (prunedOrphans > 0) {
      logger.info(LOG_CAT, 'reindexAll: pruned orphan vec rows', {
        pruned: prunedOrphans,
      });
    }

    await this.runOneKind('observation', { afterId: obsAfter, project: opts.project, pageSize: opts.pageSize, batchDelayMs: opts.batchDelayMs, onProgress: opts.onProgress });
    await this.runOneKind('session_summary', { afterId: sumAfter, project: opts.project, pageSize: opts.pageSize, batchDelayMs: opts.batchDelayMs, onProgress: opts.onProgress });

    this.status = 'idle';
    this.progress.status = 'idle';
    this.progress.finishedAt = new Date().toISOString();
    logger.info(LOG_CAT, 'reindexAll done', {
      obs: this.progress.observations,
      sum: this.progress.summaries,
    });
  }

  /**
   * 数 vec.db 中某 kind 已经 embed 的行数。用作进度起点显示, 不影响 watermark 决策。
   * 数据源是 vectorStore.stats(); 失败时返回 0 (不阻塞 reindex)。
   */
  private countAlreadyEmbedded(kind: DocKind): number {
    try {
      const stats = this.deps.vectorStore.stats();
      return kind === 'observation' ? stats.observations : stats.summaries;
    } catch {
      return 0;
    }
  }

  /**
   * 删除 vec.db 中那些 main DB 已不存在对应行的孤儿 embedding。
   *
   * 触发场景: 用户/脚本从 session_summaries 或 observations 删了行后, vec.db
   * 里残留的 (kind, sqlite_id) 失去了 join 目标 → 向量检索会命中但回查空, 表现
   * 为搜索结果里幽灵行/空卡片。reindex 自己不清, 因为它是 watermark 推进式
   * (按 max sqlite_id), 中间被删的行不会触及。这是显式补救入口。
   *
   * 委托给 vectorStore.pruneOrphans 实现。失败时记日志降级, 不阻塞 reindex。
   */
  private async pruneOrphanVecRows(): Promise<number> {
    try {
      // VectorStore 需要 main DB 路径来 ATTACH。HybridIndexer 自己持有 main DB
      // 连接 (deps.db), 但拿不到它的文件路径。从 sqlite pragma 读 main DB 路径
      // 是最稳的——避免给 HybridIndexerDeps 加新字段牵动多处构造。
      const row = this.deps.db
        .prepare(`SELECT file FROM pragma_database_list WHERE name='main'`)
        .get() as { file?: string } | undefined;
      const mainPath = row?.file;
      if (!mainPath) {
        logger.warn(LOG_CAT, 'pruneOrphanVecRows: main DB path not resolvable, skipping');
        return 0;
      }
      return this.deps.vectorStore.pruneOrphans(mainPath);
    } catch (err) {
      logger.warn(LOG_CAT, 'pruneOrphanVecRows failed (continuing)', {
        error: String(err),
      });
      return 0;
    }
  }

  private async runOneKind(
    kind: DocKind,
    opts: { afterId: number; project?: string; pageSize?: number; batchDelayMs?: number; onProgress?: (p: IndexerProgress) => void }
  ): Promise<void> {
    const counter = kind === 'observation' ? this.progress.observations : this.progress.summaries;
    const pageSize = opts.pageSize ?? 50;          // beta.8: 默认从 200 → 50
    const batchDelayMs = opts.batchDelayMs ?? 50;  // 每批 sleep, 让 CPU 让步
    let cursor = opts.afterId;

    for (;;) {
      // 暂停闸门。pause() 时 gate 是 unresolved Promise, 这里 await 会一直挂起,
      // 直到 resume() 调 resolveGate。已 resolve 时立即返回, 无开销。
      if (this.paused) {
        logger.info(LOG_CAT, 'reindex gate awaiting resume', { kind, cursor });
        await this.gate;
      }

      const page = this.fetchPage(kind, { afterId: cursor, project: opts.project, limit: pageSize });
      if (page.length === 0) break;

      counter.processed += page.length;
      const indexable = page.filter((d) => d.text && d.text.trim().length > 0);

      if (indexable.length > 0) {
        const vectors = await this.deps.embedder.embedBatch(indexable.map((d) => d.text));
        const items: UpsertItem[] = indexable.map((d, i) => ({
          kind: d.kind,
          sqliteId: d.sqliteId,
          project: d.project,
          obsType: d.obsType,
          createdAtMs: d.createdAtMs,
          vector: vectors[i],
        }));
        this.deps.vectorStore.upsertBatch(items);
        counter.embedded += items.length;
      }

      cursor = page[page.length - 1].sqliteId;
      logger.info(LOG_CAT, 'reindex batch', {
        kind,
        processed: counter.processed,
        embedded: counter.embedded,
        total: counter.total,
        lastId: cursor,
      });
      opts.onProgress?.(this.progress);

      // 强制 flush WAL — 即使用户立刻强杀进程, 这一批已落盘, 下次启动续建。
      try { this.deps.vectorStore.flush?.(); } catch { /* best-effort */ }

      if (page.length < pageSize) break;

      // CPU 让步: 真实 sleep, 让前台 GUI / 网络栈拿到调度。
      // setImmediate 对同步 native ONNX 调用无效, 必须真实 setTimeout。
      if (batchDelayMs > 0) {
        await new Promise((r) => setTimeout(r, batchDelayMs));
      }
    }
  }

  // ── 数据库读取(直接操作 Worker 已打开的主库连接) ──

  private countByKind(kind: DocKind, project?: string): number {
    const tbl = kind === 'observation' ? 'observations' : 'session_summaries';
    if (project) {
      const r = this.deps.db.prepare(`SELECT COUNT(*) as c FROM ${tbl} WHERE project = ?`).get(project) as { c: number };
      return r.c;
    }
    const r = this.deps.db.prepare(`SELECT COUNT(*) as c FROM ${tbl}`).get() as { c: number };
    return r.c;
  }

  private fetchPage(kind: DocKind, opts: { afterId: number; project?: string; limit: number }): IndexableDoc[] {
    if (kind === 'observation') {
      const sql = opts.project
        ? `SELECT id, project, type, title, subtitle, text, narrative, concepts, created_at_epoch
             FROM observations WHERE id > ? AND project = ? ORDER BY id ASC LIMIT ?`
        : `SELECT id, project, type, title, subtitle, text, narrative, concepts, created_at_epoch
             FROM observations WHERE id > ? ORDER BY id ASC LIMIT ?`;
      const rows = (opts.project
        ? this.deps.db.prepare(sql).all(opts.afterId, opts.project, opts.limit)
        : this.deps.db.prepare(sql).all(opts.afterId, opts.limit)) as Array<{
        id: number; project: string | null; type: string | null;
        title: string | null; subtitle: string | null; text: string | null;
        narrative: string | null; concepts: string | null;
        created_at_epoch: number | null;
      }>;
      return rows.map((r) => observationRowToDoc(r));
    }
    const sql = opts.project
      ? `SELECT id, project, request, investigated, learned, completed, next_steps, notes, created_at_epoch
           FROM session_summaries WHERE id > ? AND project = ? ORDER BY id ASC LIMIT ?`
      : `SELECT id, project, request, investigated, learned, completed, next_steps, notes, created_at_epoch
           FROM session_summaries WHERE id > ? ORDER BY id ASC LIMIT ?`;
    const rows = (opts.project
      ? this.deps.db.prepare(sql).all(opts.afterId, opts.project, opts.limit)
      : this.deps.db.prepare(sql).all(opts.afterId, opts.limit)) as Array<{
      id: number; project: string | null;
      request: string | null; investigated: string | null; learned: string | null;
      completed: string | null; next_steps: string | null; notes: string | null;
      created_at_epoch: number | null;
    }>;
    return rows.map((r) => summaryRowToDoc(r));
  }

  private fetchDocsByIds(kind: DocKind, ids: number[]): IndexableDoc[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    if (kind === 'observation') {
      const rows = this.deps.db.prepare(
        `SELECT id, project, type, title, subtitle, text, narrative, concepts, created_at_epoch
           FROM observations WHERE id IN (${placeholders})`
      ).all(...ids) as Array<{
        id: number; project: string | null; type: string | null;
        title: string | null; subtitle: string | null; text: string | null;
        narrative: string | null; concepts: string | null;
        created_at_epoch: number | null;
      }>;
      return rows.map(observationRowToDoc);
    }
    const rows = this.deps.db.prepare(
      `SELECT id, project, request, investigated, learned, completed, next_steps, notes, created_at_epoch
         FROM session_summaries WHERE id IN (${placeholders})`
    ).all(...ids) as Array<{
      id: number; project: string | null;
      request: string | null; investigated: string | null; learned: string | null;
      completed: string | null; next_steps: string | null; notes: string | null;
      created_at_epoch: number | null;
    }>;
    return rows.map(summaryRowToDoc);
  }
}

// ────────────────── 文档格式化 ──────────────────
// 跟 agentmem-hybrid-mcp 的 agentMemoryDb.ts 完全一致,确保跟 vec.db 里已有的向量同源。

function observationRowToDoc(row: {
  id: number; project: string | null; type: string | null;
  title: string | null; subtitle: string | null; text: string | null;
  narrative: string | null; concepts: string | null;
  created_at_epoch: number | null;
}): IndexableDoc {
  const parts: string[] = [];
  if (row.title) parts.push(String(row.title));
  if (row.subtitle) parts.push(String(row.subtitle));
  if (row.narrative) parts.push(String(row.narrative));
  else if (row.text) parts.push(String(row.text));
  const concepts = decodeJsonList(row.concepts);
  if (concepts.length > 0) parts.push(concepts.join(', '));
  const text = parts.filter(Boolean).join('\n\n') || (row.title ?? row.text ?? '');
  return {
    kind: 'observation',
    sqliteId: row.id,
    project: row.project,
    obsType: row.type ?? null,
    createdAtMs: row.created_at_epoch,
    text,
  };
}

function summaryRowToDoc(row: {
  id: number; project: string | null;
  request: string | null; investigated: string | null; learned: string | null;
  completed: string | null; next_steps: string | null; notes: string | null;
  created_at_epoch: number | null;
}): IndexableDoc {
  const parts: string[] = [];
  if (row.request) parts.push(`Request: ${row.request}`);
  if (row.investigated) parts.push(`Investigated: ${row.investigated}`);
  if (row.learned) parts.push(`Learned: ${row.learned}`);
  if (row.completed) parts.push(`Completed: ${row.completed}`);
  if (row.next_steps) parts.push(`Next steps: ${row.next_steps}`);
  if (row.notes) parts.push(`Notes: ${row.notes}`);
  const text = parts.join('\n\n') || (row.request ?? '');
  return {
    kind: 'session_summary',
    sqliteId: row.id,
    project: row.project,
    obsType: null,
    createdAtMs: row.created_at_epoch,
    text,
  };
}

function decodeJsonList(value: string | null): string[] {
  if (!value) return [];
  try {
    const v = JSON.parse(value);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
