# AgentMemory 技术架构与原理

## 一、项目概述

AgentMemory 是一个为 AI 编程助手（CodeBuddy Agent / Cursor）提供**跨会话持久化记忆**的插件系统。它在 AI 编码会话中自动捕获关键操作，通过 AI 将原始操作压缩为结构化记忆，并在后续会话中自动注入历史上下文，使 AI 助手具备"记忆力"。

### 核心能力

- **自动捕获**：通过 Hook 机制拦截 Shell 命令、MCP 调用、文件编辑、Agent 响应等操作
- **智能压缩**：调用 LLM 将原始操作数据提取为结构化的 Observation（观察）记录
- **会话总结**：会话结束时，聚合所有 Observation 生成 Summary（总结）
- **上下文注入**：新会话开始时，自动将历史记忆注入到 Prompt 中
- **多项目隔离**：不同 Workspace 的记忆彼此独立
- **全文搜索**：支持 FTS5 全文搜索和 LIKE 模糊搜索（适配中文）

---

## 二、技术栈

| 类别 | 技术 | 说明 |
|------|------|------|
| **语言** | TypeScript 5.3 | 全栈使用 TypeScript，类型安全 |
| **运行时** | Node.js ≥ 18 | 支持原生 ESM |
| **数据库** | SQLite (better-sqlite3) | 嵌入式数据库，零配置部署，WAL 模式支持并发读取 |
| **全文搜索** | SQLite FTS5 | 内置全文搜索引擎，通过触发器自动同步索引 |
| **HTTP 服务** | Node.js 原生 http | 轻量级 HTTP API 服务器，无框架依赖 |
| **MCP 协议** | @modelcontextprotocol/sdk | 实现 Model Context Protocol，供 AI 客户端主动查询记忆 |
| **AI 处理** | OpenAI 兼容 API / claude CLI | 默认使用 TIMIAI 平台（gpt-4o-mini），也支持 OpenAI / Anthropic；可通过 `CODEBUDDY_MEM_PROVIDER=claude-code` 切换为本地 claude CLI |
| **编码处理** | iconv-lite | 解决 Windows GBK/GB18030 编码问题 |
| **开发工具** | tsx | TypeScript 即时执行，无需预编译 |

---

## 三、系统架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                    CodeBuddy Agent / Cursor IDE                     │
│                                                                     │
│  ┌─────────────┐    ┌──────────────┐    ┌────────────────────────┐  │
│  │ Shell 命令   │    │ 文件编辑      │    │ MCP 工具调用           │  │
│  └──────┬──────┘    └──────┬───────┘    └───────────┬────────────┘  │
│         │                  │                        │               │
│         └──────────────────┼────────────────────────┘               │
│                            │                                        │
│                     ┌──────▼──────┐                                 │
│                     │  Hook 层    │  (hooks-cli.ts / hooks/index.ts)│
│                     └──────┬──────┘                                 │
└────────────────────────────┼────────────────────────────────────────┘
                             │ HTTP
                    ┌────────▼────────┐
                    │  Worker Service  │  (端口 3847)
                    │  ┌────────────┐  │
                    │  │  SDKAgent   │  │ ← AI 处理引擎
                    │  └────────────┘  │
                    │  ┌────────────┐  │
                    │  │  SQLite DB  │  │ ← 持久化存储
                    │  └────────────┘  │
                    └────────┬────────┘
                             │ stdio
                    ┌────────▼────────┐
                    │   MCP Server    │  ← AI 客户端主动查询入口
                    └─────────────────┘
