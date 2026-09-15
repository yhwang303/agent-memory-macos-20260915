# 设计文档：服务端管理后台与多用户 Token 分发

> 版本: 1.0.0
> 最后更新: 2026-04-19
> 对应 PRD: PRD-server-admin-multiuser.md

---

## 一、架构总览

```
┌────────────────────────────────────────────────────────────────────────────┐
│  用户操作面（全部图形化，零终端）                                              │
│                                                                            │
│  ┌─────────────────────────┐  ┌──────────────────────────────────────┐    │
│  │ Desktop App (Electron)   │  │ Browser                              │    │
│  │ ┌─────────────────────┐  │  │ ┌──────────────────────────────┐    │    │
│  │ │ Settings Window     │  │  │ │ /admin/setup  初始化向导       │    │    │
│  │ │  - 服务器连接 Tab   │  │  │ │ /admin        管理后台         │    │    │
│  │ │  - 邀请链接录入      │◀─┼──┼─┤   - Overview / Users / Memory │    │    │
│  │ │  - 同步状态显示      │  │  │ │   - Settings                  │    │    │
│  │ └──────────┬──────────┘  │  │ │   - 邀请链接 + 二维码生成      │    │    │
│  │            │ 写配置       │  │ └──────────────┬───────────────┘    │    │
│  │            ▼              │  │                │                     │    │
│  │ ┌─────────────────────┐  │  └────────────────┼─────────────────────┘    │
│  │ │ Worker (Node.js)    │  │   admin_session_token │                      │
│  │ │  - 本地 SQLite      │  │                       │                      │
│  │ │  - SyncQueue        │──┼───────────────────────┼─── user_token        │
│  │ └─────────────────────┘  │                       │                      │
│  │                          │                       │                      │
│  │ cmem:// URL Scheme  ◀────┼─── 浏览器/相机扫描邀请链接                       │
│  └──────────────────────────┘                       │                      │
└─────────────────────────────────────────────────────┼──────────────────────┘
                                                     ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  agent-mem-server                                                           │
│                                                                            │
│  ┌──────────────────┐    ┌──────────────────────────────────────────────┐ │
│  │ Sync API         │    │ Admin API (新增)                              │ │
│  │ (user token)     │    │ /api/v1/admin/setup                          │ │
│  │ /api/v1/sync/*   │    │ /api/v1/admin/login / logout                 │ │
│  │ /api/v1/viewer/* │    │ /api/v1/admin/users (CRUD)                   │ │
│  │ /api/v1/aggregate│    │ /api/v1/admin/users/:id/invite (邀请链接)      │ │
│  └────────┬─────────┘    │ /api/v1/admin/users/:id/rotate-token         │ │
│           │              │ /api/v1/admin/users/:id/revoke               │ │
│           │              │ /api/v1/admin/memory/* (按 user 过滤的浏览)    │ │
│           │              └────────────┬─────────────────────────────────┘ │
│           ▼                           ▼                                    │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │ Auth Layer (新)                                                        │ │
│  │ - resolveUserByToken(token) → User                                    │ │
│  │ - resolveAdminBySession(token) → AdminSession                         │ │
│  │ - isFirstRun() → bool（用于跳转向导）                                  │ │
│  └──────────────────────────────────────┬──────────────────────────────┘ │
│                                         ▼                                  │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │ SQLite                                                                │ │
│  │ - users (新)         - admin_sessions (新)                            │ │
│  │ - user_tokens (新)   - admin_config (新)                              │ │
│  │ - sessions + user_id      - observations + user_id                    │ │
│  │ - summaries + user_id     - devices + user_id                         │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │ Web Static                                                            │ │
│  │ - /admin/setup → web/setup.html       初始化向导                      │ │
│  │ - /admin       → web/admin.html       管理后台                        │ │
│  │ - 共用 web/admin.css（与客户端 viewer.html 同源样式）                  │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、数据库 Schema 改动

### 2.1 新增表

```sql
-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  note        TEXT,
  created_at  TEXT NOT NULL,
  is_default  INTEGER NOT NULL DEFAULT 0    -- 是否是 SHARED_TOKEN 自动迁移产生
);

-- 用户 Token 表（一个 user 可有多个历史 token，仅一个 active）
CREATE TABLE IF NOT EXISTS user_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,        -- sha256(token + global_salt)
  token_tail  TEXT NOT NULL,                -- token 后 8 位，用于显示
  created_at  TEXT NOT NULL,
  revoked_at  TEXT,                         -- 吊销时间，null 表示有效
  last_used_at TEXT,                        -- 最近使用时间
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_tokens_hash ON user_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_user_tokens_user ON user_tokens(user_id);

