# claude-mem → agent-memory 合并方案

> 目标：把 `claude-mem`（v12.3.8，AGPL-3.0）的关键能力合入 `agent-memory`，并借此**彻底解决** `docs/summary-image-missing-analysis.md` 指出的"Claude Code 链路下 summary 丢失图片语义"问题。
>
> 基准分支：`cloudboyguo`
> 参考仓库位置：`E:\Github\agent-memory\claude-mem\`
> 主仓库位置：`E:\Github\agent-memory\src\`
> 生成时间：2026-04-21

---

## 0. TL;DR（一页纸结论）

1. **根因再确认**：Claude Code 的 hook 规范**没有** `afterAgentResponse` 事件，所以即便补注册也无效（见 `summary-image-missing-analysis.md` §3.3 / §10 方案 A）。
2. **真正可行的修复**：采用 claude-mem 的做法——**在 `Stop` hook 中读取 Claude Code 的 transcript JSONL 文件**（`~/.claude/projects/<project-hash>/*.jsonl`），提取最后一条 assistant 消息作为 `agent_response` observation 落库。
3. **合并思路**：**不**把 claude-mem 作为子包整包引入（架构、存储、Worker 端口都会冲突），而是**移植三个高价值模块**到 `agent-memory/src/`：
   - `TranscriptParser`（JSONL/多模态解析）
   - `TranscriptTailReader`（从 hook stdin 拿到 `transcript_path` 并读取尾部消息）
   - `AsyncSummaryPoller`（Stop hook 不阻塞，后台轮询 summary 状态）
4. **最小改动路径**：只改 `hooks-cli.ts:handleStop` + 新增 `src/shared/transcript-parser.ts` + 在 `claude-code.ts` / `claude-internal.ts` / `codebuddy-ide.ts` 三个适配器的 `Stop` 负载里透传 `transcript_path`。不改数据库 schema，不改 MCP，不改 Worker 端口。

---

## 1. 两仓对比快照

| 维度 | agent-memory（当前） | claude-mem（参考） | 合并取舍 |
|---|---|---|---|
| 许可证 | 私有 | **AGPL-3.0** | ⚠️ 只移植源码片段并重写，不整包引入，避免 AGPL 传染 |
| 运行时 | Node (tsx/tsc) | **Bun** + Express | 保留 Node；丢弃 Bun 运行时 |
| 存储 | SQLite `~/.config/agent-memory/agent-memory.db` | SQLite `~/.claude-mem/claude-mem.db` + Chroma 向量库 | 保留现有 SQLite；**不**引入 Chroma（下个阶段再说） |
| Worker 端口 | 3847 | 37700–37799 (UID hash) | 保留 3847 |
| 适配器层 | 5 个 IDE（Cursor/Claude Code/Claude Internal/CodeBuddy/CodeBuddy IDE） | 仅 Claude Code / Gemini / 原生 | agent-memory 更完整，**以它为主干** |
| 捕获 assistant 回复 | 仅 Cursor 的 `afterAgentResponse` 能捕获 | **读 transcript JSONL** | **移植 transcript 读取** ✅ |
| 多模态（图片） | 完全丢失 | 读文件名但丢语义；但 assistant 回复里的描述文本能拿到 | 通过 transcript 拿到 assistant 的图片描述文本即可解决 #1855 类问题 |
| Summary 触发 | Stop hook 同步调 `summarizeSession` | Stop hook 异步入队 + 轮询（最长 120 s） | **移植异步 + 轮询**（减少 hook 卡住 IDE 的风险） |
| MCP 工具 | `search`、`timeline` | `search`、`timeline` + Chroma 语义搜索 | 保持现状，第二阶段再加语义搜索 |
| 技能 / Skills | 无 | `mem-search` / `make-plan` / `do` / ... | 本次**不**移植（与 agent-memory 定位不符） |

---

## 2. 要解决的核心问题

### 2.1 问题回顾（参照 `summary-image-missing-analysis.md`）

- Summary #1855（Claude Code）`learned` 字段原文："没有保留具体命令、输出或图片中的报错文本"。
- 根因链：`claude-code.ts` 的 `HOOKS_EVENTS` 不含 `afterAgentResponse` → `hooks-cli.ts:646` 的 `handleAfterAgentResponse` 永远不会被触发 → `observations` 表里没有 `type='agent_response'` 的记录 → `buildSummaryPrompt` 输入中缺失助手侧的图片描述 → Summary LLM 只能基于工具骨架写结论。
- 方案 A（给 Claude Code 补注册 `afterAgentResponse`）已经在原文档中被否决：**Claude Code hook 规范根本没这个事件**，只支持 `PreToolUse / PostToolUse / Notification / Stop / SubagentStop / UserPromptSubmit / SessionStart / SessionEnd / PreCompact`。

### 2.2 claude-mem 的破局做法

claude-mem 的 `Stop` hook 处理器从 hook stdin 中拿到 Claude Code 注入的 `transcript_path` 字段，然后用 `transcript-parser.ts` 直接读取那个 JSONL 文件的**最后一条 assistant 消息**，抽取所有 `content[].type === 'text'` 的片段拼起来，交给 summary 管线作为 `last_assistant_message`。

这恰好是 `summary-image-missing-analysis.md` §10 的**方案 B**，而且 claude-mem 已经有可用实现可以参考移植。

---

## 3. 合并方案（分阶段）

### 阶段 A：止血（修复图片语义丢失） — 1~2 天

#### A.1 新增 `src/shared/transcript-parser.ts`

从 `claude-mem/src/shared/transcript-parser.ts` 移植并裁剪，只保留 Claude Code JSONL 分支。核心 API：

```ts
export interface AssistantMessage {
  text: string;               // 拼接后的纯文本
  hasImages: boolean;         // content 中是否出现过 image/image_url block
  imageRefs: string[];        // 图片来源（文件路径或 base64 摘要）
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

**实现要点**：
- 从文件尾部反向扫描（避免把整个 JSONL 读进内存），找到最后一条 `type === 'assistant'` 的 JSON 行。
- `message.content` 按 block 遍历：`text` 累加到 `text`；`image` / `image_url` 记入 `imageRefs` 并置 `hasImages=true`；`tool_use` 记入 `toolUses`。
- 容错：跳过坏行、截断行；`maxBytes` 默认 1 MiB。

#### A.2 在 Claude Code 适配器透传 `transcript_path`

`hooks-cli.ts` 里 `handleStop` 当前只能拿到 `StopInput & { response?; text? }`（`summary-image-missing-analysis.md` §4.2）。Claude Code 的 Stop hook stdin 其实包含 `transcript_path`、`cwd`、`stop_hook_active` 等字段，但 `StopInput` 接口没声明。

改动：
- 在 `src/types/hooks.ts` 的 `StopInput` 增加可选字段：`transcript_path?: string`、`stop_hook_active?: boolean`。
- 在 `src/adapters/claude-code.ts` 的 `normalizeInput`（如有）里把 `transcript_path` 原样透传进来。`claude-internal.ts` 继承，自动生效。
- `codebuddy-ide.ts` 同样处理（CodeBuddy IDE 的 Stop 事件若带 transcript 就用，没有就跳过）。

#### A.3 改造 `handleStop`（`hooks-cli.ts:693`）

核心新增逻辑（伪代码）：

```ts
async function handleStop(input: StopInput) {
  // 1) 原有逻辑：记录 stop observation
  const sourceAdapter = detectAdapterByEvent(process.argv[2] || '');
  const fromClaude = sourceAdapter?.id === 'claude-code'
                  || sourceAdapter?.id === 'claude-internal';

  // 2) 新增：对无 afterAgentResponse 的适配器，从 transcript 补录 assistant 回复
  if (fromClaude && input.transcript_path) {
    const msg = readLastAssistantMessage(input.transcript_path);
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
    }
  }

  // 3) 原有：triggerSummary（改成异步，见 A.4）
  ...
}
```

这样 `observations` 表就会出现 `type='agent_response'` 的记录，`SDKAgent.generateSummary` 在 `getObservationsBySession` 时就能捞到，直接喂给 `buildSummaryPrompt`，问题闭环。

#### A.4 激活 `last_assistant_message` 死代码（`summary-image-missing-analysis.md` §7）

- `src/sdk/prompts.ts:buildSummaryPrompt`：在模板中真正引用 `lastAssistantMessage`（截断到 2000 字符），作为 `## Agent's Last Response` 段落。
- `src/services/worker/SDKAgent.ts:generateSummary`：在构造 `buildSummaryPrompt` 参数时，从 `observations` 里挑出最新一条 `type='agent_response'`，填入 `last_assistant_message` 字段。

这一步是冗余保险：即便 observation 列表被截断到最近 20 条把 agent_response 挤掉了，`last_assistant_message` 仍会独立保留一份。

#### A.5 处理用户侧的图片 attachments（`summary-image-missing-analysis.md` §6）

- `handleBeforeSubmitPrompt`：读取 `input.attachments`，把附件元信息（type/name/size）作为一条 `type='agent_response'`、`toolName='user_attachments'` 的 observation 录入。
- 不上传图片内容，只留元数据，避免把大 base64 塞进 SQLite。

---

### 阶段 B：吸收 claude-mem 的架构红利 — 3~5 天

#### B.1 异步 Summary + 状态轮询

**移植对象**：`claude-mem` 的 `Stop` hook "入队后轮询 `/api/sessions/status`" 模式。

**动机**：当前 `handleStop` 调 `client.summarizeSession()` 后立刻返回，Worker 端是 fire-and-forget；虽然不阻塞 IDE，但**没有任何反馈**。claude-mem 的做法是 Stop hook 在 120 s 内轮询 Worker 队列，直到 summary 完成或超时，再返回 hook 成功。这样 IDE 端能在下一轮上下文里立刻看到摘要。

**改动点**：
- `WorkerService` 增加 `/api/session/status?sessionId=...` 端点，返回 `queued | running | done | failed`。
- `client.ts` 新增 `waitSummary(sessionId, { timeoutMs })` 方法。
- `hooks-cli.ts:handleStop` 在非 `stop_hook_active` 情况下调用 `waitSummary`，超时则默默返回（不报错）。

#### B.2 TranscriptTailReader 复用到 PreCompact

Claude Code 有 `PreCompact` 事件（上下文压缩前触发）。可以复用 `readLastAssistantMessage` 在 PreCompact 时做一次 snapshot 录入，进一步降低 summary 对 Stop 事件的依赖。

**改动点**：
- `claude-code.ts` 的 `EVENT_MAP` 增加 `'PreCompact': 'beforePreCompact'`。
- `hooks-cli.ts` 新增 `handleBeforePreCompact`，复用 A.1 的解析器把 transcript 写一份长摘要进 `observations`。
- `HOOKS_EVENTS` 增加 `{ ideEvent: 'PreCompact', timeout: 30000 }`。

#### B.3 `sessions` 表补字段（向后兼容）

为了更好支持 claude-mem 风格的回溯，建议加两个可空列（迁移脚本放在 `src/services/sqlite/migrations/`）：

```sql
ALTER TABLE sdk_sessions ADD COLUMN transcript_path TEXT;
ALTER TABLE sdk_sessions ADD COLUMN last_assistant_message TEXT;
```

- `transcript_path` 在 `SessionStart` / `UserPromptSubmit` 中拿到就写入。
- `last_assistant_message` 在 Stop 的 A.3 分支里顺手更新。

这两列完全可选，不影响现有查询。

---

### 阶段 C：可选 / 下阶段再议

| 特性 | 取舍建议 |
|---|---|
| Chroma 向量库 | 延后；当前 FTS5 已够用，引入 Chroma 会多一个原生依赖和外部服务 |
| claude-mem 的 Skills 系统（make-plan/do/...） | **不合并**，与 agent-memory 的"被动观察者"定位不符 |
| claude-mem 的 Bun Worker | **不合并**，agent-memory 已基于 Node，换运行时代价过大 |
| claude-mem 的 React 可视化面板（:37777） | 可选：若要引入，放 `web/` 子目录独立构建，避免污染主包 |
| claude-mem 的 prompts 表（DB 里存 prompt 模板） | 可选：能支持运行时热替换 prompt，B 阶段之后再评估 |

---

## 4. 冲突模块清单

| 模块 | agent-memory 现状 | claude-mem 现状 | 冲突等级 | 处置 |
|---|---|---|---|---|
| **Claude Code hook 注册** | `~/.claude/settings.json` hooks 段 | 同一个 settings.json hooks 段 | 🔴 高 | 两者并存会重复触发；安装器需检测并二选一，**不**并行安装 claude-mem 插件 |
| **Stop hook 处理器** | `handleStop`（同步入队） | 异步轮询 | 🟡 中 | 按阶段 B.1 重构 |
| **SQLite 数据目录** | `~/.config/agent-memory/` | `~/.claude-mem/` | 🟢 低 | 路径不同，不冲突 |
| **Worker 端口** | 3847 | 37700–37799 | 🟢 低 | 不冲突 |
| **MCP 工具名** | `search` / `timeline` | `search` / `timeline` | 🟡 中 | 两个 MCP server 同时在 Claude Desktop 注册会撞名；用户需选一；或给 agent-memory 的工具加前缀 `mem_search`（不建议，破坏兼容） |
| **Transcript 解析** | 无 | 有 | 🟢 低 | 新增模块，无冲突 |
| **依赖项 `@anthropic-ai/claude-agent-sdk`** | 未引入 | v0.1.76+ | 🟢 低 | 阶段 A 不需要；若未来引入需做 SDK 版本对齐 |
| **许可证** | 私有 | AGPL-3.0 | 🔴 高 | **关键**：不要直接 `cp` 源文件进 `src/`。阶段 A/B 的移植需要重写，保留算法思路但不复制成段源码；或把 `src/shared/transcript-parser.ts` 单独放在标注 AGPL 的子目录并在 LICENSE 中声明 |

---

## 5. 新增功能清单（落地到 agent-memory 之后）

| # | 功能 | 所在文件 | 阶段 |
|---|---|---|---|
| F1 | Claude Code transcript JSONL 解析器 | `src/shared/transcript-parser.ts`（新） | A |
| F2 | Stop hook 从 transcript 补录 assistant 回复 | `src/hooks-cli.ts:handleStop` | A |
| F3 | `StopInput` 增加 `transcript_path` 字段 | `src/types/hooks.ts` | A |
| F4 | `buildSummaryPrompt` 真正使用 `last_assistant_message` | `src/sdk/prompts.ts` | A |
| F5 | `SDKAgent.generateSummary` 回填 `last_assistant_message` | `src/services/worker/SDKAgent.ts` | A |
| F6 | 用户附件元信息 observation | `src/hooks-cli.ts:handleBeforeSubmitPrompt` | A |
| F7 | Worker `/api/session/status` 端点 | `src/services/worker/WorkerService.ts` | B |
| F8 | Stop hook 异步轮询 summary 完成 | `src/hooks-cli.ts:handleStop` + `client.ts` | B |
| F9 | `PreCompact` hook 捕获 transcript snapshot | `src/adapters/claude-code.ts`、`src/hooks-cli.ts` | B |
| F10 | `sdk_sessions` 表新增 `transcript_path` / `last_assistant_message` 列 | `src/services/sqlite/migrations/` | B |

---

## 6. 验证计划

### 6.1 单元测试（放在 `tests/`）

- `transcript-parser.test.ts`：用 claude-mem 仓库下的 fixture JSONL，校验 `readLastAssistantMessage` 返回的 `text`、`hasImages`、`imageRefs`、`toolUses`。
- `handle-stop.test.ts`：mock 一个 transcript，跑 `handleStop`，断言 `client.addObservation` 被以 `type='agent_response'` 调用一次。

### 6.2 集成场景回归

对照 `summary-image-missing-analysis.md` 的现象表：

| 场景 | 预期 |
|---|---|
| Claude Code 用户发送报错截图 | 新 summary 的 `learned` / `completed` 字段能复述图片里的错误信息 |
| CodeBuddy IDE 用户发送截图（若 IDE 在 Stop 事件透传 transcript_path） | 同上 |
| Cursor 用户发送截图 | 保持原行为（由 `afterAgentResponse` 捕获） |
| Claude Code 长对话触发 `PreCompact` | `observations` 表多出一条 `type='agent_response'`、`toolName='pre_compact_snapshot'` |

### 6.3 A/B 对比

迁移前后各跑 10 组含图片的真实会话，人工打分 summary 是否反映图片语义。目标：`Claude Code` 链路从 **0/10** 提升到 **≥ 8/10**。

---

## 7. 时间表与里程碑

| 里程碑 | 工期 | 交付物 |
|---|---|---|
| M1 | 0.5 天 | 新增 `transcript-parser.ts` + 单测通过 |
| M2 | 0.5 天 | `handleStop` 改造 + `StopInput` 字段扩展 |
| M3 | 0.5 天 | `buildSummaryPrompt` / `SDKAgent.generateSummary` 激活 `last_assistant_message` |
| M4 | 0.5 天 | attachments 元信息 observation |
| M5 | 1 天 | 集成回归 10 组场景，产出对比报告 |
| **阶段 A 完成（图片语义问题闭环）** | ~3 天 | — |
| M6 | 1 天 | Worker `/api/session/status` + hook 轮询 |
| M7 | 1 天 | `PreCompact` hook 接入 |
| M8 | 0.5 天 | `sdk_sessions` 表迁移 + 回灌 |
| **阶段 B 完成** | ~6 天总计 | — |

---

## 8. 风险与回退

| 风险 | 缓解 |
|---|---|
| AGPL 传染 | 只保留算法思路 + 重写实现；在 `NOTICE` / `THIRD_PARTY.md` 声明参考来源 |
| `transcript_path` 在不同 Claude Code 版本 payload 里字段名变化 | 同时读 `transcript_path` / `transcriptPath` / `transcript`，做好 fallback |
| transcript 文件被锁/读失败 | 包在 try/catch，失败回退到原有 `input.text || input.response` 分支 |
| 读 transcript 耗时过长阻塞 Stop hook | `maxBytes` 限制 + 倒序流式读；配合阶段 B 的异步模式把主体工作放到 Worker 端 |
| 异步轮询带来新的 hang | 120 s 硬超时；`stop_hook_active=true` 时跳过轮询避免递归 |
| `PreCompact` 在不同版本 Claude Code 中不一定触发 | 作为增强项，缺失不影响阶段 A 的主修复 |

---

## 9. 附录：关键引用

- `docs/summary-image-missing-analysis.md` §3.3（Claude Code 适配器缺 `afterAgentResponse`）
- `docs/summary-image-missing-analysis.md` §7（`last_assistant_message` 死代码）
- `docs/summary-image-missing-analysis.md` §10 方案 B（从 transcript 读取 —— 本方案即其实现化）
- `claude-mem/src/shared/transcript-parser.ts`（参考实现）
- `claude-mem/plugin/scripts/worker-service.cjs`（Stop hook 异步轮询模式参考）

---

*本方案聚焦"最小改动闭环图片语义问题"→"选择性吸收 claude-mem 的架构红利"两段式推进，不做整包合并，规避 AGPL 与运行时差异带来的系统性风险。*