```

### 进程模型

系统由三类进程组成：

1. **Worker Service**：核心后台服务，独立 HTTP 进程（默认端口 3847），负责接收 Hook 数据、调用 AI、读写数据库
2. **Hook 层**：运行在 Agent 进程内（或作为 CLI 子进程），通过 HTTP 调用 Worker
3. **MCP Server**：独立进程，通过 stdio 与 MCP 客户端通信，内部 HTTP 转发到 Worker

---

## 四、核心数据模型

系统围绕三个核心概念构建：**Session → Observation → Summary**

### 4.1 Session（会话）

每次用户与 AI 助手的交互会话。

```
sdk_sessions
├── content_session_id   # Agent 端的会话 ID（唯一）
├── memory_session_id    # 记忆系统内部 ID
├── project              # 项目路径（用于隔离）
├── user_prompt          # 用户的原始请求
├── status               # active / completed
└── started_at / completed_at
```

### 4.2 Observation（观察）

单次工具调用的结构化记录，是记忆的最小粒度单元。

```
observations
├── memory_session_id    # 所属会话
├── project              # 项目路径
├── type                 # discovery | bugfix | feature | refactor | ...
├── title                # 简短描述（≤80字符）
├── subtitle             # 补充上下文
├── meta_intent          # 元意图：用户的深层目的
├── facts                # 可验证的事实列表
├── narrative            # 叙事：发生了什么、为什么重要
├── concepts             # 相关概念标签
├── files_read           # 读取的文件
├── files_modified       # 修改的文件
└── created_at_epoch     # 时间戳
```

### 4.3 Summary（总结）

会话级别的聚合总结，从该会话的所有 Observation 中提炼。

```
session_summaries
├── memory_session_id    # 所属会话
├── project              # 项目路径
├── request              # 用户想做什么（一句话）
├── investigated         # 探索了什么
├── learned              # 关键发现
├── meta_intent          # 深层目的
├── completed            # 完成了什么
├── next_steps           # 后续建议
├── files_read / files_edited
└── created_at_epoch
```

### 数据关系

```
1 Session ──── N Observations   （一个会话产生多个观察）
1 Session ──── 1 Summary        （一个会话生成一份总结）
```

---

## 五、记忆记录流程

整个记忆系统的生命周期可分为四个阶段：

### 阶段一：会话初始化 + 上下文注入

```
用户输入 Prompt
       │
       ▼
beforeSubmitPrompt Hook 触发
       │
       ├── 1. 创建 Session
       │   POST /api/session/start
       │   → createSession() 写入 sdk_sessions
       │
       └── 2. 注入历史记忆
           GET /api/context/inject?project=...
           → ContextBuilder.buildContext()
           → 查询最近 5 条 Summary + 10 条 Observation
           → 格式化为 <memory_context> XML
           → 作为 additionalContext 注入到 Prompt
```

注入的上下文格式示例：

```xml
<memory_context>
  <recent_sessions>
    <session date="2026-03-05T10:00:00Z">
      <request>用户想要优化数据库查询性能</request>
      <learned>发现 N+1 查询问题是主要瓶颈</learned>
      <completed>添加了批量查询接口，性能提升 3x</completed>
      <next_steps>考虑添加 Redis 缓存层</next_steps>
    </session>
  </recent_sessions>
  <observations>
    <observation type="bugfix" date="2026-03-05T09:30:00Z">
      <title>修复数据库连接泄漏</title>
      <narrative>发现连接池未正确关闭，导致内存泄漏</narrative>
    </observation>
  </observations>
</memory_context>
```

### 阶段二：实时观察记录

Agent 执行过程中，每次工具调用都会触发对应的 Hook，自动记录为 Observation。

```
Agent 执行工具
       │
       ├── afterShellExecution    → Shell 命令执行后
       ├── afterFileEdit          → 文件编辑后
       ├── afterSearchReplaceFileEdit → 搜索替换后
       ├── afterMCPExecution      → MCP 工具调用后
       ├── afterAgentResponse     → Agent 响应后
       └── afterAgentThought      → Agent 思考后
              │
              ▼
       构造 NormalizedObservation
              │
              ▼
       POST /api/observation → WorkerService
              │
              ▼
       SDKAgent.processObservation()
              │
              ├── 1. 根据类型选择 Prompt 模板
              │   ├── agent_response → buildResponsePrompt()
              │   ├── agent_thought  → buildThoughtPrompt()
              │   └── 其他工具       → buildObservationPrompt()
              │
              ├── 2. 调用 LLM API 提取结构化信息
              │   → OpenAI 兼容接口 (gpt-4o-mini)
              │   → 指数退避重试（最多 3 次）
              │
              ├── 3. 解析 AI 返回的 XML
              │   → parseObservations() 提取 type/title/facts/narrative/...
              │   → 如果返回 <skip/>，则不写入
              │
              └── 4. 写入数据库
                  → insertObservation() 写入 observations 表
                  → FTS 触发器自动同步到 observations_fts