-- Admin 配置表（单行，存 admin password hash + global salt）
CREATE TABLE IF NOT EXISTS admin_config (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash   TEXT NOT NULL,            -- sha256(password + admin_salt)
  admin_salt      TEXT NOT NULL,            -- 16 字节随机
  global_salt     TEXT NOT NULL,            -- 16 字节随机，用于 token_hash
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Admin 会话表（内存 + 持久化双写，重启不丢）
CREATE TABLE IF NOT EXISTS admin_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_token TEXT NOT NULL UNIQUE,       -- 64 字符随机
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_used_at TEXT,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_token ON admin_sessions(session_token);
```

### 2.2 现有表增量列

通过启动时 `ensureMissingColumns()` 自动 ALTER：

```typescript
const EXPECTED_COLUMNS_V2: Record<string, Record<string, string>> = {
  sessions:     { user_id: 'INTEGER' },
  observations: { user_id: 'INTEGER' },
  summaries:    { user_id: 'INTEGER' },
  devices:      { user_id: 'INTEGER' },
};
// 配套索引
// CREATE INDEX IF NOT EXISTS idx_sessions_user     ON sessions(user_id);
// CREATE INDEX IF NOT EXISTS idx_observations_user ON observations(user_id);
// CREATE INDEX IF NOT EXISTS idx_summaries_user    ON summaries(user_id);
// CREATE INDEX IF NOT EXISTS idx_devices_user      ON devices(user_id);
```

### 2.3 数据迁移流程（启动时一次）

```typescript
function migrateV2(db: Database): void {
  // 1. 自动 ALTER TABLE ADD COLUMN
  ensureMissingColumns(db, EXPECTED_COLUMNS_V2);

  // 2. 初始化 admin_config（若不存在）
  const cfg = db.prepare('SELECT * FROM admin_config WHERE id=1').get();
  if (!cfg) {
    const adminSalt = randomHex(16);
    const globalSalt = randomHex(16);
    const password = process.env.ADMIN_PASSWORD || randomBase64(12);
    if (!process.env.ADMIN_PASSWORD) {
      logger.warn('ADMIN', `>>> Initial admin password generated: ${password} <<<`);
      logger.warn('ADMIN', '>>> Set ADMIN_PASSWORD env var to override <<<');
    }
    db.prepare(`INSERT INTO admin_config(id, password_hash, admin_salt, global_salt, created_at, updated_at)
                VALUES (1, ?, ?, ?, ?, ?)`).run(
      sha256(password + adminSalt), adminSalt, globalSalt, now(), now()
    );
  } else if (process.env.ADMIN_PASSWORD) {
    // 允许通过环境变量覆盖（每次启动都同步）
    const newHash = sha256(process.env.ADMIN_PASSWORD + cfg.admin_salt);
    if (newHash !== cfg.password_hash) {
      db.prepare('UPDATE admin_config SET password_hash=?, updated_at=? WHERE id=1')
        .run(newHash, now());
      logger.info('ADMIN', 'Admin password updated from ADMIN_PASSWORD env var');
    }
  }

  // 3. SHARED_TOKEN 自动迁移
  const sharedToken = process.env.SHARED_TOKEN;
  const userCount = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as any).n;
  if (sharedToken && userCount === 0) {
    const userId = db.prepare(`INSERT INTO users(name, note, created_at, is_default)
                                VALUES ('default', 'Auto-migrated from SHARED_TOKEN', ?, 1)`)
      .run(now()).lastInsertRowid as number;
    const cfg2 = db.prepare('SELECT global_salt FROM admin_config WHERE id=1').get() as any;
    db.prepare(`INSERT INTO user_tokens(user_id, token_hash, token_tail, created_at)
                VALUES (?, ?, ?, ?)`)
      .run(userId, sha256(sharedToken + cfg2.global_salt), sharedToken.slice(-8), now());

    // 历史数据归属到 default
    db.prepare('UPDATE sessions     SET user_id=? WHERE user_id IS NULL').run(userId);
    db.prepare('UPDATE observations SET user_id=? WHERE user_id IS NULL').run(userId);
    db.prepare('UPDATE summaries    SET user_id=? WHERE user_id IS NULL').run(userId);
    db.prepare('UPDATE devices      SET user_id=? WHERE user_id IS NULL').run(userId);
    logger.info('ADMIN', `Migrated SHARED_TOKEN to default user (id=${userId})`);
  }
}
```

---

## 三、模块设计

### 3.1 文件结构（agent-mem-server）

```
agent-mem-server/
├── src/
│   ├── server.ts                          # 路由入口
│   ├── auth/
│   │   ├── token.ts                       # (改) authenticateToken → resolveUserByToken
│   │   └── admin.ts                       # (新) admin password / session
│   ├── routes/
│   │   ├── sync.ts                        # (改) 调用 resolveUserByToken 拿 user_id
│   │   ├── aggregate.ts                   # (改) 支持 user_id 过滤
│   │   ├── export.ts                      # (改) 支持 user_id 过滤
│   │   └── admin/                         # (新)
│   │       ├── setup.ts                   # /admin/setup 初始化向导 API
│   │       ├── auth.ts                    # /admin/login /logout
│   │       ├── users.ts                   # /admin/users CRUD + invite
│   │       └── overview.ts                # /admin/overview
│   ├── db/
│   │   ├── Database.ts                    # (改) 加新表 + ensureMissingColumns + migrateV2
│   │   └── users.ts                       # (新) User / Token DAO
│   └── utils/
│       ├── logger.ts
│       └── crypto.ts                      # (新) sha256 / randomHex / randomBase64 / timingSafeEqual
├── web/                                   # (新, 此前已删，重新加回)
│   ├── setup.html                         # 初始化向导（3 步）
│   ├── admin.html                         # 管理后台单页（4 个 Tab）
│   ├── admin.css                          # 共享样式（与客户端 viewer 同源）
│   ├── admin.js                           # 共享 JS（API client + Tab 渲染）
│   └── lib/
│       └── qrcode.min.js                  # 纯前端二维码生成（~10KB，无依赖）
└── ...
```

### 3.1.x 客户端文件结构（agent-memory，新增/改动）

```
agent-memory/
├── desktop/src/
│   ├── windows/
│   │   ├── SettingsWindow.ts              # (改) 新增"服务器连接" tab 处理
│   │   ├── settings.html                  # (改) 新增"服务器连接" 区块
│   │   └── ConnectInvite.ts               # (新) cmem:// 解析 + 测试连接 + 写配置流程
│   ├── main.ts                            # (改) 注册 cmem:// URL Scheme + open-url 事件
│   └── config/
│       ├── store.ts                       # (改) 加 server / token 字段（替换 .env.local 写入）
│       └── connectionTester.ts            # (改) 加 testServer() / testToken()
├── src/
│   └── shared/identity.ts                 # (改) 配置来源加 store.ts 优先于 env
└── ...
```

### 3.2 Auth 模块

#### 3.2.1 用户 Token 校验（auth/token.ts 重构）

```typescript
export interface AuthenticatedUser {
  id: number;
  name: string;
  tokenId: number;
}

// 校验失败返回 null；调用方据此返回 401
export function resolveUserByToken(req: IncomingMessage): AuthenticatedUser | null {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  if (!token) return null;

  const db = getDatabase();
  const cfg = db.prepare('SELECT global_salt FROM admin_config WHERE id=1').get() as any;
  const hash = sha256(token + cfg.global_salt);

  const row = db.prepare(`
    SELECT t.id AS token_id, t.user_id, t.revoked_at, u.name
    FROM user_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ?
  `).get(hash) as any;

  if (!row || row.revoked_at) return null;

  // 异步更新 last_used_at（fire and forget）
  db.prepare('UPDATE user_tokens SET last_used_at=? WHERE id=?').run(now(), row.token_id);

  return { id: row.user_id, name: row.name, tokenId: row.token_id };
}
```

#### 3.2.2 Admin Session（auth/admin.ts）

```typescript
export interface AdminSession {
  sessionToken: string;
  expiresAt: string;
}

export function loginAdmin(password: string, userAgent?: string): AdminSession | null {
  const db = getDatabase();
  const cfg = db.prepare('SELECT * FROM admin_config WHERE id=1').get() as any;
  if (!cfg) return null;
  const hash = sha256(password + cfg.admin_salt);
  if (!timingSafeEqual(hash, cfg.password_hash)) return null;

  const sessionToken = randomHex(32);
  const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  db.prepare(`INSERT INTO admin_sessions(session_token, created_at, expires_at, user_agent)
              VALUES (?, ?, ?, ?)`)
    .run(sessionToken, now(), expiresAt, userAgent ?? null);
  return { sessionToken, expiresAt };
}

