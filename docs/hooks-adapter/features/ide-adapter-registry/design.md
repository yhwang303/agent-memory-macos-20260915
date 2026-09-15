# IDE Adapter Registry 设计文档

> **日期**：2026-04-01
> **分支**：`feat/ide-adapter-registry`
> **状态**：Draft
> **目标**：以适配器注册表模式支持多 IDE 接入，首批新增 CodeBuddy IDE，并为 Claude Code 等后续 IDE 预留扩展能力。

---

## 一、背景与动机

当前 agent-memory 支持两种 IDE：

| IDE | 配置路径 | 配置文件 | 事件名风格 |
|-----|---------|---------|-----------|
| Cursor | `~/.cursor/` | `hooks.json` | camelCase |
| CodeBuddy 插件版 | `~/.gongfeng-copilot/` | `hooks/hooks.json` | camelCase |

两者的差异散落在 `hooks-cli.ts`（环境变量、注释）、`scripts/setup.js`（分支逻辑）和 `README.md`（文档段落）中。
每增加一种 IDE 就需要在多个文件中添加 if/else 分支，维护成本线性增长。

### 新增需求

- **CodeBuddy IDE**（独立 IDE 产品）：使用 `settings.json`，PascalCase 事件名，嵌套 hooks 数组结构
- **未来**：Claude Code、Windsurf 等更多 IDE

### 设计目标

1. 新增 IDE 只需添加一个适配器文件 + 注册一行
2. 核心逻辑（hooks-cli、WorkerService）零改动
3. 现有 Cursor / CodeBuddy 插件版行为完全不变

---

## 二、现有三种 IDE 配置格式对比

### 2.1 Cursor — `~/.cursor/hooks.json`

```json
{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [
      { "command": "node .../hooks-cli.js beforeSubmitPrompt", "timeout": 10 }
    ]
  }
}
```

- 事件名：camelCase
- 值：对象数组 `[{ command, timeout }]`
- 超时单位：秒

### 2.2 CodeBuddy 插件版 — `~/.gongfeng-copilot/hooks/hooks.json`

```json
{
  "hooks": {
    "beforeSubmitPrompt": "node .../hooks-cli.js beforeSubmitPrompt"
  }
}
```

- 事件名：camelCase
- 值：单条命令字符串
- 无显式超时

### 2.3 CodeBuddy IDE — `~/.codebuddy/settings.json`（新增）

```json
{
  "enabledPlugins": { ... },
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "node .../hooks-cli.js UserPromptSubmit", "timeout": 10000 }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node .../hooks-cli.js PreToolUse", "timeout": 10000 }
        ]
      }
    ]
  }
}
```

- 事件名：PascalCase
- 值：嵌套数组 `[{ matcher?, hooks: [{ type, command, timeout }] }]`
- 超时单位：毫秒
- 特有字段：`matcher`（工具类型过滤）、`enabledPlugins`

---

## 三、架构设计

### 3.1 目录结构

```
src/
├── adapters/
│   ├── types.ts              # IDEAdapter 接口 + 公共类型
│   ├── registry.ts           # 适配器注册表 + IDE 自动检测
│   ├── cursor.ts             # Cursor 适配器
│   ├── codebuddy.ts          # CodeBuddy 插件版适配器
│   └── codebuddy-ide.ts      # CodeBuddy IDE 适配器
├── hooks-cli.ts              # 统一 CLI 入口（调用 registry）
├── scripts/
│   └── setup.js              # 交互式配置（读取 registry）
└── ...
```

### 3.2 IDEAdapter 接口

```typescript
export interface IDEAdapter {
  /** 唯一标识 */
  id: string;

  /** 显示名（用于 setup 脚本菜单和日志） */
  displayName: string;

  /** 用户级配置目录，如 ~/.cursor */
  configDir: string;

  /** hooks 配置文件名，如 hooks.json / config.json / settings.json */
  hooksConfigFile: string;

  /** MCP 配置文件名（若有） */
  mcpConfigFile?: string;

  /** 获取项目目录的环境变量名 */
  projectDirEnvVar?: string;

  /**
   * 将 IDE 原生事件名映射为内部规范事件名。
   * 返回 null 表示该事件不被支持/忽略。
   */
  mapEventName(ideEventName: string): string | null;

  /**
   * 标准化 stdin 输入。
   * IDE 可能对同一语义使用不同的字段名，此方法做归一化。
   */
  normalizeInput(internalEventName: string, rawInput: any): any;

  /**
   * 生成该 IDE 的 hooks 配置对象，用于写入配置文件。
   */
  generateHooksConfig(hooksCliPath: string, platform: NodeJS.Platform): object;

  /**
   * 生成该 IDE 的 MCP 配置对象。
   */
  generateMcpConfig(mcpServerPath: string): object;
}
```

