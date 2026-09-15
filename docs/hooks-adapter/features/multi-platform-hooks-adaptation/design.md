# 多平台 Hooks 适配策略

> 本文档介绍 AgentMemory 如何在四个不同的 AI 编程助手平台（Cursor、CodeBuddy 插件版、CodeBuddy IDE、Claude Code）上，通过各平台差异化的 Hooks 事件实现**同一套记忆功能**。
>
> 如需单独理解 `Claude Code` 为什么“Hook 很多但仍缺少 `afterAgentResponse` / `afterAgentThought` 等价能力”，以及当前项目如何补偿，参见：`docs/CLAUDE-CODE-HOOKS-SOLUTION.md`。

最后更新：2026-04-09

---

## 一、问题背景

AgentMemory 的记忆功能依赖**四个核心能力**：

| 能力 | 说明 |
|:---|:---|
| **① 会话初始化 + 上下文注入** | 新会话开始时创建 Session，并将历史记忆注入到 Agent 的 Prompt 中 |
| **② 实时操作记录** | Agent 执行工具（Shell/MCP/文件编辑）后，实时捕获并记录为 Observation |
| **③ Agent 回复记录** | 捕获 Agent 的每轮回复内容，作为最有价值的会话数据 |
| **④ 会话总结生成** | 会话结束时，聚合所有 Observation 生成 Summary |

然而，四个平台提供的 Hooks 事件**名称不同、粒度不同、能力不同**。AgentMemory 需要一套适配层，将各平台的 Hooks 统一映射到同一套内部处理逻辑。

---

## 二、核心映射关系总表

> 💡 **本表是全文档最重要的参考表**。它回答了一个核心问题：**Mem 需要什么能力 → 对应内部哪个事件 → 各平台用什么 Hook 实现**。

### 2.1 Mem 系统需要的 Hook 点

| # | Mem 内部事件名 | Hook 类型 | 作用 | 对应 Handler 函数 |
|:-:|:---|:---:|:---|:---|
| 1 | `sessionStart` | 生命周期 | 创建新会话（Session），初始化存储，注入环境变量 `CODEBUDDY_MEM_SESSION_ID` | `handleSessionStart()` |
| 2 | `beforeSubmitPrompt` | 控制型 | 初始化会话 + 从记忆库构建上下文 → 通过 `additional_context` 注入给 Agent | `handleBeforeSubmitPrompt()` |
| 3 | `beforeShellExecution` | 控制型 | Shell 命令执行前的安全检查（敏感信息检测） | `handleBeforeShellExecution()` |
| 4 | `afterShellExecution` | 监控型 | 记录 Shell 命令执行结果（command、output、exit_code），生成 Observation | `handleAfterShellExecution()` |
| 5 | `afterMCPExecution` | 监控型 | 记录 MCP 工具调用结果（tool_name、input、result），生成 Observation | `handleAfterMCPExecution()` |
| 6 | `afterFileEdit` | 监控型 | 记录文件编辑操作（file_path、diff），生成 Observation | `handleAfterFileEdit()` |
| 7 | `afterSearchReplaceFileEdit` | 监控型 | 记录搜索替换操作（file_path、edits[]），生成 Observation | `handleAfterSearchReplaceFileEdit()` |
| 8 | `afterAgentResponse` | 监控型 | 捕获 Agent 每轮完整回复内容，是**最有价值的会话数据** | `handleAfterAgentResponse()` |
| 9 | `afterAgentThought` | 监控型 | 捕获 Agent 的思考/推理过程 | `handleAfterAgentThought()` |
| 10 | `stop` | 生命周期 | 会话停止时触发 Summary 生成（聚合所有 Observation → 会话总结） | `handleStop()` |
| 11 | `sessionEnd` | 生命周期 | 会话结束兜底，确保 Summary 一定被生成 | `handleSessionEnd()` |

### 2.2 四平台 Hook 映射关系

下表展示了 Mem 系统每个内部事件在四个平台上分别使用**哪个 IDE 原生 Hook** 来实现。

