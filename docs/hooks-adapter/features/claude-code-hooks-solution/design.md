# Claude Code Hooks 缺口补偿方案

> 本文档专门说明：当 `Claude Code` 没有 `afterAgentResponse`、`afterAgentThought` 这类理想 Hook 时，`agent-memory` 如何利用现有 Hook 组合出"可用于记忆系统"的最小闭环。
>
> ⭐ **2026-04-09 源码分析更新**：通过阅读 Claude Code 完整源码，发现了多个此前未知的重要能力。

最后更新：2026-04-09

---

## 一、先说结论

**Claude Code 的 Hook 节点很多，但大多数是会话、工具、权限、任务、压缩等生命周期事件；并不存在官方的 `afterAgentThought`，也没有一个与 `afterAgentResponse` 完全等价的逐轮回复 Hook。**

对记忆系统来说，Claude Code 当前可行的解决方案不是"把缺失 Hook 直接补出来"，而是：

- **用 `UserPromptSubmit` 保存任务目标**
- **用 `PostToolUse` 保存执行轨迹**
- **用 `Stop.last_assistant_message` 兜底保存主 Agent 最终回复**
- **必要时用 `SubagentStop.last_assistant_message` 补采子 Agent 最终回复**
- **⭐ 用 `PostCompact.compact_summary` 在长会话压缩时获取阶段性总结**
- **⭐ 用 `transcript_path` 直接读取完整的 JSONL 会话 transcript 文件**

也就是说，Claude Code 的方案本质上是：

\[
用户意图 + 工具轨迹 + 最终回复 + 阶段性总结 + Transcript 文件 = 记忆系统可用的会话重建材料
\]

---

## 二、源码分析：发现此前没注意到的重大能力

> 以下发现来自对 Claude Code 源码的深度阅读（`f:\claude-code\src`）。

### 2.1 ⭐ Transcript 文件：完整的会话历史 JSONL

**这是最重大的发现。** Claude Code 的每个 Hook 事件的 `BaseHookInput` 中都包含一个字段：

```typescript
// src/entrypoints/sdk/coreSchemas.ts
export const BaseHookInputSchema = lazySchema(() =>
  z.object({
    session_id: z.string(),
    transcript_path: z.string(),   // ← 每个事件都有
    cwd: z.string(),
    permission_mode: z.string().optional(),
    agent_id: z.string().optional(),
    agent_type: z.string().optional(),
  }),
)
```

`transcript_path` 指向一个 **JSONL 格式**的完整会话日志文件，位于 `~/.claude/projects/<sanitized-path>/<session-id>/transcript.jsonl`。

源码中可以看到它包含了：
- 所有 `user` 和 `assistant` 类型的 message
- 完整的 tool_use / tool_result 块
- attachment / system 消息
- content-replacement 记录
- compact boundary 标记

**这意味着：我们不需要等 `afterAgentResponse` 事件——理论上可以直接读 transcript 文件来获取完整对话历史。**

#### 实际约束

- transcript 文件可能很大（源码中 `MAX_TRANSCRIPT_READ_BYTES = 50MB`）
- 格式是 JSONL，每行一个 JSON entry
- 子 Agent 的 transcript 在 `subagents/agent-<id>.jsonl`
- 需要解析 entry 类型来区分 user/assistant/tool 消息

#### 对记忆系统的价值

**在 `Stop` 事件触发时，可以去读 transcript 文件来获取完整的会话记录**，而不是仅依赖 `last_assistant_message`（只有最后一条 assistant 消息的文本内容）。

### 2.2 ⭐ `PostCompact.compact_summary`：阶段性压缩总结

```typescript
// src/entrypoints/sdk/coreSchemas.ts
export const PostCompactHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('PostCompact'),
      trigger: z.enum(['manual', 'auto']),
      compact_summary: z
        .string()
        .describe('The conversation summary produced by compaction'),
    }),
  ),
)
```

当 Claude Code 执行上下文压缩（auto-compact）时，`PostCompact` 事件会携带 `compact_summary`——这是**由模型生成的阶段性对话摘要**。

