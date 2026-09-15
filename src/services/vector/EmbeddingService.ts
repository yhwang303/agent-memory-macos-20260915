/**
 * EmbeddingService — BGE-zh ONNX 模型生命周期。
 *
 * 职责:
 *   1. 模型路径优先级:
 *        构造时显式 modelDir > AGENTMEM_MODELS_DIR env > installer resources/models > userDataDir/models
 *      安装包预打了模型,所以正常情况第一次启动直接走 installer resources。
 *   2. lazy ensureReady(): 第一次 search/embed 时才加载,避免阻塞 Worker 启动。
 *   3. 状态机 + 进度回调: index_status 工具能看到 downloading 进度。
 *   4. embed(text) → Float32Array; embedBatch(texts) → Float32Array[]。
 *
 * 与 agentmem-hybrid-mcp/src/modelStore.ts 的差异:
 *   - 不再依赖 agentmem-hybrid-mcp 的 Config 类型,改用简单 options
 *   - 不强制 allowLocalModels=false (我们 ship 的就是 local model)
 *   - 模型已就位时静默 ready,不会去访问网络
 *   - logger 改用 AgentMemory 的 category-based API
 */
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../../utils/logger.js';

const LOG_CAT = 'hybrid-embed';

export type ModelStatus = 'uninitialized' | 'downloading' | 'ready' | 'failed';

export interface ModelStatusReport {
  status: ModelStatus;
  modelId: string;
  remoteHost: string;
  cacheDir: string;
  startedAt?: string;
  readyAt?: string;
  lastError?: string;
  /** 最近一次 transformers.js 进度事件 */
  lastProgress?: {
    file?: string;
    progress?: number;
    loaded?: number;
    total?: number;
    status?: string;
  };
}

export interface EmbeddingServiceOptions {
  /** 模型 ID,默认 Xenova/bge-base-zh-v1.5 */
  modelId?: string;
  /** 模型缓存目录(优先级最高) */
  modelDir?: string;
  /** 远端镜像,用于在线下载兜底。默认 https://hf-mirror.com */
  remoteHost?: string;
  /** 是否允许在线下载。默认 true(线下镜像不可达时报 failed) */
  allowRemoteModels?: boolean;
  /** 嵌入维度,默认 768 (BGE-base) */
  dim?: number;
  /**
   * onnxruntime intra-op 线程数。**未设置时默认 2** —— onnxruntime-node 默认会用
   * 物理核心数,对存量数据 (32k+ obs) 重建时会把所有核心打满,Windows 调度器
   * 把前台 GUI / 网络栈用户态进程挤到几乎拿不到 CPU 时间,体感"网都断了"。
   * 桌面端通过 OMP_NUM_THREADS 环境变量传进来,允许用户在托盘菜单里切档。
   */
  numThreads?: number;
}

export class EmbeddingService {
  private status: ModelStatus = 'uninitialized';
  private startedAt?: string;
  private readyAt?: string;
  private lastError?: string;
  private lastProgress?: ModelStatusReport['lastProgress'];
  private extractor?: unknown;
  private readyPromise?: Promise<void>;

  private readonly modelId: string;
  private readonly modelDir: string;
  private readonly remoteHost: string;
  private readonly allowRemoteModels: boolean;
  private readonly dim: number;
  private readonly numThreads: number;

  constructor(opts: EmbeddingServiceOptions = {}) {
    this.modelId = opts.modelId ?? 'Xenova/bge-base-zh-v1.5';
    this.modelDir = opts.modelDir ?? this.resolveDefaultModelDir();
    this.remoteHost =
      ((opts.remoteHost ?? process.env.AGENTMEM_HYBRID_HF_ENDPOINT ?? process.env.HF_ENDPOINT ?? 'https://hf-mirror.com')
        .replace(/\/+$/, '')) + '/';
    this.allowRemoteModels = opts.allowRemoteModels ?? true;
    this.dim = opts.dim ?? 768;
    // 线程数解析: 显式 opts > OMP_NUM_THREADS env > 默认 2 (省电档)
    const envThreads = parseInt(process.env.OMP_NUM_THREADS || '', 10);
    this.numThreads = opts.numThreads ?? (Number.isFinite(envThreads) && envThreads > 0 ? envThreads : 2);
  }

  getStatus(): ModelStatusReport {
    return {
      status: this.status,
      modelId: this.modelId,
      remoteHost: this.remoteHost,
      cacheDir: this.modelDir,
      startedAt: this.startedAt,
      readyAt: this.readyAt,
      lastError: this.lastError,
      lastProgress: this.lastProgress,
    };
  }

  getDim(): number {
    return this.dim;
  }

  /**
   * 幂等。多个并发调用共享同一个加载 Promise。失败后允许重试。
   */
  ensureReady(): Promise<void> {
    if (this.status === 'ready') return Promise.resolve();
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.doInit().catch((err) => {
      this.readyPromise = undefined;
      throw err;
    });
    return this.readyPromise;
  }

  /**
   * 单条 embed。调用方须先 ensureReady()。
   */
  async embed(text: string): Promise<Float32Array> {
    if (this.status !== 'ready' || !this.extractor) {
      throw new Error(`EmbeddingService not ready (status=${this.status})`);
    }
    const fn = this.extractor as (
      input: string,
      options: { pooling: 'mean' | 'cls' | 'none'; normalize: boolean }
    ) => Promise<{ data: Float32Array | number[] }>;
    const out = await fn(text, { pooling: 'mean', normalize: true });
    return out.data instanceof Float32Array ? out.data : new Float32Array(out.data);
  }

