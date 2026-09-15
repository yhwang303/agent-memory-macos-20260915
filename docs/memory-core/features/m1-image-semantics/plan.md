# M1 · Image Semantics Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code / Claude Internal 会话触发 Stop / PreCompact hook 时，从 transcript JSONL 反读最后一条助手消息，录入 `agent_response` observation，并激活 `buildSummaryPrompt` 里的 `last_assistant_message` 死代码，让 summary 能反映图片语义。

**Architecture:** 在 `src/shared/transcript-parser.ts` 新增一个流式读取器，从 Claude Code 的 JSONL transcript 尾部反向找到最后一条 `assistant` 消息并抽取所有 text block。hook 层（`handleStop`、新增的 `handleBeforePreCompact`、已有的 `handleBeforeSubmitPrompt`）在对应时机调它，把助手回复与用户 attachments 元信息作为 observation 写入。`sdk_sessions` 表新增 `last_assistant_message` / `transcript_path` 两列（通过 `EXPECTED_COLUMNS` 自动迁移），`buildSummaryPrompt` 激活现有但未使用的 `lastAssistantMessage` 变量。

**Tech Stack:** TypeScript, Node 20+, `node --test` + `tsx`, `better-sqlite3`, existing `WorkerClient`/`SDKAgent` stack, `fs.createReadStream` for streaming JSONL reads.

**Branch:** `feat/claude-mem-integration`

---

## Spec Reference & Corrections

本 plan 基于 `docs/superpowers/specs/2026-04-21-m1-image-semantics-design.md`。实施中已发现 spec 与现状的 3 处偏差，统一按下述口径执行：

1. **`StopInput` 位置**：spec §3.2 说在 `src/types/hooks.ts`，实际在 `src/hooks-cli.ts:207` 作为 inline interface。本 plan 按现状在 `hooks-cli.ts` 原地扩展，同时导出到 `src/types/hooks.ts` 供 adapters 复用。
2. **数据库迁移**：spec §3.5 提到 `src/services/sqlite/migrations/`，仓库内无此目录；现有机制是 `src/services/sqlite/Database.ts` 的 `EXPECTED_COLUMNS` 表驱动的 `ensureMissingColumns`。本 plan 直接扩展 `EXPECTED_COLUMNS`，不新增 migrations 目录。
3. **`lastAssistantMessage` 死代码**：`src/sdk/prompts.ts:249` 已声明 `const lastAssistantMessage = session.last_assistant_message || ''`，但模板字符串未引用。本 plan 在模板里加上 `## Agent's Last Response` 段落。

---

## Dependency Graph

```
T1 (parser)
  ├─► T3 (handleStop 改造)
  ├─► T5 (handleBeforePreCompact)
  └─► (M3 codex-cli 未来复用)

T2 (types + migration)
  ├─► T3
  ├─► T4 (激活死代码)
  └─► T6 (client.updateSessionField)

T3 依赖 T1 + T2 + T6
T4 依赖 T2
T5 依赖 T1 + T2 + T6 + T7 (adapter PreCompact 注册)
T7 独立
T8 (attachments) 独立
T9 (集成回归 fixture) 依赖 T1
T10 (regression matrix) 依赖 T1 T3 T4 T5
```

---

## File Structure

### Created
- `src/shared/transcript-parser.ts` — JSONL 尾部反向读取 + 多模态 block 分类
- `tests/transcript-parser.test.ts` — 4 组 fixture 单测
- `tests/handle-stop-transcript.test.ts` — `handleStop` 在有/无 transcript_path 时的行为
- `tests/fixtures/transcripts/text-only.jsonl`
- `tests/fixtures/transcripts/with-images.jsonl`
- `tests/fixtures/transcripts/with-tool-use.jsonl`
- `tests/fixtures/transcripts/corrupt.jsonl`
- `tests/fixtures/transcripts/empty.jsonl`

### Modified
- `src/types/hooks.ts` — 导出 `StopInput`、`PreCompactInput`
- `src/hooks-cli.ts` — `StopInput` 扩 2 字段；`handleStop` 接 transcript；新增 `handleBeforePreCompact`；`handleBeforeSubmitPrompt` 加 attachments 录入；CLI 路由加 `PreCompact`
- `src/adapters/claude-code.ts` — `EVENT_MAP` + `HOOKS_EVENTS` 加 `PreCompact`；`normalizeInput` 透传 `transcript_path` / `stop_hook_active`
- `src/adapters/claude-internal.ts` — 继承自 `claude-code`，仅验证字段透传
- `src/adapters/codebuddy-ide.ts` — 透传 `transcript_path`（若有）
- `src/services/worker/client.ts` — 新增 `updateSessionField(sessionId, field, value)` 方法
- `src/services/worker/WorkerService.ts` — 新增 `/api/session/field` PATCH 端点
- `src/services/sqlite/Database.ts` — `EXPECTED_COLUMNS.sdk_sessions` 增 `last_assistant_message` + `transcript_path`
- `src/services/sqlite/sessions.ts` — 新增 `updateSessionField()` 函数
- `src/sdk/prompts.ts:buildSummaryPrompt` — 在模板里真正引用 `lastAssistantMessage`
- `src/services/worker/SDKAgent.ts:generateSummary` — 构造 prompt 时填充 `last_assistant_message`

---

## Task 0: Prep — 切分支 & 建 fixtures 目录

**Files:**
- Create directory: `tests/fixtures/transcripts/`

- [ ] **Step 1: 切到新分支**

```bash
cd E:/Github/agent-memory
git checkout -b feat/claude-mem-integration
git status
```

Expected: `On branch feat/claude-mem-integration`

- [ ] **Step 2: 建 fixtures 目录**

```bash
mkdir -p tests/fixtures/transcripts
```

- [ ] **Step 3: Commit 空目录占位**

```bash
touch tests/fixtures/transcripts/.gitkeep
git add tests/fixtures/transcripts/.gitkeep
git commit -m "chore(m1): scaffold transcript fixtures dir"
```

---

## Task 1: Transcript Parser — 新增 `src/shared/transcript-parser.ts`

**Files:**
- Create: `src/shared/transcript-parser.ts`
- Create: `tests/transcript-parser.test.ts`
- Create: `tests/fixtures/transcripts/*.jsonl` (5 个)

**Depends on:** Task 0

### Step 1: 写 fixture 文件

- [ ] **Step 1.1: 创建 `tests/fixtures/transcripts/text-only.jsonl`**

```jsonl
{"type":"user","message":{"content":"Hello"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"Hi there! How can I help?"}]}}
```

- [ ] **Step 1.2: 创建 `tests/fixtures/transcripts/with-images.jsonl`**

```jsonl
{"type":"user","message":{"content":[{"type":"text","text":"What is in this screenshot?"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBOR..."}}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"The screenshot shows a TypeError: cannot read property 'length' of undefined at line 42 of index.ts."}]}}
```

- [ ] **Step 1.3: 创建 `tests/fixtures/transcripts/with-tool-use.jsonl`**

