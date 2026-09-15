import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { logger } from '../utils/logger.js';

export interface AssistantMessage {
  text: string;
  hasImages: boolean;
  imageRefs: string[];
  toolUses: Array<{ name: string; input: unknown }>;
  timestamp?: number;
}

export interface UserMessage {
  text: string;
  /**
   * True when the user's content contained any image signal — structured
   * image blocks OR plain-text [Image]/<image_files> markers (Cursor).
   * This is more reliable than checking attachments because text-literal
   * markers without resolvable absolute paths still set hasImages=true.
   */
  hasImages: boolean;
  attachments: Array<{ type: string; ref?: string }>;
}

export interface ImageTurnAssistantMessage {
  user: UserMessage;
  assistant: AssistantMessage;
}

interface ReadOpts {
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MiB

function tailBytes(path: string, maxBytes: number): { text: string; startedAtZero: boolean } {
  const stat = statSync(path);
  const size = stat.size;
  if (size === 0) return { text: '', startedAtZero: true };
  const readLen = Math.min(size, maxBytes);
  const start = size - readLen;
  const startedAtZero = start === 0;
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(readLen);
    readSync(fd, buf, 0, readLen, start);
    let text = buf.toString('utf8');
    if (startedAtZero && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { text, startedAtZero };
  } finally {
    closeSync(fd);
  }
}

function* linesReversed(tail: string, startedAtZero: boolean): Generator<string> {
  const parts = tail.split('\n');
  const end = startedAtZero ? 0 : 1; // skip potentially-truncated first slice
  for (let i = parts.length - 1; i >= end; i--) {
    const line = parts[i].trim();
    if (line) yield line;
  }
}

function* linesForward(tail: string, startedAtZero: boolean): Generator<string> {
  const parts = tail.split('\n');
  const start = startedAtZero ? 0 : 1; // skip potentially-truncated first slice
  for (let i = start; i < parts.length; i++) {
    const line = parts[i].trim();
    if (line) yield line;
  }
}

function safeJsonParse(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Codex Desktop rollout JSONL: { type: "response_item", payload: { role, content } }. */
function parseCodexRolloutLine(obj: any): { role: string; content: unknown } | null {
  if (!obj || obj.type !== 'response_item' || !obj.payload || typeof obj.payload !== 'object') {
    return null;
  }
  const p = obj.payload as Record<string, unknown>;
  if (p.type !== 'message' || typeof p.role !== 'string') return null;
  return { role: p.role, content: p.content };
}

export const IMAGE_MARKER_RE = /\[Image(?:\s*#?\d*)?\]|<image_files>/i;
const IMAGE_PATH_RE = /(?:[A-Za-z]:[\\/]|[\\/])[^\s"'<>|*?]+?\.(?:png|jpe?g|gif|webp|bmp|svg)/gi;

/**
 * Annotate image markers that are only expressed as plain text (not structured
 * blocks). Cursor transcripts put user-pasted images here. Mutates `out` to set
 * hasImages=true and push deduped file paths into imageRefs/attachments.
 */
function annotateTextLiteralImageMarkers(
  text: string,
  out: { hasImages: boolean; imageRefs: string[]; attachments: Array<{ type: string; ref?: string }> }
): void {
  if (!text || !IMAGE_MARKER_RE.test(text)) return;
  out.hasImages = true;
  const seen = new Set(out.imageRefs);
  const matches = text.match(IMAGE_PATH_RE);
  if (matches) {
    for (const raw of matches) {
      const ref = raw.replace(/[,;).\]]+$/, '');
      if (seen.has(ref)) continue;
      seen.add(ref);
      out.imageRefs.push(ref);
      out.attachments.push({ type: 'image', ref });
    }
  }
}

function classifyContent(content: unknown): {
  text: string;
  hasImages: boolean;
  imageRefs: string[];
  toolUses: Array<{ name: string; input: unknown }>;
  attachments: Array<{ type: string; ref?: string }>;
} {
  const out = {
    text: '',
    hasImages: false,
    imageRefs: [] as string[],
    toolUses: [] as Array<{ name: string; input: unknown }>,
    attachments: [] as Array<{ type: string; ref?: string }>,
  };
  if (typeof content === 'string') {
    out.text = content;
    annotateTextLiteralImageMarkers(content, out);
    return out;
  }
  if (!Array.isArray(content)) return out;
  const textParts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as any;
    switch (b.type) {
      case 'text':
      case 'input_text':
      case 'output_text':
        if (typeof b.text === 'string') {
          textParts.push(b.text);
          // Cursor represents pasted images as text-literal markers inside a
          // type:"text" block (no structured image block). Detect "[Image]" /
          // "<image_files>...</image_files>" and extract file paths so hasImages
          // and imageRefs behave the same as for real image blocks.
          // See reports/2026-04-22-cursor-media-context-analysis.md §8.2.
          annotateTextLiteralImageMarkers(b.text, out);
        }
        break;
      case 'image':
      case 'image_url': {
        out.hasImages = true;
        let ref = 'inline';
        if (b.type === 'image_url' && typeof b.image_url?.url === 'string') {
          ref = b.image_url.url;
        } else if (b.source?.type === 'base64') {
          ref = `base64:${b.source.media_type || 'unknown'}`;
        } else if (b.source?.type === 'url' && typeof b.source.url === 'string') {
          ref = b.source.url;
        }
        out.imageRefs.push(ref);
        out.attachments.push({ type: 'image', ref });
        break;
      }
      case 'tool_use':
        out.toolUses.push({ name: String(b.name || ''), input: b.input ?? {} });
        break;
      default:
        break;
    }
  }
  out.text = textParts.join('\n');
  return out;
}

function readLastByRole(
  transcriptPath: string,
  role: 'assistant' | 'user',
  opts?: ReadOpts
): AssistantMessage | UserMessage | null {
  if (!transcriptPath) return null;
  if (!existsSync(transcriptPath)) return null;

  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  let tail: string;
  let startedAtZero: boolean;
  try {
    const result = tailBytes(transcriptPath, maxBytes);
    tail = result.text;
    startedAtZero = result.startedAtZero;
  } catch {
    return null;
  }
  if (!tail) return null;

  for (const line of linesReversed(tail, startedAtZero)) {
    const obj = safeJsonParse(line);
    const codex = parseCodexRolloutLine(obj);
    const lineRole = codex?.role ?? obj?.type ?? obj?.role;
    // Support Claude ({type:"assistant"}), Cursor ({role:"assistant"}), Codex rollout JSONL.
    if (!lineRole || lineRole !== role) continue;
    const content = codex?.content ?? obj.message?.content ?? obj.content;
    if (content == null) continue;
    const parts = classifyContent(content);
    const ts = typeof obj.timestamp === 'number' ? obj.timestamp : undefined;

    if (role === 'assistant') {
      return {
        text: parts.text,
        hasImages: parts.hasImages,
        imageRefs: parts.imageRefs,
        toolUses: parts.toolUses,
        timestamp: ts,
      } satisfies AssistantMessage;
    } else {
      return {
        text: parts.text,
        hasImages: parts.hasImages,
        attachments: parts.attachments,
      } satisfies UserMessage;
    }
  }
  return null;
}

export function readLastAssistantMessage(
  transcriptPath: string,
  opts?: ReadOpts
): AssistantMessage | null {
  return readLastByRole(transcriptPath, 'assistant', opts) as AssistantMessage | null;
}

export function readLastUserMessage(
  transcriptPath: string,
  opts?: ReadOpts
): UserMessage | null {
  return readLastByRole(transcriptPath, 'user', opts) as UserMessage | null;
}

function userMessageHasImage(user: UserMessage): boolean {
  return user.hasImages || user.attachments.some(a => a?.type === 'image');
}

export function readLastImageTurnAssistantMessage(
  transcriptPath: string,
  opts?: ReadOpts
): ImageTurnAssistantMessage | null {
  if (!transcriptPath) return null;
  if (!existsSync(transcriptPath)) return null;

  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  let tail: string;
  let startedAtZero: boolean;
  try {
    const result = tailBytes(transcriptPath, maxBytes);
    tail = result.text;
    startedAtZero = result.startedAtZero;
  } catch {
    return null;
  }
  if (!tail) return null;

  let activeUser: UserMessage | null = null;
  let assistantTextParts: string[] = [];
  let assistantImageRefs: string[] = [];
  let assistantToolUses: Array<{ name: string; input: unknown }> = [];
  let assistantHasImages = false;
  let assistantTimestamp: number | undefined;
  let latest: ImageTurnAssistantMessage | null = null;

  for (const line of linesForward(tail, startedAtZero)) {
    const obj = safeJsonParse(line);
    const codex = parseCodexRolloutLine(obj);
    const role = codex?.role ?? obj?.type ?? obj?.role;
    if (role !== 'user' && role !== 'assistant') continue;

    const content = codex?.content ?? obj.message?.content ?? obj.content;
    if (content == null) continue;
    const parts = classifyContent(content);
    const ts = typeof obj.timestamp === 'number' ? obj.timestamp : undefined;

    if (role === 'user') {
      const user = {
        text: parts.text,
        hasImages: parts.hasImages,
        attachments: parts.attachments,
      } satisfies UserMessage;

      if (userMessageHasImage(user)) {
        activeUser = user;
        assistantTextParts = [];
        assistantImageRefs = [];
        assistantToolUses = [];
        assistantHasImages = false;
        assistantTimestamp = undefined;
        latest = null;
      } else {
        activeUser = null;
      }
      continue;
    }

    if (!activeUser) continue;

    if (parts.text.trim()) {
      assistantTextParts.push(parts.text);
    }
    assistantHasImages ||= parts.hasImages;
    assistantImageRefs.push(...parts.imageRefs);
    assistantToolUses.push(...parts.toolUses);
    if (ts !== undefined) assistantTimestamp = ts;

    if (assistantTextParts.length > 0) {
      latest = {
        user: activeUser,
        assistant: {
          text: assistantTextParts.join('\n\n'),
          hasImages: assistantHasImages,
          imageRefs: [...new Set(assistantImageRefs)],
          toolUses: assistantToolUses,
          timestamp: assistantTimestamp,
        },
      };
    }
  }

  return latest;
}

export function safeReadLastAssistantMessage(
  transcriptPath: string | undefined,
  opts?: ReadOpts
): AssistantMessage | null {
  if (!transcriptPath) return null;
  try {
    return readLastAssistantMessage(transcriptPath, opts);
  } catch (err) {
    try { logger?.debug?.('TRANSCRIPT', `safeReadLastAssistantMessage failed: ${String(err)}`); } catch {}
    return null;
  }
}

export function safeReadLastUserMessage(
  transcriptPath: string | undefined,
  opts?: ReadOpts
): UserMessage | null {
  if (!transcriptPath) return null;
  try {
    return readLastUserMessage(transcriptPath, opts);
  } catch (err) {
    try { logger?.debug?.('TRANSCRIPT', `safeReadLastUserMessage failed: ${String(err)}`); } catch {}
    return null;
  }
}

export function safeReadLastImageTurnAssistantMessage(
  transcriptPath: string | undefined,
  opts?: ReadOpts
): ImageTurnAssistantMessage | null {
  if (!transcriptPath) return null;
  try {
    return readLastImageTurnAssistantMessage(transcriptPath, opts);
  } catch (err) {
    try { logger?.debug?.('TRANSCRIPT', `safeReadLastImageTurnAssistantMessage failed: ${String(err)}`); } catch {}
    return null;
  }
}