| Mem 内部事件 | Cursor | CodeBuddy 插件版 | CodeBuddy IDE | Claude Code |
|:---|:---|:---|:---|:---|
| `sessionStart` | `sessionStart` | — *(未注册)* | `SessionStart` | `SessionStart` |
| `beforeSubmitPrompt` | `beforeSubmitPrompt` | `beforeSubmitPrompt` | `UserPromptSubmit` | `UserPromptSubmit` |
| `beforeShellExecution` | *(未注册)* | *(未注册)* | `PreToolUse` *(matcher: Bash)* | `PreToolUse` *(matcher: Bash)* |
| `afterShellExecution` | `afterShellExecution` | `afterShellExecution` | `PostToolUse` → 路由 | `PostToolUse` → 路由 |
| `afterMCPExecution` | `afterMCPExecution` | `afterMCPExecution` | `PostToolUse` → 路由 | `PostToolUse` → 路由 |
| `afterFileEdit` | `afterFileEdit` | `afterFileEdit` | `PostToolUse` → 路由 | `PostToolUse` → 路由 |
| `afterSearchReplaceFileEdit` | — *(未注册)* | `afterSearchReplaceFileEdit` | — *(无对应)* | — *(无对应)* |
| `afterAgentResponse` | `afterAgentResponse` ✅ | `afterAgentResponse` ✅ | ❌ **不支持** | ❌ **不支持** |
| `afterAgentThought` | `afterAgentThought` ✅ | `afterAgentThought` ✅ | ❌ **不支持** | ❌ **不支持** |
| `stop` | `stop` | `stop` | `Stop` | `Stop` |
| `sessionEnd` | `sessionEnd` | *(未注册)* | `SessionEnd` | `SessionEnd` |

**图例说明**：
- **直接同名** — IDE 原生事件名与 Mem 内部事件名一致，适配器直接透传
- **`PostToolUse` → 路由** — IDE 只提供统一的 `PostToolUse` 事件，适配器根据输入字段二次路由到具体 Handler
- **❌ 不支持** — IDE 不提供该事件，Mem 通过 workaround 补救（详见第四章）
- **— *(未注册)*  / *(无对应)*** — 该平台未注册或不具备该事件

### 2.3 实际注册的 IDE Hook 清单

下表从**各平台视角**出发，列出每个平台实际注册了哪些 IDE Hook，以及每个 Hook 最终映射到 Mem 的哪些内部事件。

| 平台 | 实际注册的 IDE Hook | 映射到 Mem 内部事件 | 超时 |
|:---|:---|:---|:---:|
| **Cursor** | `beforeSubmitPrompt` | → `beforeSubmitPrompt` | 10s |
| | `afterShellExecution` | → `afterShellExecution` | 10s |
| | `afterMCPExecution` | → `afterMCPExecution` | 10s |
| | `afterFileEdit` | → `afterFileEdit` | 10s |
| | `afterAgentResponse` | → `afterAgentResponse` | 10s |
| | `afterAgentThought` | → `afterAgentThought` | 10s |
| | `stop` | → `stop` | 30s |
| **CodeBuddy 插件版** | `beforeSubmitPrompt` | → `beforeSubmitPrompt` | — |
| | `afterShellExecution` | → `afterShellExecution` | — |
| | `afterMCPExecution` | → `afterMCPExecution` | — |
| | `afterFileEdit` | → `afterFileEdit` | — |
| | `stop` | → `stop` | — |
| **CodeBuddy IDE** | `UserPromptSubmit` | → `beforeSubmitPrompt` | 10000ms |
| | `PreToolUse` *(matcher: Bash)* | → `beforeShellExecution` | 10000ms |
| | `PostToolUse` | → `afterShellExecution` / `afterMCPExecution` / `afterFileEdit` *(二次路由)* | 10000ms |
| | `Stop` | → `stop` | 30000ms |
| | `SessionStart` | → `sessionStart` | 15000ms |
| | `SessionEnd` | → `sessionEnd` | 10000ms |
| **Claude Code** | `UserPromptSubmit` | → `beforeSubmitPrompt` | 10000ms |
| | `SessionStart` | → `sessionStart` | 15000ms |
| | `PreToolUse` *(matcher: Bash)* | → `beforeShellExecution` | 10000ms |
| | `PostToolUse` | → `afterShellExecution` / `afterMCPExecution` / `afterFileEdit` *(二次路由)* | 10000ms |
| | `Stop` | → `stop` | 30000ms |
| | `SessionEnd` | → `sessionEnd` | 10000ms |

### 2.4 PostToolUse 二次路由规则对比

CodeBuddy IDE 和 Claude Code 都使用统一的 `PostToolUse` 事件，但二次路由策略不同：