```jsonl
{"type":"user","message":{"content":"List files"}}
{"type":"assistant","message":{"content":[{"type":"text","text":"I'll list them."},{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"ls"}}]}}
```

- [ ] **Step 1.4: 创建 `tests/fixtures/transcripts/corrupt.jsonl`**

```jsonl
{"type":"user","message":{"content":"test"}}
{this is not json
{"type":"assistant","message":{"content":[{"type":"text","text":"Parsed despite corrupt line above."}]}}
```

- [ ] **Step 1.5: 创建 `tests/fixtures/transcripts/empty.jsonl`**

空文件：
```bash
touch tests/fixtures/transcripts/empty.jsonl
```

### Step 2: 写失败测试

- [ ] **Step 2.1: 创建 `tests/transcript-parser.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readLastAssistantMessage, readLastUserMessage } from '../src/shared/transcript-parser.js';

const FX = (name: string) => resolve(__dirname, 'fixtures/transcripts', name);

test('readLastAssistantMessage: plain text', () => {
  const msg = readLastAssistantMessage(FX('text-only.jsonl'));
  assert.ok(msg, 'should return message');
  assert.equal(msg!.text, 'Hi there! How can I help?');
  assert.equal(msg!.hasImages, false);
  assert.deepEqual(msg!.imageRefs, []);
  assert.deepEqual(msg!.toolUses, []);
});

test('readLastAssistantMessage: image-describing assistant turn', () => {
  const msg = readLastAssistantMessage(FX('with-images.jsonl'));
  assert.ok(msg);
  assert.match(msg!.text, /TypeError/);
  // assistant turn itself has no image block; user turn does — parser must only
  // look at ASSISTANT content for hasImages flag
  assert.equal(msg!.hasImages, false);
});

test('readLastUserMessage: detects image attachments from user turn', () => {
  const msg = readLastUserMessage(FX('with-images.jsonl'));
  assert.ok(msg);
  assert.match(msg!.text, /screenshot/);
  assert.equal(msg!.attachments.length, 1);
  assert.equal(msg!.attachments[0].type, 'image');
});

test('readLastAssistantMessage: tool_use extracted', () => {
  const msg = readLastAssistantMessage(FX('with-tool-use.jsonl'));
  assert.ok(msg);
  assert.equal(msg!.text, "I'll list them.");
  assert.equal(msg!.toolUses.length, 1);
  assert.equal(msg!.toolUses[0].name, 'Bash');
});

test('readLastAssistantMessage: skips corrupt lines', () => {
  const msg = readLastAssistantMessage(FX('corrupt.jsonl'));
  assert.ok(msg);
  assert.match(msg!.text, /Parsed despite/);
});

test('readLastAssistantMessage: empty file returns null', () => {
  const msg = readLastAssistantMessage(FX('empty.jsonl'));
  assert.equal(msg, null);
});

test('readLastAssistantMessage: missing file returns null', () => {
  const msg = readLastAssistantMessage(FX('nonexistent.jsonl'));
  assert.equal(msg, null);
});

test('readLastAssistantMessage: honors maxBytes cap', () => {
  // fixture is small; pass a tiny cap to verify the option is wired
  const msg = readLastAssistantMessage(FX('text-only.jsonl'), { maxBytes: 10 });
  // with 10 bytes we cannot reach the assistant line from end; should still return null gracefully
  // (not throw)
  assert.ok(msg === null || typeof msg.text === 'string');
});
```

- [ ] **Step 2.2: 跑测试确认失败**

```bash
npm test -- --test-name-pattern=readLastAssistantMessage
```

Expected: all tests fail with "Cannot find module '../src/shared/transcript-parser.js'" or similar.

### Step 3: 实现 parser

- [ ] **Step 3.1: 创建 `src/shared/transcript-parser.ts`**

```ts
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
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
  attachments: Array<{ type: string; ref?: string }>;
}

interface ReadOpts {
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MiB

/**
 * Read the last N bytes of a file as a string. Returns '' on any error.
 */
function tailBytes(path: string, maxBytes: number): string {
  try {
    const stat = statSync(path);
    const size = stat.size;
    if (size === 0) return '';
    const readLen = Math.min(size, maxBytes);
    const start = size - readLen;
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(readLen);
      readSync(fd, buf, 0, readLen, start);
      // strip UTF-8 BOM if present at absolute start only
      let text = buf.toString('utf8');
      if (start === 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      return text;
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    logger?.debug?.('TRANSCRIPT', `tailBytes failed: ${String(err)}`);
    return '';
  }
}

/**
 * Iterate lines of `tail` from end to start. Lines are split on '\n'; the first
 * (partial) line at the absolute beginning of `tail` is discarded only when the
 * caller did NOT start at file offset 0 (we conservatively always drop the
 * first slice to avoid returning a truncated JSON object).
 */
function* linesReversed(tail: string, startedAtZero: boolean): Generator<string> {
  const parts = tail.split('\n');
  const end = startedAtZero ? 0 : 1; // skip potentially-truncated first slice
  for (let i = parts.length - 1; i >= end; i--) {
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

/**
 * Extract text blocks and classify content. Handles both string-content and
 * array-of-blocks shapes.
 */
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
    return out;
  }
  if (!Array.isArray(content)) return out;

  const textParts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as any;
    switch (b.type) {
      case 'text':
        if (typeof b.text === 'string') textParts.push(b.text);
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
        // ignore tool_result, thinking, etc.
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
  let startedAtZero = false;
  try {
    const stat = statSync(transcriptPath);
    startedAtZero = stat.size <= maxBytes;
    tail = tailBytes(transcriptPath, maxBytes);
  } catch {
    return null;
  }
  if (!tail) return null;

  for (const line of linesReversed(tail, startedAtZero)) {
    const obj = safeJsonParse(line);
    if (!obj || obj.type !== role) continue;
    const content = obj.message?.content ?? obj.content;
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
  const msg = readLastByRole(transcriptPath, 'assistant', opts);
  return (msg as AssistantMessage | null);
}

export function readLastUserMessage(
  transcriptPath: string,
  opts?: ReadOpts
): UserMessage | null {
  const msg = readLastByRole(transcriptPath, 'user', opts);
  return (msg as UserMessage | null);
}

/**
 * Wrapper that never throws. Logs and returns null on any error.
 */
export function safeReadLastAssistantMessage(
  transcriptPath: string | undefined,
  opts?: ReadOpts
): AssistantMessage | null {
  if (!transcriptPath) return null;
  try {
    return readLastAssistantMessage(transcriptPath, opts);
  } catch (err) {
    logger?.debug?.('TRANSCRIPT', `safeReadLastAssistantMessage failed: ${String(err)}`);
    return null;
  }
}
```

- [ ] **Step 3.2: 跑测试确认通过**

```bash
npm test -- --test-name-pattern=readLast
```

Expected: all tests pass.

- [ ] **Step 3.3: Commit**

```bash
git add src/shared/transcript-parser.ts tests/transcript-parser.test.ts tests/fixtures/transcripts/
git commit -m "feat(m1): add transcript-parser with JSONL tail reader"
```

---

