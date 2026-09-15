# AgentMemory 记忆查看器 - 产品需求文档（简化版）

> 版本: v1.1  
> 日期: 2026-02-09  
> 状态: 草稿

---

## 1. 项目概述

### 1.1 背景

AgentMemory 系统已具备完整的记忆存储能力，需要一个简单的可视化界面让用户查看已存储的记忆数据。

### 1.2 目标

开发一个**极简的** Web 页面，让用户能够：
- 浏览当前存储的所有记忆数据（Sessions、Observations、Summaries）
- 查看记忆的详细内容

### 1.3 设计原则

- **最小后端修改**：复用现有 WorkerService，仅新增必要的查询 API
- **无框架前端**：使用纯 HTML + Vanilla JS + CSS，无需构建工具
- **单文件部署**：前端代码尽可能简单，便于维护

---

## 2. 功能需求

### 2.1 核心功能（MVP）

| 功能点 | 描述 | 优先级 |
|-------|------|-------|
| 会话列表 | 展示所有 SDK Session 记录 | P0 |
| 观察记录列表 | 展示所有 Observation 记录 | P0 |
| 会话总结列表 | 展示所有 Session Summary 记录 | P0 |
| 详情查看 | 点击记录查看完整 JSON 详情 | P0 |
| 统计信息 | 显示记录总数 | P0 |

### 2.2 可选功能（后续迭代）

| 功能点 | 描述 | 优先级 |
|-------|------|-------|
| 按项目筛选 | 根据项目名称过滤 | P1 |
| 分页加载 | 支持分页查看 | P1 |
| 删除记忆 | 删除单条记录 | P2 |

---

## 3. 技术方案

### 3.1 后端 API（复用现有 WorkerService）

**现有可复用的接口：**

| 接口 | 方法 | 状态 | 说明 |
|-----|------|------|------|
| `/health` | GET | ✅ 已有 | 包含 stats 统计信息 |
| `/api/search` | GET | ✅ 已有 | 搜索 observations |
| `/api/context/inject` | GET | ✅ 已有 | 获取 observations + summaries |

**需要新增的接口：**

| 接口 | 方法 | 说明 |
|-----|------|------|
| `/api/viewer/sessions` | GET | 获取所有会话列表 |
| `/api/viewer/observations` | GET | 获取所有观察记录列表 |
| `/api/viewer/summaries` | GET | 获取所有会话总结列表 |
| `/api/viewer/projects` | GET | 获取所有项目列表（去重） |

### 3.2 后端修改量估算

只需要在 `WorkerService.ts` 中新增 **4 个路由处理函数**，每个函数约 20-30 行代码，总计约 **100-150 行代码**。

需要新增的数据库查询函数（在现有 sqlite 模块中）：

```typescript
// sessions.ts - 新增
export function getAllSessions(limit = 100): SDKSessionRow[];
export function getDistinctProjects(): string[];

// observations.ts - 复用现有
// getRecentObservations() 已存在

// summaries.ts - 复用现有  
// getRecentSummaries() 已存在
```

### 3.3 前端方案

**技术选型：纯静态 HTML**

```
web/
└── viewer.html    # 单文件，包含 HTML + CSS + JS
```

**为什么选择单文件静态页面：**
- 零构建依赖，无需 npm/vite/webpack
- 便于调试和修改
- 可直接通过 WorkerService 托管静态文件
- 代码量小，易于维护

### 3.4 数据流

```
┌─────────────────┐       HTTP GET        ┌──────────────────┐
│   viewer.html   │ ──────────────────────▶│  WorkerService   │
│  (浏览器打开)    │                        │  (localhost:3847)│
└─────────────────┘ ◀────────────────────── └──────────────────┘
                         JSON Response
```

---

## 4. 界面设计

### 4.1 简化版布局