| 判断条件 | CodeBuddy IDE 路由结果 | Claude Code 路由结果 |
|:---|:---|:---|
| `tool_name === 'Bash'` | — *(不依赖 tool_name)* | → `afterShellExecution` |
| 输入含 `command` 或 `exit_code` 字段 | → `afterShellExecution` | → `afterShellExecution` |
| `tool_name` 以 `mcp__` 开头 | — *(不依赖 tool_name)* | → `afterMCPExecution` |
| 输入含 `mcp_server` 或 `tool_name` 字段 | → `afterMCPExecution` | — *(优先用 mcp__ 前缀)* |
| `tool_name ∈ {Write, Edit, FileWrite, FileEdit, NotebookEdit}` | — *(不依赖 tool_name)* | → `afterFileEdit` |
| 输入含 `file_path` 字段 | → `afterFileEdit` | → `afterFileEdit` |
| 以上都不匹配 | → `afterShellExecution` *(兜底)* | → `afterShellExecution` *(兜底)* |

> **核心差异**：Claude Code 提供明确的 `tool_name` 字段，路由更精准；CodeBuddy IDE 主要依赖输入字段特征（`command`、`mcp_server`、`file_path`）来推断工具类型。

---

## 三、四平台 Hooks 事件全景

### 3.1 各平台注册的 Hooks 事件

| 内部功能 | Cursor | CodeBuddy 插件版 | CodeBuddy IDE | Claude Code |
|:---|:---|:---|:---|:---|
| 会话初始化 | `sessionStart` + `beforeSubmitPrompt` | `beforeSubmitPrompt` | `SessionStart` + `UserPromptSubmit` | `SessionStart` + `UserPromptSubmit` |
| Shell 执行前 | `beforeShellExecution` | — | `PreToolUse` (matcher: Bash) | `PreToolUse` (matcher: Bash) |
| Shell 执行后 | `afterShellExecution` | `afterShellExecution` | `PostToolUse` → 路由 | `PostToolUse` → 路由 |
| MCP 调用后 | `afterMCPExecution` | `afterMCPExecution` | `PostToolUse` → 路由 | `PostToolUse` → 路由 |
| 文件编辑后 | `afterFileEdit` | `afterFileEdit` | `PostToolUse` → 路由 | `PostToolUse` → 路由 |
| 搜索替换后 | — | `afterSearchReplaceFileEdit` | — | — |
| Agent 回复 | `afterAgentResponse` | `afterAgentResponse` | ❌ **不支持** | ❌ **不支持** |
| Agent 思考 | `afterAgentThought` | `afterAgentThought` | ❌ **不支持** | ❌ **不支持** |
| 会话结束/停止 | `stop` + `sessionEnd` | `stop` | `Stop` + `SessionEnd` | `Stop` + `SessionEnd` |

### 3.2 关键差异总结

| 差异维度 | Cursor | CodeBuddy 插件版 | CodeBuddy IDE | Claude Code |
|:---|:---|:---|:---|:---|
| **事件命名风格** | camelCase | camelCase | PascalCase | PascalCase |
| **工具事件粒度** | 按类型拆分独立事件 | 按类型拆分独立事件 | 统一 `PostToolUse` | 统一 `PostToolUse` |
| **超时单位** | 秒 | 秒 | 毫秒 | 毫秒 |
| **配置文件** | `~/.cursor/hooks.json` | `~/.gongfeng-copilot/hooks/hooks.json` | `~/.codebuddy/settings.json` | `~/.claude/settings.json` |
| **配置格式** | `{ command, timeout }` | `{ command }` | `{ matcher?, hooks: [{ type, command, timeout }] }` | `{ matcher?, hooks: [{ type, command, timeout }] }` |
| **Session ID 字段** | `conversation_id` | `session_id` | `session_id` | `session_id` |
| **Agent 回复捕获** | ✅ 原生支持 | ✅ 原生支持 | ❌ 需 workaround | ❌ 需 workaround |

---

## 四、适配器架构

### 4.1 总体设计

AgentMemory 采用 **Adapter（适配器）模式**，每个平台对应一个适配器类，统一实现 `IDEAdapter` 接口：

```
平台原始事件（PascalCase / camelCase）
         │
         ▼
  ┌─────────────────┐
  │  IDEAdapter      │  ← 每个平台一个实现
  │  · mapEventName  │     将平台事件名 → 内部事件名
  │  · normalizeInput│     标准化输入数据格式
  └────────┬────────┘
           │
           ▼
   内部统一事件名（camelCase）
   beforeSubmitPrompt / afterShellExecution / stop / ...
           │
           ▼
  ┌─────────────────┐
  │  Hook Handlers   │  ← 所有平台共享同一套处理函数
  │  handleBefore... │
  │  handleAfter...  │
  │  handleStop      │
  └─────────────────┘
```