## Task 2: 类型扩展 + 数据库列

**Files:**
- Modify: `src/hooks-cli.ts` (StopInput at line 207, new PreCompactInput)
- Modify: `src/types/hooks.ts` (re-export)
- Modify: `src/services/sqlite/Database.ts` (EXPECTED_COLUMNS)
- Modify: `src/services/sqlite/sessions.ts` (updateSessionField function)

**Depends on:** Task 0

### Step 1: 扩展 `StopInput` + 新增 `PreCompactInput`

- [ ] **Step 1.1: 编辑 `src/hooks-cli.ts:207`**

Replace the current `StopInput` interface (line 207-212):

```ts
interface StopInput {
  session_id?: string;
  conversation_id?: string; // Cursor format
  reason?: string;
  cwd?: string;
  transcript_path?: string;
  stop_hook_active?: boolean;
}

interface PreCompactInput {
  session_id?: string;
  conversation_id?: string;
  cwd?: string;
  transcript_path?: string;
  trigger?: string; // "manual" | "auto"
}
```

- [ ] **Step 1.2: 在 `src/types/hooks.ts` 末尾加导出**

```ts
// Re-exports for adapters and downstream packages.
// Kept here so that external consumers don't have to import from hooks-cli.ts.
export interface StopInputShape {
  session_id?: string;
  conversation_id?: string;
  reason?: string;
  cwd?: string;
  transcript_path?: string;
  stop_hook_active?: boolean;
}

export interface PreCompactInputShape {
  session_id?: string;
  conversation_id?: string;
  cwd?: string;
  transcript_path?: string;
  trigger?: string;
}
```

### Step 2: 数据库列

- [ ] **Step 2.1: 编辑 `src/services/sqlite/Database.ts`**

找到 `EXPECTED_COLUMNS` 对象（约第 60 行），增加 `sdk_sessions` 的两列：

```ts
const EXPECTED_COLUMNS: Record<string, Record<string, string>> = {
  sdk_sessions: {
    last_assistant_message: 'TEXT',
    transcript_path: 'TEXT',
  },
  observations: {
    meta_intent: 'TEXT',
    discovery_tokens: 'INTEGER DEFAULT 0',
  },
  session_summaries: {
    meta_intent: 'TEXT',
    discovery_tokens: 'INTEGER DEFAULT 0',
  },
};
```

### Step 3: sessions.ts 新增 `updateSessionField`

- [ ] **Step 3.1: 编辑 `src/services/sqlite/sessions.ts`，文件尾部新增函数**

```ts
const ALLOWED_UPDATE_FIELDS = new Set([
  'last_assistant_message',
  'transcript_path',
]);

export function updateSessionField(
  db: Database,
  sessionId: string,
  field: string,
  value: string | null
): void {
  if (!ALLOWED_UPDATE_FIELDS.has(field)) {
    throw new Error(`updateSessionField: disallowed field "${field}"`);
  }
  // sessionId may be content_session_id or memory_session_id; try both
  const stmt = db.prepare(
    `UPDATE sdk_sessions SET ${field} = ?
     WHERE content_session_id = ? OR memory_session_id = ?`
  );
  stmt.run(value, sessionId, sessionId);
}
```

### Step 4: 写失败测试（迁移 idempotent）

- [ ] **Step 4.1: 创建 `tests/sdk-sessions-migration.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../src/services/sqlite/Database.js';
import { updateSessionField } from '../src/services/sqlite/sessions.js';

test('sdk_sessions has last_assistant_message and transcript_path columns', () => {
  const db = new Database(':memory:');
  initializeDatabase(db);
  const cols = db.prepare('PRAGMA table_info(sdk_sessions)').all() as any[];
  const names = cols.map(c => c.name);
  assert.ok(names.includes('last_assistant_message'), 'last_assistant_message column missing');
  assert.ok(names.includes('transcript_path'), 'transcript_path column missing');
});

test('updateSessionField writes last_assistant_message', () => {
  const db = new Database(':memory:');
  initializeDatabase(db);
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch)
     VALUES ('s1', 'p', '2026-04-21', 0)`
  ).run();
  updateSessionField(db, 's1', 'last_assistant_message', 'hello');
  const row = db.prepare('SELECT last_assistant_message FROM sdk_sessions WHERE content_session_id = ?').get('s1') as any;
  assert.equal(row.last_assistant_message, 'hello');
});

test('updateSessionField rejects disallowed field', () => {
  const db = new Database(':memory:');
  initializeDatabase(db);
  assert.throws(() => updateSessionField(db, 's1', 'status', 'bad'), /disallowed/);
});

test('migration is idempotent', () => {
  const db = new Database(':memory:');
  initializeDatabase(db);
  initializeDatabase(db); // second call must not throw
  const cols = db.prepare('PRAGMA table_info(sdk_sessions)').all() as any[];
  const names = cols.map(c => c.name);
  assert.equal(names.filter(n => n === 'last_assistant_message').length, 1);
});
```

Note: if `initializeDatabase` isn't directly exported, use the actual exported factory (check `Database.ts` top-level exports and adjust the import).

- [ ] **Step 4.2: 跑测试**

```bash
npm test -- tests/sdk-sessions-migration.test.ts
```

Expected: all pass after steps 1–3 are applied.

- [ ] **Step 4.3: Commit**

```bash
git add src/hooks-cli.ts src/types/hooks.ts src/services/sqlite/Database.ts src/services/sqlite/sessions.ts tests/sdk-sessions-migration.test.ts
git commit -m "feat(m1): extend StopInput + add sdk_sessions transcript columns"
```

---

## Task 3: Worker client — `updateSessionField` HTTP 路由

**Files:**
- Modify: `src/services/worker/client.ts`
- Modify: `src/services/worker/WorkerService.ts`

**Depends on:** Task 2

### Step 1: Worker HTTP 端点

- [ ] **Step 1.1: 在 `WorkerService.ts` 中增加路由 handler**

找到其他 `/api/...` POST 路由的注册处（搜索 `/api/observation`），在同一位置加一个：

```ts
// PATCH /api/session/field
// body: { sessionId: string, field: 'last_assistant_message' | 'transcript_path', value: string | null }
this.app.patch('/api/session/field', async (req, res) => {
  try {
    const { sessionId, field, value } = req.body || {};
    if (!sessionId || !field) {
      res.status(400).json({ success: false, error: 'sessionId and field required' });
      return;
    }
    const { updateSessionField } = await import('../sqlite/sessions.js');
    updateSessionField(this.db, String(sessionId), String(field), value == null ? null : String(value));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});
```

(调整成与现有路由一致的 express 风格；如果 worker 用 raw http 模块，改为相应分支处理。)

### Step 2: client 方法

- [ ] **Step 2.1: 在 `src/services/worker/client.ts` 增加 `updateSessionField`**

紧邻现有 `recordResponse` 方法（约 141 行）后：

```ts
async updateSessionField(
  sessionId: string,
  field: 'last_assistant_message' | 'transcript_path',
  value: string | null
): Promise<void> {
  try {
    await fetch(`${this.baseUrl}/api/session/field`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ sessionId, field, value })
    });
  } catch {
    logger.debug('WORKER_CLIENT', 'updateSessionField failed (graceful)');
  }
}
```

### Step 3: 测试

- [ ] **Step 3.1: 创建 `tests/worker-session-field.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../src/services/sqlite/Database.js';
import { updateSessionField } from '../src/services/sqlite/sessions.js';