### 3.3 适配器注册表 — `registry.ts`

```typescript
import { IDEAdapter } from './types.js';
import { CursorAdapter } from './cursor.js';
import { CodeBuddyAdapter } from './codebuddy.js';
import { CodeBuddyIDEAdapter } from './codebuddy-ide.js';

const adapters: IDEAdapter[] = [
  new CursorAdapter(),
  new CodeBuddyAdapter(),
  new CodeBuddyIDEAdapter(),
];

/** 根据 IDE id 获取适配器 */
export function getAdapter(id: string): IDEAdapter | undefined {
  return adapters.find(a => a.id === id);
}

/** 获取所有已注册适配器 */
export function getAllAdapters(): IDEAdapter[] {
  return [...adapters];
}

/**
 * 根据事件名自动检测来源 IDE。
 * PascalCase 事件名 → CodeBuddy IDE
 * camelCase 事件名 → 尝试 Cursor / CodeBuddy 插件版（两者事件名一致）
 */
export function detectAdapterByEvent(eventName: string): IDEAdapter | undefined {
  for (const adapter of adapters) {
    if (adapter.mapEventName(eventName) !== null) {
      return adapter;
    }
  }
  return undefined;
}
```

### 3.4 各适配器实现要点

#### Cursor 适配器 — `cursor.ts`

| 属性 | 值 |
|------|-----|
| `id` | `'cursor'` |
| `configDir` | `~/.cursor` |
| `hooksConfigFile` | `hooks.json` |
| `mcpConfigFile` | `mcp.json` |
| `projectDirEnvVar` | `CURSOR_PROJECT_DIR` |
| 事件映射 | 直通（camelCase → camelCase） |
| 配置格式 | `{ version: 1, hooks: { event: [{ command, timeout }] } }` |

#### CodeBuddy 插件版适配器 — `codebuddy.ts`

| 属性 | 值 |
|------|-----|
| `id` | `'codebuddy'` |
| `configDir` | `~/.gongfeng-copilot` |
| `hooksConfigFile` | `hooks/hooks.json` |
| `mcpConfigFile` | `mcp.json` |
| `projectDirEnvVar` | `CODEBUDDY_PROJECT_DIR` |
| 事件映射 | 直通（camelCase → camelCase） |
| 配置格式 | `{ hooks: { event: "command string" } }` |

#### CodeBuddy IDE 适配器 — `codebuddy-ide.ts`

| 属性 | 值 |
|------|-----|
| `id` | `'codebuddy-ide'` |
| `configDir` | `~/.codebuddy` |
| `hooksConfigFile` | `settings.json` |
| `mcpConfigFile` | `mcp.json` |
| `projectDirEnvVar` | 待运行时确认 |

**事件名映射表：**

| CodeBuddy IDE 事件 | 内部规范事件 | 说明 |
|---|---|---|
| `UserPromptSubmit` | `beforeSubmitPrompt` | 提交 Prompt 前 |
| `PreToolUse` | `beforeShellExecution` | 工具执行前（当 matcher=Bash）|
| `PostToolUse` | `afterToolUse`（新增通用） | 工具执行后（统一事件） |
| `Stop` | `stop` | 会话停止 |
| `SessionStart` | `sessionStart` | 会话开始 |
| `SessionEnd` | `sessionEnd` | 会话结束 |

**`PostToolUse` 处理策略：**

由于 CodeBuddy IDE 将所有工具回调合并为一个 `PostToolUse` 事件，而内部有 `afterShellExecution`、`afterMCPExecution`、`afterFileEdit` 三种处理路径，需要在 `normalizeInput` 中根据 input 内容做二次路由：

