import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ClaudeAdapter } from '../src/services/import/adapters/claude.js';
import { CodexImportAdapter } from '../src/services/import/adapters/codex.js';
import { CursorAgentAdapter } from '../src/services/import/adapters/cursor-agent.js';
import { CodeBuddyIdeAdapter } from '../src/services/import/adapters/codebuddy-ide.js';
import { computeFingerprint } from '../src/services/import/turn-utils.js';
import type { Turn } from '../src/services/import/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures', 'import');

async function collect(iter: AsyncIterable<Turn>): Promise<Turn[]> {
  const out: Turn[] = [];
  for await (const t of iter) out.push(t);
  return out;
}

test('claude adapter: skips noise lines and groups two turns with tool_use', async () => {
  const a = new ClaudeAdapter();
  const file = {
    adapterId: 'claude' as const,
    filePath: join(FIXTURES, 'claude', 'sample.jsonl'),
    sessionId: 'sess-1',
    cwd: 'D:/agent-memory',
    mtimeMs: 0,
  };
  const turns = await collect(a.iterateTurns(file));

  assert.equal(turns.length, 2, 'two user→assistant turns expected');
  assert.equal(turns[0].turnIndex, 0);
  assert.equal(turns[0].userText, 'hello, can you list files');
  // Two assistant lines should be joined
  assert.match(turns[0].assistantText, /sure, listing now/);
  assert.match(turns[0].assistantText, /done — found 3 files/);
  assert.equal(turns[0].toolUses.length, 1);
  assert.equal(turns[0].toolUses[0].name, 'Bash');
  assert.match(turns[0].toolUses[0].inputSummary, /ls/);
  // sessionId / cwd from line metadata
  assert.equal(turns[0].sessionId, 'sess-1');
  assert.equal(turns[0].cwd, 'D:\\agent-memory');
  // Timestamp parsed
  assert.ok(turns[0].startedAt > 0);

  assert.equal(turns[1].turnIndex, 1);
  assert.equal(turns[1].userText, 'ok thanks');
  assert.match(turns[1].assistantText, /you're welcome/);
});

test('claude adapter: fingerprint is stable across runs', async () => {
  const a = new ClaudeAdapter();
  const file = {
    adapterId: 'claude' as const,
    filePath: join(FIXTURES, 'claude', 'sample.jsonl'),
    sessionId: 'sess-1',
    cwd: 'D:/agent-memory',
    mtimeMs: 0,
  };
  const a1 = await collect(a.iterateTurns(file));
  const a2 = await collect(a.iterateTurns(file));
  assert.equal(a1[0].fingerprint, a2[0].fingerprint);
  assert.notEqual(a1[0].fingerprint, a1[1].fingerprint, 'turns must hash differently');
  // Confirm fingerprint = computeFingerprint() (no surprise inputs)
  const expected = computeFingerprint('claude', file.filePath, 0, 'hello, can you list files');
  assert.equal(a1[0].fingerprint, expected);
});

test('cursor-agent adapter: groups role-keyed lines and extracts tool_use', async () => {
  const a = new CursorAgentAdapter();
  const file = {
    adapterId: 'cursor-agent' as const,
    filePath: join(FIXTURES, 'cursor-agent', 'sample.jsonl'),
    sessionId: 'cur-1',
    cwd: 'D:/proj',
    mtimeMs: 0,
  };
  const turns = await collect(a.iterateTurns(file));

  assert.equal(turns.length, 2);
  assert.equal(turns[0].userText, 'can you read foo.ts?');
  assert.match(turns[0].assistantText, /reading now/);
  assert.match(turns[0].assistantText, /two functions/);
  assert.equal(turns[0].toolUses.length, 1);
  assert.equal(turns[0].toolUses[0].name, 'Read');
  // Cursor lines have no cwd, so adapter default should pass through
  assert.equal(turns[0].cwd, 'D:/proj');

  assert.equal(turns[1].userText, 'refactor it please');
  assert.match(turns[1].assistantText, /refactor done/);
});

test('cursor-agent adapter: decodeCwd parses workspace dir correctly', () => {
  const a = new CursorAgentAdapter();
  // Access private via any cast — small surface, tests guard against regression
  const decode = (a as any).decodeCwd.bind(a) as (s: string) => string | null;
  assert.equal(decode('d-ai-ide-langfuse'), 'D:/ai-ide-langfuse');
  assert.equal(decode('1776685781572'), null, 'numeric workspaces are unmappable');
  assert.equal(decode(''), null);
  assert.equal(decode('XX-foo'), null, 'non-letter drive returns null');
});

test('codebuddy-ide adapter: pairs (user,assistant) and gathers tool rows between', async () => {
  const a = new CodeBuddyIdeAdapter();
  const file = {
    adapterId: 'codebuddy-ide' as const,
    filePath: join(FIXTURES, 'codebuddy-ide', 'conv-1', 'index.json'),
    sessionId: 'conv-1',
    cwd: null,
    mtimeMs: 1_700_000_000_000,
  };
  const turns = await collect(a.iterateTurns(file));

  assert.equal(turns.length, 2, 'two paired turns expected');

  // turn 0: u1 → [a1, t1, a2]
  assert.equal(turns[0].userText, 'how do I configure the linter?');
  assert.match(turns[0].assistantText, /enable strict mode/);
  assert.match(turns[0].assistantText, /4 errors/);
  assert.equal(turns[0].toolUses.length, 1, 'tool row between assistant rows lifted');
  assert.match(turns[0].toolUses[0].inputSummary, /Read eslint\.config\.js/);
  // mtime fallback for startedAt
  assert.equal(turns[0].startedAt, 1_700_000_000_000);

  // turn 1: u2 → [a3]
  assert.equal(turns[1].userText, 'please fix them all');
  assert.match(turns[1].assistantText, /lint clean/);
  assert.equal(turns[1].toolUses.length, 0);
});

test('codebuddy-ide adapter: message path scan does not override workspace hash with MCP result paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'codebuddy-ws-hash-'));
  try {
    const uid = 'user-1';
    const wsHash = 'ws-hash';
    const peerConv = 'peer-conv';
    const targetConv = 'target-conv';
    const ideRoot = join(root, uid, 'CodeBuddyIDE');
    const historyWs = join(ideRoot, uid, 'history', wsHash);

    mkdirSync(join(historyWs, targetConv, 'messages'), { recursive: true });
    mkdirSync(join(ideRoot, 'genie-cache', 'LetsGoAgentEval', 'command-bar', peerConv), {
      recursive: true,
    });

    writeFileSync(
      join(historyWs, 'index.json'),
      JSON.stringify({ conversations: [{ id: peerConv }, { id: targetConv }] }),
    );
    writeFileSync(
      join(historyWs, targetConv, 'index.json'),
      JSON.stringify({ messages: [{ id: 'm1', role: 'user' }] }),
    );
    writeFileSync(
      join(historyWs, targetConv, 'messages', 'm1.json'),
      JSON.stringify({ message: 'MCP search result mentions d:/agent-memory/src/index.ts' }),
    );

    const a = new CodeBuddyIdeAdapter();
    const files = (a as any).scanRoot(root);
    const target = files.find((f: any) => f.sessionId === targetConv);
    assert.ok(target);
    assert.equal(target.cwd, 'LetsGoAgentEval');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('codex-cli adapter: groups rollout response items and extracts function_call tools', async () => {
  const a = new CodexImportAdapter();
  const file = {
    adapterId: 'codex-cli' as const,
    filePath: join(FIXTURES, 'codex', 'sample.jsonl'),
    sessionId: 'codex-sess-1',
    cwd: 'D:\\agent-memory',
    mtimeMs: 0,
  };
  const turns = await collect(a.iterateTurns(file));

  assert.equal(turns.length, 2);
  assert.equal(turns[0].adapterId, 'codex-cli');
  assert.equal(turns[0].sessionId, 'codex-sess-1');
  assert.equal(turns[0].cwd, 'D:\\agent-memory');
  assert.equal(turns[0].userText, 'please inspect the import code');
  assert.match(turns[0].assistantText, /inspect the import code/);
  assert.match(turns[0].assistantText, /three existing adapters/);
  assert.equal(turns[0].toolUses.length, 1);
  assert.equal(turns[0].toolUses[0].name, 'shell_command');
  assert.match(turns[0].toolUses[0].inputSummary, /rg import/);
  assert.ok(turns[0].startedAt > 0);

  assert.equal(turns[1].turnIndex, 1);
  assert.equal(turns[1].userText, 'now add codex support');
  assert.match(turns[1].assistantText, /existing import adapter contract/);
});

test('codex-cli adapter: does not import a recent unfinished last turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-import-active-'));
  const filePath = join(dir, 'rollout-2026-06-16T01-00-00-019ec9e6-3233-7e30-9dfb-b3916f23aad1.jsonl');
  writeFileSync(filePath, [
    JSON.stringify({
      timestamp: '2026-06-16T01:00:00.000Z',
      type: 'session_meta',
      payload: { id: '019ec9e6-3233-7e30-9dfb-b3916f23aad1', cwd: 'D:\\agent-memory' },
    }),
    JSON.stringify({
      timestamp: '2026-06-16T01:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'install obsidian skills' }] },
    }),
    JSON.stringify({
      timestamp: '2026-06-16T01:00:20.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I installed the skills.' }] },
    }),
  ].join('\n') + '\n', 'utf8');

  const a = new CodexImportAdapter();
  const turns = await collect(a.iterateTurns({
    adapterId: 'codex-cli',
    filePath,
    sessionId: '019ec9e6-3233-7e30-9dfb-b3916f23aad1',
    cwd: 'D:\\agent-memory',
    mtimeMs: Date.now(),
  }));

  assert.equal(turns.length, 0, 'recent Codex transcript without task_complete is still live');
  rmSync(dir, { recursive: true, force: true });
});

