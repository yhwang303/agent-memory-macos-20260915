# Session、Summary 与 Observation 的关系与区别

## 概述

在 AgentMemory 记忆系统中，**Session（会话）**、**Summary（会话总结）** 和 **Observation（观察记录）** 是三个核心数据实体，它们共同构成了跨会话持久化记忆的基础。

```
┌─────────────────────────────────────────────────────────────┐
│                        Session                               │
│                    （会话生命周期容器）                        │
│                                                              │
│   ┌─────────────────────────────────────────────────────┐   │
│   │              Observations (0~N个)                    │   │
│   │   ┌─────┐  ┌─────┐  ┌─────┐  ┌─────┐  ┌─────┐      │   │
│   │   │Obs 1│  │Obs 2│  │Obs 3│  │Obs 4│  │Obs N│      │   │
│   │   └─────┘  └─────┘  └─────┘  └─────┘  └─────┘      │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                              │
│   ┌─────────────────────────────────────────────────────┐   │
│   │                 Summary (0~1个)                      │   │
│   │                                                      │   │
│   │    聚合多个 Observations 的高层次总结                  │   │
│   └─────────────────────────────────────────────────────┘   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 1. 数据模型定义

### 1.1 Session（会话）

```typescript
interface SDKSessionRow {
  id: number;
  content_session_id: string;       // CodeBuddy 原始会话 ID
  memory_session_id: string | null; // 记忆系统会话 ID（用于关联 Observation 和 Summary）
  project: string;                  // 项目名称
  user_prompt: string | null;       // 用户原始请求
  started_at: string;               // 会话开始时间
  started_at_epoch: number;         // 开始时间戳
  completed_at: string | null;      // 会话完成时间
  completed_at_epoch: number | null;// 完成时间戳
  status: 'active' | 'completed' | 'failed';  // 会话状态
  worker_port?: number;             // Worker 服务端口
  prompt_counter?: number;          // 提示计数器
}
```

**Session 的职责**：
- 管理整个交互的生命周期
- 持有 `memory_session_id` 作为关联 Observation 和 Summary 的外键
- 记录用户的原始请求 (`user_prompt`)
- 跟踪会话状态（active → completed/failed）

---

### 1.2 Observation（观察记录）

```typescript
interface ObservationRow {
  id: number;
  memory_session_id: string;        // 关联的 Session ID
  project: string;                  // 项目名称
  text: string | null;              // 原始文本描述
  type: string;                     // 观察类型（见下方）
  title: string | null;             // 标题
  subtitle: string | null;          // 副标题
  facts: string | null;             // 事实列表（逗号分隔）
  narrative: string | null;         // 叙事描述
  concepts: string | null;          // 概念标签（逗号分隔）
  files_read: string | null;        // 读取的文件列表
  files_modified: string | null;    // 修改的文件列表
  prompt_number: number | null;     // 提示序号
  discovery_tokens: number;         // 发现 token 数
  created_at: string;               // 创建时间
  created_at_epoch: number;         // 创建时间戳
}
```

**Observation 类型（type）**：
| 类型 | 说明 |
|------|------|
| `discovery` | 发现 |
| `bugfix` | Bug 修复 |
| `feature` | 功能开发 |
| `refactor` | 重构 |
| `documentation` | 文档 |
| `configuration` | 配置 |
| `debugging` | 调试 |
| `investigation` | 调查 |
| `learning` | 学习 |

---

### 1.3 Summary（会话总结）

```typescript
interface SessionSummaryRow {
  id: number;
  memory_session_id: string;        // 关联的 Session ID
  project: string;                  // 项目名称
  request: string | null;           // 用户原始请求（来自 user_prompt）
  investigated: string | null;      // 探索/调查的内容
  learned: string | null;           // 学习到的关键发现
  completed: string | null;         // 实际完成的工作
  next_steps: string | null;        // 建议的后续步骤
  files_read: string | null;        // 聚合的读取文件列表
  files_edited: string | null;      // 聚合的编辑文件列表
  notes: string | null;             // 附加说明
  prompt_number: number | null;     // 提示序号
  discovery_tokens: number;         // 发现 token 数
  created_at: string;               // 创建时间
  created_at_epoch: number;         // 创建时间戳
}
```

---

## 2. 核心区别对比

| 维度 | Session | Observation | Summary |
|------|---------|-------------|---------|
| **定位** | 生命周期容器 | 原子操作记录 | 会话级别总结 |
| **粒度** | 最粗（整个会话） | 最细（单次工具调用） | 中等（聚合多个 Observation） |
| **数量关系** | 1 个 | 0~N 个（每个会话） | 0~1 个（每个会话） |
| **创建时机** | `beforeSubmitPrompt` hook | `after*` hooks（如 afterFileEdit） | `stop` hook 或 `afterAgentResponse` |
| **内容** | 会话元数据 | 具体的操作细节 | 抽象的工作概述 |
| **生成方式** | 直接创建 | AI 压缩处理 | AI 聚合生成 |
| **数据库表** | `sdk_sessions` | `observations` | `session_summaries` |
| **用途** | 关联管理 | 细节追踪、精确搜索 | 概览浏览、快速回顾 |

---

## 3. 三者关系图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│                              Session                                        │
│                        (sdk_sessions 表)                                    │
│                                                                             │
│   content_session_id ────────┐                                              │
│   memory_session_id  ────────┼──────────────────────────────────────────┐   │
│   user_prompt        ────────┼───────────────────────────────┐         │   │
│   status             ────────┘                               │         │   │
│                                                              │         │   │
└──────────────────────────────────────────────────────────────┼─────────┼───┘
                                                               │         │
                                                               │         │
                  ┌────────────────────────────────────────────┼─────────┘
                  │                                            │
                  ▼                                            ▼
┌─────────────────────────────────────┐    ┌─────────────────────────────────┐
│                                     │    │                                 │
│          Observations               │    │            Summary              │
│        (observations 表)            │    │    (session_summaries 表)       │
│                                     │    │                                 │
│   memory_session_id = Session的     │    │   memory_session_id = Session的 │
│   memory_session_id                 │    │   memory_session_id             │
│                                     │    │                                 │
│   ┌───────┐ ┌───────┐ ┌───────┐    │    │   request = Session的           │
│   │ Obs 1 │ │ Obs 2 │ │ Obs N │    │    │   user_prompt                   │
│   └───────┘ └───────┘ └───────┘    │    │                                 │
│                                     │    │   files_read / files_edited     │
│                                     │    │   = 聚合自所有 Observations      │
│                                     │    │                                 │
└─────────────────────────────────────┘    └─────────────────────────────────┘
```

