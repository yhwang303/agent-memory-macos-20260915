# Claude Code Hooks 接入设计

## 一、需求纠正

**原设计（已废弃）**：将 Claude Code CLI 作为 API Provider 替代 HTTP API 调用。
**正确需求**：将 Claude Code 作为**第四种 IDE**接入 hooks 系统，与 CodeBuddy 插件版、CodeBuddy IDE、Cursor 并列。

## 二、总体方案

在现有适配器体系中新增 `ClaudeCodeAdapter`，支持将 agent-memory hooks 注册到 Claude Code 的配置文件 `~/.claude/settings.json` 中。

```
现有 IDE 适配器体系
  ├── CodeBuddyAdapter       → ~/.gongfeng-copilot/hooks/hooks.json
  ├── CursorAdapter          → ~/.cursor/hooks.json
  ├── CodeBuddyIDEAdapter    → ~/.codebuddy/settings.json
  └── ClaudeCodeAdapter [新增] → ~/.claude/settings.json
```

## 三、Claude Code Hooks 完整调研

### 3.1 配置文件

- 路径：`~/.claude/settings.json`
- 格式：标准 JSON，根层级含 `hooks` 对象
- 5 层优先级级联：policySettings > flagSettings > localSettings > projectSettings > userSettings

### 3.2 Claude Code 完整事件列表（27种）

| 分类 | 事件 | 触发时机 | 对记忆系统的价值 |
|------|------|---------|----------------|
| **会话** | `SessionStart` | 会话开始/恢复 | ⭐ 核心：初始化记忆会话、注入上下文 |
| | `SessionEnd` | 会话结束 | ⭐ 核心：会话清理 |
| | `Stop` | AI 完成一次响应 | ⭐ 核心：触发摘要生成 |
| | `StopFailure` | API 错误导致轮次结束 | ⭐ 增强项：携带 `error`+`last_assistant_message` |
| **用户输入** | `UserPromptSubmit` | 用户提交输入 | ⭐ 核心：映射到 beforeSubmitPrompt |
| **工具相关** | `PreToolUse` | 工具执行前（可阻止） | ⭐ 核心：映射到 beforeShellExecution |
| | `PostToolUse` | 工具执行后 | ⭐ 核心：映射到 afterShellExecution/afterFileEdit |
| | `PostToolUseFailure` | 工具执行失败后 | ⭐ 增强项：记录失败 |
| | `ToolError` | 工具错误 | 暂不需要 |
| **权限** | `PermissionRequest` | 权限请求 | 暂不需要 |
| | `PermissionDenied` | 工具调用被拒绝 | 暂不需要 |
| **Agent** | `SubagentStart` | 子 Agent 启动 | 暂不需要 |
| | `SubagentStop` | 子 Agent 完成 | ⭐ 增强项：携带 `last_assistant_message`+`agent_transcript_path` |
| | `TaskCreated` | 任务创建 | 暂不需要 |
| | `TaskCompleted` | 任务完成 | 暂不需要 |
| | `TeammateIdle` | 队友空闲 | 暂不需要 |
| **上下文** | `PreCompact` | 上下文压缩前 | 可选：保存快照 |
| | `PostCompact` | 上下文压缩后 | ⭐ 高价值增强项：携带 `compact_summary` 阶段性总结 |
| | `InstructionsLoaded` | 指令文件加载完成 | 暂不需要 |
| **配置/文件** | `ConfigChange` | 配置变更 | 暂不需要 |
| | `FileChanged` | 文件变更 | 暂不需要 |
| | `CwdChanged` | 工作目录变更 | 暂不需要 |
| | `GitChange` | Git 变更 | 暂不需要 |
| **通知** | `Notification` | 系统通知 | 暂不需要 |
| **MCP** | `Elicitation` | MCP 用户输入请求 | 暂不需要 |
| | `ElicitationResult` | MCP 用户输入结果 | 暂不需要 |
| **Worktree** | `WorktreeCreate` | Worktree 创建 | 暂不需要 |
| | `WorktreeRemove` | Worktree 移除 | 暂不需要 |

### 3.3 选定的核心事件及映射

我们选择对记忆系统最有价值的 6 个事件：

| Claude Code 事件 | 映射到内部事件 | 用途 |
|---|---|---|
| `UserPromptSubmit` | `beforeSubmitPrompt` | 会话初始化 + 上下文注入 + 补录用户 prompt |
| `SessionStart` | `sessionStart` | 检测新/恢复会话 |
| `SessionEnd` | `sessionEnd` | 会话清理 |
| `PreToolUse` | `beforeShellExecution` | Shell 命令隐私检查（matcher: Bash） |
| `PostToolUse` | `afterToolUse`（路由分发） | 记录工具执行观测数据 |
| `Stop` | `stop` | 触发会话摘要生成 + 兜底获取主 Agent 最终回复 |