```

#### AI 提取示例

原始输入（Shell 命令执行）：

```json
{
  "tool_name": "shell",
  "parameters": { "command": "npm", "args": ["test"] },
  "outcome": { "exitCode": 1, "stderr": "FAIL src/utils.test.ts..." }
}
```

AI 提取后的 Observation：

```xml
<observation>
  <type>debugging</type>
  <title>单元测试失败：utils.test.ts</title>
  <subtitle>npm test 执行失败，退出码 1</subtitle>
  <meta_intent>【质量保证意图】：运行测试套件验证代码正确性，发现 utils 模块存在回归</meta_intent>
  <facts>
    <fact>npm test 退出码为 1，表示测试失败</fact>
    <fact>失败的测试文件是 src/utils.test.ts</fact>
  </facts>
  <narrative>执行单元测试发现 utils 模块测试未通过，需要排查失败原因</narrative>
  <concepts>
    <concept>unit-testing</concept>
    <concept>regression</concept>
  </concepts>
</observation>
```

### 阶段三：会话总结生成

```
会话结束（用户关闭 / stop Hook）
       │
       ▼
POST /api/session/end
       │
       ▼
SDKAgent.generateSummary()
       │
       ├── 1. 等待 Observations 就绪
       │   → 最多重试 6 次 × 5 秒（应对异步写入延迟）
       │
       ├── 2. 获取该会话的所有 Observations
       │   → getObservationsBySession()
       │   → 最多取最近 20 条
       │
       ├── 3. 聚合文件信息
       │   → 从 Observations 收集 files_read / files_modified
       │
       ├── 4. 构建 Summary Prompt
       │   → buildSummaryPrompt()
       │   → 包含用户请求 + Observations 摘要
       │   → 处理 Windows 编码乱码问题
       │
       ├── 5. 调用 LLM 生成总结
       │   → 全中文输出
       │   → parseSummary() 解析 XML
       │   → isPlaceholderContent() 过滤无效输出
       │
       └── 6. 写入数据库
           → insertSummary() 写入 session_summaries
           → FTS 触发器同步到 summaries_fts
           → updateSessionStatus('completed')
```

#### 并发安全

- `pendingSummaries` Map 防止同一 Session 并发生成多个 Summary
- `withRetry()` 处理 `SQLITE_BUSY` 数据库锁竞争

### 阶段四：记忆检索

系统提供两种检索方式：

#### 方式一：自动注入（被动）

每次新会话的 `beforeSubmitPrompt` 自动注入，由 `ContextBuilder` 完成：

```
ContextBuilder.buildContext(project)
       │
       ├── getSummariesByProject(project, limit=5)    # 最近 5 条总结
       ├── getObservationsByProject(project, limit=10) # 最近 10 条观察
       │
       └── 格式化为 <memory_context> XML → 注入 Prompt
