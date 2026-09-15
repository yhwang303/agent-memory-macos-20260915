/**
 * Runtime config — env > defaults
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export interface Paths {
  /** Top-level data dir, e.g. ~/.agentMemory-hybrid-mcp/ */
  dataDir: string;
  /** ONNX model cache, e.g. ~/.agentMemory-hybrid-mcp/models/ */
  modelsDir: string;
  /** sqlite-vec database file, e.g. ~/.agentMemory-hybrid-mcp/vec.db */
  vecDbPath: string;
  /** Optional log file (only used when AGENTMEM_HYBRID_LOG_FILE set, but we still resolve the default location) */
  logDir: string;
}

export interface EmbedderSettings {
  /** transformers.js repo id; pinned to the ONNX-compatible Xenova version */
  modelId: string;
  /** Mirror for HF downloads. Trailing slash matters. */
  remoteHost: string;
  /** Optional explicit local model dir; bypasses download entirely. */
  localModelPath?: string;
  /** Embedding output dimension (BGE-base = 768) */
  dim: number;
}

export interface RrfSettings {
  /** RRF saturation constant (Cormack 2009 default = 60). */
  k: number;
  /** Weight on the SQLite/FTS5 branch. Default 0.6 — sparse retrieval is
   *  the precision branch. */
  sqliteWeight: number;
  /** Weight on the dense vector branch. Default 0.4 — recall branch. */
  vectorWeight: number;
}

export interface Config {
  agentMemoryBaseUrl: string;
  agentMemoryDbPath: string;
  packageVersion: string;
  logFile?: string;
  paths: Paths;
  embedder: EmbedderSettings;
  rrf: RrfSettings;
  /** Default mode used by the `search` tool when caller does not pass one.
   *  Set via AGENTMEM_HYBRID_DEFAULT_MODE=sqlite|vector|hybrid. Default: hybrid. */
  defaultSearchMode: 'sqlite' | 'vector' | 'hybrid';
}

function defaultDataDir(): string {
  // v1.0.0+ shares dataDir with AgentMemory Worker so they co-own the same vec.db.
  // Old standalone-install path was ~/.agentMemory-hybrid-mcp/; we still honor it
  // when the user hasn't migrated, see resolveDataDir() below.
  return join(homedir(), '.agent-memory');
}

/**
 * Resolve dataDir with backward-compat:
 *   - explicit AGENTMEM_HYBRID_DATA_DIR env wins
 *   - otherwise prefer ~/.agent-memory/ (new default; AgentMemory Worker writes vec.db here)
 *   - if old ~/.agentMemory-hybrid-mcp/vec.db exists AND the new path doesn't, keep using old
 *     so existing standalone-install users don't lose their index on upgrade
 */
function resolveDataDir(): string {
  if (process.env.AGENTMEM_HYBRID_DATA_DIR) return process.env.AGENTMEM_HYBRID_DATA_DIR;
  const newDir = join(homedir(), '.agent-memory');
  const oldDir = join(homedir(), '.agentMemory-hybrid-mcp');
  if (!existsSync(join(newDir, 'vec.db')) && existsSync(join(oldDir, 'vec.db'))) {
    return oldDir;
  }
  return newDir;
}

function defaultAgentMemoryDbPath(): string {
  return join(homedir(), '.agent-memory', 'agent-memory.db');
}

/**
 * Resolve modelsDir priority:
 *   1. AGENTMEM_MODELS_DIR (installer-injected; points at resources/models/)
 *   2. AGENTMEM_HYBRID_MODELS_DIR (legacy explicit override)
 *   3. process.resourcesPath/models (when running embedded inside Electron)
 *   4. {dataDir}/models  (standalone fallback / dev)
 */
function resolveModelsDir(dataDir: string): string {
  if (process.env.AGENTMEM_MODELS_DIR) return process.env.AGENTMEM_MODELS_DIR;
  if (process.env.AGENTMEM_HYBRID_MODELS_DIR) return process.env.AGENTMEM_HYBRID_MODELS_DIR;
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const candidate = join(resourcesPath, 'models');
    if (existsSync(candidate)) return candidate;
  }
  return join(dataDir, 'models');
}

export function loadConfig(): Config {
  const agentMemoryBaseUrl = (process.env.AGENTMEM_BASE_URL || 'http://127.0.0.1:3847').replace(/\/+$/, '');
  const dataDir = resolveDataDir();
  const modelsDir = resolveModelsDir(dataDir);
  const vecDbPath = process.env.AGENTMEM_HYBRID_VEC_DB_PATH || join(dataDir, 'vec.db');
  const logDir = join(dataDir, 'log');

  // Mirror priority: explicit env > hf-mirror default
  // Trailing slash is required by transformers.js
  let remoteHost = (process.env.AGENTMEM_HYBRID_HF_ENDPOINT || process.env.HF_ENDPOINT || 'https://hf-mirror.com').replace(/\/+$/, '') + '/';

  // Default search mode (for `search` tool when caller doesn't pass mode)
  const rawMode = (process.env.AGENTMEM_HYBRID_DEFAULT_MODE || 'hybrid').toLowerCase();
  const defaultSearchMode: 'sqlite' | 'vector' | 'hybrid' =
    rawMode === 'sqlite' || rawMode === 'vector' ? rawMode : 'hybrid';

  return {
    agentMemoryBaseUrl,
    agentMemoryDbPath: process.env.AGENTMEM_HYBRID_AGENTMEM_DB_PATH || defaultAgentMemoryDbPath(),
    packageVersion: '0.1.0',
    logFile: process.env.AGENTMEM_HYBRID_LOG_FILE,
    paths: { dataDir, modelsDir, vecDbPath, logDir },
    embedder: {
      modelId: process.env.AGENTMEM_HYBRID_MODEL_ID || 'Xenova/bge-base-zh-v1.5',
      remoteHost,
      localModelPath: process.env.AGENTMEM_HYBRID_MODEL_PATH,
      dim: parseInt(process.env.AGENTMEM_HYBRID_EMBED_DIM || '768', 10),
    },
    rrf: {
      k: parseInt(process.env.AGENTMEM_HYBRID_RRF_K || '60', 10),
      sqliteWeight: parseFloat(process.env.AGENTMEM_HYBRID_SQLITE_WEIGHT || '0.6'),
      vectorWeight: parseFloat(process.env.AGENTMEM_HYBRID_VECTOR_WEIGHT || '0.4'),
    },
    defaultSearchMode,
  };
}

