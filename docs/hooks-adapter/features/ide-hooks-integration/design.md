# IDE Hooks 自动关联设计

## 背景

agent-memory 通过 Electron 安装包分发后，用户需要将 hooks 配置写入 CodeBuddy/Cursor 的配置文件，才能让 IDE 的 Agent 动作触发记忆采集。本设计解决"安装包用户如何零门槛完成 IDE 关联"的问题。

## 设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| Node.js 运行时 | 优先用 `ELECTRON_RUN_AS_NODE=1`，备选内置 node.exe | 零额外体积；不可行时再降级为内置 node |
| 注册触发时机 | 首次启动 Electron 时弹向导 | 安装时机不可控，首次启动更可靠 |
| MCP 配置 | 只注册 Hooks，MCP 用户自行配 | Hooks 是核心采集能力，MCP 是可选高级功能 |
| 冲突处理 | 合并追加 | 保留用户已有 hooks，按事件追加 |
| 卸载清理 | 设置界面断开 + 卸载程序兜底 | 双保险，确保干净移除 |

## 架构

```
安装包 (.exe / .dmg)
├── Electron 托盘应用（主进程）
│   ├── WorkerManager        # 管理 Worker 生命周期
│   ├── TrayManager          # 托盘图标和菜单
│   ├── SetupWizard          # 首次启动向导（新增）
│   ├── HooksRegistrar       # Electron 层封装（新增）
│   └── SettingsWindow       # 设置界面（增加 IDE 关联管理）
├── shared/
│   └── hooks-config.ts      # 纯 IO 的 hooks 读写逻辑（新增，无 Electron 依赖）
├── Worker 服务              # HTTP API + SQLite
├── hooks-cli.js             # 记忆采集脚本
└── uninstall-hooks.js       # 卸载清理脚本（新增，复用 shared/hooks-config）
```

## 模块设计

### 1. SetupWizard（首次启动向导）

**职责**：首次启动时引导用户选择要关联的 IDE。

**触发条件**：
- 读取 `~/.agent-memory/setup-state.json` 文件
- 不存在 → 弹出向导窗口
- 存在 → 轻量级校验：检测已安装但未注册的 IDE，发现新 IDE 时托盘通知提醒（不弹向导）

**`setup-state.json` 格式**：

```json
{
  "version": "1.0.0",
  "registeredIDEs": ["cursor", "codebuddy"],
  "registeredAt": "2026-03-25T10:00:00Z"
}
```

版本号用于升级时判断是否需要增量更新事件注册。

**向导流程**：
1. 扫描本机 IDE 安装情况
2. 展示检测结果，用户勾选要关联的 IDE
3. 执行注册
4. 显示结果（成功/失败明细）
5. 写入 `setup-state.json`

**IDE 检测逻辑**：

| IDE | 检测方式 | 配置文件位置 |
|-----|----------|-------------|
| CodeBuddy | `~/.gongfeng-copilot/` 目录存在 | `~/.gongfeng-copilot/hooks/hooks.json` |
| Cursor | `~/.cursor/` 目录存在 | `~/.cursor/hooks.json` |

**向导 UI**：
- BrowserWindow，480x400，不可调整大小
- 标题："AgentMemory — 初始化设置"
- 内容：检测到的 IDE 列表（带复选框），每项显示 IDE 名称和检测路径
- 按钮："开始关联" / "跳过（稍后在设置中配置）"

**文件**：`desktop/src/windows/SetupWizard.ts` + `desktop/src/windows/setup-wizard.html`

### 2. hooks-config（共享 hooks 读写模块）

**职责**：纯文件 IO 的 hooks.json 读写逻辑，**不依赖 Electron API**。被 HooksRegistrar（Electron 主进程）和 uninstall-hooks.js（独立 node 脚本）共同使用。

**所有路径通过参数传入，不在内部解析**：

```typescript
interface HooksConfigPaths {
  nodeExePath: string;      // node 运行时路径
  hooksCliPath: string;     // hooks-cli.js 路径
}

interface HooksConfig {
  detectIDEs(): DetectedIDE[];
  register(ide: IDEType, hooksFilePath: string, paths: HooksConfigPaths): RegisterResult;
  unregister(ide: IDEType, hooksFilePath: string): UnregisterResult;
  isRegistered(ide: IDEType, hooksFilePath: string): boolean;
}
```

**文件**：`desktop/src/shared/hooks-config.ts`（编译后可被 Electron 和独立 node 脚本同时引用）

### 3. HooksRegistrar（Electron 层封装）

**职责**：在 Electron 上下文中封装 hooks-config，负责路径解析和 IDE 检测。