  /**
   * 批量 embed。条目之间 setImmediate 让出事件循环,避免长时间 CPU 占用阻塞
   * Worker 的其他 HTTP 请求 / EventBus 处理。
   */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      out.push(await this.embed(texts[i]));
      await new Promise<void>((r) => setImmediate(r));
    }
    return out;
  }

  // ────────────────── internals ──────────────────

  /**
   * 默认模型目录解析顺序:
   *   1. AGENTMEM_MODELS_DIR env (installer 注入)
   *   2. process.resourcesPath/models  (Electron packaged)
   *   3. ~/.agent-memory/models       (开发态 / 兜底)
   */
  private resolveDefaultModelDir(): string {
    if (process.env.AGENTMEM_MODELS_DIR) return process.env.AGENTMEM_MODELS_DIR;
    // 在 Electron 打包后,process.resourcesPath 指向 .exe 旁的 resources 目录
    // 在开发态(直接 node 跑)是 undefined
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (resourcesPath) {
      // installer 把模型打到 resources/models/
      const candidate = pathJoin(resourcesPath, 'models');
      if (existsSync(candidate)) return candidate;
    }
    return pathJoin(homedir(), '.agent-memory', 'models');
  }

  private async doInit(): Promise<void> {
    this.status = 'downloading';
    this.startedAt = new Date().toISOString();
    this.lastError = undefined;
    logger.info(LOG_CAT, 'EmbeddingService initializing', {
      modelId: this.modelId,
      modelDir: this.modelDir,
      remoteHost: this.remoteHost,
      allowRemoteModels: this.allowRemoteModels,
    });

    if (!existsSync(this.modelDir)) {
      await mkdir(this.modelDir, { recursive: true });
    }

    // transformers.js env 必须在第一次 import 后立即设,在 pipeline() 之前。
    const tx = await import('@xenova/transformers');
    const env = tx.env as {
      cacheDir: string;
      remoteHost: string;
      allowLocalModels: boolean;
      allowRemoteModels: boolean;
      localModelPath: string;
      useFSCache: boolean;
      backends?: {
        onnx?: {
          numThreads?: number;
          wasm?: { numThreads?: number };
        };
      };
    };
    env.cacheDir = this.modelDir;
    env.remoteHost = this.remoteHost;
    env.useFSCache = true;
    env.allowLocalModels = true;       // 允许从 modelDir 读
    env.allowRemoteModels = this.allowRemoteModels;
    env.localModelPath = this.modelDir;

    // 关键: 限制 ONNX intra-op 线程数。默认行为是用所有物理核心,在存量数据
    // 重建期间把整机 CPU 打满,体感"网都断了"。同时设 wasm 与 native 两条
    // 路径, 因为 transformers.js 内部根据平台选后端。
    try {
      if (env.backends?.onnx) {
        env.backends.onnx.numThreads = this.numThreads;
        if (env.backends.onnx.wasm) {
          env.backends.onnx.wasm.numThreads = this.numThreads;
        } else {
          env.backends.onnx.wasm = { numThreads: this.numThreads };
        }
      }
      logger.info(LOG_CAT, 'ONNX numThreads applied', { numThreads: this.numThreads });
    } catch (e) {
      logger.warn(LOG_CAT, 'failed to set ONNX numThreads (non-fatal)', { error: String(e) });
    }

    try {
      const pipeline = tx.pipeline as (
        task: string,
        model: string,
        options?: { progress_callback?: (data: unknown) => void; quantized?: boolean }
      ) => Promise<unknown>;

      this.extractor = await pipeline('feature-extraction', this.modelId, {
        quantized: true,
        progress_callback: (raw: unknown) => {
          const r = raw as ModelStatusReport['lastProgress'] & { status?: string; name?: string };
          this.lastProgress = r;
          if (r?.status === 'progress' && typeof r.progress === 'number') {
            // 每 20% 打一行,避免日志洪水
            if (Math.floor((r.progress ?? 0) / 20) !== Math.floor(((r.progress ?? 0) - 0.1) / 20)) {
              logger.info(LOG_CAT, 'EmbeddingService download progress', {
                file: r.file,
                pct: Math.round(r.progress ?? 0),
              });
            }
          } else if (r?.status === 'done') {
            logger.info(LOG_CAT, 'EmbeddingService file done', { file: r.file });
          } else if (r?.status === 'ready') {
            logger.info(LOG_CAT, 'EmbeddingService pipeline ready', {});
          }
        },
      });
    } catch (err) {
      this.status = 'failed';
      this.lastError = String(err);
      logger.error(LOG_CAT, 'EmbeddingService load failed', {
        error: String(err),
        hint: `Check ${this.modelDir} exists and contains the ONNX model files, ` +
              `or that ${this.remoteHost} is reachable.`,
      });
      throw err;
    }

    this.status = 'ready';
    this.readyAt = new Date().toISOString();
    logger.info(LOG_CAT, 'EmbeddingService ready', {
      modelId: this.modelId,
      tookMs: this.startedAt ? Date.now() - new Date(this.startedAt).getTime() : null,
    });
  }
}