---

## 4. 生命周期与数据流

### 4.1 完整流程图

```
用户提问
    │
    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  Hook: beforeSubmitPrompt                                                    │
│  ─────────────────────────────────────────────────────────────────────────   │
│  1. 创建 Session 记录                                                         │
│  2. 生成 memory_session_id                                                   │
│  3. 保存 user_prompt                                                         │
│  4. 注入历史记忆上下文到提示词                                                 │
└──────────────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  Agent 执行工具调用（可能多次）                                                │
│  ─────────────────────────────────────────────────────────────────────────   │
│                                                                              │
│  ┌────────────────┐   ┌────────────────┐   ┌────────────────┐               │
│  │ afterFileEdit  │   │afterShellExec  │   │ afterMCPExec   │               │
│  └───────┬────────┘   └───────┬────────┘   └───────┬────────┘               │
│          │                    │                    │                        │
│          └────────────────────┼────────────────────┘                        │
│                               │                                             │
│                               ▼                                             │
│                    ┌──────────────────────┐                                 │
│                    │    Worker Service    │                                 │
│                    │    /observation      │                                 │
│                    └──────────┬───────────┘                                 │
│                               │                                             │
│                               ▼                                             │
│                    ┌──────────────────────┐                                 │
│                    │      SDK Agent       │                                 │
│                    │  processObservation  │                                 │
│                    └──────────┬───────────┘                                 │
│                               │                                             │
│                               ▼                                             │
│                    ┌──────────────────────┐                                 │
│                    │     AI 压缩处理       │                                 │
│                    │   (TIMIAI API)       │                                 │
│                    └──────────┬───────────┘                                 │
│                               │                                             │
│                               ▼                                             │
│                    ┌──────────────────────┐                                 │
│                    │   SQLite 存储        │                                 │
│                    │   observations 表    │ ◄─── 每次工具调用生成一条记录     │
│                    └──────────────────────┘                                 │
└──────────────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  Hook: afterAgentResponse / stop                                             │
│  ─────────────────────────────────────────────────────────────────────────   │
│                                                                              │
│  1. 获取该会话所有 Observations                                               │
│  2. 聚合 files_read / files_modified                                         │
│  3. 构建 Summary Prompt                                                      │
│  4. 调用 AI 生成总结                                                          │
│  5. 存储到 session_summaries 表                                              │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                                                                      │   │
│  │   Observations ────────────────┐                                    │   │
│  │   ┌─────┐ ┌─────┐ ┌─────┐     │                                    │   │
│  │   │Obs 1│ │Obs 2│ │Obs N│     │                                    │   │
│  │   └─────┘ └─────┘ └─────┘     │                                    │   │
│  │                               ▼                                    │   │
│  │                      ┌──────────────┐                              │   │
│  │   user_prompt ────►  │  AI 聚合     │ ────►  Summary               │   │
│  │                      │  生成总结     │                              │   │
│  │                      └──────────────┘                              │   │
│  │                                                                      │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────┘
    │
    ▼
会话结束，Session 状态更新为 completed
```

### 4.2 触发时机详解