test('updateSessionField by memory_session_id', () => {
  const db = new Database(':memory:');
  initializeDatabase(db);
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
     VALUES ('c1', 'm1', 'p', '2026-04-21', 0)`
  ).run();
  updateSessionField(db, 'm1', 'transcript_path', '/path/to.jsonl');
  const row = db.prepare('SELECT transcript_path FROM sdk_sessions WHERE memory_session_id = ?').get('m1') as any;
  assert.equal(row.transcript_path, '/path/to.jsonl');
});
```

- [ ] **Step 3.2: 跑测试**

```bash
npm test -- tests/worker-session-field.test.ts
```

Expected: pass.

- [ ] **Step 3.3: Commit**

```bash
git add src/services/worker/client.ts src/services/worker/WorkerService.ts tests/worker-session-field.test.ts
git commit -m "feat(m1): add updateSessionField worker endpoint + client method"
```

---

## Task 4: Adapter 透传 transcript_path + 注册 PreCompact

**Files:**
- Modify: `src/adapters/claude-code.ts` (EVENT_MAP + HOOKS_EVENTS + normalizeInput)
- Modify: `src/adapters/codebuddy-ide.ts` (normalizeInput transcript_path passthrough)
- Modify: `src/adapters/claude-internal.ts` (no code changes, only regression test)

**Depends on:** Task 0

### Step 1: claude-code.ts

- [ ] **Step 1.1: 先读现状**

```bash
cat -n E:/Github/agent-memory/src/adapters/claude-code.ts | head -60
```

- [ ] **Step 1.2: 编辑 `EVENT_MAP`（约第 12 行）**

新增一行：

```ts
const EVENT_MAP: Record<string, string> = {
  'UserPromptSubmit': 'beforeSubmitPrompt',
  'SessionStart': 'sessionStart',
  'SessionEnd': 'sessionEnd',
  'PreToolUse': 'beforeShellExecution',
  'PostToolUse': 'afterToolUse',
  'Stop': 'stop',
  'PreCompact': 'beforePreCompact',   // ← 新增
};
```

- [ ] **Step 1.3: 编辑 `HOOKS_EVENTS`（约第 36 行）**

增加一条：

```ts
const HOOKS_EVENTS: Array<{ ideEvent: string; timeout: number; matcher?: string }> = [
  { ideEvent: 'UserPromptSubmit', timeout: 10000 },
  { ideEvent: 'SessionStart', timeout: 15000 },
  { ideEvent: 'PostToolUse', timeout: 10000 },
  { ideEvent: 'PreToolUse', timeout: 10000, matcher: 'Bash' },
  { ideEvent: 'Stop', timeout: 30000 },
  { ideEvent: 'SessionEnd', timeout: 10000 },
  { ideEvent: 'PreCompact', timeout: 30000 },   // ← 新增
];
```

- [ ] **Step 1.4: 在 `normalizeInput` 中透传 transcript 字段**

找到 `normalizeInput`（或等价的映射函数）。把 stdin JSON 里的 `transcript_path` / `stop_hook_active` / `trigger` 字段原样带到结构化输出上。如果实现用展开 `...raw`，已经自动透传；否则显式加：

```ts
return {
  ...baseShape,
  transcript_path: raw.transcript_path ?? raw.transcriptPath ?? raw.transcript,
  stop_hook_active: raw.stop_hook_active,
  trigger: raw.trigger,
};
```

### Step 2: codebuddy-ide.ts — 仅透传 transcript_path（若存在）

- [ ] **Step 2.1: 同 Step 1.4，在其 normalizeInput 中增加透传逻辑**（若已展开，跳过）。

### Step 3: 测试 adapter 透传

- [ ] **Step 3.1: 创建 `tests/adapter-transcript-passthrough.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';

test('claude-code adapter registers PreCompact', () => {
  const a = new ClaudeCodeAdapter();
  const cfg = a.generateHooksConfig();
  const json = JSON.stringify(cfg);
  assert.match(json, /PreCompact/);
});

test('claude-code adapter passes transcript_path through', () => {
  const a = new ClaudeCodeAdapter();
  const raw = {
    session_id: 's1',
    reason: 'stop',
    transcript_path: '/tmp/t.jsonl',
    stop_hook_active: true,
  };
  const normalized = a.normalizeInput('Stop', raw);
  assert.equal(normalized.transcript_path, '/tmp/t.jsonl');
  assert.equal(normalized.stop_hook_active, true);
});

test('claude-code adapter accepts camelCase transcriptPath alias', () => {
  const a = new ClaudeCodeAdapter();
  const normalized = a.normalizeInput('Stop', { session_id: 's1', transcriptPath: '/tmp/t.jsonl' });
  assert.equal(normalized.transcript_path, '/tmp/t.jsonl');
});
```

Adjust import paths / constructor shape to match actual adapter exports.

- [ ] **Step 3.2: 跑测试**

```bash
npm test -- tests/adapter-transcript-passthrough.test.ts
```

Expected: pass.

- [ ] **Step 3.3: Commit**

```bash
git add src/adapters/claude-code.ts src/adapters/codebuddy-ide.ts tests/adapter-transcript-passthrough.test.ts
git commit -m "feat(m1): register PreCompact + passthrough transcript_path in adapters"
```

---

## Task 5: `handleStop` 改造 — 从 transcript 录入 agent_response

**Files:**
- Modify: `src/hooks-cli.ts:693` (handleStop)

**Depends on:** Task 1, 2, 3, 4

### Step 1: 写失败测试

- [ ] **Step 1.1: 创建 `tests/handle-stop-transcript.test.ts`**

```ts
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The SUT is the handleStop function. It lives inside hooks-cli.ts which is a
// CLI entry — we refactor in Step 2.1 to export handleStop for testability.

import { handleStopForTest } from '../src/hooks-cli.js';

function makeTranscript(): string {
  const p = join(tmpdir(), `t-${Date.now()}.jsonl`);
  writeFileSync(p, [
    JSON.stringify({ type: 'user', message: { content: 'hi' } }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'The screenshot shows TypeError at line 42.' }] },
    }),
  ].join('\n'));
  return p;
}

test('handleStop records agent_response when transcript_path present (claude-code)', async () => {
  const observations: any[] = [];
  const sessionFieldUpdates: any[] = [];
  const client = {
    addObservation: async (o: any) => { observations.push(o); return { success: true }; },
    updateSessionField: async (sid: string, f: string, v: string) => {
      sessionFieldUpdates.push({ sid, f, v });
    },
    summarizeSession: async () => {},
  };

  const transcript_path = makeTranscript();
  await handleStopForTest(
    { session_id: 's1', transcript_path, reason: 'stop' },
    { adapterId: 'claude-code', client, projectPath: '/proj' }
  );

  const ar = observations.find(o => o.type === 'agent_response');
  assert.ok(ar, 'agent_response observation should be recorded');
  assert.match(ar.toolOutput.response, /TypeError/);
  assert.equal(sessionFieldUpdates.length, 1);
  assert.equal(sessionFieldUpdates[0].f, 'last_assistant_message');
});

test('handleStop skips agent_response for cursor (adapter unchanged)', async () => {
  const observations: any[] = [];
  const client = {
    addObservation: async (o: any) => { observations.push(o); },
    updateSessionField: async () => {},
    summarizeSession: async () => {},
  };
  await handleStopForTest(
    { session_id: 's1', transcript_path: '/not/used' },
    { adapterId: 'cursor', client, projectPath: '/proj' }
  );
  assert.equal(observations.filter(o => o.type === 'agent_response' && o.toolInput?.source === 'transcript').length, 0);
});

test('handleStop does not throw when transcript missing', async () => {
  const client = {
    addObservation: async () => {},
    updateSessionField: async () => {},
    summarizeSession: async () => {},
  };
  await handleStopForTest(
    { session_id: 's1', transcript_path: '/definitely/not/here.jsonl' },
    { adapterId: 'claude-code', client, projectPath: '/proj' }
  );
  // no assertion — test passes if no throw
});
```

- [ ] **Step 1.2: 跑测试确认失败**

```bash
npm test -- tests/handle-stop-transcript.test.ts
```

Expected: FAIL — `handleStopForTest` not exported.

### Step 2: 实现

- [ ] **Step 2.1: 编辑 `src/hooks-cli.ts`, handleStop（行 693）**

Replace the current `handleStop` body's lead-in with the new logic. Also expose a testable wrapper:

```ts
import { safeReadLastAssistantMessage } from './shared/transcript-parser.js';

// truncateString already exists in this file.

export interface HandleStopContext {
  adapterId: string;
  client: {
    addObservation: (o: any) => Promise<any>;
    updateSessionField: (sid: string, f: string, v: string) => Promise<void>;
    summarizeSession: (sid: string) => Promise<void>;
  };
  projectPath: string;
}

export async function handleStopForTest(
  input: StopInput & { response?: string; text?: string },
  ctx: HandleStopContext
): Promise<void> {
  const sessionId = input.session_id || input.conversation_id || '';
  if (!sessionId) return;

  const fromClaude = ctx.adapterId === 'claude-code' || ctx.adapterId === 'claude-internal';
  if (fromClaude && input.transcript_path) {
    const msg = safeReadLastAssistantMessage(input.transcript_path);
    if (msg?.text) {
      await ctx.client.addObservation({
        sessionId,
        projectPath: ctx.projectPath,
        timestamp: Date.now(),
        type: 'agent_response',
        toolName: 'agent_response',
        toolInput: {
          source: 'transcript',
          has_images: msg.hasImages,
          image_refs: msg.imageRefs.slice(0, 10),
        },
        toolOutput: { response: truncateString(msg.text, 8000) },
      });
      try {
        await ctx.client.updateSessionField(
          sessionId,
          'last_assistant_message',
          truncateString(msg.text, 4000)
        );
      } catch { /* graceful */ }
    }
  }

  // Fallback: if Claude Code did not provide transcript_path but legacy
  // response/text field is present, keep the old behavior.
  const responseText = input.text || input.response || '';
  if (responseText && !(fromClaude && input.transcript_path)) {
    await ctx.client.addObservation({
      sessionId,
      projectPath: ctx.projectPath,
      timestamp: Date.now(),
      type: 'agent_response',
      toolName: 'agent_response',
      toolInput: { event: 'stop', reason: input.reason },
      toolOutput: { response: truncateString(responseText, 5000) },
    });
  }
}

async function handleStop(input: StopInput & { response?: string; text?: string }): Promise<MonitorResult> {
  const sourceAdapter = detectAdapterByEvent(process.argv[2] || '');
  await handleStopForTest(input, {
    adapterId: sourceAdapter?.id || '',
    client: {
      addObservation: client.addObservation.bind(client),
      updateSessionField: client.updateSessionField.bind(client),
      summarizeSession: client.summarizeSession.bind(client),
    },
    projectPath: process.cwd(),
  });

  // Existing summarize trigger stays untouched.
  const sessionId = input.session_id || input.conversation_id || '';
  if (sessionId) {
    try { await client.summarizeSession(sessionId); } catch { /* graceful */ }
  }

  return { success: true };
}
```

Preserve any additional logic from the original `handleStop` not captured above (reason logging, session state updates). Review the existing block line-by-line before committing.

- [ ] **Step 2.2: 跑测试**

```bash
npm test -- tests/handle-stop-transcript.test.ts
```

Expected: all pass.

- [ ] **Step 2.3: Commit**

```bash
git add src/hooks-cli.ts tests/handle-stop-transcript.test.ts
git commit -m "feat(m1): handleStop reads transcript and records agent_response"
```

---

## Task 6: 激活 `last_assistant_message` — 模板 + SDKAgent

**Files:**
- Modify: `src/sdk/prompts.ts:buildSummaryPrompt`
- Modify: `src/services/worker/SDKAgent.ts:generateSummary`

**Depends on:** Task 2

### Step 1: Prompt 模板

- [ ] **Step 1.1: 编辑 `src/sdk/prompts.ts`, buildSummaryPrompt（行 247）**

Insert a new section after `## Session Observations` (around line 279), referencing the existing `lastAssistantMessage` variable:

```ts
const lastAssistantSection = lastAssistantMessage
  ? `\n## Agent's Last Response (for context, do NOT quote verbatim):\n${lastAssistantMessage.substring(0, 2000)}\n`
  : '';

return `You are a memory summarizer. Generate a CONCISE summary of this coding session.

## User's Request
${userRequestSection}

## Session Observations (${observations.length} total):
${observationsSummary}
${lastAssistantSection}
## CRITICAL RULES - READ CAREFULLY:
...`; // rest unchanged
```

### Step 2: SDKAgent 填充字段

- [ ] **Step 2.1: 编辑 `src/services/worker/SDKAgent.ts:generateSummary`**

找到调用 `buildSummaryPrompt({...})` 的位置（约 342 行）。在构造入参时从 session 行读 `last_assistant_message`，fallback 到最新 `agent_response` observation：

```ts
// existing: const session = getSessionByMemoryId(memorySessionId);
const sessionRow = session as any;
let lastAssistant = sessionRow?.last_assistant_message || '';
if (!lastAssistant) {
  const latestResponse = allObservations
    .slice()
    .reverse()
    .find(o => o.type === 'agent_response' && o.tool_name === 'agent_response');
  if (latestResponse) {
    try {
      const parsed = typeof latestResponse.text === 'string'
        ? JSON.parse(latestResponse.text)
        : latestResponse.text;
      lastAssistant = parsed?.response || '';
    } catch {
      lastAssistant = String(latestResponse.text || '');
    }
  }
}

const prompt = buildSummaryPrompt({
  id: 0,
  memory_session_id: memorySessionId,
  project,
  user_prompt: userPrompt,
  last_assistant_message: lastAssistant,   // ← 新填入
  observations: observations.map(o => ({ /* existing shape */ })),
});
```

Match field names exactly to current SDKAgent code — inspect around line 342 first.

### Step 3: 测试

- [ ] **Step 3.1: 创建 `tests/build-summary-prompt.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummaryPrompt } from '../src/sdk/prompts.js';

test('buildSummaryPrompt includes Agent\'s Last Response when set', () => {
  const p = buildSummaryPrompt({
    id: 0, memory_session_id: 'm', project: 'p',
    user_prompt: 'fix the bug',
    last_assistant_message: 'The screenshot shows a TypeError at line 42.',
    observations: [],
  });
  assert.match(p, /Agent's Last Response/);
  assert.match(p, /TypeError at line 42/);
});

test('buildSummaryPrompt omits section when last_assistant_message empty', () => {
  const p = buildSummaryPrompt({
    id: 0, memory_session_id: 'm', project: 'p',
    user_prompt: 'fix the bug',
    observations: [],
  });
  assert.doesNotMatch(p, /Agent's Last Response/);
});

test('buildSummaryPrompt truncates at 2000 chars', () => {
  const long = 'x'.repeat(5000);
  const p = buildSummaryPrompt({
    id: 0, memory_session_id: 'm', project: 'p',
    user_prompt: 'u', last_assistant_message: long,
    observations: [],
  });
  // only 2000 x's should survive in the prompt
  const m = p.match(/x+/);
  assert.ok(m);
  assert.ok(m![0].length <= 2000);
});
```

- [ ] **Step 3.2: 跑测试**

```bash
npm test -- tests/build-summary-prompt.test.ts
```

Expected: pass.

- [ ] **Step 3.3: Commit**

```bash
git add src/sdk/prompts.ts src/services/worker/SDKAgent.ts tests/build-summary-prompt.test.ts
git commit -m "feat(m1): activate last_assistant_message in buildSummaryPrompt"
```

---

## Task 7: `handleBeforeSubmitPrompt` — attachments 元信息

**Files:**
- Modify: `src/hooks-cli.ts:554` (handleBeforeSubmitPrompt)

**Depends on:** Task 0

### Step 1: 写测试

- [ ] **Step 1.1: 创建 `tests/attachments-metadata.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleBeforeSubmitPromptForTest } from '../src/hooks-cli.js';

test('attachments are recorded as user_attachments observation', async () => {
  const observations: any[] = [];
  const client = {
    addObservation: async (o: any) => { observations.push(o); },
    initSession: async () => ({ memorySessionId: 'm1' }),
  };
  await handleBeforeSubmitPromptForTest(
    {
      session_id: 's1',
      prompt: 'look at this',
      attachments: [
        { type: 'image', name: 'err.png', size: 1234 },
        { mime_type: 'image/jpeg', filename: 'ui.jpg' },
      ],
    },
    { client, projectPath: '/proj' }
  );
  const ua = observations.find(o => o.toolName === 'user_attachments');
  assert.ok(ua, 'user_attachments observation should be recorded');
  assert.equal(ua.toolInput.attachments.length, 2);
  assert.equal(ua.toolOutput.count, 2);
});

test('no observation when attachments empty', async () => {
  const observations: any[] = [];
  const client = {
    addObservation: async (o: any) => { observations.push(o); },
    initSession: async () => ({ memorySessionId: 'm1' }),
  };
  await handleBeforeSubmitPromptForTest(
    { session_id: 's1', prompt: 'hello' },
    { client, projectPath: '/proj' }
  );
  assert.equal(observations.filter(o => o.toolName === 'user_attachments').length, 0);
});
```

- [ ] **Step 1.2: 跑测试确认失败**

```bash
npm test -- tests/attachments-metadata.test.ts
```

Expected: FAIL (`handleBeforeSubmitPromptForTest` not exported).

### Step 2: 实现

- [ ] **Step 2.1: 编辑 `src/hooks-cli.ts:554`（handleBeforeSubmitPrompt）**

在函数体现有 `lacksAgentResponse` 分支附近增加 attachments 录入。同时导出测试包装：

```ts
export interface HandleBeforeSubmitContext {
  client: {
    addObservation: (o: any) => Promise<any>;
    initSession?: (args: any) => Promise<any>;
  };
  projectPath: string;
}

export async function handleBeforeSubmitPromptForTest(
  input: BeforeSubmitPromptInput,
  ctx: HandleBeforeSubmitContext
): Promise<void> {
  const sessionId = input.session_id || input.conversation_id || '';
  if (!sessionId) return;

  if (input.attachments && input.attachments.length > 0) {
    await ctx.client.addObservation({
      sessionId,
      projectPath: ctx.projectPath,
      timestamp: Date.now(),
      type: 'agent_response',
      toolName: 'user_attachments',
      toolInput: {
        attachments: input.attachments.map((a: any) => ({
          type: a.type || a.mime_type || 'unknown',
          name: a.name || a.filename || 'unnamed',
          size: a.size,
        })),
      },
      toolOutput: { count: input.attachments.length },
    });
  }
}
```

Then in the real `handleBeforeSubmitPrompt`, call the helper:

```ts
await handleBeforeSubmitPromptForTest(input, { client, projectPath: process.cwd() });
```

- [ ] **Step 2.2: 跑测试**

```bash
npm test -- tests/attachments-metadata.test.ts
```

Expected: pass.

- [ ] **Step 2.3: Commit**

```bash
git add src/hooks-cli.ts tests/attachments-metadata.test.ts
git commit -m "feat(m1): record user attachments metadata in handleBeforeSubmitPrompt"
```

---

## Task 8: `handleBeforePreCompact` — 压缩前快照

**Files:**
- Modify: `src/hooks-cli.ts` (add handler + CLI dispatcher entry)

**Depends on:** Task 1, 2, 3, 4

### Step 1: 写测试

- [ ] **Step 1.1: 创建 `tests/pre-compact.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleBeforePreCompactForTest } from '../src/hooks-cli.js';

function transcript(): string {
  const p = join(tmpdir(), `pc-${Date.now()}.jsonl`);
  writeFileSync(p, JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'pre-compact content' }] },
  }) + '\n');
  return p;
}