> 说明：Claude Code 虽然 Hook 节点很多，但真正接近 `afterAgentResponse` 的主要是 `Stop.last_assistant_message`（主 Agent）和潜在可扩展的 `SubagentStop.last_assistant_message`（子 Agent）；并不存在等价于 `afterAgentThought` 的官方 Hook。

### 3.4 Hook 配置格式

```json
{
  "matcher": "条件表达式或空字符串",
  "hooks": [
    {
      "type": "command",
      "command": "node \"/path/to/hooks-cli.js\" EventName",
      "timeout": 10000
    }
  ]
}
```

- `matcher`：空字符串 `""` 表示匹配全部；`"Bash"` 匹配工具名
- `hooks[].type`：支持 `"command"` | `"http"` | `"prompt"` | `"agent"`，我们使用 `"command"`
- `hooks[].command`：Shell 命令，stdin 传入 JSON，stdout 输出 JSON
- `hooks[].timeout`：超时时间（毫秒）

### 3.5 Hook 数据交互协议

Claude Code hooks 通过 stdin/stdout/stderr 通信：

**输入**（通过 stdin 传入 JSON）：
```json
{
  "session_id": "abc123",
  "cwd": "/Users/sarah/myproject",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "npm test" }
}
```

**输出**（通过 stdout 返回 JSON）：
```json
{
  "continue": true
}
```

**退出码语义**：
- `exit 0`：操作继续。stdout 内容可注入到 AI 上下文（仅 UserPromptSubmit、SessionStart）
- `exit 2`：操作被阻止。stderr 内容作为反馈发送给 Claude
- 其他退出码：操作继续，stderr 被日志记录

### 3.6 Matcher 语法

| 事件 | matcher 过滤的内容 | 示例值 |
|------|-------------------|--------|
| PreToolUse / PostToolUse / PostToolUseFailure | 工具名称 | `Bash`, `Edit\|Write`, `mcp__.*` |
| SessionStart | 会话启动方式 | `startup`, `resume`, `clear`, `compact` |
| SessionEnd | 结束原因 | `clear`, `logout`, `prompt_input_exit` |
| UserPromptSubmit / Stop / TeammateIdle | 不支持 matcher | 始终触发 |

### 3.7 与 CodeBuddy IDE 的共性

| 特性 | CodeBuddy IDE | Claude Code |
|------|-------------|------------|
| 配置文件 | `~/.codebuddy/settings.json` | `~/.claude/settings.json` |
| 事件命名 | PascalCase | PascalCase |
| 超时单位 | 毫秒 | 毫秒 |
| 条目结构 | `{ matcher?, hooks: [{ type, command, timeout }] }` | `{ matcher, hooks: [{ type, command, timeout }] }` |
| PostToolUse 路由 | 根据输入字段判断工具类型 | 根据 `tool_name` 字段 + 输入字段判断 |
| 环境变量 | `CODEBUDDY_IDE_PROJECT_DIR` | `CLAUDE_PROJECT_DIR` |
| 上下文注入 | 通过 additionalContext 返回 | 通过 stdout + exit 0 返回 |

## 四、代码变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/adapters/claude-code.ts` | 新增 | ClaudeCodeAdapter 适配器实现 |
| `src/adapters/registry.ts` | 修改 | 注册 ClaudeCodeAdapter |
| `desktop/src/shared/hooks-config.ts` | 修改 | 新增 `claude-code` IDE 类型及其配置逻辑 |

**不涉及变更的文件**：
- `src/hooks/index.ts`：hooks 实现层完全复用
- `src/services/worker/SDKAgent.ts`：AI 调用层完全不变
- `src/sdk/prompts.ts`、`src/sdk/parser.ts`：完全复用
- 所有 SQLite 层、Worker 层、MCP 层

## 五、ClaudeCodeAdapter 详细设计

### 5.1 事件映射

```typescript
const EVENT_MAP: Record<string, string> = {
  'UserPromptSubmit': 'beforeSubmitPrompt',
  'SessionStart': 'sessionStart',
  'SessionEnd': 'sessionEnd',
  'PreToolUse': 'beforeShellExecution',
  'PostToolUse': 'afterToolUse',      // 统一路由，由 normalizeInput 分发
  'Stop': 'stop',
};
```

### 5.2 normalizeInput 设计