### 4.2 适配器接口

```typescript
interface IDEAdapter {
  id: string;                    // 'cursor' | 'codebuddy' | 'codebuddy-ide' | 'claude-code'
  displayName: string;
  configDir: string;             // 平台配置目录
  hooksConfigFile: string;       // hooks 配置文件名

  // 核心方法
  mapEventName(ideEventName: string): string | null;
  normalizeInput(internalEventName: string, rawInput: any): any;
  generateHooksConfig(hooksCliPath: string, platform: NodeJS.Platform): object;
  generateMcpConfig(mcpServerPath: string): object;
}
```

### 4.3 四个适配器实现

| 适配器文件 | 对应平台 | 事件映射方式 |
|:---|:---|:---|
| `src/adapters/cursor.ts` | Cursor | 直接透传（事件名相同） |
| `src/adapters/codebuddy.ts` | CodeBuddy 插件版 | 直接透传（事件名相同） |
| `src/adapters/codebuddy-ide.ts` | CodeBuddy IDE | PascalCase → camelCase 映射 |
| `src/adapters/claude-code.ts` | Claude Code | PascalCase → camelCase 映射 + tool_name 路由 |

---

## 五、逐平台适配详解

### 5.1 Cursor 适配

Cursor 使用 camelCase 事件名，与内部事件名完全一致，是**最简单的适配**。

#### 事件映射

```
Cursor 事件名        → 内部事件名          (无变化)
────────────────────────────────────────────────
beforeSubmitPrompt   → beforeSubmitPrompt
afterShellExecution  → afterShellExecution
afterMCPExecution    → afterMCPExecution
afterFileEdit        → afterFileEdit
afterAgentResponse   → afterAgentResponse   ← ✅ 原生支持
afterAgentThought    → afterAgentThought    ← ✅ 原生支持
sessionStart         → sessionStart
sessionEnd           → sessionEnd
stop                 → stop
```

#### 配置文件格式

```json
// ~/.cursor/hooks.json
{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [{ "command": "node hooks-cli.js beforeSubmitPrompt", "timeout": 10 }],
    "afterShellExecution": [{ "command": "node hooks-cli.js afterShellExecution", "timeout": 10 }],
    "afterAgentResponse": [{ "command": "node hooks-cli.js afterAgentResponse", "timeout": 10 }],
    ...
  }
}
```

#### 输入数据特点

- 使用 `conversation_id` 代替 `session_id`
- 使用 `duration_ms`（毫秒）代替 `duration`（秒）
- MCP 调用包含 `server_name` 和 `tool_result`（对象）
- Shell 调用包含 `exit_code` 和 `cwd`

#### 适配逻辑

Cursor 不需要事件名转换，仅在 Handler 层兼容字段差异（如 `conversation_id` → `session_id` 回退）。

---

### 5.2 CodeBuddy 插件版适配

CodeBuddy 插件版也使用 camelCase 事件名，适配方式与 Cursor 类似。

#### 事件映射

```
CodeBuddy 事件名              → 内部事件名        (无变化)
─────────────────────────────────────────────────────────
beforeSubmitPrompt            → beforeSubmitPrompt
afterShellExecution           → afterShellExecution
afterMCPExecution             → afterMCPExecution
afterFileEdit                 → afterFileEdit
afterSearchReplaceFileEdit    → afterSearchReplaceFileEdit  ← 独有事件
afterAgentResponse            → afterAgentResponse          ← ✅ 原生支持
afterAgentThought             → afterAgentThought           ← ✅ 原生支持
stop                          → stop
```

#### 配置文件格式

```json
// ~/.gongfeng-copilot/hooks/hooks.json
{
  "enabled": true,
  "hooks": {
    "beforeSubmitPrompt": "node hooks-cli.js beforeSubmitPrompt",
    "afterShellExecution": "node hooks-cli.js afterShellExecution",
    ...
  }
}
```

#### 独有能力

CodeBuddy 插件版有一个**独有事件** `afterSearchReplaceFileEdit`，专门追踪搜索替换操作。其他三个平台将此操作统一归入 `PostToolUse` 或 `afterFileEdit`。

---

### 5.3 CodeBuddy IDE 适配

CodeBuddy IDE 使用 PascalCase 事件名，并将所有工具执行后事件统一为 `PostToolUse`。这是**适配复杂度较高的平台**之一。

#### 事件映射

