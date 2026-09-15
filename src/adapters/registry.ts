import { IDEAdapter } from './types.js';
import { CursorAdapter } from './cursor.js';
import { CodeBuddyAdapter } from './codebuddy.js';
import { CodeBuddyIDEAdapter } from './codebuddy-ide.js';
import { ClaudeCodeAdapter, ClaudeInternalAdapter } from './claude-code.js';
import { WindsurfAdapter } from './windsurf.js';
import { GeminiCliAdapter } from './gemini-cli.js';
import { OpenCodeAdapter } from './opencode.js';
import { CodexCliAdapter, isCodexHookInput } from './codex-cli.js';
import { logger } from '../utils/logger.js';

const adapters: IDEAdapter[] = [
  new ClaudeCodeAdapter(),
  new ClaudeInternalAdapter(),
  new CodeBuddyIDEAdapter(),
  new GeminiCliAdapter(),
  new OpenCodeAdapter(),
  new CursorAdapter(),
  new WindsurfAdapter(),
  new CodeBuddyAdapter(),
  new CodexCliAdapter(),
];

export function getAdapter(id: string): IDEAdapter | undefined {
  return adapters.find(a => a.id === id);
}

export function getAllAdapters(): IDEAdapter[] {
  return [...adapters];
}

export function detectAdapterByEvent(eventName: string, rawInput?: unknown): IDEAdapter | undefined {
  if (rawInput !== undefined && isCodexHookInput(rawInput)) {
    const codex = getAdapter('codex-cli');
    if (codex && codex.mapEventName(eventName) !== null) {
      logger.debug('AdapterRegistry', `Event "${eventName}" matched adapter "codex-cli" via Codex hook payload`);
      return codex;
    }
  }

  for (const adapter of adapters) {
    const mapped = adapter.mapEventName(eventName);
    if (mapped !== null) {
      logger.debug('AdapterRegistry', `Event "${eventName}" matched adapter "${adapter.id}" → "${mapped}"`);
      return adapter;
    }
  }
  logger.debug('AdapterRegistry', `No adapter matched event "${eventName}", will use raw event name`);
  return undefined;
}
