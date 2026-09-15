# AgentMemory

**License: AGPL-3.0** | [Migration Guide](docs/MIGRATION.md)

> 🧠 为 **CodeBuddy Agent** 和 **Cursor** 提供**跨会话持久化记忆能力**的插件系统

## 🎯 解决的问题

CodeBuddy / Cursor 每次新开窗口时，之前的上下文会全部丢失，恢复上下文需要很多额外手段。

**AgentMemory** 通过以下方式解决这个问题：
- ✅ **自动捕获** - 自动记录 Shell 命令、MCP 调用、文件编辑等操作
- ✅ **智能压缩** - 使用 AI 将操作压缩为结构化记忆
- ✅ **上下文注入** - 新会话自动注入历史相关记忆
- ✅ **多项目隔离** - 不同 workspace 记忆独立存储
- ✅ **MCP 搜索** - 支持主动搜索历史记忆
- ✅ **Web 可视化** - 提供 Web 界面查看所有记忆
- ✅ **多平台支持** - 同时支持 CodeBuddy、Cursor、Windsurf、Gemini CLI、OpenCode、Codex CLI、Copilot CLI、Antigravity、Goose、Crush、Roo Code、Warp、OpenClaw

---

## 📦 一键安装与配置（推荐）

为方便快速上手，项目提供了一键安装和配置脚本。

1. 克隆项目并进入目录：
```bash
git clone https://github.com/your-repo/agent-memory.git
cd agent-memory
```

2. 运行一键配置脚本：

**Windows 用户：**
双击运行项目根目录下的 `install.bat`，或在命令行中执行：
```bat
install.bat
```

**Mac/Linux 用户：**
```bash
chmod +x install.sh
./install.sh
```

该脚本会自动执行：
1. 检查 Node.js 环境
2. 安装所有依赖并编译项目代码
3. 运行交互式配置向导（自动配置 IDE 的 Hooks 和 MCP）
4. 生成 `.env.local` 配置文件

### 填入 API Key

完成上述脚本后，打开自动生成的 `.env.local` 文件，填入你的 API Key：

```env
# 腾讯内部 TIMIAI API（推荐）
TIMIAI_API_KEY=your_timiai_api_key_here

# 或者使用 OpenAI API
# OPENAI_API_KEY=sk-xxx
```

---

## ⚙️ 手动配置（进阶）

如果你想手动配置环境或了解细节，可以跳过一键脚本，参考以下步骤：

### 步骤一：配置 API Key

1. 安装依赖并编译：
```bash
npm install
npm run build
```

2. 复制配置模板文件：

```bash
cp .env.local.example .env.local
```

2. 编辑 `.env.local` 文件，填入你的 API Key：

```env
# 腾讯内部 TIMIAI API（推荐）
TIMIAI_API_KEY=your_timiai_api_key_here

# 或者使用 OpenAI API
# OPENAI_API_KEY=sk-xxx

# 或者使用 Anthropic API
# ANTHROPIC_API_KEY=xxx
```

> 💡 **提示**：`.env.local` 文件已被 `.gitignore` 忽略，可以安全存放 API Key。

#### 支持的 API Key（三选一）

| 环境变量 | 说明 | 获取方式 |
|---------|------|---------|
| `TIMIAI_API_KEY` | 腾讯内部 TIMIAI API（推荐） | http://api.timiai.woa.com |
| `OPENAI_API_KEY` | OpenAI API | https://platform.openai.com |
| `ANTHROPIC_API_KEY` | Anthropic API | https://console.anthropic.com |

### 步骤二（A）：配置 CodeBuddy 插件版 Hooks

在 CodeBuddy 插件版的配置文件中添加以下 hooks 配置：

**配置文件位置**：`~/.gongfeng-copilot/hooks/hooks.json`

```json
{
  "hooks": {
    "beforeSubmitPrompt": "agent-memory hook beforeSubmitPrompt",
    "afterShellExecution": "agent-memory hook afterShellExecution",
    "afterMCPExecution": "agent-memory hook afterMCPExecution",
    "afterFileEdit": "agent-memory hook afterFileEdit",
    "stop": "agent-memory hook stop"
  }
}
```

> ⚠️ **注意**：确保 `agent-memory` 命令已添加到系统 PATH 中，或使用完整路径。

#### 全局安装（推荐）

```bash
npm link
```

安装后，`agent-memory` 命令即可全局使用。

### 步骤二（B）：配置 Cursor Hooks

