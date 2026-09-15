# 设计文档：跨设备记忆同步与汇总

> 版本: 1.0.0
> 最后更新: 2026-04-19
> 对应 PRD: PRD-cross-device-memory-sync.md

---

## 一、架构总览

```
┌─────────────────────────────────────────────────────────────┐
│  设备 A (Mac)                                                │
│  ┌──────────┐   ┌──────────────┐   ┌────────────────────┐   │
│  │ IDE Hook │──▶│ Worker :3847 │──▶│ 本地 SQLite        │   │
│  └──────────┘   │              │   │ (observations,     │   │
│                 │  SDKAgent    │   │  summaries, ...)   │   │
│                 │  (LLM 压缩)  │   └────────┬───────────┘   │
│                 └──────┬───────┘            │               │
│                        │                    │               │
│                        ▼                    ▼               │
│                 ┌──────────────┐   ┌────────────────────┐   │
│                 │ SyncQueue    │──▶│ sync_queue 表       │   │
│                 └──────┬───────┘   └────────────────────┘   │
│                        │ HTTP POST                          │
└────────────────────────┼────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  agent-mem-server (自部署)                                    │
│  ┌──────────────┐   ┌────────────────────────────────────┐  │
│  │ Token Auth   │──▶│ 汇总 SQLite                        │  │
│  │ Sync API     │   │ (observations, summaries, sessions │  │
│  │ Aggregate API│   │  + device_id, source_ide)          │  │
│  │ Export API   │   └────────────────────────────────────┘  │
│  │ Web Viewer   │                                           │
│  └──────────────┘                                           │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、客户端改造点

### 2.1 新文件清单

| 文件 | 职责 |
|:---|:---|
| `src/shared/identity.ts` | 管理 device_id / device_name，首次生成并持久化 |
| `src/services/sync/SyncQueue.ts` | 同步队列：入队、后台消费、重试、批量发送 |
| `src/services/sync/RemoteClient.ts` | HTTP 客户端，封装服务端 sync API 调用 |
| `src/services/sync/index.ts` | 模块导出 |
| `src/services/export/markdown.ts` | Markdown 渲染器（客户端本地导出用） |

### 2.2 数据库改动（Database.ts）

#### 2.2.1 新表：sync_queue

```sql
CREATE TABLE IF NOT EXISTS sync_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,          -- 'session' | 'observation' | 'summary'
  client_uuid   TEXT NOT NULL UNIQUE,   -- 幂等 key，格式: {kind}-{local_id}-{timestamp}
  payload_json  TEXT NOT NULL,          -- JSON 序列化的实体数据
  status        TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'sending' | 'sent' | 'failed'
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  next_retry_at INTEGER,               -- epoch ms
  created_at    INTEGER NOT NULL,       -- epoch ms
  synced_at     INTEGER                 -- 成功时间 epoch ms
);
CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status, next_retry_at);
```

#### 2.2.2 现有表增量列

通过 `EXPECTED_COLUMNS` 自动迁移：

```typescript
const EXPECTED_COLUMNS: Record<string, Record<string, string>> = {
  observations: {
    // ... 现有列 ...
    device_id: 'TEXT',
    source_ide: 'TEXT',
    synced_at: 'INTEGER',
  },
  session_summaries: {
    // ... 现有列 ...
    device_id: 'TEXT',
    source_ide: 'TEXT',
    synced_at: 'INTEGER',
  },
  sdk_sessions: {
    device_id: 'TEXT',
    source_ide: 'TEXT',
    synced_at: 'INTEGER',
  },
};
```

### 2.3 identity.ts 设计

```typescript
interface DeviceIdentity {
  deviceId: string;      // UUID v4，首次生成
  deviceName: string;    // 用户配置或 hostname
  createdAt: string;     // ISO 时间
}

// 持久化路径: ~/.agent-memory/device.json
// 优先读取环境变量:
//   CODEBUDDY_MEM_DEVICE_ID   → 覆盖 deviceId
//   CODEBUDDY_MEM_DEVICE_NAME → 覆盖 deviceName
```

### 2.4 SyncQueue 设计

```typescript
class SyncQueue {
  constructor(db: Database, remoteClient: RemoteClient)

  // 入队（写库后立即调用，非阻塞）
  enqueue(kind: 'session' | 'observation' | 'summary', payload: object): void

  // 启动后台消费循环（Worker 启动时调用一次）
  startWorker(intervalMs?: number): void

  // 停止（Worker shutdown 时调用）
  stop(): void

