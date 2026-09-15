# M1 · Claude Code 图片语义修复

**里程碑**：M1（路线图第 1/5 步）
**工作量**：~3 个工作日
**分支**：`feat/claude-mem-integration`
**前置**：无
**后继**：M3 的 transcript-based 适配器（codex-cli、升级版 claude-code）复用本里程碑产出的 `transcript-parser.ts`

---

## 1. 问题陈述

参照 `docs/summary-image-missing-analysis.md`：

- Summary #1855（Claude Code 链路）`learned` 字段："没有保留具体命令、输出或图片中的报错文本"。
- 根因：Claude Code hook 规范**没有** `afterAgentResponse` 事件；agent-memory 的 Claude Code 适配器因此永远捕获不到助手侧回复，包括助手对图片内容的文字描述。
- 连锁：`observations` 表缺 `type='agent_response'` 记录 → `buildSummaryPrompt` 输入仅有用户 prompt + 工具骨架 → Summary LLM 写不出图片语义。

## 2. 破局思路

claude-mem 的做法（`src/shared/transcript-parser.ts`）：**从 Claude Code 自身写入的 transcript JSONL 文件反读助手消息**。Claude Code 在 Stop hook 的 stdin 中注入 `transcript_path` 字段，指向 `~/.claude/projects/<hash>/<session>.jsonl`。最后一条 `type=assistant` 的 JSON 行里包含完整的 `content[]`，其中 `content[].type==='text'` 的 block 就是助手对图片/对话的纯文本回复。

这即 `summary-image-missing-analysis.md` §10 **方案 B**的成熟实现参考。

## 3. 方案设计

### 3.1 新增模块

```
src/shared/transcript-parser.ts  （从 claude-mem/src/shared/transcript-parser.ts 移植）
```

API：

```ts
export interface AssistantMessage {
  text: string;             // 所有 type==='text' block 拼接
  hasImages: boolean;       // content 里出现过 image/image_url block
  imageRefs: string[];      // 图片来源（路径/url/base64摘要）
  toolUses: Array<{ name: string; input: unknown }>;
  timestamp?: number;
}

export function readLastAssistantMessage(
  transcriptPath: string,
  opts?: { maxBytes?: number }
): AssistantMessage | null;

export function readLastUserMessage(
  transcriptPath: string
): { text: string; attachments: Array<{ type: string; ref?: string }> } | null;
```

**实现要点**：倒序流式读取（`fs.createReadStream` + 行反向缓冲），1 MiB 封顶；坏行跳过；多模态 block 分类入桶。

### 3.2 类型扩展

`src/types/hooks.ts`：

```ts
export interface StopInput {
  session_id?: string;
  conversation_id?: string;
  reason?: string;
  cwd?: string;
  transcript_path?: string;     // ← 新增
  stop_hook_active?: boolean;   // ← 新增
}
```

### 3.3 适配器透传

- `src/adapters/claude-code.ts` 的 `normalizeInput`：保留 `transcript_path`、`stop_hook_active` 原样透传。
- `src/adapters/claude-internal.ts` 继承，自动生效。
- `src/adapters/codebuddy-ide.ts`：若 IDE 注入 `transcript_path` 就带上，否则无动作。

> 注：passthrough 仅保证字段被正确带入 `normalizeInput` 的输出；但运行时 `recordStopTranscript` / `recordPreCompactSnapshot` 的适配器门控为 `adapterId.startsWith('claude-')`（见 `src/hooks/transcript-observation-common.ts`），因此 codebuddy-ide 的 transcript 不会被主动读取。若未来 CodeBuddy IDE 明确支持 Claude Code JSONL 格式，解除门控即可启用。

### 3.4 改造 `handleStop`（hooks-cli.ts:693）

```ts
async function handleStop(input: StopInput) {
  // 原有 stop observation
  ...
  const sourceAdapter = detectAdapterByEvent(process.argv[2] || '');
  const fromClaude = sourceAdapter?.id === 'claude-code'
                  || sourceAdapter?.id === 'claude-internal';

  if (fromClaude && input.transcript_path) {
    const msg = safeReadLastAssistantMessage(input.transcript_path);
    if (msg?.text) {
      await client.addObservation({
        sessionId, projectPath, timestamp: Date.now(),
        type: 'agent_response',
        toolName: 'agent_response',
        toolInput: {
          source: 'transcript',
          has_images: msg.hasImages,
          image_refs: msg.imageRefs.slice(0, 10),
        },
        toolOutput: { response: truncateString(msg.text, 8000) }
      });
      // 同时更新 sdk_sessions.last_assistant_message
      await client.updateSessionField(sessionId, 'last_assistant_message',
        truncateString(msg.text, 4000));
    }
  }

  // 继续 triggerSummary
  ...
}
```

### 3.5 激活 `last_assistant_message` 死代码

- `src/sdk/prompts.ts:buildSummaryPrompt`：在模板中真正引用 `lastAssistantMessage`，作为 `## Agent's Last Response` 段落，截断 2000 字符。
- `src/services/worker/SDKAgent.ts:generateSummary`：构造参数时，优先从 `sdk_sessions.last_assistant_message` 字段取；若空则从 `observations` 里挑最新 `type='agent_response'`。
- `src/services/sqlite/migrations/`：新增迁移，给 `sdk_sessions` 表加 `last_assistant_message TEXT` 和 `transcript_path TEXT` 两列。

### 3.6 用户侧 attachments 元信息

`handleBeforeSubmitPrompt` 里读取 `input.attachments`：

