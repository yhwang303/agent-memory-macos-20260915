/**
 * Runtime configuration for agentmem-resume-mcp.
 *
 * Resolution order: env > defaults.
 *
 * env vars (all optional):
 *   AGENTMEM_RESUME_DB_PATH        — absolute path to AgentMemory main DB (defaults to ~/.agent-memory/agent-memory.db)
 *   AGENTMEM_RESUME_LOG_FILE       — if set, also append logs to this file (in addition to stderr)
 *   AGENTMEM_RESUME_DEBUG / DEBUG  — if truthy, enable debug logging
 *   AGENTMEM_RESUME_DEFAULT_N            — default value for the `n` arg (otherwise 10)
 *   AGENTMEM_RESUME_DEFAULT_MAX_TOKENS   — default value for the `max_tokens` arg (otherwise 4000)
 *   AGENTMEM_RESUME_DEFAULT_OBS_PER_SUM  — default value for the `obs_per_summary` arg (otherwise 3)
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Defaults {
  /** Number of recent summaries to load (clamped 1..30). */
  n: number;
  /** Soft cap on returned content, char-based estimate (clamped 500..16000). */
  maxTokens: number;
  /** How many observations attached per summary (clamped 0..10). */
  obsPerSummary: number;
}

export interface Config {
  /** Absolute path to AgentMemory main DB. */
  agentMemoryDbPath: string;
  /** Optional log file (in addition to stderr). */
  logFile?: string;
  /** Reported via index_status / handshake. */
  packageVersion: string;
  /** Defaults applied when the tool is called without overrides. */
  defaults: Defaults;
}

export const PACKAGE_VERSION = '0.2.0';

function defaultAgentMemoryDbPath(): string {
  return join(homedir(), '.agent-memory', 'agent-memory.db');
}

function clamp(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

function intFromEnv(name: string, fallback: number, lo: number, hi: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
}

export function loadConfig(): Config {
  return {
    agentMemoryDbPath: process.env.AGENTMEM_RESUME_DB_PATH || defaultAgentMemoryDbPath(),
    logFile: process.env.AGENTMEM_RESUME_LOG_FILE,
    packageVersion: PACKAGE_VERSION,
    defaults: {
      n: intFromEnv('AGENTMEM_RESUME_DEFAULT_N', 10, 1, 30),
      maxTokens: intFromEnv('AGENTMEM_RESUME_DEFAULT_MAX_TOKENS', 4000, 500, 16000),
      obsPerSummary: intFromEnv(
        'AGENTMEM_RESUME_DEFAULT_OBS_PER_SUM',
        intFromEnv('AGENTMEM_RESUME_DEFAULT_OBS_PER_SES', 3, 0, 10), // backwards-compat with v0.1.0
        0,
        10
      ),
    },
  };
}
