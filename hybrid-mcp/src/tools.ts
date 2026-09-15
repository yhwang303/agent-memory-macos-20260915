/**
 * Tool definitions: name, description, JSON schema, handler.
 *
 * M1: ALL tools proxy AgentMemory Worker HTTP. No local search yet.
 * M2: index_status reports real local index state; new `reindex` tool triggers
 *     local rebuild. `search` still proxies AgentMemory (M3 will swap to true hybrid).
 */
import type { AgentMemoryClient, RawResponse } from './agentMemoryClient.js';
import type { ModelStore } from './modelStore.js';
import type { VectorStore } from './vectorStore.js';
import type { Indexer } from './indexer.js';
import type { AgentMemoryDb } from './agentMemoryDb.js';
import type { HybridSearch } from './hybridSearch.js';
import { logger } from './logger.js';

export interface ToolContext {
  agentMemory: AgentMemoryClient;
  packageVersion: string;
  /** Default mode for the `search` tool when caller doesn't pass one. */
  defaultSearchMode: 'sqlite' | 'vector' | 'hybrid';
  /** M2+ optional services. Tools must defensive-check before using. */
  model?: ModelStore;
  vec?: VectorStore;
  indexer?: Indexer;
  agentMemoryDb?: AgentMemoryDb;
  /** M3: hybrid search orchestrator. Available iff model+vec are alive. */
  hybridSearch?: HybridSearch;
}

export interface McpTextResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<McpTextResult>;
}

// ────────────────── helpers ──────────────────

function asText(obj: unknown): McpTextResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
  };
}

function asError(msg: string, extra?: unknown): McpTextResult {
  return {
    content: [{ type: 'text', text: extra ? `${msg}\n\n${JSON.stringify(extra, null, 2)}` : msg }],
    isError: true,
  };
}

async function proxyGet(
  ctx: ToolContext,
  path: string,
  params: Record<string, unknown>
): Promise<McpTextResult> {
  let r: RawResponse;
  try {
    r = await ctx.agentMemory.get(path, params);
  } catch (e) {
    logger.error('proxyGet network failure', { path, error: String(e) });
    return asError(`Failed to reach AgentMemory Worker (${path}): ${String(e)}\n\nIs AgentMemory app running? Check http://localhost:3847/health`);
  }
  if (!r.ok) {
    return asError(`AgentMemory Worker returned HTTP ${r.status} for ${path}`, r.json);
  }
  return asText(r.json);
}

async function proxyPost(
  ctx: ToolContext,
  path: string,
  body: unknown
): Promise<McpTextResult> {
  let r: RawResponse;
  try {
    r = await ctx.agentMemory.postJson(path, body);
  } catch (e) {
    logger.error('proxyPost network failure', { path, error: String(e) });
    return asError(`Failed to reach AgentMemory Worker (${path}): ${String(e)}`);
  }
  if (!r.ok) {
    return asError(`AgentMemory Worker returned HTTP ${r.status} for ${path}`, r.json);
  }
  return asText(r.json);
}

// ────────────────── tool defs ──────────────────

const __WORKFLOW: ToolDef = {
  name: '__WORKFLOW',
  description: `3-LAYER WORKFLOW (always follow):
1. search(query) -> get index with IDs
2. timeline(anchor=ID) -> chronological context around an interesting result
3. get_observations([IDs]) -> full details only for filtered IDs
NEVER fetch full details without filtering first.`,
  inputSchema: { type: 'object', properties: {} },
  handler: async () => asText({
    workflow: [
      'search(query="...", project="...", limit=20) → returns IDs + headers',
      'timeline(anchor=<ID>, depth_before=3, depth_after=3) → returns chronological context',
      'get_observations(ids=[...]) → returns full text for filtered IDs',
    ],
    why: 'avoid pulling 1000-token observation bodies when titles are enough to filter',
  }),
};