```
CodeBuddy IDE 事件名  → 内部事件名
───────────────────────────────────────────────
UserPromptSubmit      → beforeSubmitPrompt
PreToolUse            → beforeShellExecution   (matcher: Bash)
PostToolUse           → afterToolUse           ← 统一入口，需二次路由
Stop                  → stop
SessionStart          → sessionStart
SessionEnd            → sessionEnd
```

#### PostToolUse 二次路由

CodeBuddy IDE 没有独立的 `afterShellExecution` / `afterMCPExecution` / `afterFileEdit` 事件，而是统一触发 `PostToolUse`。适配器通过分析输入字段来判断实际工具类型：

```
PostToolUse 输入
     │
     ├─ 包含 command 或 exit_code 字段？ ──→ afterShellExecution
     │
     ├─ 包含 mcp_server 或 tool_name 字段？ ──→ afterMCPExecution
     │
     ├─ 包含 file_path 字段？ ──→ afterFileEdit
     │
     └─ 其他 ──→ afterShellExecution（兜底）
```

#### 配置文件格式

```json
// ~/.codebuddy/settings.json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "agentmemory-ide-hook.cmd UserPromptSubmit", "timeout": 10000 }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "agentmemory-ide-hook.cmd PostToolUse", "timeout": 10000 }] }
    ],
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "agentmemory-ide-hook.cmd PreToolUse", "timeout": 10000 }] }
    ],
    ...
  }
}
```

#### 关键缺失与 Workaround

CodeBuddy IDE 和 Claude Code 都**不支持** `afterAgentResponse` 和 `afterAgentThought`，导致无法直接捕获 Agent 的回复内容。解决方案：

1. **在 `UserPromptSubmit` 中补录用户 Prompt**：检测到来源是 CodeBuddy IDE 或 Claude Code 时，将用户的 prompt 额外记录为一条 Observation，确保会话至少有基本数据可用于生成 Summary：

   ```typescript
   // hooks-cli.ts handleBeforeSubmitPrompt()
   const sourceAdapter = detectAdapterByEvent(process.argv[2] || '');
   const lacksAgentResponse = sourceAdapter?.id === 'codebuddy-ide' || sourceAdapter?.id === 'claude-code';
   if (lacksAgentResponse && input.prompt) {
     await client.addObservation({
       sessionId,
       projectPath,
       type: 'agent_response',
       toolName: 'user_prompt',
       toolInput: { prompt: truncateString(input.prompt, 2000) },
       toolOutput: { recorded: true }
     });
   }
   ```

2. **在 `Stop` 事件中补救 Agent 回复**：如果 Stop 事件携带了 `text` 或 `response` 字段，将其记录为 Observation：

   ```typescript
   // hooks-cli.ts handleStop()
   const responseText = input.text || input.response || '';
   if (responseText) {
     await client.addObservation({
       sessionId, projectPath,
       type: 'agent_response',
       toolName: 'agent_response',
       toolInput: { event: 'stop', reason: input.reason },
       toolOutput: { response: truncateString(responseText, 5000) }
     });
   }
   ```

---

### 5.4 Claude Code 适配

Claude Code 同样使用 PascalCase 事件名和统一的 `PostToolUse`，但提供了更丰富的 `tool_name` 字段，使路由更精准。

#### 事件映射

```
Claude Code 事件名    → 内部事件名
───────────────────────────────────────────────
UserPromptSubmit      → beforeSubmitPrompt
SessionStart          → sessionStart
PostToolUse           → afterToolUse           ← 统一入口，需二次路由
PreToolUse            → beforeShellExecution   (matcher: Bash)
Stop                  → stop
SessionEnd            → sessionEnd
```

#### PostToolUse 二次路由（增强版）

Claude Code 的 `PostToolUse` 输入数据包含明确的 `tool_name` 字段（如 `"Bash"`、`"Write"`、`"mcp__github__search"`），使路由判断更精确：

```
PostToolUse 输入
     │
     ├─ tool_name === 'Bash' 或包含 command/exit_code？ ──→ afterShellExecution
     │
     ├─ tool_name 以 'mcp__' 开头？ ──→ afterMCPExecution
     │
     ├─ tool_name ∈ {Write, Edit, FileWrite, FileEdit, NotebookEdit}
     │  或包含 file_path？ ──→ afterFileEdit
     │
     └─ 其他（Read, Grep, Glob 等）──→ afterShellExecution（兜底）
```

与 CodeBuddy IDE 相比，Claude Code 的路由优势在于：
- **明确的 `tool_name`**：可精确识别 Bash、Write、Edit、MCP 等工具类型
- **MCP 命名规范**：`mcp__<server>__<tool>` 格式便于识别 MCP 调用
- **文件编辑工具枚举**：支持 Write、Edit、FileWrite、FileEdit、NotebookEdit 五种文件操作

