/**
 * ModelStore — own the ONNX embedder model lifecycle.
 *
 * Responsibilities:
 *   1. Force transformers.js to cache to ~/.agentMemory-hybrid-mcp/models/ (NOT ~/.cache/huggingface/).
 *   2. Force download from a configurable mirror (default hf-mirror) — no HF_HOME / HF_ENDPOINT
 *      side-channel reliance.
 *   3. Disable allowLocalModels to prevent accidental hits on agentMemory-boost PyTorch snapshots.
 *   4. Lazy + idempotent ensureReady() with a state machine and exposed status.
 *   5. Expose embed(text) → Float32Array.
 *
 * NEVER reads HF_HOME / HUGGINGFACE_HUB_CACHE / TRANSFORMERS_CACHE; those are agentMemory-boost
 * territory and we deliberately don't touch them.
 */
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { logger } from './logger.js';
import type { Config } from './config.js';

export type ModelStatus =
  | 'uninitialized'
  | 'downloading'
  | 'ready'
  | 'failed';

export interface ModelStatusReport {
  status: ModelStatus;
  modelId: string;
  remoteHost: string;
  cacheDir: string;
  startedAt?: string;
  readyAt?: string;
  lastError?: string;
  /** Last raw progress event from transformers.js (best-effort surfacing) */
  lastProgress?: {
    file?: string;
    progress?: number;
    loaded?: number;
    total?: number;
    status?: string;
  };
}

export class ModelStore {
  private status: ModelStatus = 'uninitialized';
  private startedAt?: string;
  private readyAt?: string;
  private lastError?: string;
  private lastProgress?: ModelStatusReport['lastProgress'];
  private extractor?: unknown; // transformers.js pipeline
  private readyPromise?: Promise<void>;

  constructor(private cfg: Config) {}

  getStatus(): ModelStatusReport {
    return {
      status: this.status,
      modelId: this.cfg.embedder.modelId,
      remoteHost: this.cfg.embedder.remoteHost,
      cacheDir: this.cfg.paths.modelsDir,
      startedAt: this.startedAt,
      readyAt: this.readyAt,
      lastError: this.lastError,
      lastProgress: this.lastProgress,
    };
  }

  /**
   * Idempotent: subsequent calls return the same promise. Safe to call from
   * multiple async contexts (server warmup + reindex + first search) — only
   * one download / load actually happens.
   */
  ensureReady(): Promise<void> {
    if (this.status === 'ready') return Promise.resolve();
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.doInit().catch((err) => {
      // reset so a future call can retry
      this.readyPromise = undefined;
      throw err;
    });
    return this.readyPromise;
  }

  /**
   * Embed a single piece of text. Caller is responsible for ensureReady().
   * Returns a Float32Array of length cfg.embedder.dim.
   */
  async embed(text: string): Promise<Float32Array> {
    if (this.status !== 'ready' || !this.extractor) {
      throw new Error(`ModelStore not ready (status=${this.status})`);
    }
    const fn = this.extractor as (
      input: string,
      options: { pooling: 'mean' | 'cls' | 'none'; normalize: boolean }
    ) => Promise<{ data: Float32Array | number[] }>;
    const out = await fn(text, { pooling: 'mean', normalize: true });
    return out.data instanceof Float32Array ? out.data : new Float32Array(out.data);
  }

  /** Same as embed() but for a batch of strings. Yields the event loop
   * between items so the MCP protocol channel and other tool calls don't
   * starve while we're CPU-bound on ONNX inference. */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      out.push(await this.embed(texts[i]));
      // Cooperative yield: let queued I/O (incl. MCP stdio reads) run.
      // setImmediate has higher priority than setTimeout(0) on Node.
      await new Promise<void>((r) => setImmediate(r));
    }
    return out;
  }

  // ────────────────── internals ──────────────────

  private async doInit(): Promise<void> {
    this.status = 'downloading';
    this.startedAt = new Date().toISOString();
    this.lastError = undefined;
    logger.info('ModelStore initializing', {
      modelId: this.cfg.embedder.modelId,
      remoteHost: this.cfg.embedder.remoteHost,
      cacheDir: this.cfg.paths.modelsDir,
      localModelPath: this.cfg.embedder.localModelPath,
    });

    // 1. Ensure cache dir
    if (!existsSync(this.cfg.paths.modelsDir)) {
      await mkdir(this.cfg.paths.modelsDir, { recursive: true });
    }

    // 2. Configure transformers.js env BEFORE first import that triggers download
    const tx = await import('@xenova/transformers');
    const env = tx.env as {
      cacheDir: string;
      remoteHost: string;
      allowLocalModels: boolean;
      allowRemoteModels: boolean;
      localModelPath: string;
      useFSCache: boolean;
    };
    env.cacheDir = this.cfg.paths.modelsDir;
    env.remoteHost = this.cfg.embedder.remoteHost;
    env.useFSCache = true;
    env.allowRemoteModels = true;

    if (this.cfg.embedder.localModelPath) {
      // Offline / pre-staged model path explicitly given — prefer it.
      env.allowLocalModels = true;
      env.localModelPath = this.cfg.embedder.localModelPath;
      logger.info('ModelStore using explicit localModelPath', {
        path: this.cfg.embedder.localModelPath,
      });
    } else {
      // Disable local model search to prevent accidental hits on
      // ~/.cache/huggingface/ snapshots left by agentMemory-boost (PyTorch format,
      // unusable for transformers.js).
      env.allowLocalModels = false;
    }

    // 3. Build the feature-extraction pipeline. This is what triggers the
    //    download on first run and the mmap-load on subsequent runs.
    try {
      const pipeline = tx.pipeline as (
        task: string,
        model: string,
        options?: { progress_callback?: (data: unknown) => void; quantized?: boolean }
      ) => Promise<unknown>;

      this.extractor = await pipeline(
        'feature-extraction',
        this.cfg.embedder.modelId,
        {
          quantized: true,
          progress_callback: (raw: unknown) => {
            // raw is { status, name, file, progress, loaded, total }
            const r = raw as ModelStatusReport['lastProgress'] & { status?: string; name?: string };
            this.lastProgress = r;
            if (r?.status === 'progress' && typeof r.progress === 'number') {
              if (Math.floor((r.progress ?? 0) * 10) % 2 === 0) {
                logger.info('ModelStore download progress', {
                  file: r.file,
                  pct: Math.round((r.progress ?? 0)),
                  loaded: r.loaded,
                  total: r.total,
                });
              }
            } else if (r?.status === 'done') {
              logger.info('ModelStore file done', { file: r.file });
            } else if (r?.status === 'ready') {
              logger.info('ModelStore pipeline ready', {});
            }
          },
        }
      );
    } catch (err) {
      this.status = 'failed';
      this.lastError = String(err);
      logger.error('ModelStore download/load failed', {
        error: String(err),
        stack: (err as Error).stack,
        hint: 'Check network access to ' + this.cfg.embedder.remoteHost +
              ' or set AGENTMEM_HYBRID_HF_ENDPOINT to a working mirror, ' +
              'or set AGENTMEM_HYBRID_MODEL_PATH to a pre-staged ONNX model dir.',
      });
      throw err;
    }

    this.status = 'ready';
    this.readyAt = new Date().toISOString();
    logger.info('ModelStore ready', {
      modelId: this.cfg.embedder.modelId,
      tookMs: this.startedAt ? Date.now() - new Date(this.startedAt).getTime() : null,
    });
  }
}