```typescript
import { app } from 'electron';
import { HooksConfig } from '../shared/hooks-config';

export class HooksRegistrar {
  private config = new HooksConfig();

  private getPaths(): HooksConfigPaths {
    if (app.isPackaged) {
      const nodePath = process.platform === 'win32'
        ? path.join(process.resourcesPath, 'node.exe')
        : path.join(process.resourcesPath, 'node');
      return {
        nodeExePath: nodePath,
        hooksCliPath: path.join(process.resourcesPath, 'worker', 'hooks-cli.js'),
      };
    }
    // 开发模式
    const repoRoot = path.join(__dirname, '..', '..', '..');
    return {
      nodeExePath: 'node',
      hooksCliPath: path.join(repoRoot, 'dist', 'hooks-cli.js'),
    };
  }

  // ... detectIDEs, register, unregister 代理到 this.config
}
```

**文件**：`desktop/src/services/HooksRegistrar.ts`

### 4. Hook 条目格式（分 IDE 区分）

两个 IDE 的 hooks.json 格式**完全不同**，注册和清理逻辑必须分别处理。

**CodeBuddy 格式**（`~/.gongfeng-copilot/hooks/hooks.json`）：

```json
{
  "command_executor_path": "...",
  "enabled": true,
  "hooks": {
    "beforeSubmitPrompt": [
      {
        "command": "\"<node路径>\" \"<hooks-cli路径>\" beforeSubmitPrompt",
        "display_name": "[AgentMemory] beforeSubmitPrompt",
        "hook_id": "agent-memory:beforeSubmitPrompt",
        "trigger_event": "beforeSubmitPrompt",
        "trigger_event_display": "提交提示词前"
      }
    ]
  }
}
```

- 保留已有 `command_executor_path` 不动
- 追加条目时包含 `hook_id`、`display_name`、`trigger_event`、`trigger_event_display`
- 清理时通过 `hook_id` 前缀 `agent-memory:` 匹配

**Cursor 格式**（`~/.cursor/hooks.json`）：

```json
{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [
      {
        "command": "\"<node路径>\" \"<hooks-cli路径>\" beforeSubmitPrompt",
        "timeout": 10
      }
    ]
  }
}
```

- 没有 `hook_id`，清理时通过 `command` 字段包含 `hooks-cli.js` 关键词匹配
- 必须设置 `timeout`（秒），控制类 hook 设 10s，监控类 hook 设 30s

**Windows 编码处理**：

在 Windows 上 command 需要加 UTF-8 编码前缀，避免中文路径乱码：

```
cmd.exe /c chcp 65001 >nul & "<node路径>" "<hooks-cli路径>" <event>
```

macOS 不需要此处理。

### 5. 注册的事件列表

**通用事件（CodeBuddy + Cursor 都注册）**：

| 事件 | 类型 | timeout | 用途 |
|------|------|---------|------|
| `beforeSubmitPrompt` | 控制 | 10s | 注入记忆上下文到 prompt |
| `afterAgentResponse` | 监控 | 30s | 记录 Agent 响应 |
| `afterAgentThought` | 监控 | 30s | 记录 Agent 思考过程 |
| `afterShellExecution` | 监控 | 30s | 记录 Shell 命令执行结果 |
| `afterMCPExecution` | 监控 | 30s | 记录 MCP 工具调用 |
| `afterFileEdit` | 监控 | 30s | 记录文件编辑操作 |
| `afterSearchReplaceFileEdit` | 监控 | 30s | 记录搜索替换操作 |
| `stop` | 监控 | 30s | 会话结束时生成总结 |

**Cursor 专用事件**：

| 事件 | 类型 | timeout | 用途 |
|------|------|---------|------|
| `sessionStart` | 控制 | 10s | 初始化会话，注入记忆上下文和环境变量 |
| `sessionEnd` | 监控 | 30s | 会话结束时触发 Summary 生成 |

CodeBuddy 不需要这两个事件：它通过 `beforeSubmitPrompt` 初始化会话，通过 `stop` 生成总结。

### 6. SettingsWindow 扩展

**新增区域**："IDE 关联管理"

在现有设置界面底部（"通用设置"下方）添加：

```
IDE 关联
┌──────────────────────────────────┐
│ ✅ CodeBuddy    已关联    [断开] │
│ ✅ Cursor       已关联    [断开] │
│                                  │
│             [重新关联]           │
└──────────────────────────────────┘
```