const search: ToolDef = {
  name: 'search',
  description: 'Search memory. Default mode=hybrid: parallel SQLite FTS5 + local vector ANN (BGE-zh + sqlite-vec), fused by basic-memory style score fusion (max(v,f) + 0.3·min(v,f)). Falls back gracefully: if vec.db is empty (no reindex done) it returns sqlite-only results. Use mode="sqlite" for pure FTS, mode="vector" for pure semantic. Params: query (required), project, limit (default 20), mode, obs_type[], dateStart, dateEnd.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search text (required)' },
      project: { type: 'string', description: 'Filter by project path' },
      mode: { type: 'string', enum: ['sqlite', 'vector', 'hybrid'], default: 'hybrid' },
      limit: { type: 'number', default: 20 },
      dateStart: { type: 'string', description: 'ISO-8601 lower bound' },
      dateEnd: { type: 'string', description: 'ISO-8601 upper bound' },
      obs_type: {
        type: 'array',
        items: { type: 'string' },
        description: 'Observation types filter, e.g. ["bugfix","feature"]',
      },
    },
    required: ['query'],
    additionalProperties: true,
  },
  handler: async (args, ctx) => {
    const query = String(args.query ?? '');
    if (!query) return asError('search: query is required');

    const mode = (args.mode as 'sqlite' | 'vector' | 'hybrid' | undefined) ?? ctx.defaultSearchMode;

    // 单一事实源:把所有模式都委托给 AgentMemory Worker 的 /api/search。
    // mode=hybrid|vector 在 Worker 内由 HybridSearchService 走 basic-memory 风格的
    // score-based fusion (ScoreFusion.ts: max(v,f) + 0.3*min(v,f)),mode=sqlite
    // 走原 SearchOrchestrator。这样 MCP 进程只是 stdio 协议的薄壳,融合算法实现
    // 只在 Worker 一处,避免双份代码漂移。
    //
    // 旧的本地 HybridSearch (rrf-based) 不再被 search 工具调用;model/vec 仍在
    // ctx 上保留供 indexer/reindex 等工具使用,所以本进程不必额外瘦身。
    return proxyGet(ctx, '/api/search', { ...args, mode });
  },
};

const search_sqlite: ToolDef = {
  name: 'search_sqlite',
  description: 'Pure SQLite FTS5 search (proxies AgentMemory /api/search?mode=sqlite). Useful for debugging / evaluation as a baseline.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      project: { type: 'string' },
      limit: { type: 'number', default: 20 },
      obs_type: { type: 'array', items: { type: 'string' } },
    },
    required: ['query'],
    additionalProperties: true,
  },
  handler: async (args, ctx) => proxyGet(ctx, '/api/search', { ...args, mode: 'sqlite' }),
};

const search_vector: ToolDef = {
  name: 'search_vector',
  description: 'Pure local vector ANN search (BGE-zh embedding + sqlite-vec). No FTS, no fusion. Useful for evaluation / debugging the vector branch in isolation.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      project: { type: 'string' },
      limit: { type: 'number', default: 20 },
      obs_type: { type: 'array', items: { type: 'string' } },
    },
    required: ['query'],
    additionalProperties: true,
  },
  handler: async (args, ctx) => {
    const query = String(args.query ?? '');
    if (!query) return asError('search_vector: query is required');
    if (!ctx.hybridSearch) return asError('search_vector: hybrid services not initialized');
    try {
      const r = await ctx.hybridSearch.search({
        query,
        project: typeof args.project === 'string' ? args.project : undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
        mode: 'vector',
        obs_type: Array.isArray(args.obs_type) ? (args.obs_type as string[]) : undefined,
      });
      return asText({ success: true, mode: r.mode, fellBack: r.fellBack, count: r.observations.length + r.summaries.length, observations: r.observations, summaries: r.summaries, timings: r.timings });
    } catch (e) {
      return asError(`vector search failed: ${e}`);
    }
  },
};

const timeline: ToolDef = {
  name: 'timeline',
  description: 'Get chronological context around an observation. Params: anchor (observation ID) OR query (auto-resolves anchor), depth_before, depth_after, project.',
  inputSchema: {
    type: 'object',
    properties: {
      anchor: { type: 'number', description: 'Observation ID to anchor on' },
      query: { type: 'string', description: 'If no anchor, find one via search first' },
      depth_before: { type: 'number', default: 3 },
      depth_after: { type: 'number', default: 3 },
      project: { type: 'string' },
    },
    additionalProperties: true,
  },
  handler: async (args, ctx) => proxyGet(ctx, '/api/timeline', args),
};

const get_observations: ToolDef = {
  name: 'get_observations',
  description: 'Fetch full observation details for a filtered list of IDs. Params: ids (number[], required), project, orderBy, limit.',
  inputSchema: {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'number' }, description: 'Observation IDs to fetch (required)' },
      project: { type: 'string' },
      orderBy: { type: 'string' },
      limit: { type: 'number' },
    },
    required: ['ids'],
    additionalProperties: true,
  },
  handler: async (args, ctx) => proxyPost(ctx, '/api/observations/batch', args),
};

