/**
 * AgentMemory MCP Search Server
 * Thin HTTP wrapper that delegates to Worker HTTP API
 * Adapted from claude-mem for CodeBuddy Agent
 */

// Version injected at build time
declare const __DEFAULT_PACKAGE_VERSION__: string;
const packageVersion = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined' ? __DEFAULT_PACKAGE_VERSION__ : '0.0.0-dev';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { buildSearchParams } from './helpers.js';

/**
 * Worker HTTP API configuration
 */
const WORKER_PORT = process.env.CODEBUDDY_MEM_WORKER_PORT || 3847;
const WORKER_HOST = process.env.CODEBUDDY_MEM_WORKER_HOST || '127.0.0.1';
const WORKER_BASE_URL = `http://${WORKER_HOST}:${WORKER_PORT}`;

/**
 * Simple logger that writes to stderr (MCP uses stdout for protocol)
 */
const logger = {
  info: (msg: string, data?: any) => console.error(`[INFO] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: any) => console.error(`[ERROR] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (msg: string, data?: any) => {
    if (process.env.DEBUG) console.error(`[DEBUG] ${msg}`, data ? JSON.stringify(data) : '');
  }
};

// Redirect console.log to stderr (MCP protocol protection)
const _originalLog = console['log'];
console['log'] = (...args: any[]) => {
  logger.error('Intercepted console.log output', { args });
};

/**
 * Map tool names to Worker HTTP endpoints
 */
const TOOL_ENDPOINT_MAP: Record<string, string> = {
  'search': '/api/search',
  'timeline': '/api/timeline'
};

/**
 * Call Worker HTTP API endpoint (GET)
 */
async function callWorkerAPI(
  endpoint: string,
  params: Record<string, any>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  logger.debug('Worker API request', { endpoint, params });

  try {
    const searchParams = buildSearchParams(params);

    const url = `${WORKER_BASE_URL}${endpoint}?${searchParams.toString()}`;
    const response = await fetch(url);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Worker API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    logger.debug('Worker API success', { endpoint, data });

    // Convert Worker API response to MCP format
    // Worker returns: { success: boolean, results?: any[], count?: number, ... }
    // MCP expects: { content: [{ type: 'text', text: '...' }] }
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(data, null, 2)
      }]
    };
  } catch (error) {
    logger.error('Worker API error', { endpoint, error: String(error) });
    return {
      content: [{
        type: 'text' as const,
        text: `Error calling Worker API: ${error}`
      }],
      isError: true
    };
  }
}

/**
 * Call Worker HTTP API with POST body
 */