```
┌─────────────────────────────────────────────────────────────┐
│  🧠 AgentMemory Viewer                                    │
│  Stats: 5 Sessions | 23 Observations | 4 Summaries          │
├─────────────────────────────────────────────────────────────┤
│  [Sessions] [Observations] [Summaries]     ← Tab 切换       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ #1  project: my-app                                  │   │
│  │     status: completed | 2026-02-09 15:30            │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ #2  project: another-project                         │   │
│  │     status: active | 2026-02-09 14:20               │   │
│  └─────────────────────────────────────────────────────┘   │
│  ...                                                        │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  点击任意记录查看详情                                         │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 详情弹窗

```
┌─────────────────────────────────────────────────┐
│  Observation #12                           [X]  │
├─────────────────────────────────────────────────┤
│  {                                              │
│    "id": 12,                                    │
│    "type": "code_review",                       │
│    "title": "Added authentication",             │
│    "narrative": "User implemented...",          │
│    "facts": ["Added login endpoint"],           │
│    "created_at": "2026-02-09T15:30:00Z"        │
│  }                                              │
├─────────────────────────────────────────────────┤
│                                       [Close]   │
└─────────────────────────────────────────────────┘
```

---

## 5. 开发计划

### 5.1 阶段划分

| 阶段 | 内容 | 预估工时 |
|-----|------|---------|
| Phase 1 | 后端新增 4 个 API 端点 | 2-3 小时 |
| Phase 2 | 前端静态页面开发 | 3-4 小时 |
| Phase 3 | 测试与调试 | 1-2 小时 |

**总计**: 约 **1 天**

### 5.2 详细任务

**Phase 1 - 后端（2-3 小时）**
1. 在 `sessions.ts` 新增 `getAllSessions()` 和 `getDistinctProjects()` 函数
2. 在 `WorkerService.ts` 新增 4 个路由：
   - `GET /api/viewer/sessions`
   - `GET /api/viewer/observations`  
   - `GET /api/viewer/summaries`
   - `GET /api/viewer/projects`
3. 新增静态文件托管路由（可选）

**Phase 2 - 前端（3-4 小时）**
1. 创建 `web/viewer.html` 单文件
2. 实现 Tab 切换逻辑
3. 实现数据获取和列表渲染
4. 实现详情弹窗
5. 基础样式美化

---

## 6. API 详细设计

### 6.1 GET /api/viewer/sessions

**Request:**
```
GET /api/viewer/sessions?limit=100&project=my-app
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "content_session_id": "sess-xxx",
      "memory_session_id": "mem-xxx",
      "project": "my-app",
      "user_prompt": "帮我实现登录功能",
      "started_at": "2026-02-09T15:00:00Z",
      "status": "completed"
    }
  ],
  "count": 1
}
```

### 6.2 GET /api/viewer/observations

**Request:**
```
GET /api/viewer/observations?limit=100&project=my-app
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 12,
      "memory_session_id": "mem-xxx",
      "project": "my-app",
      "type": "code_review",
      "title": "Added authentication",
      "narrative": "...",
      "created_at": "2026-02-09T15:30:00Z"
    }
  ],
  "count": 1
}
```

### 6.3 GET /api/viewer/summaries

**Request:**
```
GET /api/viewer/summaries?limit=100&project=my-app
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 5,
      "memory_session_id": "mem-xxx",
      "project": "my-app",
      "request": "实现登录功能",
      "completed": "已完成登录页面和API",
      "created_at": "2026-02-09T16:00:00Z"
    }
  ],
  "count": 1
}
```

### 6.4 GET /api/viewer/projects

**Request:**
```
GET /api/viewer/projects
```

**Response:**
```json
{
  "success": true,
  "data": ["my-app", "another-project", "test-project"],
  "count": 3
}
```

---

## 7. 验收标准

- [ ] 能在浏览器打开 `http://localhost:3847/viewer.html` 查看界面
- [ ] 能看到所有 Sessions 列表
- [ ] 能看到所有 Observations 列表
- [ ] 能看到所有 Summaries 列表
- [ ] 点击任意记录能看到完整 JSON 详情
- [ ] 顶部能看到统计数字

---

## 8. 后续扩展（可选）

如果需要更多功能，可以逐步添加：

1. **项目筛选下拉框** - 使用 `/api/viewer/projects` 接口
2. **分页控件** - 添加 offset 参数
3. **删除功能** - 新增 DELETE 接口
4. **导出 JSON** - 前端直接 `JSON.stringify()` 当前数据

---

## 9. 附录

### 9.1 参考资料

- [AgentMemory README](../README.md)
- [数据库类型定义](../src/types/database.ts)

### 9.2 术语表

| 术语 | 解释 |
|-----|------|
| Observation | 工具使用的结构化观察记录 |
| Session Summary | 会话结束时生成的总结 |
| SDK Session | CodeBuddy Agent 的一次会话 |
| Memory Session ID | 记忆系统内部的会话标识 |

### A. 现有可复用代码

| 模块 | 函数 | 说明 |
|-----|------|------|
| `observations.ts` | `getRecentObservations(limit)` | 获取最近的观察记录 |
| `observations.ts` | `getObservationsByProject(project, limit)` | 按项目获取 |
| `summaries.ts` | `getRecentSummaries(limit)` | 获取最近的总结 |
| `summaries.ts` | `getSummariesByProject(project, limit)` | 按项目获取 |
| `sessions.ts` | `getSessionsByProject(project, limit)` | 按项目获取会话 |
| `Database.ts` | `getDatabaseStats()` | 获取统计数据 |

### B. 需要新增的代码

```typescript
// sessions.ts - 新增约 20 行
export function getAllSessions(limit = 100): SDKSessionRow[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM sdk_sessions 
    ORDER BY started_at_epoch DESC 
    LIMIT ?
  `);
  return stmt.all(limit) as SDKSessionRow[];
}

export function getDistinctProjects(): string[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT DISTINCT project FROM sdk_sessions 
    UNION 
    SELECT DISTINCT project FROM observations
    ORDER BY project
  `);
  const rows = stmt.all() as { project: string }[];
  return rows.map(r => r.project);
}