Cursor 也支持 hooks 系统，可以在 Cursor 的配置文件中添加以下配置：

**配置文件位置**：
- **项目级**：`<project>/.cursor/hooks.json`（仅对当前项目生效）
- **用户级**：`~/.cursor/hooks.json`（全局生效）

```json
{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [
      {
        "command": "node /path/to/agent-memory/dist/hooks-cli.js beforeSubmitPrompt",
        "timeout": 10
      }
    ],
    "afterShellExecution": [
      {
        "command": "node /path/to/agent-memory/dist/hooks-cli.js afterShellExecution",
        "timeout": 10
      }
    ],
    "afterMCPExecution": [
      {
        "command": "node /path/to/agent-memory/dist/hooks-cli.js afterMCPExecution",
        "timeout": 10
      }
    ],
    "afterFileEdit": [
      {
        "command": "node /path/to/agent-memory/dist/hooks-cli.js afterFileEdit",
        "timeout": 10
      }
    ],
    "afterAgentResponse": [
      {
        "command": "node /path/to/agent-memory/dist/hooks-cli.js afterAgentResponse",
        "timeout": 10
      }
    ],
    "afterAgentThought": [
      {
        "command": "node /path/to/agent-memory/dist/hooks-cli.js afterAgentThought",
        "timeout": 10
      }
    ],
    "stop": [
      {
        "command": "node /path/to/agent-memory/dist/hooks-cli.js stop",
        "timeout": 30
      }
    ]
  }
}
```

> 💡 **提示**：将 `/path/to/agent-memory` 替换为实际的项目路径。

> ⚠️ **Windows 用户**：路径使用正斜杠 `/` 或双反斜杠 `\\`，例如：`D:/GitHub/agent-memory/dist/hooks-cli.js`

#### Cursor 支持的 Hooks

| Hook | 触发时机 | 功能说明 |
|------|---------|---------|
| `beforeSubmitPrompt` | 提交 Prompt 前 | 会话初始化 + 自动注入历史上下文 |
| `afterShellExecution` | Shell 执行后 | 捕获命令行操作并生成记忆 |
| `afterMCPExecution` | MCP 工具执行后 | 捕获 MCP 工具调用并生成记忆 |
| `afterFileEdit` | 文件编辑后 | 捕获代码修改并生成记忆 |
| `afterAgentResponse` | Agent 响应后 | 记录 Agent 响应 |
| `afterAgentThought` | Agent 思考后 | 记录 Agent 思考过程 |
| `stop` | 会话结束 | 生成会话总结（Summary） |

配置完成后，**重启 Cursor** 使 hooks 生效。可以在 Cursor 设置中的 **Hooks** 选项卡查看配置状态和执行日志。

### 步骤二（C）：配置 CodeBuddy IDE Hooks

CodeBuddy IDE（独立 IDE 产品）使用 `settings.json` 配置 hooks，事件名为 PascalCase 风格。

**配置文件位置**：`~/.codebuddy/settings.json`

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "node /path/to/agent-memory/dist/hooks-cli.js UserPromptSubmit", "timeout": 10000 }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          { "type": "command", "command": "node /path/to/agent-memory/dist/hooks-cli.js PostToolUse", "timeout": 10000 }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node /path/to/agent-memory/dist/hooks-cli.js PreToolUse", "timeout": 10000 }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node /path/to/agent-memory/dist/hooks-cli.js Stop", "timeout": 30000 }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "node /path/to/agent-memory/dist/hooks-cli.js SessionStart", "timeout": 15000 }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "node /path/to/agent-memory/dist/hooks-cli.js SessionEnd", "timeout": 10000 }
        ]
      }
    ]
  }
}
```

> 💡 **提示**：将 `/path/to/agent-memory` 替换为实际的项目路径。

> ⚠️ **Windows 用户**：路径使用正斜杠 `/` 或双反斜杠 `\\`，例如：`D:/GitHub/agent-memory/dist/hooks-cli.js`。Windows 下命令格式为 `cmd.exe /c chcp 65001 >nul & node "path" event`。

#### CodeBuddy IDE 支持的 Hooks

| Hook | 触发时机 | 功能说明 |
|------|---------|---------|
| `UserPromptSubmit` | 提交 Prompt 前 | 会话初始化 + 自动注入历史上下文 |
| `PreToolUse` | 工具执行前（Bash） | 检测敏感命令 |
| `PostToolUse` | 工具执行后 | 统一捕获 Shell/MCP/文件编辑操作并生成记忆 |
| `Stop` | 会话停止 | 生成会话总结（Summary） |
| `SessionStart` | 会话开始 | 会话初始化 |
| `SessionEnd` | 会话结束 | 生成会话总结 |

配置完成后，**重启 CodeBuddy IDE** 使 hooks 生效。

### 步骤三：配置 MCP Server（可选）

如果需要使用 MCP 工具主动搜索历史记忆，需要配置 MCP Server。

#### CodeBuddy 插件版 MCP 配置

**配置文件位置**：`~/.gongfeng-copilot/mcp.json`

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "node",
      "args": ["/path/to/agent-memory/dist/servers/mcp-server.js"],
      "env": {}
    }
  }
}
```