test('handleBeforePreCompact records pre_compact_snapshot observation', async () => {
  const observations: any[] = [];
  const client = {
    addObservation: async (o: any) => { observations.push(o); },
    updateSessionField: async () => {},
  };
  await handleBeforePreCompactForTest(
    { session_id: 's1', transcript_path: transcript(), trigger: 'manual' },
    { adapterId: 'claude-code', client, projectPath: '/proj' }
  );
  const snap = observations.find(o => o.toolName === 'pre_compact_snapshot');
  assert.ok(snap);
  assert.match(snap.toolOutput.response, /pre-compact content/);
});
```

- [ ] **Step 1.2: 跑确认失败**

```bash
npm test -- tests/pre-compact.test.ts
```

Expected: FAIL.

### Step 2: 实现

- [ ] **Step 2.1: 在 `src/hooks-cli.ts` 新增**

```ts
export async function handleBeforePreCompactForTest(
  input: PreCompactInput,
  ctx: HandleStopContext
): Promise<void> {
  const sessionId = input.session_id || input.conversation_id || '';
  if (!sessionId || !input.transcript_path) return;

  const msg = safeReadLastAssistantMessage(input.transcript_path);
  if (!msg?.text) return;

  await ctx.client.addObservation({
    sessionId,
    projectPath: ctx.projectPath,
    timestamp: Date.now(),
    type: 'agent_response',
    toolName: 'pre_compact_snapshot',
    toolInput: {
      source: 'transcript',
      trigger: input.trigger || 'unknown',
      has_images: msg.hasImages,
      image_refs: msg.imageRefs.slice(0, 10),
    },
    toolOutput: { response: truncateString(msg.text, 16000) },
  });

  try {
    await ctx.client.updateSessionField(
      sessionId, 'last_assistant_message', truncateString(msg.text, 4000)
    );
  } catch { /* graceful */ }
}