  // 获取队列状态（供 Desktop 展示）
  getStats(): { pending: number; failed: number; sent: number }
}
```

消费流程：
1. 每隔 `intervalMs`（默认 10 秒）查询 `status='pending' AND next_retry_at <= NOW()`，最多取 100 条
2. 按 kind 分组，调用 `RemoteClient.syncBatch(kind, items)`
3. 成功则更新 `status='sent', synced_at=NOW()`
4. 失败则 `attempts++, next_retry_at = NOW() + backoff(attempts)`，退避策略：`min(30s * 2^attempts, 1h)`
5. `attempts >= 10` 时标记 `status='failed'`，不再自动重试

### 2.5 RemoteClient 设计

```typescript
class RemoteClient {
  constructor(config: { baseUrl: string; token: string })

  async syncBatch(kind: string, items: SyncItem[]): Promise<SyncResult>
  async testConnection(): Promise<boolean>

  // items 结构:
  // { client_uuid: string, device_id: string, source_ide: string, payload: object }
}
```

### 2.6 WorkerService 改动点

在以下位置，写库成功后调用 `syncQueue.enqueue()`：

- `handleSessionStart()` → `createSession()` 之后 → `enqueue('session', sessionData)`
- `handleObservation()` → `sdkAgent.processObservation()` 回调成功后 → `enqueue('observation', obsData)`
- `handleSessionEnd()` → `sdkAgent.generateSummary()` 成功后 → `enqueue('summary', summaryData)`

### 2.7 hooks-cli.ts 改动点

在 `detectAdapterByEvent()` 调用处，将检测到的 `source_ide` 通过请求体传递给 Worker。具体修改：

- `handleBeforeSubmitPrompt()` / `handleAfterShellExecution()` 等函数中，在构建 POST body 时添加 `sourceIDE: adapter?.id` 字段

### 2.8 本地 Markdown 导出

WorkerService 新增路由 `GET /api/export/markdown`：

```typescript
// 参数:
//   date    - YYYY-MM-DD (可选，默认今天)
//   from/to - 日期范围 (可选，优先于 date)
//   ide     - 筛选 IDE (可选)
//   project - 筛选项目 (可选)
//   group_by - date | ide | project (默认 date)
```

---

## 三、服务端设计（agent-mem-server）

### 3.1 工程结构

```
agent-mem-server/
├── src/
│   ├── server.ts                 # HTTP 服务器入口
│   ├── config.ts                 # 配置读取
│   ├── auth/
│   │   └── token.ts              # Bearer Token 校验中间件
│   ├── routes/
│   │   ├── sync.ts               # POST /api/v1/sync/*
│   │   ├── aggregate.ts          # GET /api/v1/aggregate/*
│   │   ├── export.ts             # GET /api/v1/export/markdown
│   │   └── viewer.ts             # GET /api/v1/viewer/*
│   ├── db/
│   │   ├── Database.ts           # SQLite 初始化
│   │   ├── observations.ts       # Observation CRUD
│   │   ├── summaries.ts          # Summary CRUD
│   │   └── sessions.ts           # Session CRUD
│   ├── export/
│   │   └── markdown.ts           # Markdown 渲染器
│   └── utils/
│       └── logger.ts             # 日志
├── web/
│   └── index.html                # 极简时间线页面
├── package.json
├── tsconfig.json
├── Dockerfile
├── docker-compose.yml
└── README.md
```

### 3.2 数据库 Schema

```sql
-- 设备注册表
CREATE TABLE IF NOT EXISTS devices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   TEXT NOT NULL UNIQUE,
  device_name TEXT,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL
);

-- 会话表（从客户端同步）
CREATE TABLE IF NOT EXISTS sessions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id           TEXT NOT NULL,
  source_ide          TEXT,
  client_uuid         TEXT NOT NULL,
  content_session_id  TEXT,
  memory_session_id   TEXT,
  project             TEXT,
  user_prompt         TEXT,
  status              TEXT,
  started_at          TEXT,
  started_at_epoch    INTEGER,
  completed_at        TEXT,
  completed_at_epoch  INTEGER,
  received_at         TEXT NOT NULL,
  UNIQUE(device_id, client_uuid)
);

-- 观察记录表（从客户端同步）
CREATE TABLE IF NOT EXISTS observations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id         TEXT NOT NULL,
  source_ide        TEXT,
  client_uuid       TEXT NOT NULL,
  memory_session_id TEXT,
  project           TEXT,
  type              TEXT,
  title             TEXT,
  subtitle          TEXT,
  meta_intent       TEXT,
  facts             TEXT,
  narrative         TEXT,
  concepts          TEXT,
  files_read        TEXT,
  files_modified    TEXT,
  created_at        TEXT,
  created_at_epoch  INTEGER,
  received_at       TEXT NOT NULL,
  UNIQUE(device_id, client_uuid)
);