test('claude adapter: skips IDE-injected meta / compact / sidechain user lines', async () => {
  // Regression for the "重新安装后依然重复" duplicate-import bug. When
  // claude-internal records a multimodal user prompt, it emits TWO
  // `type:"user"` lines: the real one (text + image blocks) and a
  // sidecar with `isMeta:true` carrying `[Image: source: ...]` text
  // markers. If the iterator treats the sidecar as a real turn, the
  // real turn's hook-overlap dedup window collapses to <1s (because
  // `nextStart` becomes the meta line's identical timestamp) and the
  // hook row that fired AFTER the assistant finished falls outside the
  // window — duplicate row written.
  //
  // Fix: normalizeLine returns null for isMeta / isCompactSummary /
  // isSidechain user lines, so streamJsonlTurns never sees them. This
  // fixture has 2 real user prompts surrounded by 1 meta line and 1
  // compact-summary line; expectation is exactly 2 turns.
  const a = new ClaudeAdapter();
  const file = {
    adapterId: 'claude' as const,
    filePath: join(FIXTURES, 'claude', 'meta-lines.jsonl'),
    sessionId: 'sess-meta',
    cwd: 'D:/agent-memory',
    mtimeMs: 0,
  };
  const turns = await collect(a.iterateTurns(file));

  assert.equal(turns.length, 2, 'meta / compact-summary lines must NOT spawn turns');
  assert.equal(turns[0].turnIndex, 0);
  assert.equal(turns[0].userText, 'check this screenshot');
  assert.match(turns[0].assistantText, /i can see the screenshot/);
  assert.equal(turns[1].turnIndex, 1);
  assert.equal(turns[1].userText, 'follow-up question');
  assert.match(turns[1].assistantText, /follow-up/);

  // The two real turns must have distinct fingerprints (so dedup writes
  // one row per real interaction, not per meta-line collapse).
  assert.notEqual(turns[0].fingerprint, turns[1].fingerprint);
});
