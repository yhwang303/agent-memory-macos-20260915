/**
 * stderr-only logger. MCP uses stdout for JSON-RPC; we MUST NOT pollute stdout.
 */
import { appendFileSync } from 'node:fs';

let logFilePath: string | undefined;

export function configureLogger(opts: { logFile?: string }): void {
  logFilePath = opts.logFile;
}

function fmt(level: string, msg: string, data?: unknown): string {
  const ts = new Date().toISOString();
  const tail = data === undefined ? '' : ' ' + safeJson(data);
  return `[${ts}] [${level}] ${msg}${tail}`;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function emit(line: string): void {
  // ALWAYS stderr; never stdout.
  process.stderr.write(line + '\n');
  if (logFilePath) {
    try {
      appendFileSync(logFilePath, line + '\n', 'utf8');
    } catch {
      // swallow — logging must never throw
    }
  }
}

export const logger = {
  debug(msg: string, data?: unknown) {
    if (process.env.DEBUG || process.env.AGENTMEM_HYBRID_DEBUG) {
      emit(fmt('DEBUG', msg, data));
    }
  },
  info(msg: string, data?: unknown) {
    emit(fmt('INFO', msg, data));
  },
  warn(msg: string, data?: unknown) {
    emit(fmt('WARN', msg, data));
  },
  error(msg: string, data?: unknown) {
    emit(fmt('ERROR', msg, data));
  },
};

/**
 * Hard-redirect any stray console.log to stderr to defend the MCP protocol channel.
 * Call this at process start.
 */
export function shieldStdout(): void {
  const originalLog = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    logger.warn('Intercepted console.log (would have polluted MCP stdout)', { args });
  };
  // Keep a reference so we can restore in tests if needed
  (globalThis as any).__originalConsoleLog = originalLog;
}