```

支持 Token 限制：默认 4000 Token 上限，超出时优先裁剪 Observation，再裁剪 Summary。

#### 方式二：MCP 主动搜索

AI 客户端通过 MCP 协议主动查询记忆：

| MCP 工具 | 功能 | 对应 API |
|----------|------|----------|
| `search` | FTS5 全文搜索 | `GET /api/search` |
| `search_like` | LIKE 模糊搜索（中文友好） | `GET /api/search_like` |
| `timeline` | 时间线浏览 | `GET /api/timeline` |
| `get_observations` | 批量获取 Observation 详情 | `POST /api/observations/batch` |
| `get_summaries` | 批量获取 Summary 详情 | `POST /api/summaries/batch` |
| `get_context` | 获取格式化上下文 | `GET /api/context/inject` |
| `list_projects` | 列出所有项目 | `GET /api/viewer/projects` |
| `list_sessions` | 列出项目的会话 | `GET /api/viewer/sessions` |

推荐查询流程：`search` → `timeline` → `get_observations`（渐进式获取，节省 Token）

---

## 六、数据库设计

### 存储位置

```
~/.agent-memory/agent-memory.db
```

### SQLite 优化配置

| 配置项 | 值 | 说明 |
|--------|-----|------|
| `journal_mode` | WAL | 允许并发读取，写入不阻塞读取 |
| `busy_timeout` | 10000ms | 数据库锁等待超时 |
| `foreign_keys` | ON | 启用外键约束 |
| `synchronous` | NORMAL | 平衡性能与数据安全 |

### 全文搜索索引

使用 SQLite FTS5 扩展实现全文搜索：

- **observations_fts**：索引 text、title、subtitle、meta_intent、facts、narrative、concepts
- **summaries_fts**：索引 request、investigated、learned、meta_intent、completed、next_steps、notes

通过 `AFTER INSERT` 触发器自动保持 FTS 索引与主表同步。

### 自动迁移机制

`EXPECTED_COLUMNS` 字典定义了每张表应有的列。启动时自动检测缺失列并补全（`ALTER TABLE ADD COLUMN`），如有列变更则重建对应的 FTS 索引并回填数据。

---

## 七、AI 处理管线

### AI 提供者

系统支持两种 AI 提供者，通过环境变量 `CODEBUDDY_MEM_PROVIDER` 切换：

| 提供者 | 配置值 | 说明 |
|--------|-------|------|
| HTTP API（默认） | `api` | OpenAI 兼容 API（TIMIAI / OpenAI / Anthropic），需要 API Key |
| Claude Code CLI | `claude-code` | 本地 `claude` CLI，无需 API Key，需要安装 claude CLI 并登录 Anthropic 账号 |

**切换到 claude CLI 模式**：

```bash
CODEBUDDY_MEM_PROVIDER=claude-code
# 可选：指定 claude 二进制路径
CODEBUDDY_MEM_CLAUDE_CODE_PATH=/usr/local/bin/claude
```

两种提供者使用完全相同的 Prompt 模板和 XML 解析逻辑，产出的数据格式一致。

### Prompt 工程

系统为不同类型的输入设计了专门的 Prompt 模板：

| 模板 | 用途 | 输出 |
|------|------|------|
| `buildObservationPrompt` | 工具调用（Shell/文件编辑/MCP） | `<observation>` XML |
| `buildResponsePrompt` | Agent 响应 | `<observation>` XML |
| `buildThoughtPrompt` | Agent 思考过程 | `<observation>` XML |
| `buildSummaryPrompt` | 会话总结 | `<summary>` XML |

所有 Prompt 都包含：

- **敏感信息过滤规则**：强制脱敏 API Key、密码等
- **元意图（meta_intent）捕获**：要求记录用户的深层目的，而非表面操作
- **中文输出要求**：Summary 强制中文输出

### XML 解析

AI 返回的 XML 由 `parser.ts` 中的 `parseObservations()` 和 `parseSummary()` 解析为结构化对象。支持 `<skip reason="..."/>` 跳过无价值的记录。

### 容错机制

- **指数退避重试**：API 调用失败后等待 `1s → 2s → 4s` 重试，最多 3 次（两种提供者均适用）
- **超时控制**：默认 60 秒请求超时（claude CLI 模式会 kill 子进程）
- **占位符检测**：`isPlaceholderContent()` 过滤 AI 返回的明显无效内容
- **编码处理**：检测 Windows GBK 乱码并在 Prompt 中提示 AI 从 Observations 推断用户意图
- **Graceful Degradation**：Hook 层失败不阻塞用户操作
- **明确的 CLI 错误提示**：claude CLI 未安装时提供安装链接，而非静默失败

---

## 八、双入口 Hook 机制

### 入口一：模块式（CodeBuddy SDK）

`src/hooks/index.ts` 导出标准 Hook 函数，供 CodeBuddy Agent 直接 import 调用。

### 入口二：CLI 式（Cursor / hooks.json）

`src/hooks-cli.ts` 作为 CLI 进程，从 stdin 读取 JSON、写 JSON 到 stdout，适配 Cursor 的 `hooks.json` 配置机制。

两种入口最终都通过 `WorkerClient` HTTP 调用 Worker Service，共享同一套记忆系统。

---

## 九、完整数据流总览

```
┌──────────────────── 会话生命周期 ────────────────────┐
│                                                       │
│  ① 会话开始                                           │
│  beforeSubmitPrompt                                   │
│       │                                               │
│       ├─→ 创建 Session (sdk_sessions)                 │
│       └─→ 注入历史 <memory_context>                   │
│                                                       │
│  ② Agent 工作中（循环多次）                            │
│  afterShellExecution / afterFileEdit / ...             │
│       │                                               │
│       └─→ SDKAgent.processObservation()               │
│            ├─→ LLM 提取结构化 Observation              │
│            └─→ 写入 observations + FTS 索引            │
│                                                       │
│  ③ 会话结束                                           │
│  stop                                                 │
│       │                                               │
│       └─→ SDKAgent.generateSummary()                  │
│            ├─→ 聚合该会话所有 Observations              │
│            ├─→ LLM 生成 Summary                       │
│            └─→ 写入 session_summaries + FTS 索引       │
│                                                       │
│  ④ 下次会话                                           │
│  beforeSubmitPrompt                                   │
│       │                                               │
│       └─→ 读取历史 Summary + Observation               │
│            → 注入新会话 Prompt ← 记忆闭环 ✓            │
│                                                       │
└───────────────────────────────────────────────────────┘
```

---

## 十、项目目录结构

```
agent-memory/
├── src/
│   ├── hooks/              # Hook 插件层（捕获 Agent 操作）
│   │   ├── index.ts        #   模块式入口（CodeBuddy SDK）
│   │   └── types.ts        #   Hook 类型定义
│   ├── hooks-cli.ts        # CLI 式入口（Cursor hooks.json）
│   ├── sdk/                # AI Prompt 与解析
│   │   ├── prompts.ts      #   Prompt 模板构建
│   │   └── parser.ts       #   XML 响应解析
│   ├── servers/            # MCP Server
│   │   └── mcp-server.ts   #   MCP 工具定义与转发
│   ├── services/
│   │   ├── sqlite/         # 数据持久化层
│   │   │   ├── Database.ts #   数据库初始化、Schema、迁移
│   │   │   ├── observations.ts # Observation CRUD + 搜索
│   │   │   ├── summaries.ts    # Summary CRUD + 搜索
│   │   │   └── sessions.ts     # Session CRUD
│   │   ├── worker/         # Worker 服务层
│   │   │   ├── WorkerService.ts # HTTP API 服务器
│   │   │   ├── SDKAgent.ts      # AI 处理引擎
│   │   │   └── client.ts        # Worker HTTP 客户端
│   │   └── context/        # 上下文构建
│   │       └── builder.ts  #   记忆格式化与注入
│   ├── types/              # 类型定义
│   ├── utils/              # 工具函数
│   └── bin/
│       └── worker.ts       # Worker 进程入口
├── web/
│   └── viewer.html         # 记忆 Web 查看器
├── scripts/                # 迁移与安装脚本
├── docs/                   # 文档
└── package.json
```