```ts
if (input.attachments?.length) {
  await client.addObservation({
    sessionId, projectPath, timestamp: Date.now(),
    type: 'agent_response',
    toolName: 'user_attachments',
    toolInput: {
      attachments: input.attachments.map(a => ({
        type: a.type || a.mime_type,
        name: a.name || a.filename,
        size: a.size
      }))
    },
    toolOutput: { count: input.attachments.length }
  });
}
```

不存图片内容，仅元信息，避免撑大 SQLite。

### 3.7 PreCompact hook（增强）

Claude Code 在上下文压缩前触发 `PreCompact` 事件，stdin 也带 `transcript_path`：

- `src/adapters/claude-code.ts` 的 `EVENT_MAP` 加 `'PreCompact': 'beforePreCompact'`。
- `HOOKS_EVENTS` 加 `{ ideEvent: 'PreCompact', timeout: 30000 }`。
- `hooks-cli.ts` 新增 `handleBeforePreCompact`：同 3.4 逻辑写一条 `toolName='pre_compact_snapshot'` 的 observation，锁定压缩前的完整助手回复。

---

## 4. 数据流

```
用户发含图消息
    │
    ▼
Claude Code 多模态 LLM 生成文字回复（含图片描述）
    │
    ▼
Claude Code 把回复写进 ~/.claude/projects/<hash>/<session>.jsonl
    │
    ▼
Stop hook 触发 ─ stdin 带 transcript_path
    │
    ▼
hooks-cli.handleStop
    ├─ readLastAssistantMessage(transcript_path)
    ├─ addObservation(type='agent_response', response=<图片描述文本>)
    └─ updateSessionField('last_assistant_message', text)
    │
    ▼
triggerSummary(sessionId)
    │
    ▼
SDKAgent.generateSummary
    ├─ getObservationsBySession ← 含 agent_response
    ├─ getSessionByMemoryId    ← 含 last_assistant_message
    └─ buildSummaryPrompt
         observations = [...agent_response, ...tool_obs]
         last_assistant_message = <图片描述文本>
    │
    ▼
Summary LLM 看到助手原话 → 产出反映图片语义的 summary
```

---

## 5. 文件清单

| 文件 | 动作 |
|---|---|
| `src/shared/transcript-parser.ts` | **新增** |
| `src/types/hooks.ts` | 编辑：`StopInput` 增 2 字段 |
| `src/adapters/claude-code.ts` | 编辑：透传 `transcript_path`；新增 PreCompact 注册 |
| `src/adapters/claude-internal.ts` | 继承，仅做字段透传测试 |
| `src/adapters/codebuddy-ide.ts` | 编辑：透传 `transcript_path`（若存在） |
| `src/hooks-cli.ts` | 编辑：`handleStop` 扩展 + 新增 `handleBeforePreCompact` + `handleBeforeSubmitPrompt` 加 attachments |
| `src/sdk/prompts.ts` | 编辑：`buildSummaryPrompt` 激活 `lastAssistantMessage` |
| `src/services/worker/SDKAgent.ts` | 编辑：`generateSummary` 回填 `last_assistant_message` |
| `src/services/worker/client.ts` | 新增：`updateSessionField` 方法 |
| `src/services/sqlite/migrations/00X_add_last_assistant_message.sql` | 新增迁移 |
| `tests/transcript-parser.test.ts` | 新增 |
| `tests/handle-stop-transcript.test.ts` | 新增 |

---

## 6. 测试计划

### 6.1 单元测试

- `transcript-parser.test.ts`：4 条 fixture JSONL（纯文本回复 / 带图描述 / 带 tool_use / 破损行），断言输出。
- `handle-stop-transcript.test.ts`：mock transcript + mock `client.addObservation`，断言被以正确参数调用一次。

### 6.2 集成回归

10 组含图片的真实会话：
- 5 组 Claude Code
- 3 组 Claude Internal
- 2 组 CodeBuddy IDE（若 IDE 提供 transcript_path）

**目标**：Summary `learned/completed` 字段命中图片内容 ≥ 8/10（对照：修复前 0/10）。

### 6.3 回归矩阵

| 场景 | 预期 |
|---|---|
| Claude Code 截图对话 | summary 复述图片内容 |
| PreCompact 触发 | `observations` 多一条 `pre_compact_snapshot` |
| transcript 文件缺失/损坏 | handleStop 不抛异常，退化到原行为 |
| Cursor 链路 | 保持不变（已由 afterAgentResponse 处理） |

---

## 7. 非目标

- **不**支持图片内容本身的 embedding（Chroma 不存图）。
- **不**支持用户 attachments 二进制存储。
- **不**改动 Cursor / CodeBuddy 插件版适配器。
- **不**实现异步 summary 轮询（留给未来或 M2 一起）。

---

## 8. 风险

| 风险 | 缓解 |
|---|---|
| `transcript_path` 字段在新版 Claude Code 改名 | 同时读 `transcript_path` / `transcriptPath` / `transcript`，多 key fallback |
| JSONL 文件被 Claude Code 正在写（锁） | 用 `fs.createReadStream`，失败静默返回 null |
| 2000 字符截断把图片描述截掉 | 优先从 `agent_response` observation（8000 截断）走，`last_assistant_message` 只是备胎 |
| Windows 路径分隔符 | `path.normalize` + UTF-8 BOM 处理 |

---

## 9. 验收标准

- [ ] `readLastAssistantMessage` 单测 100% 通过
- [ ] 10 组回归会话 summary 命中图片语义 ≥ 8/10
- [ ] `sdk_sessions` 表新增两列，迁移脚本可幂等执行
- [ ] `PreCompact` 事件在真实 Claude Code 中能触发并写入 observation
- [ ] `handleStop` 在 transcript 读取失败时不影响原有流程

---

*下一里程碑：M2 RAG + SQLite 双重查询。*
