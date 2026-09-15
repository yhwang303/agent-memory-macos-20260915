#!/usr/bin/env node
/**
 * agentmem-resume-mcp — stdio MCP server.
 *
 * Single tool: load_recent_context. Pulls the most recent N session summaries
 * (and key observations) for the project that matches the MCP server's CWD,
 * so a fresh IDE/agent can resume work without re-reading the full AgentMemory DB.
 *
 * Robustness: if AgentMemory's main DB is missing we still start the MCP and let the
 * tool itself return a structured error — never crash the process, since IDEs
 * usually surface that as "MCP failed to start" with no diagnostics.
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
import { AgentMemoryDb } from './agentMemoryDb.js';
import { TOOLS, type ToolContext } from './tools.js';

async function main(): Promise<void> {
  shieldStdout();
  const config = loadConfig();
  configureLogger({ logFile: config.logFile });

  logger.info('agentmem-resume-mcp starting', {
    version: config.packageVersion,
    agentMemoryDbPath: config.agentMemoryDbPath,
    cwd: process.cwd(),
    pid: process.pid,
  });

  const ctx: ToolContext = {
    packageVersion: config.packageVersion,
    defaults: config.defaults,
  };

  // Best-effort: open AgentMemory read-only. If it fails the MCP still starts so the
  // tool can return a clean error.
  try {
    if (existsSync(config.agentMemoryDbPath)) {
      ctx.agentMemoryDb = new AgentMemoryDb(config.agentMemoryDbPath);
    } else {
      logger.warn('AgentMemory main DB not found — load_recent_context will return an error', {
        path: config.agentMemoryDbPath,
      });
    }
  } catch (e) {
    logger.warn('AgentMemoryDb init failed', { error: String(e) });
  }

  const server = new Server(
    { name: 'agentmem-resume-mcp', version: config.packageVersion },
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('agentmem-resume-mcp connected via stdio', { tools: TOOLS.length });
}

function shutdown(reason: string): void {
  logger.info('shutting down', { reason });
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
