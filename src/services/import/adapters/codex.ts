/**
 * Codex App / CLI adapter.
 *
 * The official Codex desktop app persists sessions under:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<sessionId>.jsonl
 *
 * The JSONL stream is a rollout log. Conversational messages are stored as
 * `{ type:"response_item", payload:{ type:"message", role, content } }`.
 * Tool calls are response items too: `{ payload:{ type:"function_call", ... } }`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { logger } from '../../../utils/logger.js';
import {
  computeFingerprint,
  MAX_ASSISTANT_TEXT,
  MAX_USER_TEXT,
  summarizeToolInput,
  truncate,
} from '../turn-utils.js';
import type {
  AdapterDiscoveryResult,
  ImportAdapter,
  TranscriptFile,
  Turn,
} from '../types.js';

type ToolUse = { name: string; inputSummary: string };

interface PendingTurn {
  turnIndex: number;
  userText: string;
  assistantTextParts: string[];
  toolUses: ToolUse[];
  startedAt: number;
  cwd: string | null;
  sessionId: string | null;
}

interface CodexMeta {
  sessionId: string | null;
  cwd: string | null;
  timestampMs: number;
}

const RECENT_INCOMPLETE_IMPORT_GRACE_MS = 30 * 60 * 1000;

export class CodexImportAdapter implements ImportAdapter {
  readonly id = 'codex-cli' as const;
  readonly displayName = 'Codex App / CLI';

  roots(): string[] {
    return [join(homedir(), '.codex', 'sessions')];
  }

  async discoverSessions(): Promise<AdapterDiscoveryResult> {
    const probedRoots = this.roots().map((p) => ({
      path: p,
      exists: existsSync(p),
    }));

    const files: TranscriptFile[] = [];
    for (const { path: root, exists } of probedRoots) {
      if (!exists) continue;
      try {
        files.push(...this.scanRoot(root));
      } catch (err) {
        logger.warn('IMPORT', `codex-cli adapter: failed scanning ${root}`, {
          error: String(err),
        });
      }
    }

    logger.info('IMPORT', 'codex-cli adapter discovery', {
      probedRoots,
      filesFound: files.length,
    });

    return { adapterId: this.id, probedRoots, files };
  }

  private scanRoot(root: string): TranscriptFile[] {
    const out: TranscriptFile[] = [];
    const stack = [root];

    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;

        let mtimeMs = 0;
        try {
          mtimeMs = statSync(fullPath).mtimeMs;
        } catch {
          continue;
        }

        const meta = this.readSessionMeta(fullPath);
        const fallbackId = basename(fullPath).replace(/\.jsonl$/i, '');
        out.push({
          adapterId: this.id,
          filePath: fullPath,
          sessionId: meta.sessionId ?? fallbackId,
          cwd: meta.cwd,
          mtimeMs,
          extra: { scanRoot: root, sessionStartedAt: meta.timestampMs || undefined },
        });
      }
    }

    return out;
  }

  private readSessionMeta(filePath: string): CodexMeta {
    let raw = '';
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch {
      return { sessionId: null, cwd: null, timestampMs: 0 };
    }
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: any;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (obj?.type !== 'session_meta') continue;
      const payload = obj.payload;
      const sessionId = typeof payload?.id === 'string' ? payload.id : null;
      const cwd = typeof payload?.cwd === 'string' ? payload.cwd : null;
      const timestampMs = parseTimestamp(payload?.timestamp ?? obj.timestamp);
      return { sessionId, cwd, timestampMs };
    }

    return { sessionId: null, cwd: null, timestampMs: 0 };
  }

  // eslint-disable-next-line require-yield
  async *iterateTurns(file: TranscriptFile): AsyncIterable<Turn> {
    const finalizeIncompleteLastTurn =
      file.mtimeMs <= 0 || Date.now() - file.mtimeMs > RECENT_INCOMPLETE_IMPORT_GRACE_MS;
    for (const turn of streamCodexTurns(file.filePath, file.cwd, file.sessionId, {
      finalizeIncompleteLastTurn,
    })) {
      yield turn;
    }
  }
}

export function* streamCodexTurns(
  filePath: string,
  defaultCwd: string | null,
  defaultSessionId: string | null,
  opts: { finalizeIncompleteLastTurn?: boolean } = {},
): Generator<Turn> {
  let raw = '';
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    logger.warn('IMPORT', `streamCodexTurns: cannot read ${filePath}`, {
      error: String(err),
    });
    return;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  let pending: PendingTurn | null = null;
  let nextTurnIndex = 0;
  let cwd = defaultCwd;
  let sessionId = defaultSessionId;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (obj?.type === 'session_meta' || obj?.type === 'turn_context') {
      if (typeof obj.payload?.cwd === 'string') cwd = obj.payload.cwd;
      if (typeof obj.cwd === 'string') cwd = obj.cwd;
      if (typeof obj.payload?.id === 'string') sessionId = obj.payload.id;
      continue;
    }

    if (obj?.type === 'event_msg' && obj.payload?.type === 'task_complete') {
      if (pending && pending.assistantTextParts.length > 0) {
        const t = finalizeCodexTurn(filePath, pending);
        if (t) yield t;
        pending = null;
      }
      continue;
    }

    if (obj?.type !== 'response_item' || !obj.payload || typeof obj.payload !== 'object') {
      continue;
    }

    const payload = obj.payload as Record<string, unknown>;
    const ts = parseTimestamp(obj.timestamp);

    if (payload.type === 'message') {
      const role = payload.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const text = flattenCodexContent(payload.content);
      if (role === 'user') {
        if (!text.trim()) continue;
        if (pending && pending.assistantTextParts.length > 0) {
          const t = finalizeCodexTurn(filePath, pending);
          if (t) yield t;
        }
        pending = {
          turnIndex: nextTurnIndex++,
          userText: truncate(text, MAX_USER_TEXT),
          assistantTextParts: [],
          toolUses: [],
          startedAt: ts || 0,
          cwd,
          sessionId,
        };
        continue;
      }

      if (!pending) continue;
      if (text.trim()) pending.assistantTextParts.push(text);
      continue;
    }

    if (payload.type === 'function_call' && pending) {
      const name = typeof payload.name === 'string' ? payload.name : '';
      pending.toolUses.push({
        name,
        inputSummary: summarizeToolInput(parseCodexArguments(payload.arguments)),
      });
    }
  }

  if (pending && pending.assistantTextParts.length > 0 && opts.finalizeIncompleteLastTurn !== false) {
    const t = finalizeCodexTurn(filePath, pending);
    if (t) yield t;
  }
}

function flattenCodexContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    switch (b.type) {
      case 'input_text':
      case 'output_text':
      case 'text':
        if (typeof b.text === 'string') parts.push(b.text);
        break;
      default:
        break;
    }
  }
  return parts.join('\n');
}

function parseCodexArguments(args: unknown): unknown {
  if (typeof args !== 'string') return args ?? {};
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

function parseTimestamp(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return 0;
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}

function finalizeCodexTurn(filePath: string, p: PendingTurn): Turn | null {
  const assistantText = truncate(
    p.assistantTextParts.join('\n\n'),
    MAX_ASSISTANT_TEXT,
  );
  return {
    adapterId: 'codex-cli',
    fingerprint: computeFingerprint('codex-cli', filePath, p.turnIndex, p.userText),
    filePath,
    sessionId: p.sessionId,
    turnIndex: p.turnIndex,
    userText: p.userText,
    assistantText,
    toolUses: p.toolUses,
    cwd: p.cwd,
    startedAt: p.startedAt,
  };
}