对记忆系统来说，这相当于 **Claude Code 自己帮你做了一次 Summary**，而且是基于完整上下文做的。

### 2.3 ⭐ `StopFailure`：失败场景补充

```typescript
export const StopFailureHookInputSchema = lazySchema(() =>
  BaseHookInputSchema().and(
    z.object({
      hook_event_name: z.literal('StopFailure'),
      error: SDKAssistantMessageErrorSchema(),
      error_details: z.string().optional(),
      last_assistant_message: z.string().optional(),
    }),
  ),
)
```

当 Agent 响应失败时（API 错误、超限等），`StopFailure` 会携带错误信息和可能的最后 assistant 消息。这对记忆系统记录"这轮失败了，失败原因是什么"很有价值。

### 2.4 ⭐ Claude Code 内置记忆系统的工作方式

源码揭示了 Claude Code 自己有一套完整的记忆抽取机制（`src/services/extractMemories/`）：

1. **在每轮 Stop 之后**，通过 `stopHooks.ts` 触发 `executeExtractMemories()`
2. 抽取使用 **forked agent 模式**——fork 一个完整的会话副本，让 AI 子进程去抽取记忆
3. 记忆存储在 `~/.claude/projects/<path>/memory/` 下的 markdown 文件里
4. 记忆有四种类型：user、feedback、project、reference
5. 使用 `MEMORY.md` 作为索引文件
6. 支持自动梦境整理（`autoDream`）

**启示**：我们的记忆系统和 Claude Code 内置记忆系统是并行运行的。可以考虑**直接读取 Claude Code 生成的记忆文件**作为额外的上下文来源。

### 2.5 ⭐ Session Memory（会话笔记）

源码中还有一个 `SessionMemory` 机制（`src/services/SessionMemory/`）：

1. 它在后台周期性运行，提取当前会话的关键信息
2. 使用 `postSamplingHook`（模型每次采样后触发）
3. 维护一个结构化的 markdown 笔记文件，包含：
   - Session Title
   - Current State
   - Task specification
   - Files and Functions
   - Workflow
   - Errors & Corrections
   - Key results
   - Worklog

这个文件路径可以通过读取 Claude Code 配置目录获得。

### 2.6 `last_assistant_message` 的源码实现

源码中确认了 `last_assistant_message` 的生成逻辑：

```typescript
// src/utils/hooks.ts executeStopHooks()
const lastAssistantMessage = messages
  ? getLastAssistantMessage(messages)
  : undefined
const lastAssistantText = lastAssistantMessage
  ? extractTextContent(lastAssistantMessage.message.content, '\n').trim() ||
    undefined
  : undefined
```

它是从 messages 数组中取最后一个 `assistant` 类型消息，然后提取其中所有 `text` 类型的 content block，用换行拼接。

**重要**：它只提取了 text block，**tool_use block 不在其中**。所以 `last_assistant_message` 只有 Agent 的文字回复，没有工具调用信息。

---

## 三、为什么"Hook 很多"仍然不等于"回复能力完整"

很多人看到 Claude Code 官方列出了大量 Hook，就会自然以为：

- 应该能拿到每一轮 Agent 回复
- 应该能拿到 Agent 的思考过程
- 缺失的能力应该只要多注册几个 Hook 就能补齐

**这里最大的误区是把"事件数量"误认为"事件语义覆盖度"。**

Claude Code 的大量 Hook，主要覆盖的是：

- **会话生命周期**：`SessionStart`、`SessionEnd`
- **用户输入与结束**：`UserPromptSubmit`、`Stop`、`StopFailure`
- **工具执行**：`PreToolUse`、`PostToolUse`、`PostToolUseFailure`
- **权限与通知**：`PermissionRequest`、`PermissionDenied`、`Notification`
- **任务与子代理**：`TaskCreated`、`TaskCompleted`、`SubagentStart`、`SubagentStop`、`TeammateIdle`
- **上下文压缩**：`PreCompact`、`PostCompact`
- **其他**：`Setup`、`ConfigChange`、`CwdChanged`、`FileChanged`、`Elicitation`、`InstructionsLoaded`、`WorktreeCreate`、`WorktreeRemove`