- 每行显示 IDE 名称、关联状态、操作按钮
- "断开"：调用 `HooksRegistrar.unregister()`
- "重新关联"：调用 `HooksRegistrar.register()`，用于修复或重新注册
- 未检测到的 IDE 灰显，不可操作

**IPC 新增**：
- `hooks:detect-ides` → 返回 `DetectedIDE[]`
- `hooks:register` → 注册指定 IDE
- `hooks:unregister` → 断开指定 IDE

### 7. 卸载清理

**`uninstall-hooks.js`**：
- 引用编译后的 `shared/hooks-config.js`（纯 Node.js，无 Electron 依赖）
- 路径从 `__dirname` 推算（与安装包目录结构对应）
- 扫描所有已知 IDE 配置目录
- 移除所有 agent-memory 相关的 hook 条目
- 静默执行，不弹窗

**NSIS 卸载脚本**：

```nsis
IfFileExists "$INSTDIR\resources\uninstall-hooks.js" 0 +2
  nsExec::ExecToLog /TIMEOUT=10000 '"$INSTDIR\resources\node.exe" "$INSTDIR\resources\uninstall-hooks.js"'
```

- 在文件删除步骤**之前**执行
- 用 `IfFileExists` 守卫，文件不存在则跳过
- 用 `nsExec::ExecToLog` + 10 秒超时，避免卸载进程挂起

### 8. Node.js 运行时策略

**优先方案：`ELECTRON_RUN_AS_NODE=1`**

Electron 可执行文件设置此环境变量后，行为等同于标准 Node.js。command 格式：

- Windows：`set ELECTRON_RUN_AS_NODE=1 && "<electron.exe路径>" "<hooks-cli.js>" <event>`
- macOS：`ELECTRON_RUN_AS_NODE=1 "<app路径>/Contents/MacOS/AgentMemory" "<hooks-cli.js>" <event>`

优点：零额外体积。需验证 hooks-cli.js（含 http、fs、process 等标准 API）在此模式下完全兼容。

**降级方案：内置 node.exe**

如果 `ELECTRON_RUN_AS_NODE` 存在兼容性问题（如 better-sqlite3 native module 在 Electron Node 下 ABI 不匹配——但 hooks-cli 本身不直接用 better-sqlite3，它通过 HTTP 与 Worker 通信），则在 `extraResources` 中打包独立 node：

```json
{
  "from": "vendor/${os.platform() === 'win32' ? 'node.exe' : 'node'}",
  "to": "."
}
```

构建前脚本下载对应平台的 Node.js 二进制到 `desktop/vendor/`。

**实现策略**：先验证 `ELECTRON_RUN_AS_NODE` 方案，通过后采用；不通过再切到内置 node。两种方案的 command 格式不同，需要在 `HooksRegistrar.getPaths()` 中统一处理。

## 数据流

```
用户首次启动
    │
    ▼
SetupWizard 检测 IDE → 读 setup-state.json
    │
    ▼
用户勾选 → HooksRegistrar.register()
    │
    ▼
写入 ~/.cursor/hooks.json 或 ~/.gongfeng-copilot/hooks/hooks.json
    │
    ▼
写入 setup-state.json（记录版本和已注册 IDE）
    │
    ▼
IDE Agent 触发事件
    │
    ▼
IDE 执行: <node路径> <hooks-cli.js路径> <event>
    │
    ▼
hooks-cli.js 通过 HTTP 与本机 Worker (localhost:3847) 通信
    │
    ▼
Worker 处理并存入 SQLite
```

## 边界情况

1. **IDE 安装在非默认路径**：IDE 的配置目录跟安装路径无关，始终在用户目录下（`~/`），不存在此问题。

2. **用户先装 agent-memory 再装 IDE**：每次启动时轻量校验 `setup-state.json`，检测到新 IDE 时托盘通知提醒，用户可在设置中关联。

3. **多个 AgentMemory 实例**：`hook_id` 和 `command` 路径唯一标识了一个安装，不会冲突。

4. **hooks.json 格式不兼容**：注册前校验 JSON 结构，无法解析则提示用户手动检查，不强制覆盖。

5. **权限问题**：hooks.json 在用户目录下，不需要管理员权限。

6. **版本升级新增事件**：`setup-state.json` 记录注册版本，升级后版本号不一致时自动增量注册新事件。

7. **IDE 已卸载但 hooks.json 残留**：不影响，hooks-cli 不存在时 IDE 会静默忽略执行失败。

## 不包含在本设计中

- MCP Server 自动配置（用户自行在 Cursor 设置中添加）
- Linux 平台支持（当前只做 Windows 和 macOS）
- IDE 插件市场分发（未来方向，不在本次范围）