Claude Code 的 `PostToolUse` 事件提供 `tool_name` 字段，可以精确判断工具类型：

```typescript
normalizeInput(internalEventName: string, rawInput: any): any {
  if (internalEventName !== 'afterToolUse') {
    return rawInput;
  }

  const input = rawInput ?? {};

  // Claude Code 的 PostToolUse 输入包含 tool_name 字段
  const toolName = input.tool_name ?? input.tool ?? '';

  if (toolName === 'Bash' || input.command !== undefined || input.exit_code !== undefined) {
    return { ...input, _routeTo: 'afterShellExecution' };
  }
  if (toolName.startsWith('mcp__') || input.mcp_server !== undefined) {
    return { ...input, _routeTo: 'afterMCPExecution' };
  }
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'FileWrite' || toolName === 'FileEdit' || input.file_path !== undefined) {
    return { ...input, _routeTo: 'afterFileEdit' };
  }

  // 默认路由
  return { ...input, _routeTo: 'afterShellExecution' };
}
```

### 5.3 generateHooksConfig 设计

```typescript
const HOOKS_EVENTS: Array<{ ideEvent: string; timeout: number; matcher?: string }> = [
  { ideEvent: 'UserPromptSubmit', timeout: 10000 },
  { ideEvent: 'SessionStart', timeout: 15000 },
  { ideEvent: 'PostToolUse', timeout: 10000 },
  { ideEvent: 'PreToolUse', timeout: 10000, matcher: 'Bash' },
  { ideEvent: 'Stop', timeout: 30000 },
  { ideEvent: 'SessionEnd', timeout: 10000 },
];
```

## 六、hooks-config.ts 变更

### 6.1 新增 IDE 类型

```typescript
export type IDEType = 'codebuddy' | 'cursor' | 'codebuddy-ide' | 'claude-code';
```

### 6.2 新增配置路径

```typescript
function claudeCodeDataDir(): string {
  return path.join(getHomeDir(), '.claude');
}

// getHooksJsonPath 新增分支
if (ide === 'claude-code') {
  return path.join(claudeCodeDataDir(), 'settings.json');
}
```

### 6.3 新增事件列表

```typescript
const CLAUDE_CODE_HOOK_EVENTS: HookEventSpec[] = [
  { name: 'UserPromptSubmit', timeout: 10000 },
  { name: 'SessionStart', timeout: 15000 },
  { name: 'PostToolUse', timeout: 10000 },
  { name: 'PreToolUse', timeout: 10000, matcher: 'Bash' },
  { name: 'Stop', timeout: 30000 },
  { name: 'SessionEnd', timeout: 10000 },
];
```

### 6.4 detectIDEs 新增探测

```typescript
if (fs.existsSync(claudeCodeDataDir())) {
  const hooksJsonPath = getHooksJsonPath('claude-code');
  const raw = readJsonFile<Record<string, unknown>>(hooksJsonPath);
  out.push({
    type: 'claude-code',
    ideDataDir: claudeCodeDataDir(),
    hooksJsonPath,
    isRegistered: computeIsRegistered('claude-code', raw),
  });
}
```

### 6.5 register / unregister

- `register('claude-code')`：读取 `~/.claude/settings.json`，在 `hooks` 对象中追加每个事件的 agent-memory hook 条目
- `unregister('claude-code')`：过滤掉包含 `hooks-cli` 或 `agent-memory` 的条目

注意：`~/.claude/settings.json` 可能包含其他配置（如 `permissions`、`env` 等），注册/注销只操作 `hooks` 部分，不影响其他配置。

## 七、注册后的配置示例