这些事件都很有价值，但它们没有提供：

- **主 Agent 每一轮完整回复的稳定回调**（最接近的是 `Stop` 的 `last_assistant_message`，但只在停止时触发一次）
- **模型内部 thought / 推理链的外显回调**（完全不存在）

**但源码分析发现了一个重要的旁路：每个 Hook 事件都携带 `transcript_path`，可以直接读取完整的 JSONL 会话历史。**

---

## 四、记忆系统真正需要的是什么

对于 `agent-memory`，最关键的不是 Hook 名字本身，而是以下三类信息：

### 1. 用户这一轮到底想做什么

如果没有这个信息，后续再多工具日志也会丢语义。  
Claude Code 中最合适的来源是：`UserPromptSubmit.prompt`。

### 2. Agent 中间做了哪些动作

这部分决定后续 Summary 能不能解释"它为什么得到这个结果"。  
Claude Code 中最合适的来源是：`PostToolUse`。

### 3. Agent 最后到底回复了什么

这部分是会话最重要的输出信息。  
Claude Code 中来源有三个，按优先级排列：

1. **`transcript_path` → 读 JSONL 文件**：最完整，包含所有 assistant 消息（⭐ 新发现）
2. **`Stop.last_assistant_message`**：官方提供的最终文本回复
3. **`PostCompact.compact_summary`**：长会话场景下的阶段性总结（⭐ 新发现）

---

## 五、Claude Code 里哪些 Hook 真正有用

### 5.1 主流程中最重要的节点

| Hook | 作用 | 能补什么 | 当前状态 |
|:---|:---|:---|:---|
| `SessionStart` | 初始化或恢复会话 | 建 Session、准备上下文 | ✅ 已使用 |
| `UserPromptSubmit` | 用户提交 prompt 前 | 记录任务目标、注入记忆上下文 | ✅ 已使用 |
| `PreToolUse` | 工具执行前 | Shell 安全检查 | ✅ 已使用 |
| `PostToolUse` | 工具执行后 | 记录执行轨迹 | ✅ 已使用 |
| `Stop` | 主 Agent 完成响应 | `last_assistant_message` + `transcript_path` + 触发 Summary | ✅ 已使用 |
| `SessionEnd` | 会话结束 | 收尾兜底 | ✅ 已使用 |

### 5.2 ⭐ 高价值未接入节点（源码分析新发现）

| Hook | 价值 | 为什么重要 | 优先级 |
|:---|:---|:---|:---|
| **`PostCompact`** | 获取 `compact_summary` | Claude Code 自动生成的阶段性对话摘要，相当于免费的 Summary | 🔴 高 |
| **`SubagentStop`** | 获取子 Agent 的 `last_assistant_message` + `agent_transcript_path` | 多代理工作流下补足子流程输出 | 🟡 中 |
| **`StopFailure`** | 获取失败原因 `error` + `error_details` | 让失败场景的记忆也完整 | 🟡 中 |
| **`PostToolUseFailure`** | 获取工具失败记录 | 更完整地解释任务过程 | 🟢 低 |

### 5.3 ⭐ 旁路方案：直接读 Transcript 文件

**这不是一个 Hook，而是比任何单一 Hook 都更强大的能力。**

所有 Hook 事件的 `BaseHookInput` 都包含 `transcript_path` 字段。这个文件是 JSONL 格式的完整会话 transcript，包含：

- 所有 `user` message（用户输入）
- 所有 `assistant` message（Agent 的完整回复，含 text + tool_use blocks）
- 所有 `tool_result`（工具执行结果）
- `system` message（系统消息）
- `attachment` message（附件/Hook 结果）

**在 `Stop` 事件触发时读 transcript 文件，理论上就能获取到完整的对话历史——这等于绕过了"没有 `afterAgentResponse`"的限制。**