1. 运行时检查 input 中的字段特征（如是否有 `command`/`exit_code` → shell、`mcp_server`/`tool_name` → MCP、`file_path` → file edit）
2. 无法识别时，走通用观测记录路径并记录完整 input 到日志
3. 随着实际运行数据积累，逐步完善路由规则

---

## 四、hooks-cli.ts 改动

### 4.1 改动前（现有逻辑）

```typescript
switch (hookName) {
  case 'beforeShellExecution':
    result = await handleBeforeShellExecution(input);
    break;
  case 'beforeSubmitPrompt':
    result = await handleBeforeSubmitPrompt(input);
    break;
  // ... 每个事件硬编码
}
```

### 4.2 改动后

```typescript
import { detectAdapterByEvent } from './adapters/registry.js';

// 1. 检测来源 IDE 并归一化事件名
const adapter = detectAdapterByEvent(hookName);
const internalEvent = adapter?.mapEventName(hookName) ?? hookName;
const normalizedInput = adapter?.normalizeInput(internalEvent, input) ?? input;

// 2. 用内部规范事件名路由（switch 不变）
switch (internalEvent) {
  case 'beforeShellExecution':
    result = await handleBeforeShellExecution(normalizedInput);
    break;
  // ... 现有 handler 完全不动
}
```

**关键：** 现有 switch 内的所有 case 和 handler 函数零改动，仅在 switch 前加 3 行归一化逻辑。

---

## 五、setup.js 改动

### 5.1 改动概要

```javascript
// 从 registry 动态读取可用 IDE 列表
const adapters = getAllAdapters();

console.log('您想配置哪款编辑器？');
adapters.forEach((a, i) => console.log(`${i + 1}) ${a.displayName}`));
console.log(`${adapters.length + 1}) 全部`);

// 选择后调用对应 adapter.generateHooksConfig() 生成配置
```

每个适配器自包含配置生成逻辑，setup.js 不再需要 IDE 特定的 if/else。

---

## 六、README.md 改动

新增「步骤二（C）：配置 CodeBuddy IDE Hooks」章节，与现有 Cursor 和 CodeBuddy 插件版章节平行。包含：

- 配置文件路径
- JSON 示例
- 支持的 hooks 事件表
- Windows 路径注意事项

---

## 七、风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| `PostToolUse` 的 input 格式未知 | normalizeInput 做防御式处理 + 完整日志记录，先走通用路径 |
| CodeBuddy IDE 配置目录已确认 | `~/.codebuddy/settings.json`，与插件版 `~/.gongfeng-copilot/` 独立隔离 |
| 事件名冲突（`Stop` vs `stop`） | detectAdapterByEvent 按注册顺序匹配，PascalCase 适配器优先级靠后，camelCase 先匹配 Cursor/CodeBuddy |
| 现有行为回归 | Cursor 和 CodeBuddy 适配器的 mapEventName 为直通映射，normalizeInput 返回原始 input，等价于无适配器 |

---

## 八、实现计划（概要）

| 步骤 | 内容 | 估时 |
|------|------|------|
| 1 | 创建 `src/adapters/types.ts` + `registry.ts` | 0.5h |
| 2 | 实现 `cursor.ts` + `codebuddy.ts`（从现有代码提取） | 1h |
| 3 | 实现 `codebuddy-ide.ts`（事件映射 + 配置格式） | 1h |
| 4 | 改造 `hooks-cli.ts`（加 3 行归一化） | 0.5h |
| 5 | 改造 `scripts/setup.js`（动态菜单） | 0.5h |
| 6 | 更新 `README.md` | 0.5h |
| 7 | 测试验证 | 1h |

---

## 九、未来扩展示例

新增 Claude Code 支持时，只需：

```typescript
// src/adapters/claude-code.ts
export class ClaudeCodeAdapter implements IDEAdapter {
  id = 'claude-code';
  displayName = 'Claude Code';
  configDir = '~/.claude';
  hooksConfigFile = 'settings.json';
  // ... 实现事件映射和配置生成
}
```

然后在 `registry.ts` 中加一行注册：

```typescript
import { ClaudeCodeAdapter } from './claude-code.js';
const adapters = [
  // ...existing
  new ClaudeCodeAdapter(),
];
```

核心代码无需任何改动。