export function resolveAdminSession(req: IncomingMessage): AdminSession | null {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) return null;
  const sessionToken = auth.slice(7);
  const db = getDatabase();
  const row = db.prepare(`
    SELECT * FROM admin_sessions WHERE session_token=? AND expires_at > ?
  `).get(sessionToken, now()) as any;
  if (!row) return null;
  db.prepare('UPDATE admin_sessions SET last_used_at=? WHERE id=?').run(now(), row.id);
  return { sessionToken: row.session_token, expiresAt: row.expires_at };
}

export function logoutAdmin(sessionToken: string): void {
  getDatabase().prepare('DELETE FROM admin_sessions WHERE session_token=?').run(sessionToken);
}
```

### 3.3 Sync 路由改造

```typescript
// src/routes/sync.ts (变更点)
export async function handleSyncObservations(req, body, res) {
  const auth = resolveUserByToken(req);
  if (!auth) { res.statusCode = 401; res.end('{"error":"Unauthorized"}'); return; }

  // ... 现有 UPSERT 逻辑，新增 user_id 列写入 ...
  const stmt = db.prepare(`
    INSERT INTO observations (
      user_id, device_id, source_ide, client_uuid, ...
    ) VALUES (?, ?, ?, ?, ...)
    ON CONFLICT(device_id, client_uuid) DO UPDATE SET
      user_id = excluded.user_id, ...   -- 允许变更归属（同 device_id 切换 user 不太常见，但保持一致）
  `);
  for (const item of body.items) {
    stmt.run(auth.id, item.device_id, item.source_ide, item.client_uuid, ...);
  }
}
```

> sessions / summaries 同理。devices 表在 first_seen 时也要打上 `user_id`。

### 3.4 Viewer / Aggregate 改造

所有 `/api/v1/viewer/*` 与 `/api/v1/aggregate/*` 路由：

1. **必须**通过 `resolveUserByToken` 拿到 `user_id`
2. 查询语句强制加 `WHERE user_id = ?`
3. 不允许跨用户读
4. Admin 后台读取数据走另一组路由 `/api/v1/admin/memory/*`，不复用 `/api/v1/viewer/*`，因为 Admin 可以指定任意 user_id

```typescript
// 新路由表
GET  /api/v1/viewer/sessions       (user)  - 自动 WHERE user_id=auth.id
GET  /api/v1/viewer/observations   (user)
GET  /api/v1/viewer/summaries      (user)
GET  /api/v1/viewer/projects       (user)

GET  /api/v1/admin/memory/sessions      (admin) ?user_id=X
GET  /api/v1/admin/memory/observations  (admin) ?user_id=X
GET  /api/v1/admin/memory/summaries     (admin) ?user_id=X
GET  /api/v1/admin/memory/projects      (admin) ?user_id=X
```

### 3.5 Admin API 详细

#### 3.5.1 登录

```
POST /api/v1/admin/login
Body: { "password": "xxx" }

Response 200:
  { "session_token": "...", "expires_at": "ISO" }
Response 401:
  { "error": "Invalid password" }
```

#### 3.5.2 注销

```
POST /api/v1/admin/logout
Headers: Authorization: Bearer <session_token>

Response 200: { "success": true }
```

#### 3.5.3 概览

```
GET /api/v1/admin/overview

Response 200:
{
  "users":          { "total": 3 },
  "devices":        { "total": 5 },
  "sessions":       { "total": 120 },
  "observations":   { "total": 8500 },
  "summaries":      { "total": 110 },
  "db_size_bytes":  524288,
  "recent_users": [
    { "id": 1, "name": "default", "last_synced_at": "..." },
    ...
  ]
}
```

#### 3.5.4 用户列表

```
GET /api/v1/admin/users

Response 200:
{
  "users": [
    {
      "id": 1, "name": "default", "note": "...", "created_at": "...",
      "is_default": 1,
      "active_token": { "tail": "abc12345", "created_at": "...", "last_used_at": "..." },
      "stats": { "devices": 2, "sessions": 50, "observations": 3000, "summaries": 60 }
    }
  ]
}
```

#### 3.5.5 创建用户

```
POST /api/v1/admin/users
Body: { "name": "alice", "note": "Mac mini" }

Response 200:
{
  "user": { "id": 2, "name": "alice", ... },
  "token": "PLAINTEXT_TOKEN_ONLY_RETURNED_HERE"   // ← 仅此一次
}
Response 409: { "error": "User name already exists" }
```

#### 3.5.6 重生成 Token

```
POST /api/v1/admin/users/2/rotate-token

Response 200:
{
  "token": "NEW_PLAINTEXT_TOKEN",
  "revoked_old_token_tail": "abc12345"
}
```

服务端逻辑：把当前 user 的所有 active token 全部 `revoked_at=now()`，再插入一个新的 active token。

#### 3.5.7 吊销 Token

```
POST /api/v1/admin/users/2/revoke

Response 200: { "success": true, "revoked_count": 1 }
```

#### 3.5.8 删除用户

```
DELETE /api/v1/admin/users/2?confirm=1

Response 200:
{
  "success": true,
  "deleted": {
    "sessions": 50,
    "observations": 3000,
    "summaries": 60,
    "devices": 2,
    "tokens": 3
  }
}
Response 400: { "error": "confirm=1 required" }
```

服务端通过外键 `ON DELETE CASCADE` 删除 user_tokens；其他表显式按 user_id 删除。

### 3.6 路由注册（server.ts）

```typescript
// Admin endpoints
if (pathname === '/api/v1/admin/login' && req.method === 'POST') { ... }
if (pathname === '/api/v1/admin/logout' && req.method === 'POST') { ... }

if (pathname.startsWith('/api/v1/admin/')) {
  const session = resolveAdminSession(req);
  if (!session) { res.statusCode = 401; res.end('{"error":"Unauthorized"}'); return; }

  if (pathname === '/api/v1/admin/overview' && req.method === 'GET') { ... }
  if (pathname === '/api/v1/admin/users' && req.method === 'GET') { ... }
  if (pathname === '/api/v1/admin/users' && req.method === 'POST') { ... }
  // /api/v1/admin/users/:id/rotate-token
  // /api/v1/admin/users/:id/revoke
  // DELETE /api/v1/admin/users/:id
  // /api/v1/admin/memory/{sessions,observations,summaries,projects}
}

// Admin web entry
if ((pathname === '/admin' || pathname === '/admin/') && req.method === 'GET') {
  serveStatic('admin.html', res);
}
```

---

## 四、Admin 前端设计（web/admin.html）

### 4.1 视觉规范（与客户端 viewer 对齐）

| 元素 | 规范 |
|:---|:---|
| 字体 | -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto |
| Header | `linear-gradient(135deg, #667eea 0%, #764ba2 100%)`，圆角 12px |
| 卡片 | 白底圆角 12px，阴影 `0 2px 8px rgba(0,0,0,0.05)` |
| Tab | 未激活白底，激活紫色渐变 |
| 主操作按钮 | 紫色渐变圆角 8px |
| 危险操作按钮 | `#e53e3e` 红色 |
| 标签徽章 | 圆角 20px，灰底 + 类型色（device 紫 / IDE 蓝 / project 灰） |

### 4.2 页面结构

```html
<div class="container">
  <header>
    <h1>Agent Memory Admin</h1>
    <div class="stats" id="overview-stats">
      <span>Users 3</span><span>Sessions 120</span><span>Observations 8500</span>...
    </div>
  </header>

  <div class="tabs">
    <button data-tab="overview" class="tab active">概览</button>
    <button data-tab="users" class="tab">用户</button>
    <button data-tab="memory" class="tab">记忆</button>
    <button data-tab="settings" class="tab">设置</button>
  </div>

  <div id="content"></div>
</div>

<!-- 登录覆盖层（未登录时显示） -->
<div id="login-overlay">
  <form id="login-form">
    <h2>管理员登录</h2>
    <input type="password" id="password" placeholder="ADMIN_PASSWORD" />
    <button>登录</button>
  </form>
</div>

<!-- 通用 Modal（用户详情 / Token 显示 / 确认对话框） -->
<div id="modal" class="modal-overlay"> ... </div>
```

### 4.3 Tab 内容

#### 4.3.1 概览（Overview）

- 顶部 4 个大卡片：Users / Devices / Sessions / Observations 的总数
- DB 大小 + 启动时间
- 「最近活跃用户」列表（最近 7 天）

#### 4.3.2 用户（Users）

```
┌────────────────────────────────────────────────────────────────┐
│ [+ 新建用户]                            搜索: [_________]        │
├────────────────────────────────────────────────────────────────┤
│ #1 default     [default]                                       │
│ Token: ********abc12345   ·  Last used 2 min ago               │
│ 2 devices · 50 sessions · 3000 obs · 60 sums                   │
│ [复制 Token Tail] [重生成] [吊销] [删除]                          │
│                                                                │
│ #2 alice                                                       │
│ Token: ********xyz98765   ·  Never used                        │
│ 0 devices · 0 sessions · 0 obs · 0 sums                        │
│ [重生成] [吊销] [删除]                                            │
└────────────────────────────────────────────────────────────────┘
```

「新建用户」表单 modal → 提交后弹出「Token 生成成功」modal，明文显示一次 + 复制按钮 + 警告语「**此 Token 只显示一次，请立即保存**」

#### 4.3.3 记忆（Memory）

复用客户端 viewer 的视觉与交互，区别只在顶部多一个「用户筛选」下拉：

```
┌──────────────────────────────────────────────────────────────┐
│ User: [全部 ▼] Project: [全部 ▼] [刷新]                         │
│ [Summaries] [Observations] [Sessions]                          │
├──────────────────────────────────────────────────────────────┤
│ #495 [user: default] [device: mac-work] [ide: cursor]          │
│ 2026/4/19 16:59:42                                             │
│ 执行目录列出命令并发现 PowerShell 配置报错                          │
│ 此次操作属于...                                                  │
└──────────────────────────────────────────────────────────────┘
```

数据来源：`/api/v1/admin/memory/{...}?user_id=X`

#### 4.3.4 设置（Settings）

- 当前 admin session 信息（创建时间 / 过期时间）
- 重置 admin 密码（弹框输入旧密码 + 新密码）—— P1 可选
- 注销

### 4.4 状态管理

纯原生 JS，不引第三方框架。模块结构：

```javascript
const ADMIN = {
  sessionToken: localStorage.getItem('admin_session_token'),
  state: { users: [], currentTab: 'overview', filterUserId: '' },

  api: {
    login(password) { ... },
    logout() { ... },
    overview() { return this._get('/api/v1/admin/overview'); },
    listUsers() { return this._get('/api/v1/admin/users'); },
    createUser(name, note) { return this._post('/api/v1/admin/users', { name, note }); },
    rotateToken(id) { return this._post(`/api/v1/admin/users/${id}/rotate-token`); },
    revokeToken(id) { return this._post(`/api/v1/admin/users/${id}/revoke`); },
    deleteUser(id) { return this._delete(`/api/v1/admin/users/${id}?confirm=1`); },
    memory(resource, params) { return this._get(`/api/v1/admin/memory/${resource}?${qs(params)}`); },
    _get / _post / _delete: 统一 fetch + Bearer header + 401 跳登录
  },

  views: {
    renderOverview / renderUsers / renderMemory / renderSettings / renderLogin
  }
};
```

---

## 五、向后兼容

### 5.1 SHARED_TOKEN 旧客户端

启动迁移流程后：
- `SHARED_TOKEN` 自动注册为 `default` 用户的 active token
- 旧客户端拿 `SHARED_TOKEN` 请求 `/api/v1/sync/*` → `resolveUserByToken` 解析出 `default` 用户 → 写入 `user_id=1`
- 旧客户端 viewer 远端模式 `/api/v1/viewer/*` 同样按 user_id 过滤，看到的就是它自己上传的数据

### 5.2 客户端 viewer 远端模式

之前 worker 代理 `/api/viewer/*?source=remote` 走的就是 `Authorization: Bearer <CODEBUDDY_MEM_REMOTE_TOKEN>`，**完全不需要改**。token 现在变成 user_token，行为不变。

### 5.3 迁移期共存

部署升级时：
1. 服务端先升级（自动跑 migrateV2，老数据迁到 default 用户）
2. 老客户端继续用 SHARED_TOKEN 工作
3. 管理员逐个用户在后台创建并发新 Token，让用户替换 `.env.local` 中的 token
4. 全部替换完后从环境变量中移除 SHARED_TOKEN（下次启动 `default` 用户的 token 仍保留在数据库中，可以在后台改名/吊销）

---

## 六、安全考量

| 威胁 | 缓解措施 |
|:---|:---|
| Token 数据库泄露 | Token 只存 `sha256(token + global_salt)`，泄露后短期内仍需暴力破解，可立即在后台一键吊销全部 |
| Admin 密码暴力破解 | login 接口加入 `setTimeout(resolve, 500ms)` 固定延时；同 IP 失败超过 5 次锁定 15 分钟（P1） |
| Session 劫持 | session_token 64 字符随机；7 天过期；可手动注销 |
| CSRF | 不使用 Cookie 鉴权，所有 admin API 必须带 `Authorization` header → CSRF 自然防护 |
| 跨用户数据泄露 | `/api/v1/viewer/*` 强制 `WHERE user_id = ?`，单元测试覆盖 |
| 管理员误删 | DELETE 用户必须带 `?confirm=1`，前端二次确认弹框 |
| 时序攻击 | 所有密码/token 比对走 `crypto.timingSafeEqual` |

---

## 七、配置变更总览

### 7.1 服务端新增环境变量

```env
# 新增（可选；未配置时启动日志会打印随机生成的密码）
ADMIN_PASSWORD=your-strong-password

# 保留（向后兼容）
SHARED_TOKEN=legacy-token   # 自动迁移为 default 用户的 token

# 现有（不变）
PORT=8848
HOST=0.0.0.0
DATA_DIR=/data
```

### 7.2 客户端配置（不变）

```env
CODEBUDDY_MEM_REMOTE_URL=http://server:8848
CODEBUDDY_MEM_REMOTE_TOKEN=user_token_from_admin_console   # ← 来源换成"后台生成"
```

---

## 八、实施分步

### Step 1 数据层
- 新建 `admin_config / admin_sessions / users / user_tokens` 表
- 现有表加 `user_id` 列 + 索引
- `migrateV2()` 启动钩子（密码初始化、SHARED_TOKEN 迁移）

### Step 2 鉴权层
- 重构 `auth/token.ts` → `resolveUserByToken`
- 新增 `auth/admin.ts`
- 提供 `utils/crypto.ts`（sha256 / randomHex / timingSafeEqual）
- 实现 `isFirstRun()` 用于向导跳转判定

### Step 3 Sync / Viewer 改造
- 所有 sync 路由用 `resolveUserByToken` 注入 `user_id`
- `/api/v1/viewer/*` 强制按 `user_id` 过滤
- aggregate / export 同上

### Step 4 Admin API
- `/admin/setup`（向导一次性提交，未初始化时唯一可用的写接口）
- `/admin/login` `/logout`
- `/admin/overview`
- `/admin/users` GET / POST
- `/admin/users/:id/invite`（邀请链接 + 二维码数据）
- `/admin/users/:id/rotate-token` `/revoke` DELETE
- `/admin/memory/*`

### Step 5 Admin 前端
- `web/admin.css` 共享样式（提取自客户端 viewer.html）
- `web/setup.html` 初始化向导（3 步）
- `web/admin.html` 管理后台（4 个 Tab + 邀请链接 modal）
- `web/lib/qrcode.min.js` 二维码库
- 「用户」Tab 卡片大白话按钮 + 二次确认（依文案对照表）

### Step 6 客户端 Desktop 改造
- `desktop/src/main.ts` 注册 `cmem://` URL Scheme + open-url / second-instance
- `desktop/src/windows/ConnectInvite.ts` 实现解析-测试-写配置-重启 worker 流程
- `desktop/src/windows/SettingsWindow.ts` + `settings.html` 加「服务器连接」分页
- `desktop/src/config/store.ts` 加 server / token / userName 字段
- `src/shared/identity.ts` 改造配置优先级：desktop-config.json > .env > env
- worker 新增 `GET /api/sync/status` 提供队列状态 + 补传进度给 Settings 轮询
- worker 新增 `POST /api/sync/rescan` 兜底重扫
- `SyncQueue.backfillFromDatabase()` 增加 `backfillState` 状态字段，按 D.2 补强
- `sync_queue` 表加 `priority` 列，新数据 priority=10、补传 priority=0
- `settings.html` 加补传进度卡片 + 完成提示（D.2.3）
- 客户端首次成功连接服务器（用户粘贴邀请链接成功后）立即触发一次 `backfillFromDatabase()`

### Step 6.5 历史数据补传（FR-11）
- 服务端 `/api/v1/admin/overview` 加 `last_24h` 统计（D.5）
- 联调：在客户端塞 3000+ 条假数据 → 关闭 sync → 启 sync → 看到进度卡跑完 → 服务端数据数 = 客户端

### Step 7 联调验证
- 启动**全新**服务（无 ADMIN_PASSWORD、无 SHARED_TOKEN、空 DB）→ 浏览器开 `/` → 自动跳向导
- 走完 3 步向导 → 自动登录后台 → 看到 1 个用户
- 在「用户」Tab 点「📋 邀请链接」→ 复制 cmem:// 链接
- Desktop App 粘贴邀请链接 → 弹确认 → 测试通过 → 写配置 → 重启 worker → 出现"已连接"
- IDE 触发 hook → 服务端「记忆」Tab 看到该用户的数据
- **历史数据补传场景**：另一台机器先用 1 周（积累 N 条本地数据，未连服务器）→ 接入邀请链接 → 出现补传进度卡 → 完成后服务端数据 == 客户端本地数据，断点续传可重启验证
- 在管理端「换一把新钥匙」→ Desktop App 同步立刻 401 失败 → 重新粘贴新邀请链接 → 恢复
- 在管理端「删除账号」→ 输入用户名确认 → 该用户所有数据消失，其他用户不受影响
- 旧路径回归：启动时设 `SHARED_TOKEN=xxx`，老客户端 `.env.local` 配 `CODEBUDDY_MEM_REMOTE_TOKEN=xxx` → 自动落到 `default` 用户，行为如旧

---

## 八之 A、初始化向导（FR-8 实现）

### A.1 触发判定

```typescript
// 启动时计算一次，记到内存
function isFirstRun(db: Database): boolean {
  const cfg = db.prepare('SELECT * FROM admin_config WHERE id=1').get();
  if (!cfg) return true;
  const userCount = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as any).n;
  return userCount === 0;
}
```

### A.2 路由行为

```
GET  /                        → 302 /admin/setup（如果 isFirstRun）/ 302 /admin（否则）
GET  /admin/setup             → 返回 web/setup.html（向导）
GET  /admin                   → 如果 isFirstRun 仍然 302 /admin/setup
POST /api/v1/admin/setup      → Body: { password, confirm_password, first_user_name, first_user_note }
                                响应: { admin_session_token, user, token_plain }
```

### A.3 setup.html 步骤

```
┌────────────────────────────────────────────────────────────┐
│  AgentMemory 服务初始化向导                                 │
│  ●━━━━━━━━━━○━━━━━━━━━━○                                   │
│  设置密码        创建账号       开始使用                     │
├────────────────────────────────────────────────────────────┤
│  Step 1：设置管理员密码                                      │
│                                                            │
│  这是用来登录管理后台的密码，请牢记。                          │
│                                                            │
│  密码:        [________________]                            │
│  再输一次:    [________________]                            │
│  强度:        🟢 强（>=12 字符 + 大小写 + 数字）              │
│                                                            │
│                                       [下一步 →]             │
└────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────┐
│  Step 2：创建第一个账号                                      │
│                                                            │
│  账号是用来连接客户端的"身份"。每台设备可以共用一个账号。       │
│                                                            │
│  账号名:    [me______________]  ← 默认填好，可改             │
│  备注:      [我的主力工作账号___] (可选)                      │
│                                                            │
│              [← 上一步]              [创建账号 →]             │
└────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────┐
│  Step 3：把这个账号配置到客户端                                │
│                                                            │
│  ┌────────┐   方式 A：用客户端 Desktop App 扫码              │
│  │  二维码  │   ─────────────────────────                   │
│  │ ▓▓▓▓▓ │                                                 │
│  │ ▓░░▓░ │   方式 B：复制邀请链接到客户端                    │
│  │ ▓▓▓▓▓ │   cmem://connect?server=...&token=...           │
│  └────────┘   [📋 复制]                                      │
│                                                            │
│  方式 C：手动配置（折叠展开）                                 │
│  服务器地址: http://nas:8848             [📋]                │
│  钥匙:       abc...xyz (32 字符)         [📋]                │
│                                                            │
│  ⚠️ 这把钥匙只显示这一次，请保存好或现在就配到客户端。          │
│                                                            │
│                                       [完成，进入后台 →]      │
└────────────────────────────────────────────────────────────┘
```

### A.4 setup.html 技术要点

- 单 HTML 文件 + 内联 CSS / JS
- 二维码用 `web/lib/qrcode.min.js`（纯前端 SVG 生成，~10KB）
- 步骤之间用 `display: none` 切换，不刷新页面
- 完成后写入 `localStorage.admin_session_token` 跳转 `/admin`
- 强度提示规则（前端实时计算）：
  - 长度 < 8：弱（红）
  - 长度 8-11：中（橙）
  - 长度 >= 12 且包含大小写或数字：强（绿）
- `cmem://` 链接生成示例：
  ```
  cmem://connect
    ?server=http%3A%2F%2Fnas%3A8848
    &token=PLAIN_TOKEN
    &user=me
  ```

---

## 八之 B、邀请链接 / 二维码（FR-9 实现）

### B.1 服务端 API

```
POST /api/v1/admin/users/:id/invite

Response 200:
{
  "invite_link": "cmem://connect?server=...&token=...&user=...",
  "qr_svg": "<svg>...</svg>",            // 服务端可选预生成；前端也可自己生成
  "server_url": "http://nas:8848",
  "user_name": "me",
  "token_visible_until": "2026-04-19T09:35:00Z",   // 5 分钟内允许再查看
  "token_tail": "abc12345"
}
```

服务端规则：
- 当且仅当该 token 是「最近 5 分钟内创建/重生成」的，invite_link 中包含明文 token
- 超过 5 分钟，invite_link 中只有 `server` 和 `user`，没有 `token`，并提示前端"安全起见，钥匙已隐藏，请重新生成钥匙以获取邀请链接"

### B.2 服务端拼接邀请链接的服务器地址来源

优先级：
1. 请求 header 的 `X-Public-Server-URL`（管理员可在 Settings 里手动设置）
2. `process.env.PUBLIC_SERVER_URL`
3. 回退到 `req.headers.host`（HTTP）

> 部署在 NAT/代理后时，host 不一定是用户能访问的地址。在 Settings 中提供「设置我的公网访问地址」字段持久化到 admin_config。

### B.3 admin_config 增加列

```sql
ALTER TABLE admin_config ADD COLUMN public_server_url TEXT;
```

### B.4 二维码生成

- 前端使用 `qrcode.min.js`（如 `davidshimjs/qrcodejs` 或更小的 `kazuhikoarase/qrcode-generator`）
- 直接渲染到 `<svg>` 节点（不用 canvas，便于复制图片）
- 二维码内容就是 invite_link 字符串

### B.5 客户端 cmem:// 协议处理（Electron）

#### 5.1 注册（main.ts）

```typescript
import { app } from 'electron';

if (process.defaultApp) {
  // 开发模式
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('cmem', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('cmem');
}

// macOS / Linux 用 open-url
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleCmemUrl(url);
});

// Windows / Linux 用 second-instance（单例）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
app.on('second-instance', (_event, argv) => {
  const url = argv.find(a => a.startsWith('cmem://'));
  if (url) handleCmemUrl(url);
});
```

#### 5.2 处理流程（ConnectInvite.ts）

```typescript
async function handleCmemUrl(url: string): Promise<void> {
  // 1. 解析
  const parsed = new URL(url);
  if (parsed.protocol !== 'cmem:' || parsed.host !== 'connect') {
    showToast('链接格式不对', 'error'); return;
  }
  const server = parsed.searchParams.get('server');
  const token = parsed.searchParams.get('token');
  const user = parsed.searchParams.get('user');
  if (!server) { showToast('链接缺少服务器地址', 'error'); return; }

  // 2. 弹出确认窗口（避免恶意链接静默生效）
  const ok = await showConfirmDialog({
    title: '检测到接入邀请',
    body: `要把这个客户端连接到服务器吗？\n\n服务器：${server}\n账号：${user || '(未指定)'}`,
    confirmText: '连接',
    cancelText: '取消'
  });
  if (!ok) return;

  // 3. 测试服务器
  const healthOk = await testServerHealth(server);
  if (!healthOk) { showToast(`连不上服务器 ${server}`, 'error'); return; }

  // 4. 测试 Token（如果有）
  if (token) {
    const tokenOk = await testToken(server, token);
    if (!tokenOk) { showToast('钥匙不对，请向管理员要新链接', 'error'); return; }
  }

  // 5. 写入配置（store.ts 持久化 + 同步写入 .env.local 兼容旧版）
  await store.set({
    remoteUrl: server,
    remoteToken: token || '',
    remoteUserName: user || '',
    syncEnabled: !!token,
  });

  // 6. 重启 worker 应用配置
  await workerManager.restart();

  showToast(`已连接到 ${server}（${user || '未指定账号'}）`, 'success');
}
```

#### 5.3 测试连接 API

```typescript
async function testServerHealth(server: string): Promise<boolean> {
  try {
    const r = await fetch(`${server}/health`, { method: 'GET' });
    return r.ok;
  } catch { return false; }
}

async function testToken(server: string, token: string): Promise<boolean> {
  try {
    const r = await fetch(`${server}/api/v1/viewer/projects?limit=1`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    return r.ok;
  } catch { return false; }
}
```

---

## 八之 C、Desktop「服务器连接」设置页（FR-10 实现）

### C.1 settings.html 新增区块

```html
<section id="server-connection" class="settings-section">
  <h2>服务器连接</h2>

  <!-- 状态卡片 -->
  <div class="status-card" id="connStatus">
    <span class="status-dot" id="connDot"></span>
    <div>
      <div class="status-line">
        <strong id="connState">未配置</strong>
        <small id="connServer"></small>
      </div>
      <div class="status-line">
        <small>账号：<span id="connUser">—</span></small>
        <small>钥匙：<span id="connTokenTail">—</span></small>
        <small>最近同步：<span id="connLastSync">—</span></small>
      </div>
    </div>
  </div>

  <!-- 队列状态 -->
  <div class="queue-card">
    <span class="queue-num pending">待发：<b id="qPending">0</b></span>
    <span class="queue-num sent">已同步：<b id="qSent">0</b></span>
    <span class="queue-num failed">失败：<b id="qFailed">0</b></span>
    <button id="syncNow">立即同步</button>
    <button id="retryFailed">清空失败重试</button>
  </div>

  <!-- 操作按钮 -->
  <div class="actions">
    <button class="primary" id="connectByInvite">使用邀请链接连接</button>
    <button id="testConn">测试连接</button>
    <button class="danger" id="disconnect">断开</button>
  </div>

  <p class="muted">
    使用邀请链接：把管理员给你的 <code>cmem://...</code> 链接粘贴到这里，自动配置。
    <button class="link" id="pasteInvite">粘贴并连接</button>
  </p>
</section>
```

### C.2 状态颜色

| 状态 | dot 颜色 | 文字 |
|:---|:---|:---|
| 未配置 | 灰 | "未配置" |
| 配置中 | 橙脉冲 | "正在测试连接..." |
| 在线 | 绿 | "已连接" |
| 重连中 | 橙脉冲 | "正在重连..." |
| 断开 | 红 | "已断开" + 错误说明 |

### C.3 队列状态来源

新增 worker API：

```
GET /api/sync/status

Response:
{
  "enabled": true,
  "remoteUrl": "http://nas:8848",
  "userName": "me",
  "tokenTail": "abc12345",
  "lastSyncAt": "2026-04-19T09:30:00Z",
  "queue": { "pending": 0, "sent": 528, "failed": 0 }
}
```

Settings 页每 3 秒轮询。

### C.4 配置写入策略

- Desktop App 通过 `store.ts` 写入 `~/.agent-memory/desktop-config.json`
- Worker 启动时 `identity.ts` / `getSyncConfig()` **优先读 desktop-config.json**，回退到 `.env.local`，最后回退到环境变量
- 这样保证 Desktop GUI 配置生效，同时不破坏命令行用户的 `.env.local` 体验

具体优先级：

```typescript
// src/shared/identity.ts (改造后)
function loadDesktopConfig(): Partial<SyncConfig> | null {
  const file = path.join(getDataDir(), 'desktop-config.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

export function getSyncConfig(): SyncConfig {
  const desktop = loadDesktopConfig();
  return {
    enabled: desktop?.syncEnabled ?? (!!process.env.CODEBUDDY_MEM_REMOTE_URL && !!process.env.CODEBUDDY_MEM_REMOTE_TOKEN),
    remoteUrl: (desktop?.remoteUrl ?? process.env.CODEBUDDY_MEM_REMOTE_URL ?? '').replace(/\/+$/, ''),
    remoteToken: desktop?.remoteToken ?? process.env.CODEBUDDY_MEM_REMOTE_TOKEN ?? '',
    redactRaw: desktop?.redactRaw ?? (process.env.CODEBUDDY_MEM_SYNC_REDACT_RAW === 'true'),
  };
}
```

---

## 八之 D、历史数据自动补传（FR-11 实现）

### D.1 已落地的基础能力（无需重做）

`SyncQueue` 已实现 `backfillFromDatabase()`，能力如下（`src/services/sync/SyncQueue.ts` 现状）：

```typescript
// 启动时调用
async backfillFromDatabase(): Promise<{ enqueued: number }> {
  const db = this.db;
  let total = 0;

  // 1. 扫描 sdk_sessions
  const sessions = db.prepare(`
    SELECT * FROM sdk_sessions WHERE synced_at IS NULL ORDER BY started_at_epoch ASC
  `).all() as any[];
  for (const s of sessions) {
    this.enqueue('session', buildSessionPayload(s));
    total++;
  }

  // 2. 扫描 observations
  const obs = db.prepare(`
    SELECT * FROM observations WHERE synced_at IS NULL ORDER BY created_at_epoch ASC
  `).all() as any[];
  for (const o of obs) {
    this.enqueue('observation', buildObservationPayload(o));
    total++;
  }

  // 3. 扫描 session_summaries
  const sums = db.prepare(`
    SELECT * FROM session_summaries WHERE synced_at IS NULL ORDER BY created_at_epoch ASC
  `).all() as any[];
  for (const s of sums) {
    this.enqueue('summary', buildSummaryPayload(s));
    total++;
  }

  return { enqueued: total };
}
```

调用时机：
- `SyncQueue.startWorker()` 一次性调用 → 启动 / 重启时自动跑
- `SyncQueue` 实现了 `markSourceSynced()`，sync 成功后回写 `synced_at`，避免下次重复入队
- 服务端 sync API 用 `(device_id, client_uuid)` UPSERT，重复发不产生重复数据

### D.2 本次需要补强的部分

#### D.2.1 「补传中」状态明确暴露

之前 `backfillFromDatabase()` 默默地跑，UI 不知道总数和进度。补强：

```typescript
class SyncQueue {
  // 新增状态字段
  private backfillState: {
    running: boolean;
    total: number;          // 启动时扫描出的总数
    enqueued: number;       // 已入队（含已发送 + 等待）
    sent: number;           // 已成功发送
    failed: number;
    startedAt: number | null;
    completedAt: number | null;
  } = { running: false, total: 0, enqueued: 0, sent: 0, failed: 0, startedAt: null, completedAt: null };

  async backfillFromDatabase(): Promise<void> {
    const total = this.countUnsynced();
    if (total === 0) return;
    this.backfillState = { running: true, total, enqueued: 0, sent: 0, failed: 0, startedAt: Date.now(), completedAt: null };
    // ... 原有入队逻辑，每入一条 enqueued++ ...
  }

  // 队列消费成功时触发回调
  private onItemSent(item: SyncQueueRow): void {
    if (this.backfillState.running) {
      this.backfillState.sent++;
      if (this.backfillState.sent + this.backfillState.failed >= this.backfillState.total) {
        this.backfillState.running = false;
        this.backfillState.completedAt = Date.now();
      }
    }
  }

  getBackfillState() { return { ...this.backfillState }; }
}
```

#### D.2.2 进度通过 `/api/sync/status` 暴露

扩展 C.3 中定义的 status API 响应：

```jsonc
{
  "enabled": true,
  "remoteUrl": "http://nas:8848",
  "userName": "me",
  "tokenTail": "abc12345",
  "lastSyncAt": "2026-04-19T09:30:00Z",
  "queue": { "pending": 12, "sent": 528, "failed": 0 },
  "backfill": {
    "running": true,
    "total": 3085,
    "sent": 1240,
    "failed": 0,
    "remaining": 1845,
    "elapsed_ms": 45000,
    "eta_ms": 67000          // 由 (remaining / sent * elapsed) 估算
  }
}
```

#### D.2.3 Desktop UI「补传进度卡片」

在 `settings.html` 「服务器连接」分页的状态卡下方，运行期间动态插入：

```html
<div class="backfill-card" id="backfillCard" style="display:none">
  <div class="backfill-header">
    <span class="backfill-icon">📤</span>
    <strong>正在补传你的历史记忆…</strong>
    <span class="backfill-eta" id="backfillEta">预计还需 1 分钟</span>
  </div>
  <div class="progress-bar">
    <div class="progress-fill" id="backfillFill" style="width:0%"></div>
  </div>
  <div class="backfill-counts">
    <span id="backfillSent">0</span> / <span id="backfillTotal">0</span> 条
    <small id="backfillFailedHint" style="color:#e53e3e"></small>
  </div>
  <p class="muted">这是你之前在没连接服务器时记录的内容，正在搬到服务器上。完成前关闭 App 也没关系，下次打开会接着传。</p>
</div>

<div class="backfill-done" id="backfillDone" style="display:none">
  ✅ 历史数据已全部同步到服务器（<span id="backfillDoneCount"></span> 条）
</div>
```

JavaScript 行为：
- 每 2 秒轮询 `/api/sync/status`
- `backfill.running === true` 显示进度卡，更新数字
- `backfill.running === false && backfill.total > 0`：显示完成提示，30 秒后自动 hide

ETA 文案换算：
- < 30s → "预计还需 30 秒"
- < 5min → "预计还需 N 分钟"
- < 1h → "预计还需 N 分钟"
- 否则 → "正在传输，请保持 App 运行"

### D.3 优先级队列（FR-11.3）

为避免补传 3000 条阻塞用户实时新数据：

```sql
ALTER TABLE sync_queue ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
-- 0 = backfill (低)
-- 10 = realtime (高)
CREATE INDEX IF NOT EXISTS idx_sync_queue_priority
  ON sync_queue(status, priority DESC, next_retry_at);
```

入队时区分：
```typescript
enqueue(kind, payload, opts?: { priority?: number; isBackfill?: boolean }) {
  const priority = opts?.priority ?? (opts?.isBackfill ? 0 : 10);
  // ...
}
```

消费时先 `ORDER BY priority DESC, next_retry_at`，确保新数据立刻出队，补传慢慢来。

### D.4 「重新检查未同步」按钮（FR-11.7）

Desktop 设置页加一个不显眼的小按钮：

```html
<button class="link" id="rescanUnsynced">🔍 重新检查未同步数据</button>
```

点击调用 worker 新接口：

```
POST /api/sync/rescan

Response:
{ "enqueued": 12, "message": "找到 12 条未同步的数据，已加入队列" }
```

Worker 内部就是再调一次 `backfillFromDatabase()`。

### D.5 服务端「最近 24h 新增」（FR-11.5）

`/api/v1/admin/overview` 响应中每个 user 的统计加：

```jsonc
{
  "recent_users": [
    {
      "id": 1, "name": "default",
      "last_synced_at": "...",
      "stats": {
        "total":     { "sessions": 50, "observations": 3000, "summaries": 60 },
        "last_24h":  { "sessions": 8, "observations": 145, "summaries": 9 }
      }
    }
  ]
}
```

通过 `WHERE received_at > datetime('now', '-1 day')` 在 SQLite 内统计。管理员看到 last_24h 一直在增长就知道某个 user 在补传中。

---

## 八之 E、零术语 UI 文案对照表（FR-12）

| 功能/概念 | 技术术语（不用） | 大白话（用这个） |
|:---|:---|:---|
| 用户 | User | 账号 |
| Token | Token / Bearer Token | 钥匙 |
| Token Hash | Token Hash | （不暴露） |
| 创建用户 | Create User | 新建账号 |
| 重生成 Token | Rotate Token | 换一把新钥匙 🔑 |
| 吊销 Token | Revoke Token | 暂停这个账号 ⏸ |
| 删除用户 | Delete User | 删除这个账号 🗑 |
| Active Token | Active Token | 当前正在使用的钥匙 |
| Migrate | Migrate / Migration | 升级数据 |
| Database Size | Database Size | 数据占用 |
| Session | Session | 会话 |
| Observation | Observation | 观察记录 |
| Summary | Summary | 会话总结 |
| Device ID | Device ID | 设备 |
| Source IDE | Source IDE | 来自哪个编辑器 |
| Sync Queue Pending | Sync Queue Pending | 待发送 |
| Sync Failed | Sync Failed | 同步失败 |
| Admin Session | Admin Session | （不暴露，自动管理） |

### 二次确认弹框模板

```
[换一把新钥匙]
"换钥匙后，旧钥匙立即失效。所有用旧钥匙连接的设备需要重新设置（用新邀请链接）。
旧的同步数据保留不变。
确定要换吗？"
[取消] [确定换]

[暂停账号]
"暂停后，这个账号的客户端将无法继续同步数据上来，但已经同步上来的历史数据会保留。
你以后可以再生成一把新钥匙重新启用。
确定暂停吗？"
[取消] [确定暂停]

[删除账号]
"⚠️ 删除是永久的，不可恢复！
将清除：N 个会话、M 条记忆、X 个设备记录。
请输入账号名 [alice] 以确认："
[__________________]
[取消] [我已输入正确，确认删除]
```

---

## 九、不做（Phase 2+）

- 用户自注册 / 邮箱验证 / 密码找回
- bcrypt / argon2 密码哈希（首版 sha256+salt 已足够自部署场景）
- 多 Admin / 角色分级（reader / writer）
- 操作审计日志表
- 操作频率限制 / IP 白名单
- WebSocket 实时同步状态推送
- 管理后台移动端响应式优化（Phase 1 桌面优先）