限制：
- 文件可能很大（最大 50MB），不适合全量读取
- 需要 JSONL 解析能力
- 需要区分 entry 类型（`TranscriptMessage` vs `ContentReplacementEntry` 等）
- 应该只读取 **最新一轮**（从上次 Stop 到本次 Stop 之间）的增量

### 5.4 ⭐ 旁路方案：读取 Claude Code 内置记忆

Claude Code 自己有完整的记忆抽取系统，记忆文件存储在：

```
~/.claude/projects/<sanitized-cwd>/memory/MEMORY.md   (索引文件)
~/.claude/projects/<sanitized-cwd>/memory/*.md         (主题文件)
```

这些记忆文件是 Claude Code 的 AI 子进程在每轮 Stop 后自动抽取生成的（由 `extractMemories.ts` 驱动），包含了 user preference、project knowledge、feedback 等高质量结构化信息。

**agent-memory 可以在 `SessionStart` 或 `UserPromptSubmit` 时扫描这些文件，作为额外的上下文来源。**

### 5.5 明确补不了的能力

| 目标能力 | Claude Code 官方现状 | 旁路可行性 | 结论 |
|:---|:---|:---|:---|
| `afterAgentResponse` 等价能力 | 无同名 Hook；`Stop.last_assistant_message` 接近 | ⭐ 读 transcript 文件可获取**完整逐轮回复** | **可以通过旁路完全补齐** |
| `afterAgentThought` 等价能力 | 无官方 Hook | transcript 文件也不含 thought（extended thinking 不记录在 transcript 中） | **不能真实补齐** |

---

## 六、当前方案与增强路线

### 6.1 当前方案（已落地）

```
UserPromptSubmit → 补录 prompt → Observation
PostToolUse → 记录工具轨迹 → Observation  
Stop → last_assistant_message → Observation + 触发 Summary
```

### 6.2 ⭐ 增强方案 A：接入 `PostCompact`（推荐，成本最低）

```
PostCompact → compact_summary → 直接作为一次 Observation 存入
```

好处：
- Claude Code 自动生成的高质量阶段性总结，不需要我们消耗 LLM token
- 格式已经是自然语言摘要
- 只在 compact 发生时触发，频率不高，不浪费资源

### 6.3 ⭐ 增强方案 B：在 `Stop` 时读 Transcript 增量

```
Stop → 读 transcript_path → 解析最近一轮的 assistant messages → 完整记录
```

好处：
- 能拿到完整的逐轮回复，不仅是最后一条
- 解决了 `last_assistant_message` 只有 text 没有 tool_use 信息的问题
- 对 Summary 质量提升最大

成本：
- 需要实现 JSONL 解析器
- 需要增量读取逻辑（只读本轮新增内容）
- transcript 文件 I/O 可能有性能开销

### 6.4 ⭐ 增强方案 C：读取 Claude Code 内置记忆

```
SessionStart → 扫描 ~/.claude/projects/<path>/memory/*.md → 注入上下文
```

好处：
- Claude Code 自己的 AI 子进程已经做了高质量的记忆抽取
- 我们不需要重复做同样的事，直接利用它的输出
- 记忆文件格式标准（markdown + frontmatter）

适合场景：
- 作为 `agent-memory` 上下文注入的补充来源
- 特别是在 `agent-memory` 的 summary 还没跑完时，先用 Claude Code 的记忆顶上

### 6.5 增强方案 D：接入 `SubagentStop`

```
SubagentStop → last_assistant_message + agent_transcript_path → Observation
```

适合场景：多代理协作（Claude Code 的 Agent Tool 调用场景）

---

## 七、为什么 `afterAgentThought` 基本补不出来

`afterAgentThought` 的价值在于记录模型"为什么这么做"。  
这和记录"做了什么"是两回事。

通过源码确认：

- Claude Code 的 transcript 文件**不包含 extended thinking 内容**
- `last_assistant_message` 只提取 `text` 类型的 content block
- 没有任何 Hook 暴露 thought / reasoning chain

所以 `afterAgentThought` 只能通过**行为推断**（从工具调用轨迹反推意图）来弱近似，不能真实恢复。

---

