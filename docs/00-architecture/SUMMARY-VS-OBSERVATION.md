# Summary 与 Observation 的关系与区别

## 概述

在 AgentMemory 记忆系统中，**Observation（观察记录）** 和 **Summary（会话总结）** 是两个核心数据实体，它们共同构成了跨会话持久化记忆的基础。

---

## 1. 数据模型对比

### 1.1 Observation（观察记录）

```typescript
interface ObservationRow {
  id: number;
  memory_session_id: string;    // 关联的记忆会话 ID
  project: string;              // 项目名称
  text: string | null;          // 原始文本描述
  type: string;                 // 观察类型（见下方）
  title: string | null;         // 标题
  subtitle: string | null;      // 副标题
  facts: string | null;         // 事实列表（逗号分隔）
  narrative: string | null;     // 叙事描述
  concepts: string | null;      // 概念标签（逗号分隔）
  files_read: string | null;    // 读取的文件列表
  files_modified: string | null;// 修改的文件列表
  prompt_number: number | null;
  discovery_tokens: number;
  created_at: string;
  created_at_epoch: number;
}
```

**Observation 类型（type）：**
- `discovery` - 发现
- `bugfix` - Bug 修复
- `feature` - 功能开发
- `refactor` - 重构
- `documentation` - 文档
- `configuration` - 配置
- `debugging` - 调试
- `investigation` - 调查
- `learning` - 学习

### 1.2 Summary（会话总结）

```typescript
interface SessionSummaryRow {
  id: number;
  memory_session_id: string;    // 关联的记忆会话 ID
  project: string;              // 项目名称
  request: string | null;       // 用户原始请求
  investigated: string | null;  // 探索/调查的内容
  learned: string | null;       // 学习到的关键发现
  completed: string | null;     // 实际完成的工作
  next_steps: string | null;    // 建议的后续步骤
  files_read: string | null;    // 聚合的读取文件列表
  files_edited: string | null;  // 聚合的编辑文件列表
  notes: string | null;         // 附加说明
  prompt_number: number | null;
  discovery_tokens: number;
  created_at: string;
  created_at_epoch: number;
}
```

---

## 2. 核心区别

| 维度 | Observation | Summary |
|------|-------------|---------|
| **粒度** | 细粒度（单次工具操作） | 粗粒度（整个会话） |
| **数量关系** | 一个会话可有多个 | 一个会话通常只有一个 |
| **生成时机** | 每次 Hook 事件触发时 | 会话结束时（afterAgentResponse） |
| **内容来源** | 单次工具调用的输入/输出 | 聚合该会话所有 Observations |
| **用途** | 记录具体操作细节 | 提供会话级别的概览 |
| **关联关系** | 被 Summary 引用 | 引用多个 Observations |

---

## 3. 数据流关系图

```
┌─────────────────────────────────────────────────────────────────────┐
│                         一次完整会话                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐            │
│  │ Observation  │   │ Observation  │   │ Observation  │   ...      │
│  │     #1       │   │     #2       │   │     #3       │            │
│  │  (file edit) │   │  (mcp call)  │   │  (shell cmd) │            │
│  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘            │
│         │                  │                  │                     │
│         └──────────────────┼──────────────────┘                     │
│                            │                                        │
│                            ▼                                        │
│                   ┌────────────────┐                                │
│                   │    Summary     │                                │
│                   │   (聚合总结)    │                                │
│                   │                │                                │
│                   │ - request      │                                │
│                   │ - investigated │                                │
│                   │ - learned      │                                │
│                   │ - completed    │                                │
│                   │ - next_steps   │                                │
│                   │ - files_read   │ ← 聚合自所有 Observations      │
│                   │ - files_edited │ ← 聚合自所有 Observations      │
│                   └────────────────┘                                │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 4. 生成流程

### 4.1 Observation 生成流程

```
Hook 事件触发
     │
     ▼
┌─────────────────┐
│ afterFileEdit   │
│ afterMCPExec    │  ← 各种 Hook 类型
│ afterShellExec  │
│ ...             │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Worker Service │
│  /observation   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   SDK Agent     │
│ processObs()    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   AI 压缩处理    │
│ (TIMIAI API)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  SQLite 存储    │
│  observations   │
└─────────────────┘
```

### 4.2 Summary 生成流程

```
afterAgentResponse Hook
         │
         ▼
┌─────────────────┐
│  Worker Service │
│  /generate-     │
│   summary       │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────┐
│         SDK Agent               │
│      generateSummary()          │
│                                 │
│  1. 获取该会话所有 Observations  │
│  2. 聚合 files_read/modified    │
│  3. 构建 Summary Prompt         │
│  4. 调用 AI 生成总结             │
└────────────┬────────────────────┘
             │
             ▼
┌─────────────────┐
│   AI 生成总结    │
│ (TIMIAI API)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  SQLite 存储    │
│session_summaries│
└─────────────────┘
```

---

## 5. 上下文注入

在新会话开始时，系统会将历史的 Observations 和 Summaries 注入到上下文中：

```xml
<memory_context>

<recent_sessions>
  <!-- Summary 内容：提供会话概览 -->
  <session date="2026-02-10T12:00:00Z" project="my-app">
    <request>实现用户登录功能</request>
    <completed>完成了登录页面和API</completed>
    <next_steps>添加密码重置功能</next_steps>
  </session>
</recent_sessions>

<observations>
  <!-- Observation 内容：提供操作细节 -->
  <observation type="feature" date="2026-02-10T12:30:00Z">
    <title>Added login component</title>
    <narrative>Created LoginForm.tsx with email/password validation</narrative>
    <files_modified>src/components/LoginForm.tsx</files_modified>
  </observation>
</observations>

</memory_context>
```

---

## 6. 使用场景对比

### 6.1 何时使用 Observation

- 查找特定的代码修改记录
- 追踪某个 Bug 是如何修复的
- 了解某个功能的实现细节
- 搜索涉及特定文件的操作
- 按类型筛选（bugfix/feature/refactor 等）

### 6.2 何时使用 Summary

- 快速了解之前会话做了什么
- 查看用户的原始需求
- 了解下一步建议
- 获取会话级别的学习总结
- 按项目浏览历史工作

---

## 7. 数据库表结构

### 7.1 observations 表

```sql
CREATE TABLE observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  text TEXT,
  type TEXT NOT NULL,
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

### 7.2 session_summaries 表

```sql
CREATE TABLE session_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  request TEXT,
  investigated TEXT,
  learned TEXT,
  completed TEXT,
  next_steps TEXT,
  files_read TEXT,
  files_edited TEXT,
  notes TEXT,
  prompt_number INTEGER,
  discovery_tokens INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL
);
```

---

## 8. 总结

| 特性 | Observation | Summary |
|------|-------------|---------|
| 定位 | 原子操作记录 | 会话级别总结 |
| 关系 | 1:N（会话:观察） | 1:1（会话:总结） |
| 内容 | 具体的操作细节 | 抽象的工作概述 |
| 生成 | 实时（每次工具调用） | 延迟（会话结束时） |
| 用途 | 细节追踪、精确搜索 | 概览浏览、快速回顾 |

**核心关系**：Summary 是对多个 Observations 的**聚合和抽象**，提供更高层次的会话视角，而 Observations 保留了详细的操作痕迹用于精确检索。