注册后 `~/.claude/settings.json` 中的 hooks 部分：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/hooks-cli.js\" UserPromptSubmit",
            "timeout": 10000
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/hooks-cli.js\" SessionStart",
            "timeout": 15000
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/hooks-cli.js\" PostToolUse",
            "timeout": 10000
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/hooks-cli.js\" PreToolUse",
            "timeout": 10000
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/hooks-cli.js\" Stop",
            "timeout": 30000
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/path/to/hooks-cli.js\" SessionEnd",
            "timeout": 10000
          }
        ]
      }
    ]
  }
}
```

## 八、实现顺序

1. 新增 `src/adapters/claude-code.ts`（ClaudeCodeAdapter）
2. 更新 `src/adapters/registry.ts` 注册新适配器
3. 更新 `desktop/src/shared/hooks-config.ts` 新增 `claude-code` IDE 类型
4. 更新桌面端 UI 支持 Claude Code IDE 的注册/注销
5. 测试：确认 hooks 能正确注册到 `~/.claude/settings.json`

## 九、测试要点

| 测试场景 | 验证方式 |
|---------|---------|
| 检测 Claude Code 安装 | `~/.claude` 目录存在 → 出现在 IDE 列表中 |
| 注册 hooks | 注册后 `~/.claude/settings.json` 包含所有事件的 agent-memory hook |
| 注销 hooks | 注销后 agent-memory hook 被移除，其他配置不受影响 |
| 事件映射 | `UserPromptSubmit` → `beforeSubmitPrompt`，`PostToolUse` → `afterToolUse` 等 |
| PostToolUse 路由 | Bash 工具 → `afterShellExecution`，Write/Edit → `afterFileEdit`，mcp__ → `afterMCPExecution` |
| 已有配置不被覆盖 | `settings.json` 中的 `permissions`、`env` 等字段保持不变 |
| matcher 为空字符串 | 非 PreToolUse 事件的 matcher 使用空字符串 `""` 而非 `"*"` |

## 十、⭐ 源码分析发现的增强能力（2026-04-09）

> 通过阅读 Claude Code 完整源码发现了以下此前未知的重大能力，详见 `docs/CLAUDE-CODE-HOOKS-SOLUTION.md`。

### 10.1 `transcript_path`：每个 Hook 事件都携带的完整会话日志路径

`BaseHookInput` 中包含 `transcript_path` 字段，指向一个 JSONL 格式的完整会话 transcript 文件：

```
~/.claude/projects/<sanitized-path>/<session-id>/transcript.jsonl
```

该文件包含所有 user/assistant/tool 消息，意味着在 `Stop` 事件触发时可以直接读取完整对话历史，**绕过"没有 `afterAgentResponse`"的限制**。

### 10.2 `PostCompact.compact_summary`：自动阶段性总结

当 Claude Code 执行 auto-compact 时，`PostCompact` 事件携带 `compact_summary`——由模型生成的阶段性对话摘要。对记忆系统而言，相当于 **Claude Code 免费做了一次 Summary**。

### 10.3 Claude Code 内置记忆系统

Claude Code 自身有完整的记忆抽取机制（`extractMemories.ts`），记忆文件存储在：

```
~/.claude/projects/<sanitized-cwd>/memory/MEMORY.md   (索引)
~/.claude/projects/<sanitized-cwd>/memory/*.md         (主题记忆)
```

agent-memory 可以在 `SessionStart` 时扫描这些文件作为额外上下文来源。

### 10.4 增强优先级路线

| 优先级 | 增强项 | 预估工作量 | 收益 |
|:---|:---|:---|:---|
| P0 | `Stop` 中优先消费 `last_assistant_message` | 1h | 直接获取官方最终文本回复 |
| P1 | 接入 `PostCompact` 获取 `compact_summary` | 2h | 长会话自动获得阶段性总结 |
| P2 | `Stop` 时增量读 transcript 文件 | 4-6h | 获取完整逐轮对话，Summary 质量跃升 |
| P3 | `SessionStart` 扫描 Claude Code 内置记忆 | 3h | 补充高质量上下文来源 |
| P4 | 接入 `SubagentStop` | 2h | 多代理场景覆盖 |
| P5 | 接入 `StopFailure` | 1h | 失败场景记录 |

## 十一、Claude Internal（腾讯内网版）支持

### 11.1 背景

腾讯内网部署了 `@tencent/claude-code-internal` 包（简称 `claude-internal`），它与官方 Claude Code 共享相同的 hooks 系统（事件名、格式、协议），但使用**独立的配置目录**：

| 特性 | Claude Code（官方） | Claude Internal（内网） |
|------|-------------------|----------------------|
| NPM 包 | `@anthropic-ai/claude-code` | `@tencent/claude-code-internal` |
| CLI 命令 | `claude` | `claude-internal` |
| 配置目录 | `~/.claude/` | `~/.claude-internal/` |
| settings.json | `~/.claude/settings.json` | `~/.claude-internal/settings.json` |
| hooks 格式 | PascalCase 事件 + stdin/stdout JSON | **完全相同** |
| 项目目录环境变量 | `CLAUDE_PROJECT_DIR` | `CLAUDE_PROJECT_DIR`（共用） |
| transcript 路径 | `~/.claude/projects/<path>/<sid>/transcript.jsonl` | `~/.claude-internal/projects/<path>/<sid>/transcript.jsonl` |
| 内置记忆 | `~/.claude/projects/<cwd>/memory/` | `~/.claude-internal/projects/<cwd>/memory/` |

### 11.2 方案：新增独立 IDE 类型 `claude-internal`

由于两者仅配置目录不同，其余逻辑完全一致，采用**继承策略**：

```
IDE 适配器体系（更新后）
  ├── CodeBuddyAdapter       → ~/.gongfeng-copilot/hooks/hooks.json
  ├── CursorAdapter          → ~/.cursor/hooks.json
  ├── CodeBuddyIDEAdapter    → ~/.codebuddy/settings.json
  ├── ClaudeCodeAdapter      → ~/.claude/settings.json
  └── ClaudeInternalAdapter [新增] → ~/.claude-internal/settings.json
```

### 11.3 ClaudeInternalAdapter 设计

继承 `ClaudeCodeAdapter`，仅覆盖 `id`、`displayName`、`configDir`：

```typescript
export class ClaudeInternalAdapter extends ClaudeCodeAdapter {
  id = 'claude-internal';
  displayName = 'Claude Internal';
  configDir = path.join(os.homedir(), '.claude-internal');
}
```

- 事件映射（`EVENT_MAP`）：复用父类
- `normalizeInput`：复用父类
- `generateHooksConfig`：复用父类
- `generateMcpConfig`：复用父类

### 11.4 代码变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/adapters/claude-code.ts` | 修改 | 导出 `ClaudeInternalAdapter`（继承 `ClaudeCodeAdapter`） |
| `src/adapters/registry.ts` | 修改 | 注册 `ClaudeInternalAdapter` |
| `desktop/src/shared/hooks-config.ts` | 修改 | IDEType 新增 `'claude-internal'`；新增 `claudeInternalDataDir()`；detectIDEs 新增 `~/.claude-internal` 探测；register/unregister 支持新类型 |
| `desktop/src/windows/settings.html` | 修改 | `IDE_LABEL` 新增 `'claude-internal': 'Claude Internal'` |

### 11.5 hooks-config.ts 具体变更

```typescript
// IDEType 新增
export type IDEType = 'codebuddy' | 'cursor' | 'codebuddy-ide' | 'claude-code' | 'claude-internal';

// 新增目录
function claudeInternalDataDir(): string {
  return path.join(getHomeDir(), '.claude-internal');
}

// getHooksJsonPath 新增分支
if (ide === 'claude-internal') {
  return path.join(claudeInternalDataDir(), 'settings.json');
}

// getEventsForIDE 新增分支（复用 CLAUDE_CODE_HOOK_EVENTS）
if (ide === 'claude-internal') {
  return CLAUDE_CODE_HOOK_EVENTS;
}

// detectIDEs 新增 ~/.claude-internal 探测
if (fs.existsSync(claudeInternalDataDir())) {
  const hooksJsonPath = getHooksJsonPath('claude-internal');
  const raw = readJsonFile<Record<string, unknown>>(hooksJsonPath);
  out.push({
    type: 'claude-internal',
    ideDataDir: claudeInternalDataDir(),
    hooksJsonPath,
    isRegistered: computeIsRegistered('claude-internal', raw),
  });
}

// register 中 claude-internal 复用 claude-code 的逻辑
// buildHookCommand 中 claude-internal 走同样的 ideProxyCmdPath 分支
// ensureClaudeInternalProxyCmd 新增（独立 .cmd 文件名避免冲突）
```

### 11.6 注册后的配置示例

注册后 `~/.claude-internal/settings.json` 结构与 `~/.claude/settings.json` 完全一致：

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "command", "command": "...", "timeout": 10000 }] }],
    "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "...", "timeout": 15000 }] }],
    "PostToolUse": [{ "matcher": "", "hooks": [{ "type": "command", "command": "...", "timeout": 10000 }] }],
    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "...", "timeout": 10000 }] }],
    "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "...", "timeout": 30000 }] }],
    "SessionEnd": [{ "matcher": "", "hooks": [{ "type": "command", "command": "...", "timeout": 10000 }] }]
  }
}
```

### 11.7 测试要点

| 测试场景 | 验证方式 |
|---------|---------|
| 检测 Claude Internal 安装 | `~/.claude-internal` 目录存在 → 出现在 IDE 列表中 |
| 与 Claude Code 共存 | 同时安装两者时，IDE 列表分别显示两个条目 |
| 独立注册/注销 | 注册 claude-internal 不影响 claude-code 的配置 |
| hooks-cli 事件映射 | 通过 `claude-internal` 触发的事件能被正确识别为 `claude-internal` 适配器 |
| proxy cmd 文件名隔离 | `agentmemory-claude-hook.cmd`（官方版）与 `agentmemory-claude-internal-hook.cmd`（内网版）独立 |
