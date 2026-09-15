# AgentMemory 项目介绍文档

> 版本: 1.0.0  
> 最后更新: 2026-02-10

---

## 📖 目录

1. [项目概述](#1-项目概述)
2. [核心功能](#2-核心功能)
3. [技术架构](#3-技术架构)
4. [数据模型](#4-数据模型)
5. [Hook 系统](#5-hook-系统)
6. [API 接口](#6-api-接口)
7. [安装与配置](#7-安装与配置)
8. [使用方法](#8-使用方法)
9. [项目结构](#9-项目结构)
10. [技术栈](#10-技术栈)

---

## 1. 项目概述

### 1.1 简介

**AgentMemory** 是一个为 CodeBuddy Agent 设计的**跨会话持久化记忆系统插件**。它通过捕获每次会话中的工具使用行为（如 Shell 命令、MCP 工具调用、文件编辑等），将其压缩为结构化的观察记录（Observation），存储到数据库中，并在未来会话启动时自动注入相关上下文。

### 1.2 设计理念

本项目基于 [claude-mem](https://github.com/anthropics/claude-mem) 的设计理念，针对 CodeBuddy Agent 的 **11 个生命周期钩子**进行了专门适配，实现了：

- **行为记忆**：记录用户与 Agent 的交互历史
- **智能压缩**：使用 AI 将原始数据压缩为结构化信息
- **上下文增强**：为新会话提供历史记忆支持

### 1.3 核心价值

| 价值点 | 说明 |
|-------|------|
| 🧠 记忆持久化 | 跨会话保存工具使用记录和操作历史 |
| 🔍 智能检索 | 支持按项目、类型、关键词搜索历史记忆 |
| 💉 上下文注入 | 新会话自动获取相关历史上下文 |
| 📊 会话总结 | 自动生成会话结束时的总结报告 |

---

## 2. 核心功能

### 2.1 工具使用捕获

通过 4 个细分钩子捕获不同类型的工具操作：

| 钩子 | 捕获内容 |
|-----|---------|
| `afterShellExecution` | Shell 命令执行记录 |
| `afterMCPExecution` | MCP 工具调用记录 |
| `afterFileEdit` | 文件编辑操作记录 |
| `afterSearchReplaceFileEdit` | 搜索替换操作记录 |

### 2.2 智能压缩

使用 AI Agent（支持 GPT-4o-mini、Anthropic、混元等模型）将原始工具数据压缩为结构化的 Observation，包含：

- **类型分类** (type)
- **标题摘要** (title/subtitle)
- **事实提取** (facts)
- **叙事描述** (narrative)
- **概念标签** (concepts)
- **文件关联** (files_read/files_modified)

### 2.3 持久化存储

采用 **SQLite 数据库**进行本地持久化存储，支持：

- 会话记录 (Sessions)
- 观察记录 (Observations)
- 会话总结 (Summaries)
- 用户提示 (User Prompts)
- 待处理消息队列 (Pending Messages)

### 2.4 上下文注入

新会话启动时通过 `beforeSubmitPrompt` 钩子自动：

1. 检索相关历史 Observations
2. 获取项目相关的会话总结
3. 构建上下文注入到 Agent prompt 中

### 2.5 MCP 搜索服务

提供 MCP Server 支持主动搜索历史记忆，可通过 MCP 协议与其他工具集成。

---

## 3. 技术架构

### 3.1 架构概览

```
用户操作 CodeBuddy Agent
        │
        ▼
┌───────────────────────────────┐
│    Hook Plugin Layer          │  ← 捕获 11 种生命周期事件
│    (src/hooks/)               │
└───────────────────────────────┘
        │ HTTP
        ▼
┌───────────────────────────────┐
│    Worker Service             │  ← Express API 处理
│    (src/services/worker/)     │
└───────────────────────────────┘
        │
        ▼
┌───────────────────────────────┐
│    SDK Agent                  │  ← AI 子进程压缩为结构化观察
│    (src/services/worker/)     │
└───────────────────────────────┘
        │ XML 解析
        ▼
┌───────────────────────────────┐
│    Storage Layer              │  ← SQLite 持久化存储
│    (src/services/sqlite/)     │
└───────────────────────────────┘
        │
        ▼
┌───────────────────────────────┐
│    Context Builder            │  ← 下次会话注入上下文
│    (src/services/context/)    │
└───────────────────────────────┘
```

### 3.2 数据流

```
┌─────────────┐    Hook触发    ┌───────────────┐    HTTP    ┌────────────────┐
│  CodeBuddy  │ ────────────▶  │  Hook Plugin  │ ────────▶  │ Worker Service │
│    Agent    │                │               │            │  (port:3847)   │
└─────────────┘                └───────────────┘            └────────────────┘
                                                                   │
      ┌────────────────────────────────────────────────────────────┤
      │                                                            │
      ▼                                                            ▼
┌───────────────┐                                        ┌─────────────────┐
│  SQLite DB    │ ◀──────────────────────────────────────│    SDK Agent    │
│  (memory.db)  │         存储 Observation               │   (AI 压缩)     │
└───────────────┘                                        └─────────────────┘
```

---

## 4. 数据模型

### 4.1 核心实体

#### SDK Session (会话记录)

```typescript
interface SDKSessionRow {
  id: number;
  content_session_id: string;      // CodeBuddy 会话 ID
  memory_session_id: string | null; // 记忆系统会话 ID
  project: string;                  // 项目名称
  user_prompt: string | null;       // 用户提示
  started_at: string;               // 开始时间
  completed_at: string | null;      // 完成时间
  status: 'active' | 'completed' | 'failed';
}
```

#### Observation (观察记录)

```typescript
interface ObservationRow {
  id: number;
  memory_session_id: string;
  project: string;
  type: string;           // 观察类型
  title: string | null;   // 标题
  subtitle: string | null;
  facts: string | null;   // 事实列表 (JSON)
  narrative: string | null; // 叙事描述
  concepts: string | null;  // 概念标签 (JSON)
  files_read: string | null;
  files_modified: string | null;
  created_at: string;
}
```

#### Session Summary (会话总结)

```typescript
interface SessionSummaryRow {
  id: number;
  memory_session_id: string;
  project: string;
  request: string | null;      // 用户请求
  investigated: string | null; // 调查内容
  learned: string | null;      // 学习到的
  completed: string | null;    // 完成内容
  next_steps: string | null;   // 后续步骤
  files_read: string | null;
  files_edited: string | null;
}
```

### 4.2 数据库表

| 表名 | 说明 |
|-----|------|
| `sdk_sessions` | 会话记录 |
| `observations` | 观察记录（核心） |
| `session_summaries` | 会话总结 |
| `user_prompts` | 用户提示记录 |
| `pending_messages` | 待处理消息队列 |

---

## 5. Hook 系统

### 5.1 支持的 Hook 类型

AgentMemory 支持 CodeBuddy Agent 的以下生命周期钩子：

| Hook 名称 | 触发时机 | 记忆系统功能 |
|----------|---------|-------------|
| `beforeSubmitPrompt` | 提交 Prompt 前 | 会话初始化 + 上下文注入 |
| `afterAgentResponse` | Agent 响应后 | 记录响应内容 |
| `afterAgentThought` | Agent 思考后 | 记录思考过程 |
| `stop` | 会话结束 | 生成会话总结 |
| `beforeShellExecution` | Shell 执行前 | 命令审核（可选） |
| `afterShellExecution` | Shell 执行后 | 捕获命令行操作 |
| `beforeMCPExecution` | MCP 执行前 | 工具调用审核（可选） |
| `afterMCPExecution` | MCP 执行后 | 捕获 MCP 工具调用 |
| `afterSearchReplaceFileEdit` | 搜索替换后 | 捕获替换操作 |
| `afterFileEdit` | 文件编辑后 | 捕获代码修改 |

### 5.2 Hook 上下文接口

每个 Hook 都会接收到基础上下文：

```typescript
interface HookContext {
  sessionId: string;   // 会话 ID
  project: string;     // 项目名称
  timestamp: number;   // 时间戳
}
```

### 5.3 核心 Hook 详解

#### beforeSubmitPrompt

```typescript
interface BeforeSubmitPromptContext extends HookContext {
  prompt: string;
  isNewSession: boolean;
}

interface BeforeSubmitPromptResult {
  allow: boolean;
  modifiedPrompt?: string;
  additionalContext?: string;  // 注入的历史上下文
}
```

#### afterShellExecution

```typescript
interface AfterShellExecutionContext extends HookContext {
  command: string;
  workingDirectory: string;
  output: string;
  exitCode: number;
  duration: number;
}
```

#### afterFileEdit

```typescript
interface AfterFileEditContext extends HookContext {
  filePath: string;
  diff: string;
  linesAdded: number;
  linesRemoved: number;
}
```

---

## 6. API 接口

### 6.1 Worker Service API

Worker Service 运行在 `http://localhost:3847`，提供以下 API：

| 接口 | 方法 | 说明 |
|-----|------|------|
| `/health` | GET | 健康检查，包含统计信息 |
| `/api/search` | GET | 搜索 observations |
| `/api/context/inject` | GET | 获取上下文注入数据 |
| `/api/viewer/sessions` | GET | 获取会话列表 |
| `/api/viewer/observations` | GET | 获取观察记录列表 |
| `/api/viewer/summaries` | GET | 获取会话总结列表 |
| `/api/viewer/projects` | GET | 获取项目列表 |

### 6.2 搜索 API 示例

```bash
# 搜索观察记录
GET /api/search?query=登录功能&project=my-app&limit=10

# 获取上下文注入
GET /api/context/inject?project=my-app&sessionId=sess-xxx
```

### 6.3 MCP Server

提供符合 MCP 协议的搜索服务，可通过 MCP 客户端调用：

```bash
npm run mcp:start
```

---

## 7. 安装与配置

### 7.1 安装

```bash
# 克隆项目
git clone <repository-url>
cd agent-memory

# 安装依赖
npm install

# 编译
npm run build
```

### 7.2 配置

#### 本地配置文件（推荐）

```bash
# 复制配置模板
cp .env.local.example .env.local

# 编辑配置
```

#### 支持的 API Key（三选一）

| 环境变量 | 说明 | 获取方式 |
|---------|------|---------|
| `TIMIAI_API_KEY` | 腾讯内部 TIMIAI API（推荐） | http://api.timiai.woa.com |
| `OPENAI_API_KEY` | OpenAI API | https://platform.openai.com |
| `ANTHROPIC_API_KEY` | Anthropic API | https://console.anthropic.com |

#### 可选配置项

```env
# API 端点
CODEBUDDY_MEM_API_ENDPOINT=http://api.timiai.woa.com/ai_api_manage/llmproxy/chat/completions

# 使用的模型（默认 gpt-4o-mini）
CODEBUDDY_MEM_MODEL=gpt-4o-mini

# Worker 服务端口（默认 3847）
CODEBUDDY_MEM_PORT=3847

# 日志级别：debug, info, warn, error
LOG_LEVEL=info

# 数据存储目录
DATA_DIR=~/.agent-memory
```

### 7.3 CodeBuddy Hooks 配置

在 CodeBuddy 配置文件中添加：

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

---

## 8. 使用方法

### 8.1 启动 Worker 服务

```bash
# 启动服务
npm run worker:start

# 查看状态
npm run worker:status

# 重启服务
npm run worker:restart

# 停止服务
npm run worker:stop
```

### 8.2 启动 MCP Server

```bash
npm run mcp:start
```

### 8.3 查看记忆数据

打开浏览器访问：
```
http://localhost:3847/viewer.html
```

可视化界面支持：
- 查看所有会话列表
- 浏览观察记录
- 查看会话总结
- 按项目筛选
- 查看详细 JSON

### 8.4 命令行工具

```bash
# 执行 Hook
agent-memory hook <hookName>

# 示例
agent-memory hook beforeSubmitPrompt
agent-memory hook afterShellExecution
agent-memory hook stop
```

---

## 9. 项目结构

```
agent-memory/
├── src/
│   ├── index.ts              # 主入口，导出公共 API
│   ├── hooks/                # Hook Plugin 层
│   │   ├── index.ts          # Hook 入口和路由
│   │   └── types.ts          # Hook 类型定义
│   ├── hooks-cli.ts          # Hook CLI 处理
│   ├── sdk/                  # AI SDK 交互
│   │   ├── prompts.ts        # AI 提示词构建
│   │   └── parser.ts         # XML 响应解析
│   ├── services/
│   │   ├── sqlite/           # SQLite 存储层
│   │   │   ├── Database.ts   # 数据库连接管理
│   │   │   ├── observations.ts
│   │   │   ├── sessions.ts
│   │   │   └── summaries.ts
│   │   ├── worker/           # Worker 服务
│   │   │   ├── WorkerService.ts  # Worker 主服务
│   │   │   ├── SDKAgent.ts   # AI Agent 封装
│   │   │   └── client.ts     # Worker 客户端
│   │   └── context/          # 上下文构建
│   │       └── builder.ts    # 上下文构建器
│   ├── servers/              # MCP Server
│   │   └── mcp-server.ts
│   ├── types/                # TypeScript 类型定义
│   │   ├── database.ts
│   │   ├── hooks.ts
│   │   └── index.ts
│   ├── utils/                # 工具函数
│   │   └── logger.ts
│   └── shared/               # 共享模块
│       └── paths.ts
├── bin/
│   └── agent-memory.ts      # CLI 入口
├── web/
│   └── viewer.html           # 记忆查看器 Web 界面
├── tests/                    # 测试文件
├── docs/                     # 文档
├── APIRef/                   # API 参考文档
├── package.json
├── tsconfig.json
└── README.md
```

---

## 10. 技术栈

### 10.1 核心技术

| 技术 | 版本 | 用途 |
|-----|------|------|
| TypeScript | ^5.3.0 | 主开发语言 |
| Node.js | >=18.0.0 | 运行环境 |
| Express | ^4.18.2 | HTTP 服务框架 |
| better-sqlite3 | ^12.6.2 | SQLite 数据库 |
| @modelcontextprotocol/sdk | ^1.25.1 | MCP 协议支持 |

### 10.2 开发工具

| 工具 | 用途 |
|-----|------|
| tsx | TypeScript 执行器 |
| tsc | TypeScript 编译器 |

### 10.3 支持的 AI 模型

| 供应商 | 模型 |
|-------|------|
| Azure | gpt-4o, gpt-4o-mini, gpt-5 系列 |
| Google | Gemini 2.5/3 系列 |
| Anthropic | Claude 系列 |
| 腾讯混元 | 混元系列模型 |

---

## 📄 许可证

MIT License

---

## 🔗 相关链接

- [README.md](./README.md) - 快速入门
- [CODEBUDDY.md](./CODEBUDDY.md) - CodeBuddy 集成说明
- [APIRef/API-Reference.md](./APIRef/API-Reference.md) - API 参考
- [docs/PRD-memory-viewer.md](./docs/PRD-memory-viewer.md) - 产品需求文档
