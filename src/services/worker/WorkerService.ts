/**
 * Worker Service for AgentMemory System
 * HTTP API server that handles memory operations
 */

import http from 'http';
import { URL } from 'url';
import { EventEmitter } from 'node:events';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDatabase, closeDatabase, getDatabaseStats } from '../sqlite/Database.js';
import { 
  insertObservation, 
  getTieredObservationsByProject,
  searchObservations,
  searchObservationsLike,
  getAllObservations,
  getObservationsByIds,
  getObservationsTimeline
} from '../sqlite/observations.js';
import {
  createSession,
  getSessionByContentId,
  updateSessionStatus,
  updateSessionUserPrompt,
  repairFallbackSessionProject,
  updateSessionField,
  getAllSessions,
  getDistinctProjects
} from '../sqlite/sessions.js';
import { 
  insertSummary, 
  getSummariesByProject,
  getAllSummaries,
  getSummariesByIds,
  searchSummariesLike
} from '../sqlite/summaries.js';
import { normalizeTimestamp } from '../../types/database.js';
import { isLowConfidenceProjectPath } from '../../utils/projectPath.js';
import { SDKAgent } from './SDKAgent.js';
import { SQLiteSearchStrategy } from './search/SQLiteSearchStrategy.js';
import { ChromaSearchStrategy } from './search/ChromaSearchStrategy.js';
import { HybridSearchStrategy } from './search/HybridSearchStrategy.js';
import { SearchOrchestrator } from './search/SearchOrchestrator.js';
import { formatSearchResults } from './search/ResultFormatter.js';
import { ChromaProcessManager } from '../sync/ChromaProcessManager.js';
import { ChromaMcpManager } from '../sync/ChromaMcpManager.js';
import { ChromaSync } from '../sync/ChromaSync.js';
import { loadSettings } from '../../config/settings.js';
import type { AgentMemorySettings } from '../../config/settings.js';
import { createSelfEvolvePlugin } from '../../plugins/self-evolve/index.js';
import type { SelfEvolvePlugin } from '../../plugins/self-evolve/index.js';
import { createInjectorPlugin } from '../../plugins/injector/index.js';
import type { InjectorPlugin } from '../../plugins/injector/index.js';
import type { PluginUIManifest } from '../../plugins/types.js';
import { getDataDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { renderMarkdown, type GroupBy, type ExportData } from '../export/markdown.js';
import { SyncQueue } from '../sync/SyncQueue.js';
import { RemoteClient } from '../sync/RemoteClient.js';
import { getSyncConfig, getDeviceId } from '../../shared/identity.js';
import {
  discoverAll,
  pendingRetryTaskCount,
  retryFailedTasks,
  runImport,
  takePendingRetryTasks,
} from '../import/index.js';
import { resetAdapter } from '../import/fingerprints.js';
import { reverseDedupAfterHookSummary } from '../import/reverse-dedup.js';
import type {
  ImportAdapterId,
  ImportProgressSnapshot,
  ImportResult,
} from '../import/types.js';
import {
  EmbeddingService,
  VectorStore,
  HybridIndexer,
  HybridSearchService,
  type IndexerProgress,
} from '../vector/index.js';
import {
  ShadowFolkUploader,
  loadShadowFolkConfig,
  type PushAllResult,
  type PushWorkspaceResult,
} from '../shadowfolk/ShadowFolkUploader.js';
import type { PushHistoryEntry } from '../shadowfolk/PushHistoryStore.js';
import { nextBeijingDailyRun } from '../shadowfolk/schedule.js';

interface ShadowFolkWorkspaceAlias {
  workspace: string;
  memoryRoots: string[];
}

interface ShadowFolkWorkspaceConfig {
  workspace: string;
  memoryRoots: string[];
}

type ShadowFolkUploaderLike = {
  validateWorkspace?: (workspace: string) => Promise<any>;
  pushWorkspaces(workspaces: Array<string | ShadowFolkWorkspaceConfig>): Promise<PushAllResult>;
  repushWorkspaceFull?(workspace: string | ShadowFolkWorkspaceConfig): Promise<PushWorkspaceResult>;
  listPushHistory?(workspace: string | ShadowFolkWorkspaceConfig): Promise<PushHistoryEntry[]>;
  replayHistoryEntry?(workspace: string | ShadowFolkWorkspaceConfig, historyId: string): Promise<PushWorkspaceResult>;
};

export interface WorkerConfig {
  port: number;
  host: string;
  dbPath?: string;
  /**
   * Test seam: override settings loader. Defaults to real loadSettings().
   */
  loadSettings?: () => AgentMemorySettings;
  shadowfolk?: {
    enabled: boolean;
    dailyTime: string;
    workspaces: string[];
    workspaceAliases?: ShadowFolkWorkspaceAlias[];
    createUploader?: () => ShadowFolkUploaderLike;
  };
}

interface ShadowFolkRuntimeStatus {
  running: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastResult: PushAllResult | null;
}

export class WorkerService {
  private server: http.Server | null = null;
  private config: WorkerConfig;
  private sdkAgent: SDKAgent;
  private syncQueue: SyncQueue | null = null;
  private isShuttingDown = false;
  private eventBus = new EventEmitter();
  // Track sessions with ongoing summary generation to prevent duplicates
  private pendingSummaries: Map<string, Promise<any>> = new Map();
  private pendingObservations: Map<string, Set<Promise<any>>> = new Map();
  private searchOrchestrator: SearchOrchestrator | null = null;
  private chromaProcess: ChromaProcessManager | null = null;
  private chromaMcp: ChromaMcpManager | null = null;
  private chromaSync: ChromaSync | null = null;
  private shadowfolkTimer: ReturnType<typeof setTimeout> | null = null;
  private shadowfolkNextRunAt: string | null = null;
  private shadowfolkOverride: {
    enabled: boolean;
    dailyTime: string;
    workspaces: string[];
    workspaceAliases: ShadowFolkWorkspaceAlias[];
  } | null = null;
  private shadowfolkStatus: ShadowFolkRuntimeStatus = {
    running: false,
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastResult: null,
  };
  private selfEvolve: SelfEvolvePlugin | null = null;
  private injector: InjectorPlugin | null = null;
  private pluginUIManifests: PluginUIManifest[] = [];

  // ── 本地 hybrid 检索栈(BGE-zh ONNX + sqlite-vec + RRF) ──
  // 这套服务初始化失败也不阻塞 Worker 启动 — handleSearch 在它们 null 时
  // 会自动 fallback 到原 SearchOrchestrator(SQLite-only)。
  private embedder: EmbeddingService | null = null;
  private vectorStore: VectorStore | null = null;
  private hybridIndexer: HybridIndexer | null = null;
  private hybridSearchService: HybridSearchService | null = null;
  /** 首次 reindex 进度,供 /api/vector/status 上报。 */
  private vectorReindexProgress: IndexerProgress | null = null;
  /** 首次 reindex 是否已开始(避免重复触发) */
  private vectorBootstrapTriggered = false;

  // ─── import-history feature state (Surface 2/3 backing) ─────────────
  /**
   * The retroactive history-import feature runs inside the Worker process
   * (NOT a forked CLI subprocess) so it inherits the same SDKAgent + the
   * same TIMIAI/OpenAI/Anthropic API key env that the desktop app injected
   * when starting the worker. A separate process would not see that env
   * (see desktop/src/config/store.ts:232-251) and would silently fall back
   * to the built-in default key. Critical for keeping the API key chain
   * unbroken across surfaces.
   */
  private importInProgress = false;
  private importProgress: ImportProgressSnapshot | null = null;
  private importLastResult: ImportResult | null = null;
  private importStartedAt: number | null = null;
  /** Set when scheduleBackgroundRetry is currently waiting / running. */
  private importRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private importRetryRunning = false;

  constructor(config: WorkerConfig) {
    this.config = config;
    // Initialize database
    const db = getDatabase();
    this.sdkAgent = new SDKAgent();

    // Initialize sync queue if remote is configured
    const syncConfig = getSyncConfig();
    if (syncConfig.enabled && syncConfig.remoteUrl) {
      const remoteClient = new RemoteClient({
        baseUrl: syncConfig.remoteUrl,
        token: syncConfig.remoteToken,
      });
      this.syncQueue = new SyncQueue(db, remoteClient);
      logger.info('WORKER', 'Sync queue initialized', { remoteUrl: syncConfig.remoteUrl });
    }

    // Initialize search orchestrator with SQLite-only strategies by default.
    // T6 will later promote this with Chroma when ChromaProcessManager+Sync succeed.
    const sqliteStrategy = new SQLiteSearchStrategy();
    this.searchOrchestrator = new SearchOrchestrator({
      sqlite: sqliteStrategy,
      chroma: null,
      hybrid: null,
    });

    // 本地 hybrid 检索栈初始化(best-effort)。任一步失败都只 log 不抛,
    // Worker 仍可以用 sqlite-only 模式服务请求。
    this.initHybridStack(db);
  }

  /**
   * 初始化本地 hybrid 检索栈 — VectorStore (sqlite-vec) + EmbeddingService
   * (BGE-zh ONNX) + HybridIndexer + HybridSearchService。挂 EventBus 监听器,
   * 让新增的 observation / session_summary 自动入向量库。
   *
   * 设计原则:
   *  - 初始化失败不阻塞 Worker(handleSearch 检测到 null 会回退 SQLite-only)
   *  - 模型加载是 lazy 的(EmbeddingService.ensureReady 第一次调用时才 load)
   *  - 首次 reindex 在 start() 里以 fire-and-forget 方式触发
   */
  private initHybridStack(db: ReturnType<typeof getDatabase>): void {
    try {
      const vecDbPath = path.join(getDataDir(), 'vec.db');
      this.vectorStore = new VectorStore({ dbPath: vecDbPath, dim: 768 });

      this.embedder = new EmbeddingService({
        modelId: process.env.AGENTMEM_HYBRID_MODEL_ID || 'Xenova/bge-base-zh-v1.5',
        modelDir: process.env.AGENTMEM_MODELS_DIR, // installer 注入;空则走默认路径解析
        remoteHost: process.env.AGENTMEM_HYBRID_HF_ENDPOINT,
        allowRemoteModels: true,
        dim: 768,
        // beta.8: 限 ONNX intra-op 线程数。桌面端通过 OMP_NUM_THREADS 注入,
        // 这里显式 parse 以便 EmbeddingService 在 transformers.js env 上设值。
        numThreads: parseInt(process.env.OMP_NUM_THREADS || '2', 10) || 2,
      });

      this.hybridIndexer = new HybridIndexer({
        db,
        embedder: this.embedder,
        vectorStore: this.vectorStore,
      });

      this.hybridSearchService = new HybridSearchService({
        embedder: this.embedder,
        vectorStore: this.vectorStore,
        // basic-memory 风格 score-based fusion 的两个调参点 (生产默认即上游推荐):
        //   - FUSION_BONUS = 0.3:双路一致性奖励,过大会盖过单路强信号
        //   - FTS gate = 0.0:归一化后小于此值的 FTS 分数视为 0,过滤极弱命中
        // 旧的 AGENTMEM_HYBRID_RRF_K / SQLITE_WEIGHT / VECTOR_WEIGHT 在新算法下没有意义,
        // 已停止读取以避免运维误以为它们仍然生效。
        fusionBonus: process.env.AGENTMEM_HYBRID_FUSION_BONUS
          ? parseFloat(process.env.AGENTMEM_HYBRID_FUSION_BONUS)
          : undefined,
        ftsGateThreshold: process.env.AGENTMEM_HYBRID_FTS_GATE
          ? parseFloat(process.env.AGENTMEM_HYBRID_FTS_GATE)
          : undefined,
        db, // 显式注入 Worker 的 DB 连接,避免依赖 module-level getDatabase() 的隐式状态
      });

      // 增量入队: 主表写完 commit 后才 emit,所以失败不会回滚 obs/summary 写入。
      // 监听器内部用 P-Queue 串行,失败 3 次进重试桶。
      this.eventBus.on('new_observation', (payload: { id?: number }) => {
        try {
          if (typeof payload.id !== 'number') {
            // Defensive: predates 2.1.0-beta.6 some emit sites forgot to pass id.
            // Don't silently call enqueue(undefined) which corrupts the Set.
            logger.warn('HYBRID', 'enqueue observation skipped: payload.id missing', { payload });
            return;
          }
          this.hybridIndexer?.enqueue('observation', payload.id);
        } catch (err) {
          logger.warn('HYBRID', 'enqueue observation failed', { error: String(err) });
        }
      });
      this.eventBus.on('new_summary', (payload: { id?: number; session_id?: string }) => {
        // session_summary 是按 session 算的;EventBus 上目前 emit 的是 session_id,
        // 我们需要通过 session_id 查到对应的 summary id 再入队。
        try {
          if (typeof payload.id === 'number') {
            this.hybridIndexer?.enqueue('session_summary', payload.id);
          } else if (payload.session_id) {
            const row = db.prepare(
              `SELECT id FROM session_summaries WHERE memory_session_id = ? ORDER BY id DESC LIMIT 1`
            ).get(payload.session_id) as { id: number } | undefined;
            if (row) this.hybridIndexer?.enqueue('session_summary', row.id);
          }
        } catch (err) {
          logger.warn('HYBRID', 'enqueue summary failed', { error: String(err) });
        }
      });

      logger.info('HYBRID', 'Hybrid vector stack initialized', {
        vecDbPath,
        modelId: this.embedder.getStatus().modelId,
        modelDir: this.embedder.getStatus().cacheDir,
      });
    } catch (err) {
      logger.error('HYBRID', 'Failed to init hybrid stack; fallback to SQLite-only', {
        error: String(err),
      });
      // 清理可能已经部分初始化的实例,避免半残状态
      try { this.vectorStore?.close(); } catch { /* ignore */ }
      this.embedder = null;
      this.vectorStore = null;
      this.hybridIndexer = null;
      this.hybridSearchService = null;
    }
  }

  /**
   * Start the HTTP server
   */
  async start(): Promise<void> {
    // Initialize logger for this service lifecycle
    logger.init('worker');

    // Verify API connection before starting to ensure configuration is correct
    // This prevents the worker from accepting requests if API is not available
    const apiReady = await this.sdkAgent.verifyApiConnection();
    if (!apiReady) {
      logger.warn('WORKER', 'API connection verification failed - worker will start but may not function properly');
      // Continue starting but log warning - don't block startup entirely
    } else {
      logger.info('WORKER', 'API connection verified successfully');
    }

    // Initialize Self-Evolve plugin if enabled
    const settings = (this.config.loadSettings ?? loadSettings)();
    const selfEvolveCfg = settings.plugins?.selfEvolve;
    if (selfEvolveCfg?.enabled) {
      this.selfEvolve = createSelfEvolvePlugin();
      this.selfEvolve.initialize(selfEvolveCfg);
      logger.info('WORKER', 'Self-Evolve plugin activated', {
        reviewMode: selfEvolveCfg.reviewMode,
        targetPlatforms: selfEvolveCfg.targetPlatforms,
      });
    }

    // Initialize Injector plugin if enabled
    const injectorCfg = settings.plugins?.injector;
    if (injectorCfg?.enabled) {
      this.injector = createInjectorPlugin();
      this.injector.initialize(injectorCfg, { db: getDatabase() });
      logger.info('WORKER', 'Injector plugin activated');
    }

    // Build plugin UI manifests — only enabled plugins are included.
    // Frontend uses this to dynamically render tabs and cards.
    this.pluginUIManifests = [];
    if (this.selfEvolve) {
      this.pluginUIManifests.push({
        id: 'self-evolve',
        name: 'Self-Evolve',
        enabled: true,
        tab: { label: 'Self-Evolve', icon: '⚡', order: 100, badge: 'se-badge', cssClass: 'evolve-tab' },
        settingsCard: { title: 'Self-Evolve', subtitle: '读取每次会话记忆，自动提炼 Rules / Skills，写入 CLAUDE.md', order: 30, accentColor: '#7c3aed' },
      });
    }
    if (this.injector) {
      this.pluginUIManifests.push({
        id: 'injector',
        name: 'Injector',
        enabled: true,
        tab: { label: 'Injector', icon: '💉', order: 110, cssClass: 'injector-tab' },
        settingsCard: { title: 'Injector · 规范注入器', subtitle: '把内置 Skills / Rules / MCP / 规范文件按目标 IDE 一键注入到任意项目', order: 40, accentColor: '#00b894' },
      });
    }

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => {
        logger.error('HTTP', 'Request handler error', {}, error as Error);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'Internal server error' }));
      });
    });

    // Fire-and-forget Chroma init so slow uvx download / missing uv doesn't
    // block HTTP readiness. Worker stays SQLite-only until this resolves.
    this.initChroma().catch(err =>
      logger.error('CHROMA', 'initChroma crashed', {}, err as Error)
    );

    // Fire-and-forget hybrid bootstrap: 检测 vec.db 空且主库非空 → 后台 reindex。
    // 用 setTimeout 0 推到下一个 tick,让 server.listen() 先完成。
    setTimeout(() => this.bootstrapHybridIfNeeded(), 0);

    return new Promise((resolve, reject) => {
      this.server!.listen(this.config.port, this.config.host, () => {
        logger.info('WORKER', `Server listening on ${this.config.host}:${this.config.port}`);

        // Start sync queue background worker after server is up
        if (this.syncQueue) {
          this.syncQueue.startWorker();
        }

        this.startShadowFolkTimer();

        resolve();
      });

      this.server!.on('error', reject);
    });
  }

  /**
   * Handle incoming HTTP requests
   */
  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const requestId = `req-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    logger.debug('HTTP', `[${requestId}] Incoming request`, {
      method: req.method,
      url: req.url,
      headers: req.headers
    });

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${this.config.host}:${this.config.port}`);
    const path = url.pathname;

    try {
      // Route handling
      if (path === '/health' && req.method === 'GET') {
        await this.handleHealth(req, res);
      } else if (path === '/api/session/start' && req.method === 'POST') {
        await this.handleSessionStart(req, res);
      } else if (path === '/api/session/end' && req.method === 'POST') {
        await this.handleSessionEnd(req, res);
      } else if (path === '/api/session/field' && req.method === 'POST') {
        await this.handleSessionField(req, res);
      } else if (path === '/api/observation' && req.method === 'POST') {
        await this.handleObservation(req, res);
      } else if (path === '/api/context/inject' && req.method === 'GET') {
        await this.handleContextInject(req, res, url);
      } else if (path === '/api/search' && req.method === 'GET') {
        await this.handleSearch(req, res, url);
      } else if (path === '/api/search_like' && req.method === 'GET') {
        await this.handleSearchLike(req, res, url);
      } else if (path === '/api/timeline' && req.method === 'GET') {
        await this.handleTimeline(req, res, url);
      } else if (path === '/api/observations/batch' && req.method === 'POST') {
        await this.handleObservationsBatch(req, res);
      } else if (path === '/api/summaries/batch' && req.method === 'POST') {
        await this.handleSummariesBatch(req, res);
      } else if (path === '/api/summary' && req.method === 'POST') {
        await this.handleSummary(req, res);
      } else if (path === '/api/viewer/sessions' && req.method === 'GET') {
        if (url.searchParams.get('source') === 'remote') {
          await this.proxyRemoteViewer('sessions', url, res);
        } else {
          await this.handleViewerSessions(req, res, url);
        }
      } else if (path === '/api/viewer/observations' && req.method === 'GET') {
        if (url.searchParams.get('source') === 'remote') {
          await this.proxyRemoteViewer('observations', url, res);
        } else {
          await this.handleViewerObservations(req, res, url);
        }
      } else if (path === '/api/viewer/summaries' && req.method === 'GET') {
        if (url.searchParams.get('source') === 'remote') {
          await this.proxyRemoteViewer('summaries', url, res);
        } else {
          await this.handleViewerSummaries(req, res, url);
        }
      } else if (path === '/api/viewer/projects' && req.method === 'GET') {
        if (url.searchParams.get('source') === 'remote') {
          await this.proxyRemoteViewer('projects', url, res);
        } else {
          await this.handleViewerProjects(req, res);
        }
      } else if (path === '/api/viewer/config' && req.method === 'GET') {
        await this.handleViewerConfig(res);
      } else if (path === '/api/export/markdown' && req.method === 'GET') {
        await this.handleExportMarkdown(req, res, url);
      } else if (path === '/api/sync/status' && req.method === 'GET') {
        await this.handleSyncStatus(res);
      } else if (path === '/api/sync/reset' && req.method === 'POST') {
        await this.handleSyncReset(res);
      } else if (path === '/api/sync/rescan' && req.method === 'POST') {
        await this.handleSyncRescan(res);
      } else if (path === '/api/sync/test' && req.method === 'POST') {
        await this.handleSyncTest(res);
      } else if (path === '/api/shadowfolk/status' && req.method === 'GET') {
        await this.handleShadowFolkStatus(res);
      } else if (path === '/api/shadowfolk/workspaces/validate' && req.method === 'POST') {
        await this.handleShadowFolkWorkspaceValidate(req, res);
      } else if (path === '/api/shadowfolk/workspaces/suggest-aliases' && req.method === 'POST') {
        await this.handleShadowFolkWorkspaceAliasSuggestions(req, res);
      } else if (path === '/api/shadowfolk/config' && req.method === 'POST') {
        await this.handleShadowFolkConfigUpdate(req, res);
      } else if (path === '/api/shadowfolk/push' && req.method === 'POST') {
        await this.handleShadowFolkPush(res);
      } else if (path === '/api/shadowfolk/history' && req.method === 'GET') {
        await this.handleShadowFolkHistory(req, res, url);
      } else if (path === '/api/shadowfolk/replay' && req.method === 'POST') {
        await this.handleShadowFolkReplay(req, res);
      } else if (path === '/api/chroma/status' && req.method === 'GET') {
        await this.handleChromaStatus(req, res);
      } else if (path === '/api/chroma/reindex' && req.method === 'POST') {
        await this.handleChromaReindex(req, res);
      } else if (path === '/api/vector/status' && req.method === 'GET') {
        await this.handleVectorStatus(req, res);
      } else if (path === '/api/vector/reindex' && req.method === 'POST') {
        await this.handleVectorReindex(req, res);
      } else if (path === '/api/vector/pause' && req.method === 'POST') {
        await this.handleVectorPause(req, res);
      } else if (path === '/api/vector/resume' && req.method === 'POST') {
        await this.handleVectorResume(req, res);
      } else if (path === '/api/import/discover' && req.method === 'GET') {
        await this.handleImportDiscover(req, res);
      } else if (path === '/api/import/audit' && req.method === 'GET') {
        await this.handleImportAudit(req, res);
      } else if (path === '/api/import/repair-projects' && req.method === 'POST') {
        await this.handleImportRepairProjects(req, res);
      } else if (path === '/api/import/status' && req.method === 'GET') {
        await this.handleImportStatus(req, res);
      } else if (path === '/api/import/run' && req.method === 'POST') {
        await this.handleImportRun(req, res);
      } else if (path === '/api/import/reset' && req.method === 'POST') {
        await this.handleImportReset(req, res);
      } else if (path === '/api/session/complete' && req.method === 'POST') {
        await this.handleSessionComplete(req, res);
      } else if (path === '/api/readiness' && req.method === 'GET') {
        await this.handleReadiness(req, res);
      } else if (path === '/api/plugins/ui-manifest' && req.method === 'GET') {
        this.handlePluginsUIManifest(res);
      } else if (path === '/api/self-evolve/status' && req.method === 'GET') {
        await this.handleSelfEvolveStatus(req, res);
      } else if (path === '/api/self-evolve/trigger' && req.method === 'POST') {
        await this.handleSelfEvolveTrigger(req, res);
      } else if (path === '/api/self-evolve/review/pending' && req.method === 'GET') {
        await this.handleSelfEvolveReviewPending(req, res);
      } else if (path === '/api/self-evolve/review/approve' && req.method === 'POST') {
        await this.handleSelfEvolveReviewApprove(req, res);
      } else if (path === '/api/self-evolve/review/reject' && req.method === 'POST') {
        await this.handleSelfEvolveReviewReject(req, res);
      } else if (path === '/api/injector/catalog' && req.method === 'GET') {
        await this.handleInjectorCatalog(req, res);
      } else if (path === '/api/injector/detect' && req.method === 'GET') {
        await this.handleInjectorDetect(req, res);
      } else if (path === '/api/injector/ledger' && req.method === 'GET') {
        await this.handleInjectorLedger(req, res);
      } else if (path === '/api/injector/preview' && req.method === 'POST') {
        await this.handleInjectorPreview(req, res);
      } else if (path === '/api/injector/inject' && req.method === 'POST') {
        await this.handleInjectorInject(req, res);
      } else if (path === '/api/injector/uninstall' && req.method === 'POST') {
        await this.handleInjectorUninstall(req, res);
      } else if (path === '/api/viewer/rules' && req.method === 'GET') {
        await this.handleViewerRules(req, res);
      } else if (path === '/api/viewer/skills' && req.method === 'GET') {
        await this.handleViewerSkills(req, res);
      } else if (path === '/api/viewer/evo-log' && req.method === 'GET') {
        await this.handleViewerEvoLog(req, res);
      } else if (path === '/stream' && req.method === 'GET') {
        this.handleStream(req, res);
        return;
      } else if ((path === '/viewer.html' || path === '/viewer') && req.method === 'GET') {
        await this.handleStaticFile(req, res, 'viewer.html');
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (error) {
      logger.error('HTTP', `Error handling ${path}`, {}, error as Error);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  /**
   * Health check endpoint
   */
  private async handleHealth(
    _req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const stats = getDatabaseStats();
    res.statusCode = 200;
    res.end(JSON.stringify({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      stats
    }));
  }

  /**
   * Start a new session
   */
  private async handleSessionStart(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    logger.info('HTTP', '>>> handleSessionStart called');
    const body = await this.parseBody(req);
    logger.debug('HTTP', 'Session start request body', {
      sessionId: body.sessionId,
      project: body.project,
      userPromptLength: body.userPrompt?.length || 0
    });
    const { sessionId, project, userPrompt } = body;

    if (!sessionId) {
      logger.warn('HTTP', 'Session start missing sessionId', { sessionId, project });
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'sessionId is required' }));
      return;
    }

    // Check if session already exists to avoid UNIQUE constraint error
    logger.debug('HTTP', 'Checking for existing session', { sessionId });
    const existingSession = getSessionByContentId(sessionId);
    if (existingSession) {
      logger.info('HTTP', `Session ${sessionId} already exists, updating user_prompt`);
      if (!isLowConfidenceProjectPath(project) && repairFallbackSessionProject(sessionId, project)) {
        logger.info('HTTP', 'Repaired packaged-app fallback project for existing session', {
          sessionId,
          previousProject: existingSession.project,
          project,
        });
      }
      
      // Update user_prompt to the latest user question so summary reflects current question
      if (userPrompt) {
        updateSessionUserPrompt(sessionId, userPrompt);
        logger.debug('HTTP', 'Updated user_prompt for existing session', { 
          sessionId, 
          userPromptLength: userPrompt.length 
        });
      }
      
      res.statusCode = 200;
      res.end(JSON.stringify({
        success: true,
        sessionDbId: existingSession.id,
        memorySessionId: existingSession.memory_session_id
      }));
      return;
    }

    if (isLowConfidenceProjectPath(project)) {
      logger.warn('HTTP', 'Refusing to create session from low-confidence project path', { sessionId, project });
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'A valid project path is required' }));
      return;
    }

    const memorySessionId = `mem-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const { isoString, epoch } = normalizeTimestamp(new Date());
    
    const deviceId = getDeviceId();
    const sourceIde = body.sourceIDE || '';

    const sessionDbId = createSession({
      content_session_id: sessionId,
      memory_session_id: memorySessionId,
      project,
      user_prompt: userPrompt || '',
      started_at: isoString,
      started_at_epoch: epoch,
      completed_at: null,
      completed_at_epoch: null,
      status: 'active',
      worker_port: this.config.port,
      prompt_counter: 0,
      source_ide: sourceIde || null
    });

    // Enqueue for remote sync
    this.syncQueue?.enqueue('session', sessionDbId, epoch, sourceIde, {
      content_session_id: sessionId,
      memory_session_id: memorySessionId,
      project,
      user_prompt: userPrompt || '',
      status: 'active',
      started_at: isoString,
      started_at_epoch: epoch,
    });

    logger.info('HTTP', '<<< handleSessionStart completed - new session created', {
      sessionDbId,
      memorySessionId,
      project
    });

    res.statusCode = 200;
    res.end(JSON.stringify({
      success: true,
      sessionDbId,
      memorySessionId
    }));
  }

  /**
   * End a session and generate summary
   * Uses deduplication to prevent multiple concurrent summary generations for the same session
   */
  private async handleSessionEnd(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await this.parseBody(req);
    const { sessionId, reason } = body;
    // Optional — populated by claude / cursor-agent Stop hook payloads. Used
    // for reverse-dedup against any imported row whose (jsonl sid, last
    // turn index) matches the turn this hook is firing for. See
    // services/import/reverse-dedup.ts.
    const transcriptPath: string | undefined =
      typeof body.transcript_path === 'string' ? body.transcript_path : undefined;

    if (!sessionId) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'sessionId is required' }));
      return;
    }

    // Get session info
    const session = getSessionByContentId(sessionId);
    if (!session) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    const memorySessionId = session.memory_session_id!;

    // Check if summary generation is already in progress for this session
    if (this.pendingSummaries.has(memorySessionId)) {
      logger.info('WORKER', 'Summary generation already in progress, reusing queued request', { sessionId, memorySessionId });
      res.statusCode = 200;
      res.end(JSON.stringify({
        success: true,
        queued: true,
        reason,
        cached: true
      }));
      return;
    }

    // Return 200 immediately, generate summary in the background.
    // hooks-cli must receive a fast HTTP response before Cursor kills the hook process.
    res.statusCode = 200;
    res.end(JSON.stringify({ success: true, queued: true, reason }));

    logger.info('WORKER', 'Session end accepted, generating summary in background', { sessionId, memorySessionId });

    const sourceIdeHint = typeof body.sourceIDE === 'string' ? body.sourceIDE : undefined;
    const summaryPromise = (async () => {
      await this.waitForObservationQuiescence(memorySessionId);
      return this.sdkAgent.generateSummary(memorySessionId, session.project, sourceIdeHint);
    })();
    this.pendingSummaries.set(memorySessionId, summaryPromise);

    try {
      const summaryResult = await summaryPromise;
      updateSessionStatus(sessionId, 'completed', new Date().toISOString());
      logger.info('WORKER', 'Background summary generation completed', { sessionId, memorySessionId });

      // Bug fix (2.1.0-beta.5): SDKAgent.generateSummary writes via insertSummary()
      // directly without going through any event bus. Without this emit the
      // hybrid vector indexer NEVER sees LLM-generated rolling summaries, and
      // vec.db.session_summaries stays at 0 forever (verified on real users
      // who had hundreds of LLM summaries but zero vector embeddings for them).
      // Emit here on the WorkerService side so we don't need to plumb eventBus
      // through SDKAgent (keeps SDKAgent UI-free as designed).
      if (summaryResult && typeof summaryResult.id === 'number') {
        this.eventBus.emit('new_summary', {
          id: summaryResult.id,
          session_id: memorySessionId,
          project: session.project,
        });

        // Reverse dedup: if the import path beat this hook to writing a
        // row for the same (jsonl sid, turn index), delete that imported
        // row now that the more-complete hook row exists. Closes the
        // post-install race window — see services/import/reverse-dedup.ts
        // for the full rationale and match criteria.
        try {
          const dedupResult = reverseDedupAfterHookSummary({
            transcriptPath,
            hookSummaryId: summaryResult.id,
          });
          if (dedupResult.deletedSummaryIds.length > 0) {
            logger.info(
              'WORKER',
              'reverse-dedup removed imported row(s) superseded by hook summary',
              {
                hookSummaryId: summaryResult.id,
                memorySessionId,
                project: session.project,
                deleted: dedupResult.deletedSummaryIds,
              },
            );
          }
        } catch (rdErr) {
          // Reverse dedup is a best-effort cleanup; never block the hook
          // path if it throws (e.g. transient DB lock, malformed jsonl).
          logger.warn('WORKER', 'reverse-dedup failed (non-fatal)', {
            error: String(rdErr),
          });
        }
      }

      // Trigger Self-Evolve after summary is ready (non-blocking)
      if (this.selfEvolve) {
        const evolveWorkspace = session.project;
        const evolveMsid = memorySessionId;
        const plugin = this.selfEvolve;
        setImmediate(() => {
          plugin.onSessionEnd(evolveMsid, evolveWorkspace).catch(
            err => logger.error('SELF_EVOLVE', 'onSessionEnd failed', { evolveMsid }, err as Error),
          );
        });
      }

      // Enqueue summary for remote sync
      if (summaryResult && summaryResult.id && this.syncQueue) {
        this.syncQueue.enqueue('summary', summaryResult.id, summaryResult.created_at_epoch, summaryResult.source_ide || '', {
          memory_session_id: summaryResult.memory_session_id,
          project: summaryResult.project,
          request: summaryResult.request,
          investigated: summaryResult.investigated,
          learned: summaryResult.learned,
          meta_intent: summaryResult.meta_intent,
          completed: summaryResult.completed,
          next_steps: summaryResult.next_steps,
          files_read: summaryResult.files_read,
          files_edited: summaryResult.files_edited,
          notes: summaryResult.notes,
          prompt_number: summaryResult.prompt_number,
          discovery_tokens: summaryResult.discovery_tokens,
          created_at: summaryResult.created_at,
          created_at_epoch: summaryResult.created_at_epoch,
        });
      }
    } catch (error) {
      logger.error('WORKER', 'Failed to generate summary', { sessionId }, error as Error);
    } finally {
      this.pendingSummaries.delete(memorySessionId);
    }
  }

  /**
   * Update a whitelisted field on sdk_sessions.
   */
  private async handleSessionField(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    try {
      const parsed = await this.parseBody(req) as {
        sessionId?: string;
        field?: string;
        value?: string | null;
      };
      if (!parsed.sessionId || !parsed.field) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: 'sessionId and field required' }));
        return;
      }
      updateSessionField(
        String(parsed.sessionId),
        String(parsed.field),
        parsed.value == null ? null : String(parsed.value)
      );
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = /disallowed field/.test(msg) ? 400 : 500;
      res.statusCode = status;
      res.end(JSON.stringify({ success: false, error: msg }));
    }
  }

  /**
   * Create a session on demand when it is missing.
   *
   * Normally the session is created by the session-start hook before any
   * observation arrives. But that hook can be lost — e.g. on Chinese (cp936)
   * Windows, Cursor's session-init payload may fail to decode, so the session
   * is never registered and every later observation/summary would 404. As long
   * as a later hook carries the project path we recreate the session here so
   * recording (and the transcript-based summary, read from the clean on-disk
   * transcript) still works. Idempotent: returns the existing session if found.
   */
  private lazyCreateSession(sessionId: string, project: string, sourceIde: string) {
    const existing = getSessionByContentId(sessionId);
    if (existing) return existing;
    if (isLowConfidenceProjectPath(project)) {
      logger.warn('HTTP', 'Refusing to lazy-create session from low-confidence project path', {
        sessionId,
        project,
        sourceIde,
      });
      return undefined;
    }

    const memorySessionId = `mem-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const { isoString, epoch } = normalizeTimestamp(new Date());
    const sessionDbId = createSession({
      content_session_id: sessionId,
      memory_session_id: memorySessionId,
      project,
      user_prompt: '',
      started_at: isoString,
      started_at_epoch: epoch,
      completed_at: null,
      completed_at_epoch: null,
      status: 'active',
      worker_port: this.config.port,
      prompt_counter: 0,
      source_ide: sourceIde || null,
    });
    this.syncQueue?.enqueue('session', sessionDbId, epoch, sourceIde, {
      content_session_id: sessionId,
      memory_session_id: memorySessionId,
      project,
      user_prompt: '',
      status: 'active',
      started_at: isoString,
      started_at_epoch: epoch,
    });
    logger.info('HTTP', 'Lazy-created missing session', { sessionId, project, sessionDbId });
    return getSessionByContentId(sessionId);
  }

  /**
   * Record an observation from tool usage
   */
  private async handleObservation(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    logger.info('HTTP', '>>> handleObservation called');
    const body = await this.parseBody(req);
    logger.debug('HTTP', 'Observation request body', {
      sessionId: body.sessionId,
      toolName: body.toolName,
      observationType: body.observationType,
      toolInputType: typeof body.toolInput,
      toolOutputType: typeof body.toolOutput,
      toolInputPreview: JSON.stringify(body.toolInput)?.substring(0, 200),
      toolOutputPreview: JSON.stringify(body.toolOutput)?.substring(0, 200)
    });
    const { sessionId, toolName, toolInput, toolOutput, observationType } = body;

    if (!sessionId) {
      logger.warn('HTTP', 'Observation missing sessionId');
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'sessionId is required' }));
      return;
    }

    // Get session
    logger.debug('HTTP', 'Looking up session for observation', { sessionId });
    let session = getSessionByContentId(sessionId);
    if (!session) {
      // The session-start hook may have been lost (e.g. cp936 Windows decode
      // failure). Recreate it from the project path the hook still carries so
      // recording isn't silently dropped. Only 404 when we truly can't.
      const project = typeof body.projectPath === 'string' ? body.projectPath.trim() : '';
      if (project) {
        session = this.lazyCreateSession(sessionId, project, body.sourceIDE || '');
      }
      if (!session) {
        logger.warn('HTTP', 'Session not found for observation', { sessionId, hadProject: !!project });
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
    }
    logger.debug('HTTP', 'Session found', {
      sessionDbId: session.id,
      memorySessionId: session.memory_session_id,
      project: session.project
    });

    // Return 200 immediately, process observation in the background.
    // hooks-cli must receive a fast HTTP response before Cursor kills the hook process.
    res.statusCode = 200;
    res.end(JSON.stringify({ success: true, queued: true }));

    logger.info('HTTP', 'Observation accepted, processing in background', {
      memorySessionId: session.memory_session_id,
      project: session.project,
      toolName
    });

    const observationPromise = this.sdkAgent.processObservation({
      memorySessionId: session.memory_session_id!,
      project: session.project,
      toolName,
      toolInput,
      toolOutput,
      observationType,
      sourceIde: typeof body.sourceIDE === 'string' ? body.sourceIDE : undefined
    });
    this.trackPendingObservation(session.memory_session_id!, observationPromise);

    try {
      const result = await observationPromise;
      this.eventBus.emit('new_observation', {
        // Bug fix (2.1.0-beta.6): the listener at WorkerService.ts:233 reads
        // payload.id and feeds it to HybridIndexer.enqueue('observation', id).
        // Before this fix, id was missing, so every new obs ended up enqueued
        // as `undefined` — drainQueue's SQL "WHERE id IN (undefined)" returned
        // 0 rows and embedding silently no-op'd. Result: incremental obs
        // embedding has been broken since the hybrid stack landed; vec.db
        // only filled via bootstrap reindex's separate fetchPage path.
        id: result?.id,
        project: session.project,
        type: observationType,
        tool: toolName,
        content: (typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput))?.substring(0, 200),
      });
      logger.info('HTTP', '<<< handleObservation background processing completed', { toolName });

      // Enqueue for remote sync if observation was stored
      if (result && this.syncQueue) {
        const sourceIde = body.sourceIDE || '';
        this.syncQueue.enqueue('observation', result.id, result.created_at_epoch, sourceIde, {
          memory_session_id: result.memory_session_id,
          project: result.project,
          text: result.text,
          type: result.type,
          title: result.title,
          subtitle: result.subtitle,
          meta_intent: result.meta_intent,
          facts: result.facts,
          narrative: result.narrative,
          concepts: result.concepts,
          files_read: result.files_read,
          files_modified: result.files_modified,
          prompt_number: result.prompt_number,
          discovery_tokens: result.discovery_tokens,
          created_at: result.created_at,
          created_at_epoch: result.created_at_epoch,
        });
      }

      // Notify Self-Evolve incremental scheduler
      if (result && this.selfEvolve) {
        this.selfEvolve.onObservationAdded({
          id: result.id,
          type: result.type || observationType || 'unknown',
          title: result.title || '',
          narrative: result.narrative || '',
          files_modified: result.files_modified || '',
          project: session.project,
          workspace: session.project,
          memorySessionId: session.memory_session_id!,
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      logger.error('WORKER', 'Failed to process observation', { sessionId, toolName }, error as Error);
    }
  }

  private trackPendingObservation(memorySessionId: string, promise: Promise<any>): void {
    let set = this.pendingObservations.get(memorySessionId);
    if (!set) {
      set = new Set();
      this.pendingObservations.set(memorySessionId, set);
    }
    set.add(promise);
    promise.then(() => {
      const current = this.pendingObservations.get(memorySessionId);
      if (!current) return;
      current.delete(promise);
      if (current.size === 0) {
        this.pendingObservations.delete(memorySessionId);
      }
    }, () => {
      const current = this.pendingObservations.get(memorySessionId);
      if (!current) return;
      current.delete(promise);
      if (current.size === 0) {
        this.pendingObservations.delete(memorySessionId);
      }
    });
  }

  private async waitForObservationQuiescence(
    memorySessionId: string,
    quietMs = 3000,
    maxWaitMs = 30000
  ): Promise<void> {
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      const pending = this.pendingObservations.get(memorySessionId);
      if (pending && pending.size > 0) {
        logger.info('WORKER', 'Waiting for pending observations before summary', {
          memorySessionId,
          pending: pending.size,
        });
        await Promise.race([
          Promise.allSettled(Array.from(pending)),
          this.sleep(Math.max(0, deadline - Date.now())),
        ]);
        continue;
      }

      await this.sleep(Math.min(quietMs, Math.max(0, deadline - Date.now())));
      const afterQuiet = this.pendingObservations.get(memorySessionId);
      if (!afterQuiet || afterQuiet.size === 0) {
        return;
      }
    }

    logger.warn('WORKER', 'Timed out waiting for observations before summary', { memorySessionId });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get context to inject into prompts
   */
  private async handleContextInject(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ): Promise<void> {
    const project = url.searchParams.get('project');
    const limit = parseInt(url.searchParams.get('limit') || '10', 10);

    if (!project) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'project is required' }));
      return;
    }

    try {
      // Get recent observations and summaries for context.
      // 分档召回：默认只注入 Tier ≥2，Tier 2 不足时用 Tier 1 trace 兜底。
      const observations = getTieredObservationsByProject(project, limit);
      const summaries = getSummariesByProject(project, 3);

      // Build context string with clear instructions for AI
      let context = `<memory_context>
<instructions>
以下是用户在本项目中的真实历史任务记录，存储在本地数据库中。
当用户询问"最近做了什么任务"、"之前做过什么"、"历史任务"等问题时，必须优先参考此处的 <recent_sessions> 数据来回答，而不是其他来源。
<recent_sessions> 中的每个 <session> 代表一次完整的对话任务，按时间倒序排列（最新的在前）。
</instructions>
`;
      
      if (summaries.length > 0) {
        context += '<recent_sessions description="用户最近的对话任务记录，按时间倒序排列">\n';
        for (const s of summaries) {
          context += `<session date="${s.created_at}">
  <request>${s.request || ''}</request>
  <learned>${s.learned || ''}</learned>
  <completed>${s.completed || ''}</completed>
</session>\n`;
        }
        context += '</recent_sessions>\n';
      }

      if (observations.length > 0) {
        context += '<observations description="用户在项目中记录的重要观察和笔记">\n';
        for (const o of observations) {
          context += `<observation type="${o.type}" date="${o.created_at}">
  <title>${o.title || ''}</title>
  <narrative>${o.narrative || ''}</narrative>
</observation>\n`;
        }
        context += '</observations>\n';
      }

      context += '</memory_context>';

      res.statusCode = 200;
      res.end(JSON.stringify({
        success: true,
        context,
        tokenCount: Math.ceil(context.length / 4)
      }));
    } catch (error) {
      logger.error('WORKER', 'Failed to build context', { project }, error as Error);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Failed to build context' }));
    }
  }

  /**
   * Search memories
   */
  private async handleSearch(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ): Promise<void> {
    const project = url.searchParams.get('project') || undefined;
    const query = url.searchParams.get('query') || url.searchParams.get('q') || '';
    const modeRaw = url.searchParams.get('mode');
    const mode = (modeRaw === 'sqlite' || modeRaw === 'chroma' || modeRaw === 'hybrid' || modeRaw === 'vector')
      ? modeRaw
      : 'hybrid';
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);
    const dateStart = url.searchParams.get('dateStart') || undefined;
    const dateEnd = url.searchParams.get('dateEnd') || undefined;
    const obsTypeRaw = url.searchParams.get('obs_type') || url.searchParams.get('type');
    const obs_type = obsTypeRaw
      ? obsTypeRaw.split(',').map(s => s.trim()).filter(Boolean)
      : undefined;

    if (!query) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'query is required' }));
      return;
    }

    // 优先走本地 hybrid 检索栈(若已就绪): mode=hybrid|vector 都由 HybridSearchService 处理。
    // mode=sqlite 总是走原 SearchOrchestrator(保留 chroma 模式兼容)。
    if ((mode === 'hybrid' || mode === 'vector') && this.hybridSearchService) {
      try {
        const result = await this.hybridSearchService.search({
          query, mode, project, limit, obs_type, dateStart, dateEnd,
        });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        // 兼容 agentMemory-hybrid-mcp 已有调用方:既给 success/results/count(老 shape),
        // 又给 observations/summaries/timings/counts(新 shape)。
        res.end(JSON.stringify({
          success: true,
          results: result.observations.map((o) => ({ ...(o.row || {}), id: o.id, score: o.score })),
          count: result.observations.length + result.summaries.length,
          mode: result.mode,
          fellBack: result.fellBack,
          degraded: result.degraded,
          degradedReason: result.degradedReason,
          observations: result.observations,
          summaries: result.summaries,
          timings: result.timings,
          counts: result.counts,
        }));
      } catch (err) {
        logger.error('WORKER', 'Hybrid search failed', { project, query, mode }, err as Error);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'Hybrid search failed', detail: String(err) }));
      }
      return;
    }

    if (!this.searchOrchestrator) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: 'Search not initialized yet' }));
      return;
    }

    try {
      // 'vector' 模式时退化为 sqlite(orchestrator 不认 vector)
      const fallbackMode = mode === 'vector' ? 'sqlite' : mode;
      const results = await this.searchOrchestrator.search({
        query, mode: fallbackMode, project, limit, dateStart, dateEnd, obs_type,
      });
      const formatted = formatSearchResults(results);

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      // Preserve backward-compatible shape (`success`, `results`, `count`)
      // alongside the new orchestrator shape.
      res.end(JSON.stringify({
        success: true,
        results: formatted.observations,
        count: formatted.observations.length,
        mode: formatted.mode,
        fellBack: formatted.fellBack,
        observations: formatted.observations,
        summaries: formatted.summaries,
      }));
    } catch (error) {
      logger.error('WORKER', 'Search failed', { project, query, mode }, error as Error);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Search failed', detail: String(error) }));
    }
  }

  /**
   * Search memories using SQL LIKE (better for Chinese text)
   */
  private async handleSearchLike(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ): Promise<void> {
    const project = url.searchParams.get('project');
    const query = url.searchParams.get('query');
    const type = url.searchParams.get('type'); // 'observations', 'summaries', or 'all'
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);

    if (!query) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'query is required' }));
      return;
    }

    try {
      const searchType = type || 'all';
      const results: {
        observations?: any[];
        summaries?: any[];
      } = {};

      if (searchType === 'observations' || searchType === 'all') {
        results.observations = searchObservationsLike(query, {
          project: project || undefined,
          limit
        });
      }

      if (searchType === 'summaries' || searchType === 'all') {
        results.summaries = searchSummariesLike(query, {
          project: project || undefined,
          limit
        });
      }

      res.statusCode = 200;
      res.end(JSON.stringify({
        success: true,
        query,
        searchType,
        results,
        counts: {
          observations: results.observations?.length || 0,
          summaries: results.summaries?.length || 0
        }
      }));
    } catch (error) {
      logger.error('WORKER', 'Search LIKE failed', { project, query }, error as Error);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Search LIKE failed' }));
    }
  }

  /**
   * Get timeline context around an observation (for MCP timeline tool)
   */
  private async handleTimeline(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ): Promise<void> {
    const anchorParam = url.searchParams.get('anchor');
    const project = url.searchParams.get('project');
    const depthBefore = parseInt(url.searchParams.get('depth_before') || '5', 10);
    const depthAfter = parseInt(url.searchParams.get('depth_after') || '5', 10);

    if (!anchorParam) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'anchor (observation ID) is required' }));
      return;
    }

    const anchorId = parseInt(anchorParam, 10);
    if (isNaN(anchorId)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'anchor must be a valid number' }));
      return;
    }

    try {
      const timeline = getObservationsTimeline(anchorId, depthBefore, depthAfter, project || undefined);

      res.statusCode = 200;
      res.end(JSON.stringify({
        success: true,
        timeline,
        anchorId,
        counts: {
          before: timeline.before.length,
          after: timeline.after.length
        }
      }));
    } catch (error) {
      logger.error('WORKER', 'Timeline fetch failed', { anchorId }, error as Error);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Timeline fetch failed' }));
    }
  }

  /**
   * Batch fetch observations by IDs (for MCP get_observations tool)
   */
  private async handleObservationsBatch(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await this.parseBody(req);
    const { ids, project, limit, orderBy } = body;

    if (!ids || !Array.isArray(ids)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'ids array is required' }));
      return;
    }

    try {
      let results = getObservationsByIds(ids, project || undefined);
      
      // Apply limit if specified
      if (limit && typeof limit === 'number' && results.length > limit) {
        results = results.slice(0, limit);
      }

      res.statusCode = 200;
      res.end(JSON.stringify({
        success: true,
        results,
        count: results.length
      }));
    } catch (error) {
      logger.error('WORKER', 'Observations batch fetch failed', { ids }, error as Error);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Observations batch fetch failed' }));
    }
  }

  /**
   * Batch fetch summaries by IDs (for MCP get_summaries tool)
   */
  private async handleSummariesBatch(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await this.parseBody(req);
    const { ids, project, limit, offset } = body;

    try {
      let results;
      
      if (ids && Array.isArray(ids) && ids.length > 0) {
        // Fetch by specific IDs
        results = getSummariesByIds(ids, project || undefined);
      } else {
        // Fetch all summaries with optional project filter
        const queryLimit = limit && typeof limit === 'number' ? limit : 100;
        results = getAllSummaries(queryLimit, project || undefined);
        
        // Apply offset if specified
        if (offset && typeof offset === 'number') {
          results = results.slice(offset);
        }
      }
      
      // Apply limit after offset
      if (limit && typeof limit === 'number' && results.length > limit) {
        results = results.slice(0, limit);
      }

      res.statusCode = 200;
      res.end(JSON.stringify({
        success: true,
        results,
        count: results.length
      }));
    } catch (error) {
      logger.error('WORKER', 'Summaries batch fetch failed', { ids }, error as Error);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Summaries batch fetch failed' }));
    }
  }

  /**
   * Manually submit a summary
   */
  private async handleSummary(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await this.parseBody(req);
    const { sessionId, summary } = body;

    if (!sessionId || !summary) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'sessionId and summary are required' }));
      return;
    }

    const session = getSessionByContentId(sessionId);
    if (!session) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    try {
      const { isoString, epoch } = normalizeTimestamp(new Date());
      
      insertSummary({
        memory_session_id: session.memory_session_id!,
        project: session.project,
        request: summary.request || null,
        investigated: summary.investigated || null,
        learned: summary.learned || null,
        media_context: summary.media_context || null,
        meta_intent: summary.meta_intent || null,
        completed: summary.completed || null,
        next_steps: summary.next_steps || null,
        files_read: summary.files_read || null,
        files_edited: summary.files_edited || null,
        notes: summary.notes || null,
        prompt_number: 0,
        discovery_tokens: 0,
        created_at: isoString,
        created_at_epoch: epoch
      });

      this.eventBus.emit('new_summary', { session_id: session.memory_session_id, project: session.project });

      res.statusCode = 200;
      res.end(JSON.stringify({ success: true }));
    } catch (error) {
      logger.error('WORKER', 'Failed to save summary', { sessionId }, error as Error);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Failed to save summary' }));
    }
  }

  // ==================== Session / Readiness / SSE Handlers ====================

  private async handleSessionComplete(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.parseBody(req);
    const sessionId: string | undefined = body.sessionId ?? body.session_id;
    if (!sessionId) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'sessionId required' }));
      return;
    }

    try {
      updateSessionStatus(sessionId, 'completed', new Date().toISOString());
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, sessionId }));
    } catch (error) {
      logger.error('API', 'Error completing session', {}, error as Error);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
  }

  private async handleReadiness(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const stats = getDatabaseStats();
      const ready = stats && stats.observations !== undefined;
      res.statusCode = ready ? 200 : 503;
      res.end(JSON.stringify({
        ready,
        chroma: this.chromaSync !== null,
        uptime: process.uptime()
      }));
    } catch {
      res.statusCode = 503;
      res.end(JSON.stringify({ ready: false }));
    }
  }

  // ── Plugin UI manifest ──────────────────────────────────────────────────────

  private handlePluginsUIManifest(res: http.ServerResponse): void {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, data: this.pluginUIManifests }));
  }

  // ── Self-Evolve plugin handlers ─────────────────────────────────────────────

  private async handleSelfEvolveStatus(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.selfEvolve) {
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, data: { enabled: false, currentState: 'idle', lastRunAt: null, lastRunStatus: null, lastError: null } }));
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ success: true, data: this.selfEvolve.getStatus() }));
  }

  private async handleSelfEvolveTrigger(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.selfEvolve) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Self-Evolve plugin is disabled' }));
      return;
    }
    const body = await this.parseBody(req);
    const { memorySessionId, workspace, force } = body as {
      memorySessionId?: string; workspace?: string; force?: boolean;
    };
    // Fallback: when the caller cannot supply a workspace (e.g. a fresh install
    // whose Self-Evolve tables are still empty), derive it from the most recent
    // session so the manual trigger can bootstrap the very first evolution.
    let targetWorkspace = String(workspace ?? '').trim();
    if (!targetWorkspace) {
      const recent = getAllSessions(1);
      targetWorkspace = String(recent[0]?.project ?? '').trim();
    }
    if (!targetWorkspace) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'workspace is required' }));
      return;
    }
    const sessionId = memorySessionId ?? `manual-${Date.now()}`;
    res.statusCode = 200;
    res.end(JSON.stringify({ success: true, queued: true, workspace: targetWorkspace }));
    this.selfEvolve.triggerEvolve(sessionId, targetWorkspace, force ?? false).catch(
      err => logger.error('SELF_EVOLVE', 'Manual trigger failed', {}, err as Error),
    );
  }

  private async handleSelfEvolveReviewPending(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.selfEvolve) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Self-Evolve plugin is disabled' }));
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const workspace = url.searchParams.get('workspace') ?? '';
    const pending = this.selfEvolve.getPendingReview(workspace);
    res.statusCode = 200;
    res.end(JSON.stringify({ pending, total: pending.length }));
  }

  private async handleSelfEvolveReviewApprove(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.selfEvolve) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Self-Evolve plugin is disabled' }));
      return;
    }
    const body = await this.parseBody(req);
    const { id, type, targetPlatforms } = body as { id?: number; type?: 'rule' | 'skill'; targetPlatforms?: string[] };
    if (!id || !type) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'id and type are required' }));
      return;
    }
    await this.selfEvolve.approveArtifact(id, type, targetPlatforms);
    res.statusCode = 200;
    res.end(JSON.stringify({ success: true }));
  }

  private async handleSelfEvolveReviewReject(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.selfEvolve) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Self-Evolve plugin is disabled' }));
      return;
    }
    const body = await this.parseBody(req);
    const { id, type, reason } = body as {
      id?: number; type?: 'rule' | 'skill'; reason?: string;
    };
    if (!id || !type) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'id and type are required' }));
      return;
    }
    await this.selfEvolve.rejectArtifact(id, type, reason ?? '');
    res.statusCode = 200;
    res.end(JSON.stringify({ success: true }));
  }

  // ─── Injector plugin handlers ──────────────────────────────────────────────

  private injectorDisabled(res: http.ServerResponse): boolean {
    if (this.injector) return false;
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Injector plugin is disabled' }));
    return true;
  }

  private async handleInjectorCatalog(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.injectorDisabled(res)) return;
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const workspace = url.searchParams.get('workspace') ?? undefined;
    const data = this.injector!.getCatalog(workspace);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, data }));
  }

  private async handleInjectorDetect(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.injectorDisabled(res)) return;
    const data = await this.injector!.detectIdes();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, data }));
  }

  private async handleInjectorLedger(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.injectorDisabled(res)) return;
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const workspace = url.searchParams.get('workspace') ?? undefined;
    const data = this.injector!.getLedger(workspace);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true, data }));
  }

  private async handleInjectorPreview(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.injectorDisabled(res)) return;
    const body = await this.parseBody(req);
    const items: string[] = Array.isArray(body.items) ? body.items : [];
    const ides: string[] = Array.isArray(body.ides) ? body.ides : [];
    const workspace: string = body.workspace ?? '';
    if (!workspace || items.length === 0) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'items and workspace are required' }));
      return;
    }
    try {
      const data = this.injector!.preview(items, ides, workspace);
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, data }));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  }

  private async handleInjectorInject(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.injectorDisabled(res)) return;
    const body = await this.parseBody(req);
    const items: string[] = Array.isArray(body.items) ? body.items : [];
    const ides: string[] = Array.isArray(body.ides) ? body.ides : [];
    const workspace: string = body.workspace ?? '';
    if (!workspace || items.length === 0) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'items and workspace are required' }));
      return;
    }
    try {
      const data = this.injector!.inject(items, ides, workspace);
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, data }));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  }

  private async handleInjectorUninstall(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.injectorDisabled(res)) return;
    const body = await this.parseBody(req);
    const ledgerId = Number(body.ledgerId ?? body.id);
    if (!Number.isFinite(ledgerId)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'ledgerId is required' }));
      return;
    }
    try {
      const data = this.injector!.uninstall(ledgerId);
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, data }));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err) }));
    }
  }

  private async handleViewerRules(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.selfEvolve) {
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, data: [] }));
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const workspace = url.searchParams.get('workspace') ?? '';
    const category = url.searchParams.get('category') ?? undefined;
    const data = this.selfEvolve.getRules(workspace, category);
    res.statusCode = 200;
    res.end(JSON.stringify({ success: true, data }));
  }

  private async handleViewerSkills(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.selfEvolve) {
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, data: [] }));
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const workspace = url.searchParams.get('workspace') ?? '';
    const data = this.selfEvolve.getSkills(workspace);
    res.statusCode = 200;
    res.end(JSON.stringify({ success: true, data }));
  }

  private async handleViewerEvoLog(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.selfEvolve) {
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, data: [] }));
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const workspace = url.searchParams.get('workspace') ?? '';
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    const data = this.selfEvolve.getEvoLog(workspace, limit);
    res.statusCode = 200;
    res.end(JSON.stringify({ success: true, data }));
  }

  private handleStream(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.statusCode = 200;
    res.write('retry: 3000\n\n');

    const onObservation = (data: any) => {
      res.write(`event: new_observation\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onSummary = (data: any) => {
      res.write(`event: new_summary\ndata: ${JSON.stringify(data)}\n\n`);
    };

    this.eventBus.on('new_observation', onObservation);
    this.eventBus.on('new_summary', onSummary);

    const keepalive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15000);

    req.on('close', () => {
      this.eventBus.off('new_observation', onObservation);
      this.eventBus.off('new_summary', onSummary);
      clearInterval(keepalive);
    });
  }

  // ==================== Viewer API Handlers ====================

  /**
   * Get all sessions for viewer
   */
  private async handleViewerSessions(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ): Promise<void> {
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    const project = url.searchParams.get('project');

    try {
      let sessions;
      if (project) {
        const { getSessionsByProject } = await import('../sqlite/sessions.js');
        sessions = getSessionsByProject(project, limit);
      } else {
        sessions = getAllSessions(limit);
      }

      res.statusCode = 200;
      res.end(JSON.stringify({
        success: true,
        data: sessions,
        count: sessions.length
      }));
    } catch (error) {
      logger.error('WORKER', 'Failed to get sessions', {}, error as Error);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Failed to get sessions' }));
    }
  }

  /**
   * Get all observations for viewer
   */
  private async handleViewerObservations(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ): Promise<void> {
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    const project = url.searchParams.get('project');

    try {
      const observations = getAllObservations(limit, project || undefined);

      res.statusCode = 200;
      res.end(JSON.stringify({
        success: true,
        data: observations,
        count: observations.length
      }));
    } catch (error) {
      logger.error('WORKER', 'Failed to get observations', {}, error as Error);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Failed to get observations' }));
    }
  }

  /**
   * Get all summaries for viewer
   */
  private async handleViewerSummaries(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ): Promise<void> {
    const limit = parseInt(url.searchParams.get('limit') || '100', 10);
    const project = url.searchParams.get('project');

    try {
      const summaries = getAllSummaries(limit, project || undefined);

      res.statusCode = 200;
      res.end(JSON.stringify({
        success: true,
        data: summaries,
        count: summaries.length
      }));
    } catch (error) {
      logger.error('WORKER', 'Failed to get summaries', {}, error as Error);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Failed to get summaries' }));
    }
  }

  /**
   * Get all distinct projects for viewer
   */
  private async handleViewerProjects(
    _req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    try {
      const projects = getDistinctProjects();

      res.statusCode = 200;
      res.end(JSON.stringify({
        success: true,
        data: projects,
        count: projects.length
      }));
    } catch (error) {
      logger.error('WORKER', 'Failed to get projects', {}, error as Error);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Failed to get projects' }));
    }
  }

  private async handleViewerConfig(res: http.ServerResponse): Promise<void> {
    const cfg = getSyncConfig();
    res.statusCode = 200;
    res.end(JSON.stringify({
      success: true,
      data: {
        remoteEnabled: cfg.enabled && !!cfg.remoteUrl,
        remoteUrl: cfg.remoteUrl || null,
        deviceId: getDeviceId(),
      },
    }));
  }

  private async handleSyncStatus(res: http.ServerResponse): Promise<void> {
    const cfg = getSyncConfig();
    const queue = this.syncQueue?.getStats() || { pending: 0, failed: 0, sent: 0, total: 0 };
    const backfill = this.syncQueue?.getBackfillStats() || {
      running: false, total: 0, enqueued: 0, startedAt: null, completedAt: null,
      lastError: null, remaining: 0, sent_recently: 0, eta_ms: null,
    };
    res.statusCode = 200;
    res.end(JSON.stringify({
      success: true,
      data: {
        queue,
        backfill,
        remote: { configured: cfg.enabled && !!cfg.remoteUrl, url: cfg.remoteUrl || null },
      },
    }));
  }

  private normalizeShadowFolkWorkspaces(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const workspaces: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const workspace = item.trim();
      if (!workspace) continue;
      const key = this.shadowFolkPathKey(workspace);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      workspaces.push(workspace);
    }
    return workspaces;
  }

  private shadowFolkPathKey(value: string): string {
    const normalized = value.trim().replace(/\\/g, '/').replace(/^\/([a-z]:\/)/i, '$1').replace(/\/+$/, '');
    if (/^[a-z]:\//i.test(normalized)) return normalized.toLowerCase();
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }

  private normalizeShadowFolkWorkspaceAliases(value: unknown): ShadowFolkWorkspaceAlias[] {
    if (!Array.isArray(value)) return [];
    const aliases = new Map<string, { alias: ShadowFolkWorkspaceAlias; memoryRootKeys: Set<string> }>();
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const workspace = typeof record.workspace === 'string' ? record.workspace.trim() : '';
      const workspaceKey = this.shadowFolkPathKey(workspace);
      if (!workspace || !workspaceKey || !Array.isArray(record.memoryRoots)) continue;

      let target = aliases.get(workspaceKey);
      if (!target) {
        target = { alias: { workspace, memoryRoots: [] }, memoryRootKeys: new Set<string>() };
        aliases.set(workspaceKey, target);
      }

      for (const rootValue of record.memoryRoots) {
        if (typeof rootValue !== 'string') continue;
        const root = rootValue.trim();
        const rootKey = this.shadowFolkPathKey(root);
        if (!root || !rootKey || target.memoryRootKeys.has(rootKey)) continue;
        target.memoryRootKeys.add(rootKey);
        target.alias.memoryRoots.push(root);
      }
    }

    return Array.from(aliases.values())
      .map(({ alias }) => alias)
      .filter(alias => alias.memoryRoots.length > 0);
  }

  private buildShadowFolkWorkspaceConfigs(workspaces: string[], aliases: ShadowFolkWorkspaceAlias[]): ShadowFolkWorkspaceConfig[] {
    const aliasesByKey = new Map(aliases.map(alias => [this.shadowFolkPathKey(alias.workspace), alias]));
    return workspaces.map(workspace => {
      const matched = aliasesByKey.get(this.shadowFolkPathKey(workspace));
      return {
        workspace,
        memoryRoots: matched ? [...matched.memoryRoots] : [],
      };
    });
  }

  private findShadowFolkWorkspaceConfig(workspace: string, configs: ShadowFolkWorkspaceConfig[]): ShadowFolkWorkspaceConfig {
    const key = this.shadowFolkPathKey(workspace);
    return configs.find(item => this.shadowFolkPathKey(item.workspace) === key) || { workspace, memoryRoots: [] };
  }

  private listShadowFolkMemoryProjectsForAliasSuggestions(): string[] {
    const rows = getDatabase().prepare(`
      SELECT DISTINCT project FROM observations WHERE project IS NOT NULL AND project != ''
      UNION
      SELECT DISTINCT project FROM session_summaries WHERE project IS NOT NULL AND project != ''
      ORDER BY project ASC
    `).all() as Array<{ project: string }>;
    return rows.map(row => row.project).filter(Boolean);
  }

  private getShadowFolkRuntimeConfig(): {
    enabled: boolean;
    dailyTime: string;
    workspaces: string[];
    workspaceAliases: ShadowFolkWorkspaceAlias[];
    workspaceConfigs: ShadowFolkWorkspaceConfig[];
  } {
    const buildRuntime = (
      enabled: boolean,
      dailyTime: string,
      workspacesValue: unknown,
      aliasesValue: unknown,
    ) => {
      const workspaces = this.normalizeShadowFolkWorkspaces(workspacesValue);
      const workspaceAliases = this.normalizeShadowFolkWorkspaceAliases(aliasesValue);
      return {
        enabled,
        dailyTime,
        workspaces,
        workspaceAliases,
        workspaceConfigs: this.buildShadowFolkWorkspaceConfigs(workspaces, workspaceAliases),
      };
    };

    if (this.shadowfolkOverride) {
      return buildRuntime(
        this.shadowfolkOverride.enabled,
        this.shadowfolkOverride.dailyTime,
        this.shadowfolkOverride.workspaces,
        this.shadowfolkOverride.workspaceAliases,
      );
    }
    if (this.config.shadowfolk) {
      return buildRuntime(
        this.config.shadowfolk.enabled,
        this.config.shadowfolk.dailyTime || '23:30',
        this.config.shadowfolk.workspaces,
        (this.config.shadowfolk as any).workspaceAliases,
      );
    }
    let workspaces: unknown = [];
    let workspaceAliases: unknown = [];
    try {
      workspaces = JSON.parse(process.env.CODEBUDDY_MEM_SHADOWFOLK_WORKSPACES || '[]');
    } catch {
      workspaces = [];
    }
    try {
      workspaceAliases = JSON.parse(process.env.CODEBUDDY_MEM_SHADOWFOLK_WORKSPACE_ALIASES || '[]');
    } catch {
      workspaceAliases = [];
    }
    return buildRuntime(
      String(process.env.CODEBUDDY_MEM_SHADOWFOLK_ENABLED || '').toLowerCase() === 'true',
      process.env.CODEBUDDY_MEM_SHADOWFOLK_DAILY_TIME || '23:30',
      workspaces,
      workspaceAliases,
    );
  }

  private createShadowFolkUploader(): ShadowFolkUploaderLike | null {
    if (this.config.shadowfolk?.createUploader) {
      return this.config.shadowfolk.createUploader();
    }
    const config = loadShadowFolkConfig();
    if (!config) return null;
    return new ShadowFolkUploader({
      db: getDatabase(),
      server: config.server,
      apiToken: config.apiToken,
    });
  }

  private createShadowFolkWorkspaceValidator(): Pick<ShadowFolkUploaderLike, 'validateWorkspace'> {
    const override = this.config.shadowfolk?.createUploader?.();
    if (override?.validateWorkspace) return override;

    // Workspace validation is local-only and must not depend on ShadowFolk
    // credentials. The uploader consults the AgentMemory database when a path is
    // missing or is not a Git repository, enabling memory-only projects.
    return new ShadowFolkUploader({
      db: getDatabase(),
      server: 'http://localhost',
      apiToken: 'validation-only',
    });
  }

  private async runShadowFolkPush(): Promise<PushAllResult> {
    if (this.shadowfolkStatus.running) {
      throw new Error('ShadowFolk 上传正在运行');
    }
    const runtime = this.getShadowFolkRuntimeConfig();
    const uploader = this.createShadowFolkUploader();
    if (!uploader) {
      throw new Error('ShadowFolk 未配置，请先填写 ~/.shadow/config.json');
    }
    if (runtime.workspaces.length === 0) {
      throw new Error('请先添加至少一个上传工作区');
    }

    this.shadowfolkStatus.running = true;
    this.shadowfolkStatus.lastRunAt = new Date().toISOString();
    this.shadowfolkStatus.lastError = null;
    try {
      const result = await uploader.pushWorkspaces(runtime.workspaceConfigs);
      this.shadowfolkStatus.lastSuccessAt = new Date().toISOString();
      this.shadowfolkStatus.lastResult = result;
      return result;
    } catch (error) {
      this.shadowfolkStatus.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.shadowfolkStatus.running = false;
    }
  }

  private async handleShadowFolkStatus(res: http.ServerResponse): Promise<void> {
    const runtime = this.getShadowFolkRuntimeConfig();
    const configured = !!this.config.shadowfolk?.createUploader || !!loadShadowFolkConfig();
    const persistedLastSuccessAt = this.shadowfolkStatus.lastSuccessAt
      ? null
      : await this.getShadowFolkLastSuccessAtFromHistory(runtime.workspaceConfigs);
    res.statusCode = 200;
    res.end(JSON.stringify({
      success: true,
      enabled: runtime.enabled,
      configured,
      dailyTime: runtime.dailyTime,
      workspaces: runtime.workspaces.length,
      workspaceList: runtime.workspaces,
      workspaceAliasCounts: runtime.workspaceConfigs.map(item => ({ workspace: item.workspace, count: item.memoryRoots.length })),
      nextRunAt: this.shadowfolkNextRunAt,
      ...this.shadowfolkStatus,
      lastSuccessAt: this.shadowfolkStatus.lastSuccessAt || persistedLastSuccessAt,
    }));
  }

  private async getShadowFolkLastSuccessAtFromHistory(workspaceConfigs: ShadowFolkWorkspaceConfig[]): Promise<string | null> {
    const uploader = this.createShadowFolkUploader();
    if (!uploader?.listPushHistory) return null;

    let latest: string | null = null;
    for (const workspaceConfig of workspaceConfigs) {
      try {
        const history = await uploader.listPushHistory(workspaceConfig);
        for (const entry of history) {
          if (!entry.createdAt) continue;
          if (!latest || entry.createdAt > latest) latest = entry.createdAt;
        }
      } catch (error) {
        logger.warn('SHADOWFOLK', 'Failed to read push history for status', {
          workspace: workspaceConfig.workspace,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return latest;
  }

  private async handleShadowFolkWorkspaceValidate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.parseBody(req);
    const workspace = String(body.workspace || '').trim();
    if (!workspace) {
      res.statusCode = 400;
      res.end(JSON.stringify({ success: false, error: 'workspace is required' }));
      return;
    }
    const validator = this.createShadowFolkWorkspaceValidator();
    const result = await validator.validateWorkspace!(workspace);
    res.statusCode = result.valid ? 200 : 400;
    res.end(JSON.stringify({ success: result.valid, ...result }));
  }

  private async handleShadowFolkWorkspaceAliasSuggestions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req);
      const workspace = String(body.workspace || '').trim();
      const workspaceKey = this.shadowFolkPathKey(workspace);
      if (!workspace || !workspaceKey) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: 'workspace is required', suggestions: [] }));
        return;
      }

      const workspaceBasename = workspaceKey.split('/').pop() || '';
      const seen = new Set<string>();
      const suggestions: string[] = [];
      for (const project of this.listShadowFolkMemoryProjectsForAliasSuggestions()) {
        const projectValue = String(project || '').trim();
        const projectKey = this.shadowFolkPathKey(projectValue);
        if (!projectValue || !projectKey || projectKey === workspaceKey || seen.has(projectKey)) continue;
        if ((projectKey.split('/').pop() || '') !== workspaceBasename) continue;
        seen.add(projectKey);
        suggestions.push(projectValue);
      }

      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, suggestions }));
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        suggestions: [],
      }));
    }
  }

  private async handleShadowFolkPush(res: http.ServerResponse): Promise<void> {
    try {
      const result = await this.runShadowFolkPush();
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, result }));
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private async handleShadowFolkHistory(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    void req;
    try {
      const workspace = String(url.searchParams.get('workspace') || '').trim();
      if (!workspace) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: 'workspace is required' }));
        return;
      }

      const uploader = this.createShadowFolkUploader();
      if (!uploader?.listPushHistory) {
        throw new Error('ShadowFolk 未配置，请先填写 ~/.shadow/config.json');
      }

      const runtime = this.getShadowFolkRuntimeConfig();
      const workspaceConfig = this.findShadowFolkWorkspaceConfig(workspace, runtime.workspaceConfigs);
      const history = await uploader.listPushHistory(workspaceConfig);
      const safeHistory = history.map(entry => this.scrubShadowFolkHistoryEntry(entry));
      res.statusCode = 200;
      res.end(JSON.stringify({
        success: true,
        workspace,
        options: [
          { kind: 'full', label: '全量重推' },
          ...history.map(entry => ({
            kind: 'history',
            historyId: entry.id,
            label: this.formatShadowFolkHistoryLabel(entry),
          })),
        ],
        history: safeHistory,
      }));
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private scrubShadowFolkHistoryEntry(entry: PushHistoryEntry): Omit<PushHistoryEntry, 'memoryRoots'> {
    const scrubbed = { ...entry };
    delete (scrubbed as Partial<Pick<PushHistoryEntry, 'memoryRoots'>>).memoryRoots;
    return scrubbed;
  }

  private async handleShadowFolkReplay(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let started = false;
    try {
      if (this.shadowfolkStatus.running) {
        throw new Error('ShadowFolk 上传正在运行');
      }

      const body = await this.parseBody(req);
      const workspace = String(body.workspace || '').trim();
      const kind = String(body.kind || '').trim();
      const historyId = String(body.historyId || '').trim();
      if (!workspace) {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: 'workspace is required' }));
        return;
      }

      const uploader = this.createShadowFolkUploader();
      if (!uploader) {
        throw new Error('ShadowFolk 未配置，请先填写 ~/.shadow/config.json');
      }
      const runtime = this.getShadowFolkRuntimeConfig();
      const workspaceConfig = this.findShadowFolkWorkspaceConfig(workspace, runtime.workspaceConfigs);

      this.shadowfolkStatus.running = true;
      started = true;
      this.shadowfolkStatus.lastRunAt = new Date().toISOString();
      this.shadowfolkStatus.lastError = null;
      let result: PushWorkspaceResult;
      if (kind === 'full') {
        if (!uploader.repushWorkspaceFull) throw new Error('当前 ShadowFolk 上传器不支持全量重推');
        result = await uploader.repushWorkspaceFull(workspaceConfig);
      } else if (kind === 'history') {
        if (!historyId) throw new Error('historyId is required');
        if (!uploader.replayHistoryEntry) throw new Error('当前 ShadowFolk 上传器不支持历史区间重推');
        result = await uploader.replayHistoryEntry(workspaceConfig, historyId);
      } else {
        throw new Error('kind must be full or history');
      }

      this.shadowfolkStatus.lastSuccessAt = new Date().toISOString();
      this.shadowfolkStatus.lastResult = {
        pushed: result.pushed,
        workspaces: 1,
        observations: result.observations,
        summaries: result.summaries,
        commits: result.commits,
        results: [result],
        failures: [],
      };
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, mode: kind, result }));
    } catch (error) {
      this.shadowfolkStatus.lastError = error instanceof Error ? error.message : String(error);
      res.statusCode = 400;
      res.end(JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      if (started) this.shadowfolkStatus.running = false;
    }
  }

  private formatShadowFolkHistoryLabel(entry: PushHistoryEntry): string {
    const createdAt = entry.createdAt.replace('T', ' ').slice(0, 16);
    return `${createdAt} · ${entry.counts.commits} commits · ${entry.counts.observations} observations · ${entry.counts.summaries} summaries`;
  }

  private async handleShadowFolkConfigUpdate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const body = await this.parseBody(req);
      this.shadowfolkOverride = {
        enabled: !!body.enabled,
        dailyTime: String(body.dailyTime || '23:30').trim(),
        workspaces: this.normalizeShadowFolkWorkspaces(body.workspaces),
        workspaceAliases: this.normalizeShadowFolkWorkspaceAliases(body.workspaceAliases),
      };
      if (this.shadowfolkTimer) {
        clearTimeout(this.shadowfolkTimer);
        this.shadowfolkTimer = null;
      }
      if (this.shadowfolkOverride.enabled) {
        this.scheduleNextShadowFolkRun();
      } else {
        this.shadowfolkNextRunAt = null;
      }
      logger.info('SHADOWFOLK', 'Config hot-reloaded', {
        enabled: this.shadowfolkOverride.enabled,
        dailyTime: this.shadowfolkOverride.dailyTime,
        workspaces: this.shadowfolkOverride.workspaces.length,
        workspaceAliases: this.shadowfolkOverride.workspaceAliases.length,
      });
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true }));
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private startShadowFolkTimer(): void {
    this.scheduleNextShadowFolkRun();
  }

  private scheduleNextShadowFolkRun(): void {
    const runtime = this.getShadowFolkRuntimeConfig();
    if (!runtime.enabled || this.shadowfolkTimer) {
      if (!runtime.enabled) this.shadowfolkNextRunAt = null;
      return;
    }

    const nextRun = nextBeijingDailyRun(runtime.dailyTime);
    this.shadowfolkNextRunAt = nextRun.toISOString();
    const delayMs = Math.max(0, nextRun.getTime() - Date.now());

    this.shadowfolkTimer = setTimeout(async () => {
      this.shadowfolkTimer = null;
      try {
        await this.runShadowFolkPush();
      } catch (error) {
        logger.warn('SHADOWFOLK', 'Scheduled upload failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (!this.isShuttingDown) {
          this.scheduleNextShadowFolkRun();
        }
      }
    }, delayMs);
  }

  private async handleSyncReset(res: http.ServerResponse): Promise<void> {
    if (!this.syncQueue) {
      res.statusCode = 400;
      res.end(JSON.stringify({ success: false, error: '同步队列未初始化' }));
      return;
    }
    const result = this.syncQueue.resetForNewServer();
    const backfill = await this.syncQueue.backfillFromDatabase();
    res.statusCode = 200;
    res.end(JSON.stringify({
      success: true,
      data: { cleared: result.cleared, backfill },
    }));
  }

  private async handleSyncRescan(res: http.ServerResponse): Promise<void> {
    if (!this.syncQueue) {
      res.statusCode = 400;
      res.end(JSON.stringify({ success: false, error: '还没有配置服务器，开不了同步' }));
      return;
    }
    const result = await this.syncQueue.rescan();
    res.statusCode = 200;
    res.end(JSON.stringify({ success: true, data: result }));
  }

  private async handleSyncTest(res: http.ServerResponse): Promise<void> {
    const cfg = getSyncConfig();
    if (!cfg.remoteUrl) {
      res.statusCode = 400;
      res.end(JSON.stringify({ success: false, error: '没填服务器地址' }));
      return;
    }
    const client = new RemoteClient({ baseUrl: cfg.remoteUrl, token: cfg.remoteToken || '' });
    const reachable = await client.testConnection();
    if (!reachable) {
      res.statusCode = 200;
      res.end(JSON.stringify({ success: false, error: '服务器联系不上（地址或网络有问题）' }));
      return;
    }
    if (!cfg.remoteToken) {
      res.statusCode = 200;
      res.end(JSON.stringify({ success: false, error: '没填钥匙（Token）' }));
      return;
    }
    const auth = await client.testAuth();
    res.statusCode = 200;
    res.end(JSON.stringify({
      success: auth.ok,
      data: { reachable: true, authed: auth.ok, user: auth.user || null },
      error: auth.ok ? null : auth.message,
    }));
  }

  private async proxyRemoteViewer(
    resource: 'sessions' | 'observations' | 'summaries' | 'projects',
    url: URL,
    res: http.ServerResponse
  ): Promise<void> {
    const cfg = getSyncConfig();
    if (!cfg.remoteUrl) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Remote sync is not configured (CODEBUDDY_MEM_REMOTE_URL missing)' }));
      return;
    }

    const fwd = new URLSearchParams();
    for (const [k, v] of url.searchParams.entries()) {
      if (k === 'source') continue;
      fwd.append(k, v);
    }
    const qs = fwd.toString();
    const target = `${cfg.remoteUrl}/api/v1/viewer/${resource}${qs ? '?' + qs : ''}`;

    try {
      const headers: Record<string, string> = { 'Accept': 'application/json' };
      if (cfg.remoteToken) headers['Authorization'] = `Bearer ${cfg.remoteToken}`;

      const upstream = await fetch(target, { method: 'GET', headers });
      const body = await upstream.text();

      res.statusCode = upstream.status;
      const ct = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
      res.setHeader('Content-Type', ct);
      res.end(body);
    } catch (error) {
      logger.error('WORKER', `Remote viewer proxy failed (${resource})`, { target }, error as Error);
      res.statusCode = 502;
      res.end(JSON.stringify({ error: 'Remote server unreachable', target }));
    }
  }

  private async handleExportMarkdown(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ): Promise<void> {
    const project = url.searchParams.get('project') || undefined;
    const ide = url.searchParams.get('ide') || undefined;
    const groupBy = (url.searchParams.get('group_by') || 'date') as GroupBy;
    const dateParam = url.searchParams.get('date');
    const fromParam = url.searchParams.get('from');
    const toParam = url.searchParams.get('to');

    try {
      let fromEpoch = 0;
      let toEpoch = Date.now();

      if (fromParam) {
        fromEpoch = new Date(fromParam).getTime();
      } else if (dateParam) {
        fromEpoch = new Date(dateParam + 'T00:00:00').getTime();
      }

      if (toParam) {
        toEpoch = new Date(toParam + 'T23:59:59.999').getTime();
      } else if (dateParam) {
        toEpoch = new Date(dateParam + 'T23:59:59.999').getTime();
      }

      const db = getDatabase();

      let sessionQuery = 'SELECT * FROM sdk_sessions WHERE started_at_epoch >= ? AND started_at_epoch <= ?';
      const params: (string | number)[] = [fromEpoch, toEpoch];
      if (project) {
        sessionQuery += ' AND project LIKE ?';
        params.push(`%${project}%`);
      }
      sessionQuery += ' ORDER BY started_at_epoch ASC';

      const sessions = db.prepare(sessionQuery).all(...params) as any[];

      const filteredSessions = ide
        ? sessions.filter(s => s.source_ide === ide)
        : sessions;

      const sessionIds = filteredSessions.map(s => s.memory_session_id).filter(Boolean);
      let observations: any[] = [];
      let summaries: any[] = [];

      if (sessionIds.length > 0) {
        const placeholders = sessionIds.map(() => '?').join(',');
        observations = db.prepare(
          `SELECT * FROM observations WHERE memory_session_id IN (${placeholders}) ORDER BY created_at_epoch ASC`
        ).all(...sessionIds);
        summaries = db.prepare(
          `SELECT * FROM session_summaries WHERE memory_session_id IN (${placeholders})`
        ).all(...sessionIds);
      }

      const exportData: ExportData = {
        sessions: filteredSessions,
        observations,
        summaries,
      };

      const markdown = renderMarkdown(exportData, groupBy);

      const filename = dateParam
        ? `memory-${dateParam}.md`
        : `memory-${new Date(fromEpoch).toISOString().slice(0, 10)}-to-${new Date(toEpoch).toISOString().slice(0, 10)}.md`;

      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.statusCode = 200;
      res.end(markdown);
    } catch (error) {
      logger.error('WORKER', 'Export markdown failed', {}, error as Error);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Export failed' }));
    }
  }

  /**
   * Chroma sync status: counts from chroma_sync_state grouped by status.
   * Renamed from handleSyncStatus to avoid clash with remote sync queue status above.
   */
  private async handleChromaStatus(
    _req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    try {
      const db = getDatabase();
      const pending = (db.prepare(`SELECT COUNT(*) AS c FROM chroma_sync_state WHERE status = 'pending'`).get() as any).c;
      const synced = (db.prepare(`SELECT COUNT(*) AS c FROM chroma_sync_state WHERE status = 'synced'`).get() as any).c;
      const failed = (db.prepare(`SELECT COUNT(*) AS c FROM chroma_sync_state WHERE status = 'failed'`).get() as any).c;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        chromaAvailable: !!this.chromaSync,
        pending,
        synced,
        failed,
        total: pending + synced + failed,
      }));
    } catch (error) {
      logger.error('WORKER', 'chroma status failed', {}, error as Error);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'Failed to get chroma status' }));
    }
  }

  /**
   * Trigger background bulk reindex into Chroma. 503 if chromaSync is null.
   * Renamed from handleSyncReindex to align with /api/chroma/* namespace.
   */
  private async handleChromaReindex(
    _req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    if (!this.chromaSync) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ success: false, error: 'Chroma not available' }));
      return;
    }
    res.statusCode = 202;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ success: true, started: true }));
    this.chromaSync.bulkReindex().catch(err =>
      logger.error('CHROMA_REINDEX', 'bulk reindex failed', {}, err as Error)
    );
  }

  // ────────────────── Hybrid Vector endpoints ──────────────────

  /**
   * 检测 vec.db 是否需要补建。规则(2.1.0-beta.5 起加强):
   *   - 主库为空 → 跳过
   *   - vec.db 完全为空(totalDocs=0)+ 主库非空 → 全量 reindex
   *   - **新增**:vec.db 已有数据但显著少于主库(lag > 2% 且 > 5 条)→
   *     触发 reindexAll 走 watermark 续做(只 embed 之前漏掉的部分,不重做)
   *   - 否则 → 跳过(差额 <= 阈值,认为是新写入还没被增量入队,会被 EventBus 接住)
   *
   * Bug 修复背景(2.1.0-beta.5):此前的实现只检查 totalDocs==0,
   * 一旦 vec.db 有任何数据就跳过。这导致两类用户的数据被永久漏掉:
   *   1. 首次 reindex 跑到一半被中断的用户
   *   2. 升级前 SDKAgent rolling summary 没 emit 的旧版本残留差额
   * watermark 续做(maxIndexedId)成本极低 — 已经 embed 过的不会重做。
   */
  private bootstrapHybridIfNeeded(): void {
    if (this.vectorBootstrapTriggered) return;
    if (!this.hybridIndexer || !this.vectorStore) return;

    try {
      const stats = this.vectorStore.stats();
      const db = getDatabase();
      const obsCount = (db.prepare('SELECT COUNT(*) as c FROM observations').get() as { c: number }).c;
      const sumCount = (db.prepare('SELECT COUNT(*) as c FROM session_summaries').get() as { c: number }).c;
      const totalAgentMemory = obsCount + sumCount;

      if (totalAgentMemory === 0) {
        logger.info('HYBRID', 'bootstrap: AgentMemory main DB empty, nothing to index');
        return;
      }

      // 决策核心:差额检测
      const lag = totalAgentMemory - stats.totalDocs;
      // 2.1.0-beta.6: 阈值收紧到 lag > 0 就触发(reindexAll 走 watermark
      // 续做,只 embed 漏掉的那几条,成本几乎为 0;不收紧的话用户会看到
      // "向量索引: 99.96%" 这种无法到 100% 的情况,体验差)。
      if (stats.totalDocs > 0 && lag <= 0) {
        logger.info('HYBRID', 'bootstrap: vec.db in sync with main DB', {
          vecDocs: stats.totalDocs,
          agentMemoryRows: totalAgentMemory,
          lag,
        });
        return;
      }

      const reason = stats.totalDocs === 0
        ? 'vec.db empty, full reindex'
        : `partial reindex catch-up (lag=${lag}/${totalAgentMemory}, ${(lag / totalAgentMemory * 100).toFixed(1)}%)`;
      logger.info('HYBRID', `bootstrap: triggering background reindex — ${reason}`, {
        agentMemoryObs: obsCount,
        agentMemorySum: sumCount,
        vecDocs: stats.totalDocs,
        lag,
      });
      this.vectorBootstrapTriggered = true;
      this.eventBus.emit('vector:reindex:started', { total: totalAgentMemory });

      // beta.8: pageSize / batchDelayMs 按性能档位映射, 由桌面端通过
      // AGENTMEM_VECTOR_INDEXER_PROFILE 环境变量传过来。eco 默认 (50/50ms),
      // normal (100/20ms), fast (200/0ms)。watermark 续建已在 reindexAll
      // 内部用 maxIndexedId 实现, 不重做已 embed 部分。
      const profile = (process.env.AGENTMEM_VECTOR_INDEXER_PROFILE || 'eco').toLowerCase();
      const pageSize = profile === 'fast' ? 200 : profile === 'normal' ? 100 : 50;
      const batchDelayMs = profile === 'fast' ? 0 : profile === 'normal' ? 20 : 50;

      this.hybridIndexer.reindexAll({
        pageSize,
        batchDelayMs,
        onProgress: (p) => {
          this.vectorReindexProgress = p;
          this.eventBus.emit('vector:reindex:progress', { progress: p });
        },
      }).then((p) => {
        this.vectorReindexProgress = p;
        this.eventBus.emit('vector:reindex:done', { progress: p });
        logger.info('HYBRID', 'bootstrap reindex complete', {
          obsEmbedded: p.observations.embedded,
          sumEmbedded: p.summaries.embedded,
        });
      }).catch((err) => {
        this.vectorBootstrapTriggered = false; // 允许重试
        logger.error('HYBRID', 'bootstrap reindex failed', { error: String(err) });
      });
    } catch (err) {
      logger.error('HYBRID', 'bootstrap probe failed', { error: String(err) });
    }
  }

  /**
   * GET /api/vector/status — 返回向量索引健康状态。
   */
  private async handleVectorStatus(
    _req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (!this.vectorStore || !this.embedder || !this.hybridIndexer) {
      res.statusCode = 503;
      res.end(JSON.stringify({
        available: false,
        reason: 'hybrid stack not initialized',
      }));
      return;
    }
    try {
      const stats = this.vectorStore.stats();
      const model = this.embedder.getStatus();
      const indexer = this.hybridIndexer.getProgress();
      const db = getDatabase();
      const obsAgentMemory = (db.prepare('SELECT COUNT(*) as c FROM observations').get() as { c: number }).c;
      const sumAgentMemory = (db.prepare('SELECT COUNT(*) as c FROM session_summaries').get() as { c: number }).c;
      res.statusCode = 200;
      res.end(JSON.stringify({
        available: true,
        vectorIndex: stats,
        agentMemoryDb: { observations: obsAgentMemory, summaries: sumAgentMemory },
        coverage: {
          observations: obsAgentMemory === 0 ? 1 : stats.observations / obsAgentMemory,
          summaries: sumAgentMemory === 0 ? 1 : stats.summaries / sumAgentMemory,
          total: (obsAgentMemory + sumAgentMemory) === 0 ? 1 : stats.totalDocs / (obsAgentMemory + sumAgentMemory),
        },
        model,
        indexer,
        bootstrapTriggered: this.vectorBootstrapTriggered,
      }));
    } catch (err) {
      logger.error('HYBRID', 'vector status failed', {}, err as Error);
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'failed to read status', detail: String(err) }));
    }
  }

  /**
   * POST /api/vector/reindex — 手动触发全量重建。立即返回 202,后台跑。
   * Body: { project?: string, force?: boolean }
   */
  private async handleVectorReindex(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (!this.hybridIndexer) {
      res.statusCode = 503;
      res.end(JSON.stringify({ success: false, error: 'hybrid stack not initialized' }));
      return;
    }
    let body: { project?: string; force?: boolean } = {};
    try { body = await this.parseBody(req); } catch { /* default empty */ }

    res.statusCode = 202;
    res.end(JSON.stringify({ success: true, started: true }));

    this.hybridIndexer.reindexAll({
      project: body.project,
      force: body.force,
      onProgress: (p) => {
        this.vectorReindexProgress = p;
        this.eventBus.emit('vector:reindex:progress', { progress: p });
      },
    }).then((p) => {
      this.vectorReindexProgress = p;
      this.eventBus.emit('vector:reindex:done', { progress: p });
      logger.info('HYBRID', 'manual reindex complete', {
        scope: body.project ?? '(all)',
        obsEmbedded: p.observations.embedded,
        sumEmbedded: p.summaries.embedded,
      });
    }).catch((err) => {
      logger.error('HYBRID', 'manual reindex failed', { error: String(err) });
    });
  }

  /**
   * POST /api/vector/pause — 暂停 reindex 处理。当前 page 跑完后,后续 page
   * 会卡在 indexer 内部的 gate 上, 直到 /resume 被调用。增量 drain 不受影响。
   */
  private async handleVectorPause(
    _req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (!this.hybridIndexer) {
      res.statusCode = 503;
      res.end(JSON.stringify({ success: false, error: 'hybrid stack not initialized' }));
      return;
    }
    this.hybridIndexer.pause();
    res.statusCode = 200;
    res.end(JSON.stringify({ success: true, paused: true }));
  }

  /**
   * POST /api/vector/resume — 恢复被 pause 暂停的 reindex。
   */
  private async handleVectorResume(
    _req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (!this.hybridIndexer) {
      res.statusCode = 503;
      res.end(JSON.stringify({ success: false, error: 'hybrid stack not initialized' }));
      return;
    }
    this.hybridIndexer.resume();
    res.statusCode = 200;
    res.end(JSON.stringify({ success: true, paused: false }));
  }

  /**
   * Serve static files from web directory
   */
  private async handleStaticFile(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    filename: string
  ): Promise<void> {
    try {
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      const candidates = [
        path.resolve(currentDir, '..', '..', '..', 'web', filename),
        path.resolve(currentDir, '..', '..', '..', '..', 'web', filename),
      ];
      let filePath: string | null = null;
      for (const c of candidates) {
        if (fs.existsSync(c)) { filePath = c; break; }
      }

      if (!filePath) {
        logger.error('WORKER', 'Static file not found in any candidate', { filename, candidates });
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<h1>404 - File Not Found</h1><pre>looked in:\n${candidates.join('\n')}</pre>`);
        return;
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(content);
    } catch (error) {
      logger.error('WORKER', 'Failed to serve static file', { filename }, error as Error);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/html');
      res.end('<h1>500 - Internal Server Error</h1>');
    }
  }

  /**
   * Schedule a background retry pass for any TurnTasks the orchestrator
   * stashed during the most recent import run (TIMI 5xx / network glitch /
   * SDKAgent retry exhaustion). Drains the module-level retry queue with
   * a short initial wait, two attempts, exponential backoff. Successful
   * retries trigger another auto-reindex so embeddings stay in sync.
   *
   * - Silent: no progress events, no popup. Per the user's spec —
   *   "先静默不用管,先把当前其他的导入跑完,然后你后台要进行继续的导入".
   * - Idempotent: if no failed tasks, no-op. Re-entrancy guarded by
   *   `importRetryRunning` so two import runs in quick succession don't
   *   spawn parallel retry passes.
   * - Bounded: 2 attempts max with backoff. After that, leftover tasks
   *   are dropped — they'll get re-discovered on the next AgentMemory startup
   *   auto-import (no fingerprint was recorded for failures).
   */
  private scheduleBackgroundRetry(): void {
    if (this.importRetryRunning) return;
    if (pendingRetryTaskCount() === 0) return;
    if (this.importRetryTimer) clearTimeout(this.importRetryTimer);
    const FIRST_DELAY_MS = 90 * 1000; // 1.5min — enough for transient TIMI hiccups
    this.importRetryTimer = setTimeout(() => {
      this.importRetryTimer = null;
      void this.runBackgroundRetryPass();
    }, FIRST_DELAY_MS);
  }

  private async runBackgroundRetryPass(): Promise<void> {
    if (this.importRetryRunning) return;
    this.importRetryRunning = true;
    try {
      let tasks = takePendingRetryTasks();
      if (tasks.length === 0) return;
      logger.info('IMPORT_RETRY', 'background retry pass starting', {
        count: tasks.length,
      });
      let totalImported = 0;
      const MAX_ATTEMPTS = 2;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && tasks.length > 0; attempt++) {
        const r = await retryFailedTasks(tasks);
        totalImported += r.imported;
        logger.info('IMPORT_RETRY', `attempt ${attempt} done`, {
          imported: r.imported,
          stillFailed: r.stillFailedTasks.length,
        });
        tasks = r.stillFailedTasks;
        if (tasks.length === 0) break;
        if (attempt < MAX_ATTEMPTS) {
          // Exponential backoff before next attempt — 3min, 6min...
          const backoffMs = 3 * 60 * 1000 * attempt;
          await new Promise((res) => setTimeout(res, backoffMs));
        }
      }
      if (totalImported > 0 && this.hybridIndexer) {
        const profile = (process.env.AGENTMEM_VECTOR_INDEXER_PROFILE ?? 'eco').toLowerCase();
        const pageSize = profile === 'fast' ? 200 : profile === 'normal' ? 100 : 50;
        const batchDelayMs = profile === 'fast' ? 0 : profile === 'normal' ? 20 : 50;
        logger.info('IMPORT_RETRY', 'auto-reindex after background retry', {
          imported: totalImported, profile,
        });
        try {
          await this.hybridIndexer.reindexAll({ pageSize, batchDelayMs });
          this.eventBus.emit('vector:reindex:done', {});
        } catch (err) {
          logger.error('IMPORT_RETRY', 'auto-reindex after retry failed', {
            error: String(err),
          });
        }
      }
      if (tasks.length > 0) {
        // Couldn't recover after all attempts. Drop them — next AgentMemory startup
        // will re-discover the same turns since no fingerprint was written.
        logger.warn('IMPORT_RETRY', 'giving up on residual failed tasks', {
          residual: tasks.length,
        });
      }
    } finally {
      this.importRetryRunning = false;
      // If new failures landed in the queue while we were running (e.g. a
      // second import was triggered mid-retry), pick them up.
      if (pendingRetryTaskCount() > 0) {
        this.scheduleBackgroundRetry();
      }
    }
  }

  /**
   * Parse JSON body from request
   */
  private parseBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          // Concatenate all chunks and decode as UTF-8
          const body = Buffer.concat(chunks).toString('utf8');
          resolve(body ? JSON.parse(body) : {});
        } catch (error) {
          reject(new Error('Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  /**
   * Initialise the Chroma stack (uvx sidecar → MCP stdio → collection).
   * Any step failing ⇒ log warning, null out, and leave worker in SQLite-only mode.
   */
  private async initChroma(): Promise<void> {
    const settings = (this.config.loadSettings ?? loadSettings)();
    if (!settings.rag.enabled) {
      logger.info('CHROMA', 'RAG disabled by settings.json; skipping Chroma init');
      return;
    }

    const dataDir = getDataDir();
    const chromaDataDir = path.join(dataDir, 'chroma');
    const modelCacheDir = path.join(dataDir, 'models');

    this.chromaProcess = new ChromaProcessManager({
      dataDir: chromaDataDir,
      embeddingModel: settings.rag.embedding_model,
      modelCacheDir,
    });
    const startResult = await this.chromaProcess.start();
    if (!startResult.started) {
      logger.warn('CHROMA', `Chroma sidecar did not start: ${startResult.reason}. Running in SQLite-only mode.`);
      this.chromaProcess = null;
      return;
    }

    this.chromaMcp = new ChromaMcpManager();
    const stdio = this.chromaProcess.getStdio();
    if (!stdio) {
      logger.warn('CHROMA', 'chroma-mcp stdio unavailable; skipping MCP connect');
      try { await this.chromaProcess.stop(); } catch {}
      this.chromaProcess = null;
      this.chromaMcp = null;
      return;
    }
    try {
      await this.chromaMcp.connect(stdio);
    } catch (err) {
      logger.error('CHROMA', 'failed to connect to chroma-mcp', {}, err as Error);
      try { await this.chromaProcess.stop(); } catch {}
      this.chromaProcess = null;
      this.chromaMcp = null;
      return;
    }

    // project='default' — per-project sync may split this up later.
    this.chromaSync = new ChromaSync(this.chromaMcp, 'default');
    try {
      await this.chromaSync.ensureCollection();
    } catch (err) {
      logger.error('CHROMA', 'ensureCollection failed', {}, err as Error);
      this.chromaSync = null;
      return;
    }

    this.rebuildSearchOrchestrator();
    logger.info('CHROMA', 'Chroma stack initialised; hybrid search enabled');
  }

  /**
   * Rebuild the search orchestrator with both SQLite + Chroma strategies
   * once ChromaSync is ready. Cheap; simpler than a mutable ref.
   */
  private rebuildSearchOrchestrator(): void {
    if (!this.chromaSync) return;
    const settings = (this.config.loadSettings ?? loadSettings)();
    const sqliteStrategy = new SQLiteSearchStrategy();
    const chromaStrategy = new ChromaSearchStrategy(this.chromaSync);
    const hybridStrategy = new HybridSearchStrategy(sqliteStrategy, chromaStrategy, {
      k: settings.rag.rrf_k,
      sqliteWeight: settings.rag.hybrid_weights.sqlite,
      chromaWeight: settings.rag.hybrid_weights.chroma,
    });
    this.searchOrchestrator = new SearchOrchestrator({
      sqlite: sqliteStrategy,
      chroma: chromaStrategy,
      hybrid: hybridStrategy,
    });
  }

  /**
   * Accessor for ChromaSync — returns null when RAG is disabled or init failed.
   */
  public getChromaSync(): ChromaSync | null {
    return this.chromaSync;
  }

  public getEventBus(): EventEmitter {
    return this.eventBus;
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    logger.info('WORKER', 'Shutting down...');

    // Stop sync queue before closing database
    if (this.syncQueue) {
      this.syncQueue.stop();
    }

    if (this.shadowfolkTimer) {
      clearTimeout(this.shadowfolkTimer);
      this.shadowfolkTimer = null;
    }
    this.shadowfolkNextRunAt = null;

    // Persist and destroy Self-Evolve incremental scheduler
    if (this.selfEvolve) {
      this.selfEvolve.destroy();
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
    }

    // Close Chroma stack: MCP stdio first (stops further RPCs), then sidecar.
    try { await this.chromaMcp?.close(); } catch (err) {
      logger.warn('CHROMA', 'chromaMcp.close() failed', { err: String(err) });
    }
    try { await this.chromaProcess?.stop(); } catch (err) {
      logger.warn('CHROMA', 'chromaProcess.stop() failed', { err: String(err) });
    }

    // Close vector store handle (sqlite-vec). Embedder has no resources to release.
    // 先 flush WAL, 再 close — 防止强杀场景下 -wal 文件被外部进程锁住,
    // 导致下次启动时主库看到的行数 < 实际已 embed 行数, 用户感知"重建从头开始"。
    try { this.vectorStore?.flush(); } catch (err) {
      logger.warn('HYBRID', 'vectorStore.flush() failed', { err: String(err) });
    }
    try { this.vectorStore?.close(); } catch (err) {
      logger.warn('HYBRID', 'vectorStore.close() failed', { err: String(err) });
    }

    closeDatabase();

    // Gracefully shutdown logger (writes final log entry and closes file stream)
    await logger.shutdown();
  }

  // ────────────────── Import-history endpoints ──────────────────

  /**
   * GET /api/import/discover[?ide=claude,cursor-agent,...]
   *
   * Cheap file-IO scan; safe to call from desktop first-launch even when no
   * import has been queued. Returns the diagnostic shape the UI uses to
   * decide whether to show the "import history" prompt.
   */
  private async handleImportDiscover(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'x'}`);
      const ide = url.searchParams.get('ide');
      const adapterIds = ide
        ? (ide.split(',').map((s) => s.trim()).filter(Boolean) as ImportAdapterId[])
        : undefined;
      const report = await discoverAll(adapterIds);
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, report }));
    } catch (err) {
      logger.error('IMPORT_API', 'discover failed', {}, err as Error);
      res.statusCode = 500;
      res.end(
        JSON.stringify({ success: false, error: String((err as Error).message) }),
      );
    }
  }

  /**
   * GET /api/import/audit — completeness ledger.
   *
   * Walks all three adapters, runs each transcript through the same
   * pre-filters the orchestrator uses (substantive check, fingerprint
   * dedup, hook-overlap), and returns a per-file classification so the
   * user can verify nothing is silently dropped.
   *
   * Status codes:
   *   - imported       — already in import_history_fingerprints (we wrote it)
   *   - hook-overlap   — already covered by an online hook summary, won't re-import
   *   - pending        — would be imported on next /api/import/run
   *   - empty          — transcript has zero substantive content (no assistant
   *                      reply, or under 50-char threshold). Won't import.
   *   - no-cwd         — codebuddy-ide only: cwd recovery failed AND content
   *                      fell into the unknown:codebuddy-ide bucket
   *
   * Returns aggregate counts + (optionally) the per-file rows for the
   * subset matching `?status=...`. For 142 transcripts the full ledger is
   * ~50KB JSON which the UI/curl can handle.
   */
  private async handleImportAudit(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'x'}`);
      const wantStatus = url.searchParams.get('status') ?? null;

      const { auditImport } = await import('../import/audit.js');
      const ledger = await auditImport();

      const turnsOut = wantStatus
        ? ledger.turns.filter((t) => t.status === wantStatus)
        : ledger.turns;

      res.statusCode = 200;
      res.end(
        JSON.stringify({
          success: true,
          summary: ledger.summary,
          totals: ledger.totals,
          turns: turnsOut,
        }),
      );
    } catch (err) {
      logger.error('IMPORT_API', 'audit failed', {}, err as Error);
      res.statusCode = 500;
      res.end(
        JSON.stringify({ success: false, error: String((err as Error).message) }),
      );
    }
  }

  /**
   * POST /api/import/repair-projects
   *
   * Idempotent maintenance op: walks every existing imported row whose
   * project starts with `unknown:` (placeholder for cwd-recovery failures)
   * and tries to re-derive the project by re-running the codebuddy-ide
   * adapter's multi-tier recovery on the original transcript path. Updates
   * the row in place when a real project is now recoverable.
   *
   * Useful after upgrading from a build that lacked a recovery tier — the
   * old rows stay unknown forever otherwise (their fingerprints exist so
   * the next /api/import/run skips them as "already imported"). This
   * endpoint is the manual escape hatch.
   */
  private async handleImportRepairProjects(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const { repairImportedProjects } = await import('../import/repair.js');
      const result = await repairImportedProjects();
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, ...result }));
    } catch (err) {
      logger.error('IMPORT_API', 'repair-projects failed', {}, err as Error);
      res.statusCode = 500;
      res.end(
        JSON.stringify({ success: false, error: String((err as Error).message) }),
      );
    }
  }

  /**
   * GET /api/import/status — last progress snapshot + run lifecycle flags.
   * Polled by the desktop ImportProgressPanel + tray for real-time UI.
   * (Push notifications come via eventBus 'import:progress' / 'import:done'
   * events for callers that need lower latency.)
   */
  private async handleImportStatus(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        success: true,
        inProgress: this.importInProgress,
        progress: this.importProgress,
        lastResult: this.importLastResult,
        startedAt: this.importStartedAt,
      }),
    );
  }

  /**
   * POST /api/import/run
   *
   * Body: { adapterIds?, projectFilter?, sinceMs?, untilMs?, concurrency?,
   *         ratePerMinute?, maxTurns?, dryRun? }
   *
   * Fire-and-forget — returns 202 immediately. The actual import runs in
   * this Worker process so SDKAgent inherits the same provider env that
   * was injected when the desktop app spawned the worker (vital — see
   * the IMPORT FEATURE STATE block at the top of this class for why we
   * never fork a CLI subprocess for desktop-triggered imports).
   *
   * Re-entrant guard: returns 409 if a run is already in progress.
   */
  private async handleImportRun(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (this.importInProgress) {
      res.statusCode = 409;
      res.end(JSON.stringify({ success: false, error: 'import already running' }));
      return;
    }
    let body: Record<string, unknown> = {};
    try { body = await this.parseBody(req); } catch { /* default empty */ }

    this.importInProgress = true;
    this.importProgress = null;
    this.importLastResult = null;
    this.importStartedAt = Date.now();

    res.statusCode = 202;
    res.end(JSON.stringify({ success: true, started: true }));

    runImport(
      {
        adapterIds: Array.isArray(body.adapterIds)
          ? (body.adapterIds as ImportAdapterId[])
          : undefined,
        projectFilter: typeof body.projectFilter === 'string' ? body.projectFilter : undefined,
        sinceMs: typeof body.sinceMs === 'number' ? body.sinceMs : undefined,
        untilMs: typeof body.untilMs === 'number' ? body.untilMs : undefined,
        concurrency: typeof body.concurrency === 'number' ? body.concurrency : undefined,
        ratePerMinute: typeof body.ratePerMinute === 'number' ? body.ratePerMinute : undefined,
        maxTurns: typeof body.maxTurns === 'number' ? body.maxTurns : undefined,
        maxSessions: typeof body.maxSessions === 'number' ? body.maxSessions : undefined,
        skipHookOverlap: typeof body.skipHookOverlap === 'boolean' ? body.skipHookOverlap : undefined,
        dryRun: typeof body.dryRun === 'boolean' ? body.dryRun : undefined,
      },
      (snapshot) => {
        this.importProgress = snapshot;
        this.eventBus.emit('import:progress', { progress: snapshot });
      },
    )
      .then((result) => {
        this.importLastResult = result;
        this.importInProgress = false;
        this.eventBus.emit('import:done', { result });
        logger.info('IMPORT_API', 'run complete', {
          imported: result.importedSummaries,
          skipped: result.skippedSessions,
          failed: result.failedSessions,
          ms: result.durationMs,
        });

        // Background retry of TIMI-hiccup failures. The orchestrator stashes
        // failed tasks (after SDKAgent's own 3x retry exhausted) into a
        // module-level queue; we wait a couple of minutes here and drain it
        // silently. Successful retries → another auto-reindex. From the
        // user's perspective: main UI completion fires immediately with
        // current numbers, then a few minutes later the failed turns appear
        // in AgentMemory (no popup, no panel — the toast at end of reindex is the
        // only visible signal, and only if anything actually got imported).
        this.scheduleBackgroundRetry();

        // Auto-reindex hook: when an import actually wrote new rows, kick the
        // hybrid vector indexer so the user doesn't have to manually run
        // `mcp__agentmem-hybrid__reindex` to make the new memories searchable.
        // No-op when nothing was imported (saves a pass over already-embedded
        // rows). The reindex itself is idempotent — re-embedding old rows is
        // a no-op via skip-existing logic in HybridIndexer, so even if we
        // accidentally double-fire it costs only a quick scan.
        //
        // CPU PROTECTION: use the same eco/normal/fast performance profile
        // that the bootstrap reindex uses (AGENTMEM_VECTOR_INDEXER_PROFILE env).
        // Default eco = pageSize 50, batchDelayMs 50 — keeps the user's
        // CPU available during the first-install autorun chain.
        if (result.importedSummaries > 0 && this.hybridIndexer) {
          const profile = (process.env.AGENTMEM_VECTOR_INDEXER_PROFILE ?? 'eco').toLowerCase();
          const pageSize = profile === 'fast' ? 200 : profile === 'normal' ? 100 : 50;
          const batchDelayMs = profile === 'fast' ? 0 : profile === 'normal' ? 20 : 50;
          logger.info('IMPORT_API', 'auto-triggering vector reindex after import', {
            imported: result.importedSummaries, profile, pageSize, batchDelayMs,
          });
          this.hybridIndexer
            .reindexAll({
              pageSize,
              batchDelayMs,
              onProgress: (p) => {
                this.vectorReindexProgress = p;
                this.eventBus.emit('vector:reindex:progress', { progress: p });
              },
            })
            .then((p) => {
              this.vectorReindexProgress = p;
              this.eventBus.emit('vector:reindex:done', { progress: p });
              logger.info('HYBRID', 'auto reindex (post-import) complete', {
                obsEmbedded: p.observations.embedded,
                sumEmbedded: p.summaries.embedded,
              });
            })
            .catch((err) => {
              logger.error('HYBRID', 'auto reindex (post-import) failed', {
                error: String(err),
              });
            });
        }
      })
      .catch((err) => {
        this.importInProgress = false;
        const totalT = this.importProgress?.totalTurns ?? this.importProgress?.totalSessions ?? 0;
        const procT = this.importProgress?.processedTurns ?? this.importProgress?.processedSessions ?? 0;
        const skipT = this.importProgress?.skippedTurns ?? this.importProgress?.skippedSessions ?? 0;
        const failT = this.importProgress?.failedTurns ?? this.importProgress?.failedSessions ?? 0;
        this.importProgress = {
          phase: 'failed',
          totalSessions: totalT,
          totalTurns: totalT,
          processedSessions: procT,
          processedTurns: procT,
          importedSummaries: this.importProgress?.importedSummaries ?? 0,
          skippedSessions: skipT,
          skippedTurns: skipT,
          preFilteredTurns: this.importProgress?.preFilteredTurns ?? 0,
          failedSessions: failT,
          failedTurns: failT,
          etaSec: null,
          errorMessage: String((err as Error).message),
        };
        this.eventBus.emit('import:done', { error: String(err) });
        logger.error('IMPORT_API', 'run failed', {}, err as Error);
      });
  }

  /**
   * POST /api/import/reset { adapterId }
   * Wipes one adapter's fingerprints + linked summary rows so the next
   * /api/import/run reimports from scratch. Powers the desktop UI's
   * "重置导入" advanced action and the CLI's --reset flag.
   */
  private async handleImportReset(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    let body: { adapterId?: ImportAdapterId } = {};
    try { body = await this.parseBody(req); } catch { /* default empty */ }
    if (!body.adapterId) {
      res.statusCode = 400;
      res.end(JSON.stringify({ success: false, error: 'adapterId required' }));
      return;
    }
    try {
      const r = resetAdapter(body.adapterId);
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, ...r }));
    } catch (err) {
      logger.error('IMPORT_API', 'reset failed', { adapter: body.adapterId }, err as Error);
      res.statusCode = 500;
      res.end(JSON.stringify({ success: false, error: String((err as Error).message) }));
    }
  }
}

/**
 * Default configuration
 */
export function getDefaultConfig(): WorkerConfig {
  return {
    port: parseInt(process.env.CODEBUDDY_MEM_PORT || '3847', 10),
    host: process.env.CODEBUDDY_MEM_HOST || '127.0.0.1'
  };
}