-- 会话总结表（从客户端同步）
CREATE TABLE IF NOT EXISTS summaries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id         TEXT NOT NULL,
  source_ide        TEXT,
  client_uuid       TEXT NOT NULL,
  memory_session_id TEXT,
  project           TEXT,
  request           TEXT,
  investigated      TEXT,
  learned           TEXT,
  meta_intent       TEXT,
  completed         TEXT,
  next_steps        TEXT,
  files_read        TEXT,
  files_edited      TEXT,
  notes             TEXT,
  created_at        TEXT,
  created_at_epoch  INTEGER,
  received_at       TEXT NOT NULL,
  UNIQUE(device_id, client_uuid)
);

CREATE INDEX IF NOT EXISTS idx_obs_epoch ON observations(created_at_epoch);
CREATE INDEX IF NOT EXISTS idx_obs_device ON observations(device_id);
CREATE INDEX IF NOT EXISTS idx_obs_ide ON observations(source_ide);
CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project);
CREATE INDEX IF NOT EXISTS idx_sum_epoch ON summaries(created_at_epoch);
CREATE INDEX IF NOT EXISTS idx_ses_epoch ON sessions(started_at_epoch);
```

### 3.3 API 详细设计

#### 3.3.1 同步接口

**POST /api/v1/sync/observations**

```typescript
// Request
{
  items: Array<{
    client_uuid: string;      // 幂等 key
    device_id: string;
    source_ide: string;       // 'cursor' | 'codebuddy' | 'codebuddy-ide' | 'claude-code'
    memory_session_id: string;
    project: string;
    type: string;
    title: string;
    subtitle?: string;
    meta_intent?: string;
    facts?: string;
    narrative?: string;
    concepts?: string;
    files_read?: string;
    files_modified?: string;
    created_at?: string;
    created_at_epoch?: number;
  }>
}

// Response
{
  success: true,
  received: number,     // 实际写入数
  duplicates: number    // 跳过的重复数
}
```

`/sync/sessions` 和 `/sync/summaries` 结构类似，字段参照对应的客户端表。

#### 3.3.2 聚合接口

**GET /api/v1/aggregate/daily?date=YYYY-MM-DD**

```typescript
// Response
{
  date: "2026-04-19",
  devices: ["mac-work", "win-home"],
  ides: ["cursor", "claude-code"],
  sessions: [
    {
      device_id: "uuid...",
      device_name: "mac-work",
      source_ide: "cursor",
      project: "agent-memory",
      started_at: "2026-04-19T09:12:00Z",
      completed_at: "2026-04-19T10:30:00Z",
      user_prompt: "...",
      summary: { request, completed, next_steps, ... },
      observations: [
        { time: "09:14", type: "shell", title: "...", ... },
        { time: "09:30", type: "edit", title: "...", ... }
      ]
    }
  ],
  stats: {
    total_sessions: 12,
    total_observations: 87,
    total_summaries: 5
  }
}
```

**GET /api/v1/aggregate/timeline?from=&to=&device=&ide=&project=**

与 daily 类似但跨日期，返回按日分组的数组。

#### 3.3.3 导出接口

**GET /api/v1/export/markdown?from=&to=&group_by=date&format=single&ide=&project=**

- `format=single` → `Content-Type: text/markdown; charset=utf-8`，直接返回 Markdown 文本
- `format=zip` → `Content-Type: application/zip`，返回 zip 二进制流

### 3.4 Markdown 导出格式规范

#### 按日期分组（group_by=date）

```markdown
# 工作记忆 - 2026-04-19

> 跨设备汇总 | 设备: mac-work, win-home | IDE: cursor, claude-code
> 共 12 个会话、87 条观察、5 条总结

---

## 09:12 - 10:30 | cursor | mac-work | agent-memory

**用户请求**: 调研多 IDE 同步方案

**会话总结**:
- **完成**: 拉通了 4 个适配器 schema
- **发现**: 各平台 Hook 事件名差异大，需适配层
- **下一步**: 写 PRD

### 关键操作

| 时间 | 类型 | 内容 |
|:---|:---|:---|
| 09:14 | shell | `git log --oneline -20` |
| 09:22 | edit | `src/adapters/registry.ts` — 增加 source_ide 字段 |
| 09:30 | mcp | search_like("hooks adapter") |

---

## 14:00 - 16:20 | claude-code | win-home | agent-mem-server

...
```

#### 按 IDE 分组（group_by=ide）

```markdown
# 工作记忆 - 按 IDE 汇总

