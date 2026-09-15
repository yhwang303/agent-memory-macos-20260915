/**
 * CodeBuddy IDE transcript parser.
 *
 * CodeBuddy IDE does NOT use a Claude-style `.jsonl` transcript. Its Stop /
 * UserPromptSubmit `transcript_path` points to a per-conversation `index.json`:
 *
 *   <conversationId>/
 *     index.json            { "messages": [ { id, type, role, isComplete }, ... ] }
 *     messages/
 *       <messageId>.json    { role, message: "<stringified {role,content:[{type,text}]}>", id, extra }
 *
 * The `index.json` only lists the ordered role sequence; the actual text lives
 * in the sibling `messages/<id>.json` files. This module reads the last
 * user / assistant message text so the memory pipeline can record an
 * agent_response observation, mirroring the Claude jsonl parser's output shape.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AssistantMessage, UserMessage } from './transcript-parser.js';
import { logger } from '../utils/logger.js';

interface IndexEntry {
  id?: string;
  role?: string;
  type?: string;
  isComplete?: boolean;
}

function safeReadJson(path: string): any | null {
  try {
    if (!existsSync(path)) return null;
    let raw = readFileSync(path, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Extract joined text from a CodeBuddy `messages/<id>.json` file. */
function readMessageText(messagesDir: string, id: string): string {
  const file = join(messagesDir, `${id}.json`);
  const obj = safeReadJson(file);
  if (!obj) return '';

  // `message` is usually a stringified { role, content: [...] }; sometimes already an object.
  let inner: any = obj.message;
  if (typeof inner === 'string') {
    try {
      inner = JSON.parse(inner);
    } catch {
      // `message` was plain text, not JSON
      return inner.trim();
    }
  }
  const content = inner?.content ?? obj.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

/**
 * Walk the index.json `messages` array from the end and return the joined text
 * of the last entry with the given role that has non-empty content.
 */
function readLastTextByRole(indexJsonPath: string, role: 'assistant' | 'user'): string | null {
  if (!indexJsonPath) return null;
  const index = safeReadJson(indexJsonPath);
  const messages: IndexEntry[] = Array.isArray(index?.messages) ? index.messages : [];
  if (messages.length === 0) return null;

  const messagesDir = join(dirname(indexJsonPath), 'messages');
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i];
    if (entry?.role !== role || !entry.id) continue;
    const text = readMessageText(messagesDir, entry.id);
    if (text) return text;
  }
  return null;
}

/** Looks like a CodeBuddy IDE transcript path (per-conversation index.json with messages/). */
export function isCodeBuddyTranscript(transcriptPath: string | undefined): boolean {
  if (!transcriptPath) return false;
  if (!/index\.json$/i.test(transcriptPath)) return false;
  const index = safeReadJson(transcriptPath);
  return Array.isArray(index?.messages);
}

export function readCodeBuddyLastAssistantMessage(
  transcriptPath: string | undefined
): AssistantMessage | null {
  if (!transcriptPath) return null;
  try {
    const text = readLastTextByRole(transcriptPath, 'assistant');
    if (!text) return null;
    return { text, hasImages: false, imageRefs: [], toolUses: [] };
  } catch (err) {
    try { logger?.debug?.('TRANSCRIPT', `readCodeBuddyLastAssistantMessage failed: ${String(err)}`); } catch {}
    return null;
  }
}

export function readCodeBuddyLastUserMessage(
  transcriptPath: string | undefined
): UserMessage | null {
  if (!transcriptPath) return null;
  try {
    const text = readLastTextByRole(transcriptPath, 'user');
    if (text == null) return null;
    return { text, hasImages: false, attachments: [] };
  } catch (err) {
    try { logger?.debug?.('TRANSCRIPT', `readCodeBuddyLastUserMessage failed: ${String(err)}`); } catch {}
    return null;
  }
}

/** One raw turn pulled from a CodeBuddy IDE conversation, used by the import pipeline. */
export interface CodeBuddyRawTurn {
  /** 0-based index of this turn within the conversation. */
  turnIndex: number;
  userText: string;
  assistantText: string;
  /** Texts of (role:"tool") rows that occurred between this user→assistant pair. */
  toolMessageTexts: string[];
}

/**
 * Forward-iterate a CodeBuddy IDE conversation `index.json`, pairing
 * (user, assistant) entries into turns and collecting (role:"tool") rows
 * in between as toolMessageTexts.
 *
 * Used by the retroactive history import feature (src/services/import).
 * Online hooks should keep using readCodeBuddyLastAssistantMessage above —
 * this iterator is for batch backfill only.
 *
 * Pairing rule: when we encounter a user row, finalize the previous turn
 * (if it captured an assistant) and open a new turn. Assistant text lands
 * on the current turn. Tool rows in between go to toolMessageTexts. Empty
 * roles or unknown rows are skipped.
 */
export function* iterateCodeBuddyTurns(
  indexJsonPath: string,
): Generator<CodeBuddyRawTurn> {
  if (!indexJsonPath) return;
  const index = safeReadJson(indexJsonPath);
  const messages: IndexEntry[] = Array.isArray(index?.messages) ? index.messages : [];
  if (messages.length === 0) return;

  const messagesDir = join(dirname(indexJsonPath), 'messages');

  let pendingUserText = '';
  let pendingAssistantParts: string[] = [];
  let pendingToolTexts: string[] = [];
  let pendingTurnIndex = -1;
  let nextTurnIndex = 0;
  let opened = false;

  const finalize = function* (): Generator<CodeBuddyRawTurn> {
    if (!opened) return;
    if (pendingAssistantParts.length === 0) return;
    yield {
      turnIndex: pendingTurnIndex,
      userText: pendingUserText,
      assistantText: pendingAssistantParts.join('\n\n').trim(),
      toolMessageTexts: pendingToolTexts.slice(),
    };
  };

  for (const entry of messages) {
    const role = entry?.role;
    if (!entry?.id) continue;

    if (role === 'user') {
      yield* finalize();
      pendingUserText = readMessageText(messagesDir, entry.id);
      pendingAssistantParts = [];
      pendingToolTexts = [];
      pendingTurnIndex = nextTurnIndex++;
      opened = true;
    } else if (role === 'assistant' && opened) {
      const text = readMessageText(messagesDir, entry.id);
      if (text) pendingAssistantParts.push(text);
    } else if (role === 'tool' && opened) {
      const text = readMessageText(messagesDir, entry.id);
      if (text) pendingToolTexts.push(text);
    }
    // Unknown roles silently dropped.
  }

  yield* finalize();
}
