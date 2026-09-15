/**
 * tools.ts — single-tool MCP surface.
 *
 * Exposes `load_recent_context`, which pulls recent AgentMemory session_summaries
 * for the current working directory's project and renders them as an
 * XML-tagged primer for resuming work in a fresh IDE/agent session.
 */
import type { AgentMemoryDb } from './agentMemoryDb.js';
import type { Defaults } from './config.js';
import { resolveProject } from './projectResolver.js';
import { assembleRecentMemory } from './recentMemory.js';
import { applyBudget } from './tokenBudget.js';
import { format } from './formatter.js';
import { logger } from './logger.js';

export interface ToolContext {
  agentMemoryDb?: AgentMemoryDb;
  packageVersion: string;
  defaults: Defaults;
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

function asText(text: string): McpTextResult {
  return { content: [{ type: 'text', text }] };
}

function asError(message: string): McpTextResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function clamp(v: number, lo: number, hi: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, Math.trunc(v)));
}

const LOAD_RECENT_CONTEXT: ToolDef = {
  name: 'load_recent_context',
  description:
    'PRIMARY tool for resuming / continuing work on a project in a fresh IDE session. ' +
    'TRIGGER PHRASES (zh + en): "继续做下去", "接着做", "继续这个项目", "看看近期工作", ' +
    '"近期/最近做了什么", "拉一下上下文", "load context", "resume project", ' +
    '"continue where I left off", "what did I do recently", "session primer". ' +
    'When the user wants to PICK UP previous work or get oriented at the start of a ' +
    'session, prefer THIS tool over hybrid memory tools (search / list_projects / ' +
    'list_sessions / get_summaries). Those are for ad-hoc semantic lookup; this one ' +
    'returns a curated context primer wrapping the last N rolling summaries (newest ' +
    'first, attached with originating session metadata + top observations) in ' +
    '<agentmemory_resume> XML tags, auto-detecting the project from cwd. Call ONCE at session ' +
    'start; do not call repeatedly.',
  inputSchema: {
    type: 'object',
    properties: {
      project: {
        type: 'string',
        description:
          "Optional AgentMemory project key (e.g. 'd:/agent-memory'). If omitted, the tool auto-detects " +
          "from the MCP server's process.cwd() and walks up to 5 parent directories looking for a " +
          'matching project in AgentMemory.',
      },
      n: {
        type: 'number',
        minimum: 1,
        maximum: 30,
        description:
          'Number of recent session_summaries to load. Default 10. Note that one AgentMemory session can ' +
          'have multiple rolling summaries, so N=10 may include multiple snapshots of the same ' +
          'session at different time points — that is intentional.',
      },
      max_tokens: {
        type: 'number',
        minimum: 500,
        maximum: 16000,
        description:
          'Soft cap on returned content (char-based estimate). Default 4000. The tool will ' +
          'progressively truncate fields if the natural output exceeds this budget and report which ' +
          'truncation levels fired in the `truncated` attribute.',
      },
      obs_per_summary: {
        type: 'number',
        minimum: 0,
        maximum: 10,
        description:
          'How many observations to attach per summary (newest-first, taken from the same session ' +
          'the summary belongs to). Default 3. Set to 0 for summary-body-only output.',
      },
      exclude_active: {
        type: 'boolean',
        description:
          'If true, drop any summary whose originating session has status="active" (typically the ' +
          'ongoing call this tool was invoked from). Default false.',
      },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    if (!ctx.agentMemoryDb) {
      return asError(
        'AgentMemory main DB is not available. Either ~/.agent-memory/agent-memory.db is missing ' +
          '(install / start AgentMemory at least once) or the AGENTMEM_RESUME_DB_PATH env var ' +
          'points at a non-existent file. The MCP cannot serve memory until this is fixed.'
      );
    }

    const explicitProject =
      typeof args.project === 'string' && args.project.trim().length > 0
        ? (args.project as string)
        : undefined;
    const n = clamp(Number(args.n), 1, 30, ctx.defaults.n);
    const maxTokens = clamp(Number(args.max_tokens), 500, 16000, ctx.defaults.maxTokens);
    const obsPerSummary = clamp(Number(args.obs_per_summary), 0, 10, ctx.defaults.obsPerSummary);
    const excludeActive = args.exclude_active === true;

    const resolve = resolveProject(ctx.agentMemoryDb, { explicitProject });
    if (!resolve.ok) {
      return asError(
        `Could not resolve a AgentMemory project for cwd "${resolve.attemptedCwd}". The current working ` +
          'directory does not match any project recorded in AgentMemory, and no parent (up to 5 levels) does ' +
          'either.\n\nKnown AgentMemory projects:\n' +
          (resolve.knownProjects.length > 0 ? resolve.knownProjects.map((p) => `  - ${p}`).join('\n') : '  (none)') +
          '\n\nPass an explicit `project` argument to override, e.g. `{"project": "d:/agent-memory"}`.'
      );
    }

    logger.info('load_recent_context', {
      project: resolve.key,
      source: resolve.source,
      n,
      maxTokens,
      obsPerSummary,
      excludeActive,
    });

    let summaries;
    try {
      summaries = assembleRecentMemory(ctx.agentMemoryDb, {
        project: resolve.key,
        n,
        obsPerSummary,
        excludeActive,
      });
    } catch (e) {
      logger.error('assembleRecentMemory failed', { error: String(e) });
      return asError(`Failed to read AgentMemory memory: ${String(e)}`);
    }

    const budget = applyBudget(summaries, maxTokens);
    const text = format({
      resolve,
      summaries: budget.summaries,
      tokensEst: budget.tokensEst,
      truncated: budget.truncated,
    });

    return asText(text);
  },
};

export const TOOLS: ToolDef[] = [LOAD_RECENT_CONTEXT];