## 八、当前项目里已经落地了什么

### 8.1 已落地

- **`UserPromptSubmit` → `beforeSubmitPrompt`**
  - 初始化会话
  - 注入历史记忆上下文
  - 补录用户 prompt，避免 Summary 失去任务语义

- **`PostToolUse` → 二次路由**
  - Shell → `afterShellExecution`
  - MCP → `afterMCPExecution`
  - 文件编辑 → `afterFileEdit`

- **`Stop` → `stop`**
  - 兜底记录最终回复（目前用 `text`/`response` 字段）
  - 触发 Session Summary 生成

- **`SessionStart` / `SessionEnd`**
  - 会话初始化与收尾兜底

### 8.2 ⭐ 推荐优先落地的增强项

| 优先级 | 增强项 | 预估工作量 | 收益 |
|:---|:---|:---|:---|
| P0 | `Stop` 中优先消费 `last_assistant_message` | 1h | 直接拿到官方提供的完整文本回复 |
| P1 | 接入 `PostCompact` 获取 `compact_summary` | 2h | 长会话场景自动获得阶段性总结 |
| P2 | `Stop` 时增量读 transcript 文件 | 4-6h | 获取完整逐轮对话记录，Summary 质量跃升 |
| P3 | `SessionStart` 时扫描 Claude Code 内置记忆 | 3h | 补充高质量上下文来源 |
| P4 | 接入 `SubagentStop` | 2h | 多代理场景覆盖 |
| P5 | 接入 `StopFailure` | 1h | 失败场景记录 |

---

## 九、⭐ Claude Code 内部记忆系统架构参考

通过源码分析，Claude Code 的记忆系统架构如下（供 agent-memory 对齐参考）：

```
┌──────────────────────────────────────────────────────┐
│                   Claude Code 进程                    │
│                                                      │
│  主 Agent 对话循环                                    │
│     ↓ (每轮 Stop 后)                                  │
│  stopHooks.ts                                        │
│     ├→ executeExtractMemories()  [fire-and-forget]   │
│     │     └→ runForkedAgent()    [fork 会话副本]      │
│     │           └→ 读/写 memory/*.md                  │
│     │                                                │
│     ├→ executeAutoDream()        [定期整理]           │
│     │                                                │
│     └→ executePromptSuggestion() [建议优化]           │
│                                                      │
│  SessionMemory (postSamplingHook)                    │
│     └→ 周期性更新 session-memory.md                   │
│                                                      │
│  Transcript Storage                                  │
│     └→ JSONL 实时写入 transcript.jsonl               │
└──────────────────────────────────────────────────────┘

存储位置：
~/.claude/projects/<sanitized-cwd>/
  ├── <session-id>/
  │   ├── transcript.jsonl          ← 完整对话历史
  │   ├── session-memory.md         ← Session Memory 笔记
  │   └── subagents/
  │       └── agent-<id>.jsonl      ← 子 Agent transcript
  └── memory/
      ├── MEMORY.md                 ← 记忆索引
      ├── user_role.md              ← 主题记忆文件
      ├── project_context.md
      └── ...
```

---

## 十、用一句话概括 Claude Code 方案

**Claude Code 的解决方案不只是"用 Hook 拼"，源码分析发现它还提供了 `transcript_path`（完整会话 JSONL）和 `PostCompact.compact_summary`（阶段性总结）这两个强力旁路能力。结合 `UserPromptSubmit`、`PostToolUse`、`Stop` 等 Hook，完全可以重建出高质量的会话记忆——唯一真正补不了的只有 `afterAgentThought`（模型内部推理链）。**

---

## 十一、文档关系

- **总览文档**：`docs/MULTI-PLATFORM-HOOKS-ADAPTATION.md`
- **Claude Code 接入设计**：`docs/superpowers/specs/2026-04-08-claude-code-provider-design.md`
- **本文档**：专门解释 Claude Code 为什么"Hook 多但回复/思考能力仍有缺口"，以及当前项目如何做补偿
- **源码参考**：`f:\claude-code\src`（Claude Code 完整源码）