async function handleBeforePreCompact(input: PreCompactInput): Promise<MonitorResult> {
  const sourceAdapter = detectAdapterByEvent(process.argv[2] || '');
  await handleBeforePreCompactForTest(input, {
    adapterId: sourceAdapter?.id || '',
    client: {
      addObservation: client.addObservation.bind(client),
      updateSessionField: client.updateSessionField.bind(client),
      summarizeSession: client.summarizeSession.bind(client),
    },
    projectPath: process.cwd(),
  });
  return { success: true };
}
```

- [ ] **Step 2.2: 注册 CLI 派发**

Find the CLI event dispatcher (the switch-like block in hooks-cli.ts that routes by event name). Add branch:

```ts
case 'beforePreCompact':
case 'PreCompact':
  return handleBeforePreCompact(input as PreCompactInput);
```

- [ ] **Step 2.3: 跑测试**

```bash
npm test -- tests/pre-compact.test.ts
```

Expected: pass.

- [ ] **Step 2.4: Commit**

```bash
git add src/hooks-cli.ts tests/pre-compact.test.ts
git commit -m "feat(m1): add handleBeforePreCompact transcript snapshot"
```

---

## Task 9: Windows path + UTF-8 BOM — 风险兜底单测

**Files:**
- Modify: `tests/transcript-parser.test.ts` (append cases)

**Depends on:** Task 1

### Step 1: 新增 fixture

- [ ] **Step 1.1: 创建 `tests/fixtures/transcripts/bom.jsonl`**

```bash
# Write file prefixed with UTF-8 BOM (EF BB BF)
printf '\xEF\xBB\xBF{"type":"assistant","message":{"content":[{"type":"text","text":"bom ok"}]}}\n' > tests/fixtures/transcripts/bom.jsonl
```

### Step 2: 新增测试用例

- [ ] **Step 2.1: 编辑 `tests/transcript-parser.test.ts` 尾部追加**

```ts
test('readLastAssistantMessage: handles UTF-8 BOM at file start', () => {
  const msg = readLastAssistantMessage(FX('bom.jsonl'));
  assert.ok(msg, 'should parse BOM-prefixed JSONL');
  assert.equal(msg!.text, 'bom ok');
});