#### 配置文件格式

```json
// ~/.claude/settings.json
{
  "hooks": {
    "UserPromptSubmit": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "agentmemory-claude-hook.cmd UserPromptSubmit", "timeout": 10000 }] }
    ],
    "PostToolUse": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "agentmemory-claude-hook.cmd PostToolUse", "timeout": 10000 }] }
    ],
    ...
  }
}
```

> 注意：Claude Code 使用空字符串 `""` 作为 matcher 表示"匹配所有工具"，而 CodeBuddy IDE 是省略 matcher 字段。

#### 关键缺失与 Workaround

Claude Code **Hook 点很多**，但要分清：**“Hook 数量多”不等于“有等价的回复/思考 Hook”**。

对于记忆系统最关心的两类数据，Claude Code 的可用能力是：

1. **主 Agent 最终回复**：最接近 `afterAgentResponse` 的不是某个专门的 Response Hook，而是 `Stop` 事件里附带的 `last_assistant_message`
2. **子 Agent 最终回复**：最接近的是 `SubagentStop`，可拿到 `last_assistant_message`，并可结合 `agent_transcript_path` 做进一步回溯
3. **Agent Thought / 推理链**：**没有官方等价 Hook**，只能通过 prompt、工具轨迹、最终回复做弱推断，无法真实恢复

因此，Claude Code 的 workaround 不是“随便多注册几个 Hook 就补齐”，而是：

1. **在 `UserPromptSubmit` 中补录用户 Prompt**：确保 Summary 至少知道“用户要解决什么问题”
2. **在 `PostToolUse` 中记录操作轨迹**：保留 Shell / MCP / 文件编辑过程，作为行为证据
3. **在 `Stop` 中兜底记录主 Agent 最终回复**：优先消费 Claude Code 官方提供的 `last_assistant_message`
4. **未来可选增强 `SubagentStop`**：补采子 Agent 最终回复，提升多代理场景下的可观测性

此外，尽管 Claude Code 原生支持 26 个 Hooks 事件（远超其他平台），但 AgentMemory 目前只注册了 6 个。未注册但可能有价值的事件包括：

| 未注册事件 | 潜在价值 |
|:---|:---|
| `PostToolUseFailure` | 工具调用失败记录，有助于调试分析 |
| `Notification` | 通知事件追踪 |
| `PreCompact` / `PostCompact` | 上下文压缩前后注入/记录 |
| `TaskCreated` / `TaskCompleted` | 多任务工作流追踪 |
| `SubagentStart` / `SubagentStop` | 子代理生命周期追踪 |

---

## 六、统一处理流程

不论来自哪个平台，经过适配器转换后，所有事件都进入**同一套 Handler 函数**：

```
┌───────────────────────────────────────────────────────────────────┐
│                    hooks-cli.ts main()                            │
│                                                                   │
│  ① 读取 stdin JSON 输入                                           │
│  ② detectAdapterByEvent(hookName) → 识别来源平台                  │
│  ③ adapter.mapEventName(hookName) → 内部事件名                    │
│  ④ adapter.normalizeInput(event, raw) → 标准化输入                │
│  ⑤ switch(internalEvent) → 路由到对应 Handler                    │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  Handler 函数（所有平台共享）                                  │  │
│  │                                                             │  │
│  │  handleBeforeSubmitPrompt()  → 创建 Session + 注入记忆       │  │
│  │  handleAfterShellExecution() → 记录 Shell 操作              │  │
│  │  handleAfterMCPExecution()   → 记录 MCP 操作               │  │
│  │  handleAfterFileEdit()       → 记录文件编辑                 │  │
│  │  handleAfterAgentResponse()  → 记录 Agent 回复（仅部分平台） │  │
│  │  handleStop()                → 触发 Summary 生成            │  │
│  │  handleSessionStart()        → 初始化会话                   │  │
│  │  handleSessionEnd()          → 触发 Summary 生成            │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ⑥ PostToolUse 的特殊处理：                                       │
│     afterToolUse → 根据 _routeTo 字段二次分发                     │
│     ├─ _routeTo: 'afterShellExecution'                            │
│     ├─ _routeTo: 'afterMCPExecution'                              │
│     └─ _routeTo: 'afterFileEdit'                                  │
│                                                                   │
│  ⑦ writeAndExit(JSON) → 输出结果到 stdout                        │
└───────────────────────────────────────────────────────────────────┘
```