## Cursor

### 2026-04-19 (3 个会话)
...

### 2026-04-18 (2 个会话)
...

## Claude Code

### 2026-04-19 (1 个会话)
...
```

#### 按项目分组（group_by=project）

```markdown
# 工作记忆 - 按项目汇总

## agent-memory

### 2026-04-19 | cursor | mac-work (2 个会话)
...

### 2026-04-18 | claude-code | win-home (1 个会话)
...

## agent-mem-server

### 2026-04-19 | cursor | mac-work (1 个会话)
...
```

### 3.5 鉴权设计

```typescript
// auth/token.ts
function authenticateToken(req: IncomingMessage): boolean {
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7);
  return token === process.env.SHARED_TOKEN;
}
```

读取接口（aggregate / export / viewer / web）首版不鉴权，仅写入接口（sync）需鉴权。

---

## 四、同步协议

### 4.1 幂等性

- 客户端生成 `client_uuid`，格式：`{kind}-{localDbId}-{createdAtEpoch}`
- 服务端表使用 `UNIQUE(device_id, client_uuid)` 约束
- 重复插入时使用 `INSERT OR IGNORE`，返回 `duplicates` 计数

### 4.2 批量传输

- 每次最多发送 100 条
- 请求体 JSON 数组，服务端在一个事务内写入

### 4.3 重试策略

```
第 1 次失败: 30s 后重试
第 2 次失败: 60s 后重试
第 3 次失败: 120s 后重试
第 4 次失败: 240s 后重试
...
第 N 次失败: min(30 * 2^N 秒, 3600s) 后重试
超过 10 次: 标记 failed，不再自动重试
```

### 4.4 顺序保证

同步不保证严格顺序。服务端依赖 `created_at_epoch` 字段做时间排序，不依赖接收顺序。

---

## 五、配置与部署

### 5.1 客户端新增配置

```env
# 远端服务器（可选，不配则纯本地）
CODEBUDDY_MEM_REMOTE_URL=https://mem.example.com
CODEBUDDY_MEM_REMOTE_TOKEN=my-secret-token

# 设备标识
CODEBUDDY_MEM_DEVICE_NAME=mac-work

# 同步开关
CODEBUDDY_MEM_SYNC_ENABLED=true

# 隐私：是否脱敏上行数据中的原始输出
CODEBUDDY_MEM_SYNC_REDACT_RAW=false
```

### 5.2 服务端配置

```env
# 必填
SHARED_TOKEN=my-secret-token

# 可选
PORT=8848
HOST=0.0.0.0
DATA_DIR=/data
LOG_LEVEL=info
```

### 5.3 Docker 部署

```yaml
# docker-compose.yml
version: '3.8'
services:
  agent-mem-server:
    build: .
    ports:
      - "8848:8848"
    environment:
      - SHARED_TOKEN=${SHARED_TOKEN}
    volumes:
      - mem-data:/data
    restart: unless-stopped

volumes:
  mem-data:
```

```bash
# 一行命令启动
docker run -d --name agent-mem \
  -p 8848:8848 \
  -e SHARED_TOKEN=my-secret-token \
  -v agent-mem-data:/data \
  agent-mem-server:latest
```

---

## 六、兼容性与迁移

### 6.1 客户端零破坏

- 新增的 `device_id` / `source_ide` / `synced_at` 列通过 `EXPECTED_COLUMNS` 自动 `ALTER TABLE ADD COLUMN`
- 旧数据的这些列为 NULL，不影响查询
- 未配置 `CODEBUDDY_MEM_REMOTE_URL` 时，SyncQueue 构造后直接返回，不启动后台 worker
- 所有现有 API 接口不变

### 6.2 历史数据补传

首次配置远端后，可选执行一次全量补传：

```bash
# 客户端提供 CLI 命令（Phase 1.5）
agent-memory sync --full
```

MVP 阶段仅支持增量同步（配置后的新数据），全量补传作为后续增强。

### 6.3 服务端版本兼容

服务端 API 使用 `/api/v1/` 前缀，未来不兼容变更走 `/api/v2/`。

---

## 七、安全考量

| 威胁 | 缓解措施 |
|:---|:---|
| Token 泄露 | 仅内网/VPN 暴露；公网需反代 + TLS + IP 白名单 |
| 中间人攻击 | 用户自行配置 HTTPS（反向代理如 Caddy/Nginx） |
| 数据量攻击 | 单次 sync 限 100 条；服务端做请求体大小限制（10MB） |
| 未授权读取 | 首版读取接口不鉴权（自部署假设安全），Phase 2 加读取鉴权 |