#### Cursor MCP 配置

**配置文件位置**：`~/.cursor/mcp.json` 或 `<project>/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "node",
      "args": ["/path/to/agent-memory/dist/servers/mcp-server.js"],
      "env": {}
    }
  }
}
```

#### CodeBuddy IDE MCP 配置

**配置文件位置**：`~/.codebuddy/mcp.json`

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "node",
      "args": ["/path/to/agent-memory/dist/servers/mcp-server.js"],
      "env": {}
    }
  }
}
```

> 💡 **提示**：将 `/path/to/agent-memory` 替换为实际的项目路径。

---

## 🚀 启动服务

### 启动 Worker 服务（必须）

Worker 服务负责处理所有记忆存储和 AI 处理：

```bash
# 启动服务
npm run worker:start

# 查看服务状态
npm run worker:status

# 停止服务
npm run worker:stop

# 重启服务
npm run worker:restart
```

### 启动 MCP Server（可选）

如果配置了 MCP，MCP Server 会由 CodeBuddy 自动启动，无需手动操作。

如需手动测试：

```bash
npm run mcp:start
```

### 一键启动所有服务

```bash
npm run start:all
```

---

## 🌐 Web 记忆查看器

启动 Worker 服务后，可以通过浏览器访问 Web 界面查看所有记忆：

```
http://localhost:3847/viewer.html
```

### Web 界面功能

- 📋 **项目列表** - 查看所有有记忆的项目
- 📜 **会话历史** - 按时间线查看每个会话
- 🔍 **记忆搜索** - 全文搜索历史记忆
- 📊 **会话总结** - 查看 AI 生成的会话总结
- 📝 **操作详情** - 查看每个 Observation 的详细内容

---

## 📖 使用指南

### 基本工作流程

1. **启动 Worker 服务**
   ```bash
   npm run worker:start
   ```

2. **正常使用 CodeBuddy / Cursor**
   - 系统会自动捕获你的 Shell 命令、文件编辑、MCP 调用等操作
   - 每次操作会被 AI 压缩为结构化的 Observation

3. **会话结束时**
   - 自动生成会话总结（Summary）
   - 记录本次会话完成的任务、学到的知识、下一步计划

4. **新会话开始时**
   - 自动注入相关历史记忆到上下文
   - Agent 能"记住"之前的操作和知识

### MCP 工具使用

配置 MCP 后，可以在对话中让 CodeBuddy 主动搜索历史记忆：

```
# 搜索历史记忆
使用 search 工具搜索 "登录功能实现"

# 获取时间线上下文
使用 timeline 工具查看某个操作前后发生了什么

# 获取详细记忆
使用 get_observations 工具获取完整的操作详情
```

#### 可用的 MCP 工具

| 工具名 | 功能 | 参数 |
|--------|------|------|
| `search` | 搜索记忆 | `query`, `limit`, `project`, `type` |
| `timeline` | 获取时间线上下文 | `anchor` (观察ID), `depth_before`, `depth_after` |
| `get_observations` | 批量获取观察详情 | `ids` (ID数组) |
| `get_summaries` | 获取会话总结 | `ids`, `project`, `limit` |
| `list_projects` | 列出所有项目 | - |
| `list_sessions` | 列出会话 | `project`, `limit`, `offset` |
| `get_context` | 获取上下文注入数据 | `project`, `limit` |
| `get_stats` | 获取统计信息 | - |

---

## ⚙️ 高级配置

### 完整配置项

```env
# ===== AI API 配置 =====
# API Key（三选一）
TIMIAI_API_KEY=your_key_here
# OPENAI_API_KEY=sk-xxx
# ANTHROPIC_API_KEY=xxx