### 字段兼容性处理

在 Handler 函数内部，通过 fallback 策略兼容各平台的字段差异：

```typescript
// Session ID：Cursor 用 conversation_id，其他用 session_id
const sessionId = input.session_id || input.conversation_id || env.CODEBUDDY_MEM_SESSION_ID || 'default-session';

// 时长：Cursor 用 duration_ms（毫秒），CodeBuddy 用 duration（秒）
const duration = input.duration ?? (input.duration_ms ? input.duration_ms / 1000 : undefined);

// 项目路径：Cursor 用 CURSOR_PROJECT_DIR，CodeBuddy 用 workspace 数组
const projectPath = env.CURSOR_PROJECT_DIR || input.workspace?.[0] || input.workspace_roots?.[0] || process.cwd();

// Agent 回复：CodeBuddy 用 text，Cursor 用 response
const responseContent = input.text || input.response || '';

// MCP 结果：CodeBuddy 用 result_json（字符串），Cursor 用 tool_result（对象）
const result = input.tool_result ?? tryParseJSON(input.result_json);
```

---

## 七、四个能力的平台实现方式对比

### 能力 ①：会话初始化 + 上下文注入

| 平台 | 实现方式 | 说明 |
|:---|:---|:---|
| **Cursor** | `sessionStart` 创建 Session + 注入上下文<br>`beforeSubmitPrompt` 可补充 prompt | 有两个时机，`sessionStart` 更早 |
| **CodeBuddy 插件版** | `beforeSubmitPrompt` 创建 Session + 注入上下文 | 只有一个时机 |
| **CodeBuddy IDE** | `SessionStart` 创建 Session<br>`UserPromptSubmit` 注入上下文 + 补录 prompt | 两步配合完成 |
| **Claude Code** | `SessionStart` 创建 Session<br>`UserPromptSubmit` 注入上下文 + 补录 prompt | 两步配合完成，同 CodeBuddy IDE |

### 能力 ②：实时操作记录

| 平台 | Shell 记录 | MCP 记录 | 文件编辑记录 |
|:---|:---|:---|:---|
| **Cursor** | `afterShellExecution` 直接 | `afterMCPExecution` 直接 | `afterFileEdit` 直接 |
| **CodeBuddy 插件版** | `afterShellExecution` 直接 | `afterMCPExecution` 直接 | `afterFileEdit` + `afterSearchReplaceFileEdit` |
| **CodeBuddy IDE** | `PostToolUse` → 路由（字段检测） | `PostToolUse` → 路由（字段检测） | `PostToolUse` → 路由（字段检测） |
| **Claude Code** | `PostToolUse` → 路由（tool_name） | `PostToolUse` → 路由（mcp__ 前缀） | `PostToolUse` → 路由（Write/Edit） |

### 能力 ③：Agent 回复记录

| 平台 | 实现方式 | 数据完整度 |
|:---|:---|:---|
| **Cursor** | `afterAgentResponse` 直接捕获完整回复 | ⭐⭐⭐⭐⭐ 完整 |
| **CodeBuddy 插件版** | `afterAgentResponse` 直接捕获完整回复 | ⭐⭐⭐⭐⭐ 完整 |
| **CodeBuddy IDE** | `UserPromptSubmit` 补录 prompt<br>`Stop` 补录 response（如果有） | ⭐⭐ 有限 |
| **Claude Code** | `UserPromptSubmit` 补录 prompt<br>`Stop` 补录 response（如果有） | ⭐⭐ 有限 |

> 🚨 **这是最大的差异点**。Cursor 和 CodeBuddy 插件版能实时获取 Agent 的每一轮完整回复，而 CodeBuddy IDE 和 Claude Code 只能在会话结束时尝试补救。两者现在都在 `UserPromptSubmit` 中补录用户 prompt 作为 Observation，确保 Summary 生成有基础数据。

### 能力 ④：会话总结生成

| 平台 | 触发时机 | 说明 |
|:---|:---|:---|
| **Cursor** | `stop` + `sessionEnd` 双重触发 | `stop` 先触发，`sessionEnd` 作为兜底 |
| **CodeBuddy 插件版** | `stop` | 单一触发点 |
| **CodeBuddy IDE** | `Stop` + `SessionEnd` 双重触发 | 同 Cursor 策略 |
| **Claude Code** | `Stop` + `SessionEnd` 双重触发 | 同 Cursor 策略 |

---

## 八、Hooks 注册机制