const get_summaries: ToolDef = {
  name: 'get_summaries',
  description: 'Fetch session summaries by IDs. Params: ids (number[]), project, limit, offset.',
  inputSchema: {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'number' } },
      project: { type: 'string' },
      limit: { type: 'number' },
      offset: { type: 'number' },
    },
    additionalProperties: true,
  },
  handler: async (args, ctx) => proxyPost(ctx, '/api/summaries/batch', args),
};

const list_projects: ToolDef = {
  name: 'list_projects',
  description: 'List all projects in AgentMemory memory with their observation counts.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx) => proxyGet(ctx, '/api/viewer/projects', {}),
};

const list_sessions: ToolDef = {
  name: 'list_sessions',
  description: 'List sessions. Params: project, limit (default 50), offset (default 0).',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string' },
      limit: { type: 'number', default: 50 },
      offset: { type: 'number', default: 0 },
    },
    additionalProperties: true,
  },
  handler: async (args, ctx) => proxyGet(ctx, '/api/viewer/sessions', args),
};

const index_status: ToolDef = {
  name: 'index_status',
  description: 'Report agentmem-hybrid-mcp local vector index health, model status, and AgentMemory worker reachability.',
  inputSchema: { type: 'object', properties: {} },
  handler: async (_args, ctx) => {
    const agentMemoryHealth = await ctx.agentMemory.get('/health').catch((e: unknown) => ({ ok: false, status: 0, json: { error: String(e) } } as RawResponse));
    const modelStatus = ctx.model ? ctx.model.getStatus() : null;
    const vecStats = ctx.vec ? ctx.vec.stats() : null;
    const indexerProgress = ctx.indexer ? ctx.indexer.getProgress() : null;
    const agentMemoryStats = ctx.agentMemoryDb ? ctx.agentMemoryDb.stats() : null;

    // Coverage = vec docs / agentMemory docs
    let coverage: { observations: number; summaries: number; total: number } | null = null;
    if (agentMemoryStats && vecStats) {
      const totalAgentMemory = agentMemoryStats.observations + agentMemoryStats.summaries;
      const totalVec = vecStats.totalDocs;
      coverage = {
        observations: agentMemoryStats.observations === 0 ? 1 : vecStats.observations / agentMemoryStats.observations,
        summaries: agentMemoryStats.summaries === 0 ? 1 : vecStats.summaries / agentMemoryStats.summaries,
        total: totalAgentMemory === 0 ? 1 : totalVec / totalAgentMemory,
      };
    }

    return asText({
      agentMemoryHybridMcp: {
        version: ctx.packageVersion,
        milestone: 'M3 — true hybrid search (sqlite FTS + local vector + RRF)',
      },
      agentMemoryWorker: {
        baseUrl: (ctx.agentMemory as unknown as { opts: { baseUrl: string } }).opts.baseUrl,
        reachable: agentMemoryHealth.ok,
        status: agentMemoryHealth.status,
        health: agentMemoryHealth.json,
      },
      model: modelStatus,
      vectorIndex: vecStats,
      agentMemoryDb: agentMemoryStats,
      coverage,
      indexer: indexerProgress,
      syncDaemon: ctx.indexer ? ctx.indexer.getDaemonStatus() : null,
    });
  },
};

const reindex: ToolDef = {
  name: 'reindex',
  description: 'Trigger a full local re-index of the vector store from the AgentMemory main DB. Optionally scope by `project`. Returns immediately with the kicked-off progress (the actual run continues in background).',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Limit reindex to this project (optional)' },
      force: { type: 'boolean', description: 'Re-embed rows that already have a vector. Default false.' },
      wait: { type: 'boolean', description: 'Block until the run finishes. Default false (returns immediately).' },
    },
    additionalProperties: true,
  },
  handler: async (args, ctx) => {
    if (!ctx.indexer) {
      return asError('Local indexer not initialized. This is expected only if M2 services failed to start; check stderr.');
    }
    const project = typeof args.project === 'string' ? args.project : undefined;
    const force = !!args.force;
    const wait = !!args.wait;
    if (wait) {
      const prog = await ctx.indexer.reindexAll({ project, force });
      return asText({ status: 'completed', progress: prog });
    }
    // fire and forget
    ctx.indexer.reindexAll({ project, force }).catch((e) => {
      logger.error('background reindex failed', { error: String(e) });
    });
    return asText({
      status: 'started',
      hint: 'Use `index_status` to poll progress',
      progress: ctx.indexer.getProgress(),
    });
  },
};

export const TOOLS: ToolDef[] = [
  __WORKFLOW,
  search,
  search_sqlite,
  search_vector,
  timeline,
  get_observations,
  get_summaries,
  list_projects,
  list_sessions,
  index_status,
  reindex,
];
