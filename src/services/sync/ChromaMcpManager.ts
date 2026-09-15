/**
 * ChromaMcpManager — MCP stdio JSON-RPC client for chroma-mcp.
 *
 * Ported from claude-mem (AGPL-3.0). Unlike claude-mem, process spawning is
 * owned by ChromaProcessManager; this class only speaks line-delimited
 * JSON-RPC 2.0 over stdio streams that a caller supplies via connect().
 */

import { logger } from '../../utils/logger.js';

const MCP_PROTOCOL_VERSION = '2024-11-05';
const CLIENT_NAME = 'agent-memory-chroma';
const CLIENT_VERSION = '1.0.0';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface StdioStreams {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export interface ChromaQueryResult {
  ids: unknown[];
  distances: number[];
  metadatas: Array<Record<string, unknown>>;
  documents?: string[];
}

export class ChromaMcpManager {
  private stdin: NodeJS.WritableStream | null = null;
  private stdout: NodeJS.ReadableStream | null = null;
  private connected = false;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private stdoutBuffer = '';
  private dataHandler: ((chunk: Buffer | string) => void) | null = null;
  private stdoutEndHandler: (() => void) | null = null;
  private stdoutCloseHandler: (() => void) | null = null;
  private stdoutErrorHandler: ((err: Error) => void) | null = null;
  private stdinErrorHandler: ((err: Error) => void) | null = null;
  private requestTimeoutMs: number;

  constructor(opts: { requestTimeoutMs?: number } = {}) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(stdio: StdioStreams): Promise<void> {
    if (this.connected) return;

    this.stdin = stdio.stdin;
    this.stdout = stdio.stdout;
    this.stdoutBuffer = '';

    this.dataHandler = (chunk: Buffer | string) => {
      this.stdoutBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let nl: number;
      while ((nl = this.stdoutBuffer.indexOf('\n')) >= 0) {
        const line = this.stdoutBuffer.slice(0, nl).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
        if (!line) continue;
        this.handleLine(line);
      }
    };
    this.stdout.on('data', this.dataHandler);

    this.stdoutEndHandler = () => {
      this.teardown(new Error('chroma-mcp stdout ended'));
    };
    this.stdoutCloseHandler = () => {
      this.teardown(new Error('chroma-mcp stdout closed'));
    };
    this.stdoutErrorHandler = (err: Error) => {
      this.teardown(new Error(`chroma-mcp stdout error: ${err.message}`));
    };
    this.stdinErrorHandler = (err: Error) => {
      this.teardown(new Error(`chroma-mcp stdin error: ${err.message}`));
    };
    this.stdout.on('end', this.stdoutEndHandler);
    this.stdout.on('close', this.stdoutCloseHandler);
    this.stdout.on('error', this.stdoutErrorHandler);
    this.stdin.on('error', this.stdinErrorHandler);

    // MCP initialize handshake. The connection is considered alive once
    // initialize resolves; we then send initialized notification (no id).
    try {
      await this.sendRequest('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION }
      });
      this.sendNotification('notifications/initialized', {});
      this.connected = true;
      logger.info('CHROMA_MCP', 'MCP handshake complete');
    } catch (err) {
      this.teardown();
      throw err;
    }
  }

  async createCollection(name: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.callTool('chroma_create_collection', {
      collection_name: name,
      ...(metadata ? { metadata } : {})
    });
  }

  async addDocuments(
    collection: string,
    ids: string[],
    documents: string[],
    metadatas: Array<Record<string, unknown>>
  ): Promise<void> {
    await this.callTool('chroma_add_documents', {
      collection_name: collection,
      ids,
      documents,
      metadatas
    });
  }

  async query(collection: string, queryText: string, nResults: number): Promise<ChromaQueryResult> {
    const raw = await this.callTool('chroma_query_documents', {
      collection_name: collection,
      query_texts: [queryText],
      n_results: nResults
    });
    return normalizeQueryResult(raw);
  }

  async deleteDocuments(collection: string, ids: string[]): Promise<void> {
    await this.callTool('chroma_delete_documents', {
      collection_name: collection,
      ids
    });
  }

  async deleteCollection(name: string): Promise<void> {
    await this.callTool('chroma_delete_collection', { collection_name: name });
  }

  async close(): Promise<void> {
    if (!this.connected && !this.stdout && !this.stdin) return;
    this.teardown();
  }

  // -- internals ---------------------------------------------------------

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) {
      throw new Error('ChromaMcpManager not connected');
    }
    const result = (await this.sendRequest('tools/call', { name, arguments: args })) as ToolCallResult;
    if (result?.isError) {
      const text = result.content?.find(c => c.type === 'text')?.text ?? 'Unknown chroma-mcp error';
      throw new Error(`chroma-mcp tool "${name}" error: ${text}`);
    }
    const textItem = result?.content?.find(c => c.type === 'text' && c.text);
    if (!textItem?.text) return null;
    try {
      return JSON.parse(textItem.text);
    } catch {
      // Non-JSON success text (e.g. "Successfully created collection ..."): return null.
      return null;
    }
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.stdin) {
        reject(new Error('ChromaMcpManager not connected'));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`chroma-mcp request "${method}" timed out after ${this.requestTimeoutMs}ms`));
        }
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      try {
        this.stdin.write(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.stdin) return;
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    try {
      this.stdin.write(payload);
    } catch (err) {
      logger.warn('CHROMA_MCP', 'Failed to send notification', {
        method,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  private handleLine(line: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line) as JsonRpcResponse;
    } catch {
      logger.debug('CHROMA_MCP', 'Ignoring non-JSON line from chroma-mcp', { preview: line.slice(0, 120) });
      return;
    }
    if (typeof msg.id !== 'number') {
      // Notification or malformed — no pending request to resolve.
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(new Error(`chroma-mcp "${pending.method}" error: ${msg.error.message}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  private teardown(reason?: Error): void {
    if (this.stdout) {
      if (this.dataHandler) this.stdout.removeListener('data', this.dataHandler);
      if (this.stdoutEndHandler) this.stdout.removeListener('end', this.stdoutEndHandler);
      if (this.stdoutCloseHandler) this.stdout.removeListener('close', this.stdoutCloseHandler);
      if (this.stdoutErrorHandler) this.stdout.removeListener('error', this.stdoutErrorHandler);
    }
    if (this.stdin && this.stdinErrorHandler) {
      this.stdin.removeListener('error', this.stdinErrorHandler);
    }
    this.dataHandler = null;
    this.stdoutEndHandler = null;
    this.stdoutCloseHandler = null;
    this.stdoutErrorHandler = null;
    this.stdinErrorHandler = null;
    const rejectionMessage = reason
      ? `ChromaMcpManager transport error: ${reason.message}`
      : 'ChromaMcpManager closed before response';
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(rejectionMessage));
    }
    this.pending.clear();
    this.stdin = null;
    this.stdout = null;
    this.connected = false;
    this.stdoutBuffer = '';
  }
}

/**
 * Chroma's query_documents typically returns arrays-of-arrays (one per query
 * text). The test mock returns flat top-level arrays. Unwrap one level when
 * the outer array contains arrays; otherwise pass through.
 */
function normalizeQueryResult(raw: unknown): ChromaQueryResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const unwrap = <T>(v: unknown, fallback: T): T => {
    if (Array.isArray(v) && v.length > 0 && Array.isArray(v[0])) return v[0] as T;
    return (v ?? fallback) as T;
  };
  return {
    ids: unwrap(r.ids, [] as unknown[]),
    distances: unwrap(r.distances, [] as number[]),
    metadatas: unwrap(r.metadatas, [] as Array<Record<string, unknown>>),
    documents: r.documents !== undefined ? unwrap(r.documents, [] as string[]) : undefined
  };
}