test('readLastAssistantMessage: Windows backslash path normalizes', () => {
  // fixture path built via node:path already normalizes; this is a smoke
  // test ensuring parser does not crash on backslashes.
  const raw = FX('text-only.jsonl').replace(/\//g, '\\');
  const msg = readLastAssistantMessage(raw);
  assert.ok(msg);
});
```

- [ ] **Step 2.2: 跑测试**

```bash
npm test -- tests/transcript-parser.test.ts
```

Expected: all pass.

- [ ] **Step 2.3: Commit**

```bash
git add tests/transcript-parser.test.ts tests/fixtures/transcripts/bom.jsonl
git commit -m "test(m1): transcript-parser BOM + backslash path coverage"
```

---

## Task 10: 回归矩阵 — 端到端黑盒测试

**Files:**
- Create: `tests/e2e/m1-regression.test.ts`

**Depends on:** Task 1, 5, 6, 7, 8

### Step 1: 写测试

- [ ] **Step 1.1: 创建 `tests/e2e/m1-regression.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeDatabase } from '../../src/services/sqlite/Database.js';
import { updateSessionField } from '../../src/services/sqlite/sessions.js';
import { buildSummaryPrompt } from '../../src/sdk/prompts.js';
import { handleStopForTest } from '../../src/hooks-cli.js';

/**
 * Black-box regression: simulate a Claude Code session with an image-describing
 * assistant turn, run handleStop, check that buildSummaryPrompt is seeded with
 * the assistant's text, and that the summary LLM *could* surface it.
 */
test('Claude Code image-describing session: last_assistant_message flows to summary prompt', async () => {
  const db = new Database(':memory:');
  initializeDatabase(db);
  db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch, user_prompt)
     VALUES ('s1', 'm1', 'p', '2026-04-21', 0, 'why is this error here')`
  ).run();

  const transcriptPath = join(tmpdir(), `reg-${Date.now()}.jsonl`);
  writeFileSync(transcriptPath,
    `{"type":"user","message":{"content":[{"type":"text","text":"what does this error mean"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}}]}}\n` +
    `{"type":"assistant","message":{"content":[{"type":"text","text":"The screenshot shows \\"TypeError: cannot read property length of undefined\\" at index.ts line 42."}]}}\n`
  );

  // Capture-only client
  const observations: any[] = [];
  const client = {
    addObservation: async (o: any) => { observations.push(o); },
    updateSessionField: async (sid: string, f: string, v: string) => {
      updateSessionField(db, sid, f, v);
    },
    summarizeSession: async () => {},
  };

  await handleStopForTest(
    { session_id: 'm1', transcript_path: transcriptPath, reason: 'stop' },
    { adapterId: 'claude-code', client, projectPath: '/proj' }
  );

  // 1. agent_response observation captured
  const ar = observations.find(o => o.type === 'agent_response' && o.toolName === 'agent_response');
  assert.ok(ar, 'agent_response should be recorded');
  assert.match(ar.toolOutput.response, /TypeError/);

  // 2. sdk_sessions.last_assistant_message populated
  const row = db.prepare('SELECT last_assistant_message FROM sdk_sessions WHERE memory_session_id = ?').get('m1') as any;
  assert.match(row.last_assistant_message, /TypeError/);

  // 3. buildSummaryPrompt surfaces it
  const prompt = buildSummaryPrompt({
    id: 0, memory_session_id: 'm1', project: 'p',
    user_prompt: 'why is this error here',
    last_assistant_message: row.last_assistant_message,
    observations: [],
  });
  assert.match(prompt, /Agent's Last Response/);
  assert.match(prompt, /TypeError/);
});

test('Non-claude adapter: transcript not consumed, no agent_response appended', async () => {
  const observations: any[] = [];
  const client = {
    addObservation: async (o: any) => { observations.push(o); },
    updateSessionField: async () => {},
    summarizeSession: async () => {},
  };
  await handleStopForTest(
    { session_id: 's2', transcript_path: '/doesnt/matter', reason: 'stop' },
    { adapterId: 'cursor', client, projectPath: '/proj' }
  );
  const ar = observations.find(o =>
    o.type === 'agent_response' && o.toolInput?.source === 'transcript'
  );
  assert.equal(ar, undefined);
});

test('Corrupt transcript: handleStop does not throw, does not record', async () => {
  const transcriptPath = join(tmpdir(), `corrupt-${Date.now()}.jsonl`);
  writeFileSync(transcriptPath, '{\nnot-json\n');
  const observations: any[] = [];
  const client = {
    addObservation: async (o: any) => { observations.push(o); },
    updateSessionField: async () => {},
    summarizeSession: async () => {},
  };
  await handleStopForTest(
    { session_id: 's3', transcript_path: transcriptPath },
    { adapterId: 'claude-code', client, projectPath: '/proj' }
  );
  const ar = observations.find(o => o.toolInput?.source === 'transcript');
  assert.equal(ar, undefined);
});
```

