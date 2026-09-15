#!/usr/bin/env node
/**
 * agentmem-hybrid-mcp — stdio MCP server.
 *
 * M1: 9 tools that proxy AgentMemory Worker HTTP API.
 * M2: + local vector index (sqlite-vec) + ONNX embedder (BGE-zh) + indexer.
 *     `index_status` reports real coverage; new `reindex` tool triggers rebuild.
 *     `search` still proxies AgentMemory (M3 will swap to true hybrid orchestrator).
 *
 * Robustness: M2 services are best-effort. If model download fails, vec.db
 * fails to open, or AgentMemory main DB is missing, the MCP still serves the proxy
 * tools (search/timeline/etc.) — degraded gracefully, never crashes.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { existsSync } from 'node:fs';

import { loadConfig } from './config.js';
import { configureLogger, logger, shieldStdout } from './logger.js';
import { AgentMemoryClient } from './agentMemoryClient.js';
import { ModelStore } from './modelStore.js';
import { VectorStore } from './vectorStore.js';
import { AgentMemoryDb } from './agentMemoryDb.js';
import { Indexer } from './indexer.js';
import { HybridSearch } from './hybridSearch.js';
import { TOOLS, type ToolContext } from './tools.js';

async function main(): Promise<void> {
  shieldStdout();
  const config = loadConfig();
  configureLogger({ logFile: config.logFile });

  logger.info('agentmem-hybrid-mcp starting', {
    version: config.packageVersion,
    agentMemoryBaseUrl: config.agentMemoryBaseUrl,
    dataDir: config.paths.dataDir,
    pid: process.pid,
  });

  const agentMemory = new AgentMemoryClient({ baseUrl: config.agentMemoryBaseUrl });
  const ctx: ToolContext = {
    agentMemory,
    packageVersion: config.packageVersion,
    defaultSearchMode: config.defaultSearchMode,
  };

  // ── Best-effort M2 wire-up ────────────────────────────────────────
  // Each step is independently optional. If any fails, MCP still serves the
  // proxy tools; the user just won't have local vector index until they fix
  // the underlying issue.
  try {
    ctx.vec = new VectorStore({ dbPath: config.paths.vecDbPath, dim: config.embedder.dim });
  } catch (e) {
    logger.warn('VectorStore init failed; local vector features disabled', { error: String(e) });
  }
  try {
    if (existsSync(config.agentMemoryDbPath)) {
      ctx.agentMemoryDb = new AgentMemoryDb(config.agentMemoryDbPath);
    } else {
      logger.warn('AgentMemory main DB not found; reindex disabled', { path: config.agentMemoryDbPath });
    }
  } catch (e) {
    logger.warn('AgentMemoryDb init failed', { error: String(e) });
  }

  // ModelStore is constructed eagerly but model loading is lazy (ensureReady).
  ctx.model = new ModelStore(config);
  if (ctx.vec && ctx.agentMemoryDb) {
    ctx.indexer = new Indexer(ctx.model, ctx.vec, ctx.agentMemoryDb);
  }
  // M3: hybrid orchestrator. Available even if vec.db is empty — vector
  // branch will just return [] until reindex populates the index.
  if (ctx.model && ctx.vec) {
    ctx.hybridSearch = new HybridSearch({
      agentMemory,
      model: ctx.model,
      vec: ctx.vec,
      rrfK: config.rrf.k,
      sqliteWeight: config.rrf.sqliteWeight,
      vectorWeight: config.rrf.vectorWeight,
    });
  }

  // ── MCP wiring ─────────────────────────────────────────────────────
  const server = new Server(
    { name: 'agentmem-hybrid-mcp', version: config.packageVersion },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<any> => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    try {
      return await tool.handler(args, ctx);
    } catch (err) {
      logger.error('tool handler threw', { tool: name, error: String(err) });
      return {
        content: [{ type: 'text' as const, text: `Tool ${name} failed: ${String(err)}` }],
        isError: true,
      };
    }
  });

  // ── Background tasks ──────────────────────────────────────────────
  // AgentMemory health probe (logs only)
  setTimeout(() => {
    agentMemory.health()
      .then((h) => {
        if (h.ok) logger.info('AgentMemory worker reachable', { status: h.status });
        else logger.warn('AgentMemory worker unhealthy', { status: h.status });
      })
      .catch((e) => logger.warn('AgentMemory worker unreachable', { error: String(e) }));
  }, 0);

  // v1.0.0+ embedded mode:
  //   The AgentMemory Worker (main repo) now owns ALL writes to vec.db — full reindex
  //   on first launch + incremental vectorization via EventBus. This MCP is
  //   read-only for vec.db; the local sync daemon and the model-warmup hook
  //   were both removed to avoid double-writers and racing reindexes.
  //
  //   ModelStore.ensureReady() is still called lazily inside the search/index_status
  //   tools, so a standalone-install user (no Worker running) can still use
  //   `reindex` and `search_vector` — they'll just be the sole writer of vec.db
  //   in that scenario.

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('agentmem-hybrid-mcp connected via stdio', { tools: TOOLS.length });
}

function shutdown(reason: string): void {
  logger.info('shutting down', { reason });
  // Best-effort: stop daemon so the process can exit cleanly. (Timers are
  // unref'd anyway; this is just for clean log output.)
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { error: String(err), stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { reason: String(reason) });
});

main().catch((err) => {
  logger.error('fatal startup error', { error: String(err), stack: (err as Error).stack });
  process.exit(1);
});