### 8.1 自动注册

AgentMemory Desktop 应用的 `hooks-config.ts` 模块提供一键注册能力，自动生成各平台对应格式的配置：

```
register(ide: IDEType, configPaths: HooksConfigPaths)
     │
     ├─ ide === 'cursor'
     │   → 写入 ~/.cursor/hooks.json
     │   → 生成 proxy JS 脚本解决 Windows PowerShell 管道问题
     │
     ├─ ide === 'codebuddy'
     │   → 写入 ~/.gongfeng-copilot/hooks/hooks.json
     │   → Windows 下生成 executor.bat 处理编码
     │
     ├─ ide === 'codebuddy-ide'
     │   → 写入 ~/.codebuddy/settings.json
     │   → Windows 下生成 agentmemory-ide-hook.cmd 代理脚本
     │
     └─ ide === 'claude-code'
         → 写入 ~/.claude/settings.json
         → Windows 下生成 agentmemory-claude-hook.cmd 代理脚本
```

### 8.2 Windows 特殊处理

Windows 平台需要额外的代理脚本来解决两个问题：

1. **编码问题**：Windows 默认使用 GBK 编码，通过 `chcp 65001` 切换到 UTF-8
2. **管道问题**：Cursor 在 Windows 上使用 PowerShell 执行 hooks，PowerShell 管道不支持带引号路径，通过 `cmd /c` 中转解决

---

## 九、适配器检测机制

### 事件自动识别

`hooks-cli.ts` 的 `main()` 函数通过 `detectAdapterByEvent()` 自动识别来源平台：

```typescript
// 按优先级尝试每个适配器的 mapEventName()
// PascalCase 事件名（如 PostToolUse）→ 匹配 CodeBuddy IDE 或 Claude Code
// camelCase 事件名（如 afterShellExecution）→ 匹配 Cursor 或 CodeBuddy 插件版
const adapter = detectAdapterByEvent(hookName);
const internalEvent = adapter?.mapEventName(hookName) ?? hookName;
const normalizedInput = adapter?.normalizeInput(internalEvent, input) ?? input;
```

### 适配器优先级

```typescript
const adapters: IDEAdapter[] = [
  new ClaudeCodeAdapter(),      // 1. Claude Code（优先检测，因为事件名与 CodeBuddy IDE 重叠）
  new CodeBuddyIDEAdapter(),    // 2. CodeBuddy IDE
  new CursorAdapter(),          // 3. Cursor
  new CodeBuddyAdapter(),       // 4. CodeBuddy 插件版
];
```

> Claude Code 和 CodeBuddy IDE 的 PascalCase 事件名完全相同（如 `PostToolUse`、`UserPromptSubmit`），实际区分依赖调用时的上下文（不同的 cmd 代理脚本触发不同的适配器）。

---

## 十、最佳实践与已知限制

### 已知限制

| 限制 | 影响平台 | 说明 |
|:---|:---|:---|
| 无法捕获 Agent 回复 | CodeBuddy IDE, Claude Code | 缺少 `afterAgentResponse`，会话数据完整度降低 |
| PostToolUse 路由可能误判 | CodeBuddy IDE | 输入字段不明确时可能路由到错误的 Handler |
| Windows 编码问题 | 全平台 | 中文路径和内容需要 UTF-8 编码处理 |

### 改进方向

1. **争取 CodeBuddy IDE 新增 `afterAgentResponse`**：这是提升记忆质量最有效的方式
2. **注册更多 Claude Code 事件**：如 `PostToolUseFailure`、`PreCompact` 等
3. **增强 PostToolUse 路由准确度**：对 CodeBuddy IDE 的未知输入格式建立更完善的分类规则
4. **统一超时配置**：考虑自动转换秒/毫秒，减少配置出错的可能

---

## 附录：文件索引

| 文件路径 | 职责 |
|:---|:---|
| `src/adapters/types.ts` | IDEAdapter 接口定义 |
| `src/adapters/cursor.ts` | Cursor 适配器 |
| `src/adapters/codebuddy.ts` | CodeBuddy 插件版适配器 |
| `src/adapters/codebuddy-ide.ts` | CodeBuddy IDE 适配器 |
| `src/adapters/claude-code.ts` | Claude Code 适配器 |
| `src/adapters/registry.ts` | 适配器注册表与事件检测 |
| `src/hooks-cli.ts` | CLI 入口 + 所有 Handler 函数 |
| `desktop/src/shared/hooks-config.ts` | Desktop 应用的 hooks 注册/注销管理 |