| Hook | 触发条件 | 创建的实体 | 说明 |
|------|----------|-----------|------|
| `beforeSubmitPrompt` | 用户提交问题 | **Session** | 创建会话，注入历史记忆 |
| `afterFileEdit` | 编辑文件后 | **Observation** | 记录文件编辑操作 |
| `afterShellExecution` | 执行 Shell 命令后 | **Observation** | 记录命令执行结果 |
| `afterMCPExecution` | 调用 MCP 工具后 | **Observation** | 记录 MCP 工具调用 |
| `afterSearchReplaceFileEdit` | 搜索替换后 | **Observation** | 记录搜索替换操作 |
| `afterAgentResponse` | Agent 返回响应后 | **Summary** | 生成会话总结（异步） |
| `stop` | 会话结束时 | **Summary** | 生成会话总结（异步） |

---

## 5. 数据库表结构

### 5.1 sdk_sessions 表

```sql
CREATE TABLE sdk_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id TEXT NOT NULL UNIQUE,  -- CodeBuddy 会话 ID
  memory_session_id TEXT,                   -- 记忆系统会话 ID（关联键）
  project TEXT NOT NULL,
  user_prompt TEXT,
  started_at TEXT NOT NULL,
  started_at_epoch INTEGER NOT NULL,
  completed_at TEXT,
  completed_at_epoch INTEGER,
  status TEXT NOT NULL DEFAULT 'active',    -- active | completed | failed
  worker_port INTEGER,
  prompt_counter INTEGER DEFAULT 0
);
```

### 5.2 observations 表

```sql
CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_session_id TEXT NOT NULL,          -- 关联 Session
  project TEXT NOT NULL,
  text TEXT,
  type TEXT NOT NULL,                       -- discovery | bugfix | feature | ...
  title TEXT,
  subtitle TEXT,
  facts TEXT,
  narrative TEXT,
  concepts TEXT,
  files_read TEXT,
  files_modified TEXT,
  prompt_number INTEGER,
  discovery_tokens INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL
);
```

### 5.3 session_summaries 表

```sql
CREATE TABLE session_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_session_id TEXT NOT NULL,          -- 关联 Session
  project TEXT NOT NULL,
  request TEXT,                             -- 来自 Session.user_prompt
  investigated TEXT,
  learned TEXT,
  completed TEXT,
  next_steps TEXT,
  files_read TEXT,                          -- 聚合自 Observations
  files_edited TEXT,                        -- 聚合自 Observations
  notes TEXT,
  prompt_number INTEGER,
  discovery_tokens INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL
);
```

---

## 6. SQL 关联查询示例

### 6.1 获取完整会话信息（Session + Observations + Summary）

```sql
SELECT 
  s.id as session_id,
  s.content_session_id,
  s.memory_session_id,
  s.project,
  s.user_prompt,
  s.status,
  s.started_at,
  s.completed_at,
  -- 统计信息
  (SELECT COUNT(*) FROM observations WHERE memory_session_id = s.memory_session_id) as observation_count,
  (SELECT COUNT(*) FROM session_summaries WHERE memory_session_id = s.memory_session_id) as summary_count
FROM sdk_sessions s
ORDER BY s.started_at_epoch DESC
LIMIT 10;
```

### 6.2 获取某个会话的所有 Observations

```sql
SELECT o.*
FROM observations o
JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
WHERE s.content_session_id = 'your-session-id'
ORDER BY o.created_at_epoch ASC;
```

### 6.3 获取某个会话的 Summary

```sql
SELECT sum.*
FROM session_summaries sum
JOIN sdk_sessions s ON sum.memory_session_id = s.memory_session_id
WHERE s.content_session_id = 'your-session-id'
ORDER BY sum.created_at_epoch DESC
LIMIT 1;
```

---

## 7. 使用场景

### 7.1 Session 的使用场景
- 管理会话生命周期
- 跟踪会话状态
- 作为 Observation 和 Summary 的关联键
- 存储用户原始请求用于 Summary 生成

### 7.2 Observation 的使用场景
- 查找特定的代码修改记录
- 追踪某个 Bug 是如何修复的
- 了解某个功能的实现细节
- 搜索涉及特定文件的操作
- 按类型筛选（bugfix/feature/refactor 等）
- 注入到新会话的上下文中

### 7.3 Summary 的使用场景
- 快速了解之前会话做了什么
- 查看用户的原始需求
- 了解下一步建议
- 获取会话级别的学习总结
- 按项目浏览历史工作
- 注入到新会话的上下文中

---

## 8. 总结

| 特性 | Session | Observation | Summary |
|------|---------|-------------|---------|
| **定位** | 生命周期容器 | 原子操作记录 | 会话级别总结 |
| **关系** | 顶层容器 | 1:N（会话:观察） | 1:1（会话:总结） |
| **内容** | 会话元数据 | 具体的操作细节 | 抽象的工作概述 |
| **生成** | 会话开始时 | 实时（每次工具调用） | 延迟（会话结束时） |
| **用途** | 关联管理 | 细节追踪、精确搜索 | 概览浏览、快速回顾 |

**核心关系**：
- **Session** 是顶层容器，管理整个交互的生命周期
- **Observation** 是细粒度的操作记录，一个 Session 可以有多个 Observations
- **Summary** 是对多个 Observations 的聚合和抽象，一个 Session 最多有一个 Summary
- 三者通过 `memory_session_id` 字段关联