async function callWorkerAPIPost(
  endpoint: string,
  body: Record<string, any>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  logger.debug('Worker API POST request', { endpoint });

  try {
    const url = `${WORKER_BASE_URL}${endpoint}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Worker API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    logger.debug('Worker API POST success', { endpoint });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(data, null, 2)
      }]
    };
  } catch (error) {
    logger.error('Worker API POST error', { endpoint, error: String(error) });
    return {
      content: [{
        type: 'text' as const,
        text: `Error calling Worker API: ${error}`
      }],
      isError: true
    };
  }
}

/**
 * Verify Worker is accessible
 */
async function verifyWorkerConnection(): Promise<boolean> {
  try {
    const response = await fetch(`${WORKER_BASE_URL}/health`);
    return response.ok;
  } catch (error) {
    logger.debug('Worker health check failed', { error: String(error) });
    return false;
  }
}

/**
 * Tool definitions for AgentMemory search
 */
const tools = [
  {
    name: '__IMPORTANT',
    description: `3-LAYER WORKFLOW (ALWAYS FOLLOW):
1. search(query) -> Get index with IDs (~50-100 tokens/result)
2. timeline(anchor=ID) -> Get context around interesting results
3. get_observations([IDs]) -> Fetch full details ONLY for filtered IDs
NEVER fetch full details without filtering first. 10x token savings.`,
    inputSchema: {
      type: 'object',
      properties: {}
    },
    handler: async () => ({
      content: [{
        type: 'text' as const,
        text: `# AgentMemory Search Workflow

**3-Layer Pattern (ALWAYS follow this):**

1. **Search** - Get index of results with IDs
   \`search(query="...", limit=20, project="...")\`
   Returns: Table with IDs, titles, dates (~50-100 tokens/result)

2. **Timeline** - Get context around interesting results
   \`timeline(anchor=<ID>, depth_before=3, depth_after=3)\`
   Returns: Chronological context showing what was happening

3. **Fetch** - Get full details ONLY for relevant IDs
   \`get_observations(ids=[...])\`  # ALWAYS batch for 2+ items
   Returns: Complete details (~500-1000 tokens/result)

**Why:** 10x token savings. Never fetch full details without filtering first.`
      }]
    })
  },
  {
    name: 'search',
    description: 'Step 1: Search memory. Default mode is "hybrid" (Chroma semantic + SQLite FTS merge) with graceful fallback to SQLite if Chroma is unavailable. Use mode="sqlite" for pure FTS, mode="chroma" for pure semantic. Returns index with IDs plus response metadata: { success, results, count, mode, fellBack, observations, summaries }. Supports obs_type filter (array), date range (dateStart/dateEnd ISO), and legacy params (type, offset, orderBy).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search text (required)'
        },
        project: {
          type: 'string',
          description: 'Filter by project path (optional)'
        },
        mode: {
          type: 'string',
          enum: ['sqlite', 'chroma', 'hybrid'],
          description: 'Backend selector. Default "hybrid" merges Chroma semantic results with SQLite FTS and gracefully falls back to SQLite if Chroma is unavailable.',
          default: 'hybrid'
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default 20)',
          default: 20
        },
        dateStart: {
          type: 'string',
          description: 'Lower bound for result dates, ISO-8601 (optional)'
        },
        dateEnd: {
          type: 'string',
          description: 'Upper bound for result dates, ISO-8601 (optional)'
        },
        obs_type: {
          type: 'array',
          items: { type: 'string' },
          description: 'Observation types to include (optional, e.g. ["bugfix","feature"]). Serialized as comma-joined string.'
        }
      },
      required: ['query'],
      additionalProperties: true
    },
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['search'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'search_like',
    description: 'Search memory using SQL LIKE (better for Chinese/short keywords). Params: query (required), project (optional), type ("observations"/"summaries"/"all"), limit',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search keyword (uses SQL LIKE %query%)'
        },
        project: {
          type: 'string',
          description: 'Filter by project path (optional)'
        },
        type: {
          type: 'string',
          enum: ['observations', 'summaries', 'all'],
          description: 'Which tables to search (default: all)'
        },
        limit: {
          type: 'number',
          description: 'Maximum results per table (default: 20)'
        }
      },
      required: ['query']
    },
    handler: async (args: any) => {
      return await callWorkerAPI('/api/search_like', args);
    }
  },
  {
    name: 'timeline',
    description: 'Step 2: Get context around results. Params: anchor (observation ID) OR query (finds anchor automatically), depth_before, depth_after, project',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: true
    },
    handler: async (args: any) => {
      const endpoint = TOOL_ENDPOINT_MAP['timeline'];
      return await callWorkerAPI(endpoint, args);
    }
  },
  {
    name: 'get_observations',
    description: 'Step 3: Fetch full details for filtered IDs. Params: ids (array of observation IDs, required), orderBy, limit, project',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of observation IDs to fetch (required)'
        }
      },
      required: ['ids'],
      additionalProperties: true
    },
    handler: async (args: any) => {
      return await callWorkerAPIPost('/api/observations/batch', args);
    }
  },
  {
    name: 'get_summaries',
    description: 'Get session summaries. Params: ids (array), project, limit, offset',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of summary IDs to fetch'
        }
      },
      additionalProperties: true
    },
    handler: async (args: any) => {
      return await callWorkerAPIPost('/api/summaries/batch', args);
    }
  },
  {
    name: 'get_stats',
    description: 'Get database statistics and health info. Returns: observations count, summaries count, sessions count, uptime, etc.',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    handler: async () => {
      return await callWorkerAPI('/health', {});
    }
  },
  {
    name: 'list_projects',
    description: 'List all projects in memory. Returns: array of project paths with their observation counts.',
    inputSchema: {
      type: 'object',
      properties: {}
    },
    handler: async () => {
      return await callWorkerAPI('/api/viewer/projects', {});
    }
  },
  {
    name: 'list_sessions',
    description: 'List sessions. Params: project (optional, filter by project path), limit (default 50), offset (default 0)',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Filter by project path (optional)'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of sessions to return (default 50)'
        },
        offset: {
          type: 'number',
          description: 'Offset for pagination (default 0)'
        }
      },
      additionalProperties: true
    },
    handler: async (args: any) => {
      return await callWorkerAPI('/api/viewer/sessions', args);
    }
  },
  {
    name: 'get_context',
    description: 'Get project memory context summary for injection. Params: project (required), limit (optional)',
    inputSchema: {
      type: 'object',
      properties: {
        project: {
          type: 'string',
          description: 'Project path (required)'
        },
        limit: {
          type: 'number',
          description: 'Maximum items to include in context'
        }
      },
      required: ['project'],
      additionalProperties: true
    },
    handler: async (args: any) => {
      return await callWorkerAPI('/api/context/inject', args);
    }
  },

  // ── Self-Evolve plugin tools ────────────────────────────────────────────────

  {
    name: 'get_rules',
    description: 'Get evolved rules for a workspace. Returns active, approved rules that guide AI behavior in this project.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace/project path (required)' },
        category: { type: 'string', description: 'Filter by category (optional)' }
      },
      required: ['workspace']
    },
    handler: async (args: any) => callWorkerAPI('/api/viewer/rules', args)
  },
  {
    name: 'get_skills',
    description: 'Get evolved skills for a workspace. Returns active, approved reusable skill procedures.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace/project path (required)' }
      },
      required: ['workspace']
    },
    handler: async (args: any) => callWorkerAPI('/api/viewer/skills', args)
  },
  {
    name: 'get_skill_detail',
    description: 'Get the full SKILL.md content of a specific skill by slug.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace/project path' },
        slug: { type: 'string', description: 'Skill slug identifier' }
      },
      required: ['workspace', 'slug']
    },
    handler: async (args: any) => callWorkerAPI('/api/viewer/skills', args)
  },
  {
    name: 'get_evo_history',
    description: 'Get evolution history log for a workspace, showing when rules/skills were added.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace/project path' },
        limit: { type: 'number', description: 'Max entries to return (default 20)' }
      },
      required: ['workspace']
    },
    handler: async (args: any) => callWorkerAPI('/api/viewer/evo-log', args)
  },
  {
    name: 'approve_artifact',
    description: 'Approve a pending rule or skill for writing to IDE config files.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Artifact ID' },
        type: { type: 'string', enum: ['rule', 'skill'], description: 'Type of artifact' }
      },
      required: ['id', 'type']
    },
    handler: async (args: any) => callWorkerAPIPost('/api/self-evolve/review/approve', args)
  },
  {
    name: 'reject_artifact',
    description: 'Reject a pending rule or skill so it will not be written to IDE config files.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Artifact ID' },
        type: { type: 'string', enum: ['rule', 'skill'], description: 'Type of artifact' },
        reason: { type: 'string', description: 'Reason for rejection (optional)' }
      },
      required: ['id', 'type']
    },
    handler: async (args: any) => callWorkerAPIPost('/api/self-evolve/review/reject', args)
  },

  // ── Injector plugin tools ────────────────────────────────────────────────────

  {
    name: 'injector_list',
    description: 'List the Injector built-in content library (skills / rules / mcp / specs / bundles), grouped with versions. Pass workspace to annotate installed/update status.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Target workspace path (optional; enables installed/update badges)' }
      }
    },
    handler: async (args: any) => callWorkerAPI('/api/injector/catalog', args)
  },
  {
    name: 'injector_detect_ides',
    description: 'Detect which supported agent IDEs (Cursor / Claude Code / CodeBuddy / Codex) are installed on this machine.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args: any) => callWorkerAPI('/api/injector/detect', {})
  },
  {
    name: 'injector_status',
    description: 'List the injection ledger (what was injected, where, version) for a workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Target workspace path (optional)' }
      }
    },
    handler: async (args: any) => callWorkerAPI('/api/injector/ledger', args)
  },
  {
    name: 'injector_preview',
    description: 'Dry-run an injection: resolves dependency closure and returns the write plan (create/overwrite/merge/skip) without touching disk.',
    inputSchema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'string' }, description: 'Catalog ids to inject (bundles auto-expand)' },
        ides: { type: 'array', items: { type: 'string' }, description: 'Target IDE ids: cursor | claude-code | codebuddy | codex-cli' },
        workspace: { type: 'string', description: 'Target workspace path' }
      },
      required: ['items', 'workspace']
    },
    handler: async (args: any) => callWorkerAPIPost('/api/injector/preview', args)
  },
  {
    name: 'injector_inject',
    description: 'Execute an injection: resolves dependency closure, writes per IDE landing paths, and records the ledger for reversible uninstall.',
    inputSchema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'string' }, description: 'Catalog ids to inject (bundles auto-expand)' },
        ides: { type: 'array', items: { type: 'string' }, description: 'Target IDE ids: cursor | claude-code | codebuddy | codex-cli' },
        workspace: { type: 'string', description: 'Target workspace path' }
      },
      required: ['items', 'workspace']
    },
    handler: async (args: any) => callWorkerAPIPost('/api/injector/inject', args)
  },
  {
    name: 'injector_uninstall',
    description: 'Uninstall a single ledger entry, restoring from its recorded backup (managed-block removal / json key removal / file restore).',
    inputSchema: {
      type: 'object',
      properties: {
        ledgerId: { type: 'number', description: 'Ledger row id to uninstall' }
      },
      required: ['ledgerId']
    },
    handler: async (args: any) => callWorkerAPIPost('/api/injector/uninstall', args)
  }
];

// Create the MCP server
const server = new Server(
  {
    name: 'agent-memory-search',
    version: packageVersion,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tools/list handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  };
});

// Register tools/call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.find(t => t.name === request.params.name);

  if (!tool) {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  try {
    return await tool.handler(request.params.arguments || {});
  } catch (error) {
    logger.error('Tool execution failed', { tool: request.params.name, error: String(error) });
    return {
      content: [{
        type: 'text' as const,
        text: `Tool execution failed: ${error}`
      }],
      isError: true
    };
  }
});

// Cleanup function
async function cleanup() {
  logger.info('MCP server shutting down');
  process.exit(0);
}

// Register cleanup handlers
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('AgentMemory search server started');

  // Check Worker availability in background
  setTimeout(async () => {
    const workerAvailable = await verifyWorkerConnection();
    if (!workerAvailable) {
      logger.error('Worker not available', { workerUrl: WORKER_BASE_URL });
      logger.error('Start Worker with: npm run worker:start');
    } else {
      logger.info('Worker available', { workerUrl: WORKER_BASE_URL });
    }
  }, 0);
}

main().catch((error) => {
  logger.error('Fatal error', { error: String(error) });
  process.exit(0);
});