# 自定义 API 端点
CODEBUDDY_MEM_API_ENDPOINT=http://api.timiai.woa.com/ai_api_manage/llmproxy/chat/completions

# 使用的模型（默认 gpt-4o-mini）
CODEBUDDY_MEM_MODEL=gpt-4o-mini

# ===== 服务配置 =====
# Worker 服务端口（默认 3847）
CODEBUDDY_MEM_PORT=3847

# 请求超时时间（毫秒，默认 60000）
CODEBUDDY_MEM_TIMEOUT=60000

# 最大重试次数（默认 3）
CODEBUDDY_MEM_MAX_RETRIES=3

# ===== 日志配置 =====
# 日志级别：debug, info, warn, error（默认 info）
LOG_LEVEL=info

# 日志文件目录
LOG_DIR=./logs

# 最多保留的日志文件数量
LOG_MAX_FILES=10

# 是否写入文件
LOG_TO_FILE=true

# 是否输出到控制台
LOG_TO_CONSOLE=true

# ===== 数据存储 =====
# 数据存储目录（默认 ~/.agent-memory）
DATA_DIR=~/.agent-memory
```

### 配置加载优先级

1. `.env.local` - 本地配置文件（推荐，已被 gitignore）
2. `.env` - 通用配置文件
3. 系统环境变量

---

## 🔧 Hook 功能说明

| Hook | 触发时机 | 功能说明 |
|------|---------|---------|
| `beforeSubmitPrompt` | 提交 Prompt 前 | 会话初始化 + 自动注入历史上下文 |
| `afterShellExecution` | Shell 执行后 | 捕获命令行操作并生成记忆 |
| `afterMCPExecution` | MCP 工具执行后 | 捕获 MCP 工具调用并生成记忆 |
| `afterFileEdit` | 文件编辑后 | 捕获代码修改并生成记忆 |
| `stop` | 会话结束 | 生成会话总结（Summary） |

---

## 🔍 故障排查

### 1. Worker 服务无法启动

```bash
# 检查端口是否被占用
lsof -i :3847

# 查看详细日志
LOG_LEVEL=debug npm run worker:start
```

### 2. API Key 未配置

```bash
# 确保 .env.local 文件存在且配置正确
cat .env.local

# 检查环境变量是否生效
echo $TIMIAI_API_KEY
```

### 3. Hooks 不生效

```bash
# 确保 agent-memory 命令可用
which agent-memory

# 如果找不到，执行全局安装
npm link

# 手动测试 hook
agent-memory hook beforeSubmitPrompt
```

### 4. MCP 工具不可用

```bash
# 确保 Worker 服务已启动
npm run worker:status

# 检查 MCP 配置路径是否正确（插件版 / IDE版）
cat ~/.gongfeng-copilot/mcp.json
cat ~/.codebuddy/mcp.json
```

### 5. 查看日志文件

```bash
# 日志默认位置
ls -la ./logs/

# 或查看控制台输出
LOG_TO_CONSOLE=true npm run worker:start
```

---

## 📁 项目结构

```
agent-memory/
├── src/
│   ├── index.ts              # 主入口
│   ├── hooks/                # Hook Plugin 层
│   │   ├── index.ts          # 10 个 Hook 处理函数
│   │   └── types.ts          # Hook 类型定义
│   ├── sdk/                  # AI SDK 交互
│   │   ├── prompts.ts        # AI 提示词
│   │   └── parser.ts         # 响应解析
│   ├── services/
│   │   ├── sqlite/           # SQLite 存储
│   │   ├── worker/           # Worker 服务
│   │   └── context/          # 上下文构建
│   ├── servers/              # MCP Server
│   └── types/                # 类型定义
├── web/
│   └── viewer.html           # Web 查看器
├── .env.local.example        # 配置模板
├── package.json
└── README.md
```

---

## 📊 数据存储

所有记忆数据存储在本地 SQLite 数据库中：

- **位置**：`~/.agent-memory/agent-memory.db`
- **表结构**：
  - `sdk_sessions` - 会话记录
  - `observations` - 操作观察记录
  - `session_summaries` - 会话总结
  - `observations_fts` - 全文搜索索引

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

## 📄 许可证

AGPL-3.0 License — see [LICENSE](LICENSE) and [NOTICE](NOTICE)

---

## 🙏 致谢

本项目基于 [claude-mem](https://github.com/anthropics/claude-mem) 的设计理念，针对 CodeBuddy Agent 的 Hook 系统进行了适配和扩展。