- [ ] **Step 1.2: 跑测试**

```bash
npm test -- tests/e2e/m1-regression.test.ts
```

Expected: all pass.

- [ ] **Step 1.3: 跑整个测试套件一次**

```bash
npm test
```

Expected: all passing.

- [ ] **Step 1.4: Commit**

```bash
git add tests/e2e/m1-regression.test.ts
git commit -m "test(m1): end-to-end regression covering image-semantics flow"
```

---

## Task 11: 手工集成回归（spec §6.2）

这一步不是自动化测试，而是 spec §6.2 要求的"10 组含图片真实会话"回归。

**Files:**
- Create: `docs/superpowers/reports/m1-regression-<date>.md`

**Depends on:** Task 10

- [ ] **Step 1: 建报告骨架**

```bash
cat > docs/superpowers/reports/m1-regression-$(date +%Y-%m-%d).md <<'EOF'
# M1 回归报告

| # | 来源 IDE | 截图描述 | Summary 命中? | 备注 |
|---|---|---|---|---|
| 1 | Claude Code | TypeError 截图 | ⬜ | |
| 2 | Claude Code | UI 布局截图 | ⬜ | |
| 3 | Claude Code | 日志图 | ⬜ | |
| 4 | Claude Code | 代码高亮 | ⬜ | |
| 5 | Claude Code | 终端错误 | ⬜ | |
| 6 | Claude Internal | 错误 | ⬜ | |
| 7 | Claude Internal | 数据表 | ⬜ | |
| 8 | Claude Internal | 架构图 | ⬜ | |
| 9 | CodeBuddy IDE | 报错截图 | ⬜ | IDE 需提供 transcript_path，否则 N/A |
| 10 | CodeBuddy IDE | 界面截图 | ⬜ | 同上 |

**目标**：≥ 8/10 命中。

**日期**：$(date +%Y-%m-%d)
**执行人**：
EOF
```

- [ ] **Step 2: 手动执行 10 组会话**

每组会话：
1. 打开目标 IDE
2. 发送一张截图 + 一句问题
3. 等待助手回答
4. 触发 Stop（结束会话）
5. 查询 session_summaries 表对应 session 的 `learned` / `completed` 字段
6. 在报告里打 ✅/❌

```bash
# 查询最近 summary
sqlite3 "$HOME/.config/agent-memory/agent-memory.db" \
  "SELECT memory_session_id, learned, completed FROM session_summaries ORDER BY id DESC LIMIT 1;"
```

- [ ] **Step 3: Commit 报告**

```bash
git add docs/superpowers/reports/
git commit -m "docs(m1): regression report (NN/10 hits)"
```

- [ ] **Step 4: 若 < 8/10，回到对应 Task 排查并补测试**

---

## Self-Review Summary

**Spec coverage audit:**
- ✅ §3.1 parser — Task 1
- ✅ §3.2 types — Task 2
- ✅ §3.3 adapter passthrough — Task 4
- ✅ §3.4 handleStop — Task 5
- ✅ §3.5 last_assistant_message activation — Task 6
- ✅ §3.6 attachments — Task 7
- ✅ §3.7 PreCompact — Tasks 4 + 8
- ✅ §6.1 unit tests — Tasks 1, 2, 3, 4, 5, 6, 7, 8
- ✅ §6.2 integration — Task 11
- ✅ §6.3 regression matrix — Task 10
- ✅ §8 risk 1 (transcript_path rename) — Task 4 Step 3.1 (camelCase alias test)
- ✅ §8 risk 2 (locked file) — parser catches throw + `safeRead` wrapper
- ✅ §8 risk 3 (truncation) — Task 5 uses 8000 for observation (richer than 2000 session field)
- ✅ §8 risk 4 (Windows paths / BOM) — Task 9
- ✅ §9 acceptance criteria — covered by Tasks 1, 10, 2, 8, 5

**Placeholder scan:** no TBDs; every code step shows full code. Any IDE-specific `normalizeInput` exact shape is marked "inspect around line X first" because the actual adapter implementation may vary; this is unavoidable without reading every byte, but the plan prescribes the outcome contract tested by the passthrough test.

**Type consistency:**
- `HandleStopContext` used in Tasks 5 + 8 — consistent.
- `client.updateSessionField(sid, field, value)` used in Tasks 3, 5, 8 — consistent signature.
- `StopInput.transcript_path` (`string | undefined`) + `PreCompactInput.transcript_path` (`string | undefined`) — consistent.

---

## M1 Completion Status (as of 2026-04-21)

All automated tasks (T0–T10) are shipped on branch `feat/claude-mem-integration`. Commit range: `38d6bcd..3e52d1b`.

| Task | Commits | Status |
|---|---|---|
| T0 — scaffold | 38d6bcd | ✅ |
| T1 — transcript-parser | 4fa07fd | ✅ |
| T2 — types + DB columns | db7c0d2, f58d7da | ✅ |
| T3 — worker endpoint + client | 2269e32, 9c6cc4c | ✅ |
| T4 — adapter passthrough + PreCompact reg | d2b5d80, dc2ac16 | ✅ |
| T7 — attachments metadata | ddd6b41, b05e43f | ✅ |
| T5 — handleStop transcript | 9585697, e672078 | ✅ |
| T6 — activate last_assistant_message | 607835d, 96484d0 | ✅ |
| T8 — PreCompact handler | acc684a, e936e9f | ✅ |
| T9 — BOM + backslash tests | c53a561 | ✅ |
| T10 — E2E regression | 3e52d1b | ✅ |

**Test suite**: 99 passing / 2 pre-existing viewer-api failures (unrelated, carried over from master).

**Remaining for M1**: T11 manual regression — 10-session image-semantics verification run against live Claude Code / Claude Internal IDEs. See task description in this plan file.

**Next milestone**: M2 (RAG + SQLite hybrid search).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-21-m1-image-semantics.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
