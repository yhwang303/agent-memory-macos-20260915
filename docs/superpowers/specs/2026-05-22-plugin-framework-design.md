# 插件框架设计文档

**主题**：把 agent-memory 内置功能改造为可插拔插件
**首批改造目标**：服务器同步（Server Sync）、ShadowFolk Upload
**作者**：cloudboyguo
**日期**：2026-05-22
**状态**：草案，待评审

---

## 1. 背景与目标

### 1.1 现状

当前 agent-memory 的扩展能力有两个层次混乱：

1. **`src/integrations/openclaw-plugin/`** 是真正的扩展模块，但它扮演的是"被 OpenClaw 宿主调用"的角色，不是 agent-memory 自己的插件
2. **`plugins/shadowfolk-upload-plugin/`** 是一个独立的 Python 包，**主程序根本没加载**，只是放在那里
3. **服务器同步、ShadowFolk Upload** 这两个功能在代码里都是写死在主流程的核心模块——`WorkerService` 直接 import、Settings UI 硬编码渲染、配置字段进了 `AppConfig` 主结构

结果是：用户在 Settings 中看到的"Plugins" Tab 是个伪装——它展示的能力其实和"服务器同步"一样是核心功能，只是 UI 上分了组。

### 1.2 目标

定义一套**真正可插拔的插件框架**，使得：

- 拔掉一个插件 → 它的 UI 区块、HTTP endpoint、后台任务、数据库副作用全部消失
- 新增一个插件 → 不需要改主程序代码，扔个目录进去就生效
- 主程序对插件**只通过明确定义的扩展点**进行交互，不出现 `if (plugin === 'xxx')` 之类的硬编码
- 现有"服务器同步"和"ShadowFolk Upload"作为首批迁移示例

### 1.3 非目标

- 不做"第三方开发者市场"——本期只支持**内置插件**（在 monorepo 里的 first-party 插件）
- 不做插件沙箱、权限隔离——内置插件信任级别等同于主程序
- 不做插件热加载——重启 Worker 才能换插件

---

## 2. 总体架构

```
┌────────────────────────────────────────────────────────┐
│                  Worker Process                        │
│                                                        │
│   ┌──────────────────────────────────────────────┐     │
│   │   Plugin Host (插件运行时)                    │     │
│   │   ─ 加载 manifest                              │     │
│   │   ─ 调用 lifecycle (init/start/stop)           │     │
│   │   ─ 路由 HTTP 扩展点                           │     │
│   │   ─ 转发事件 (observation/summary/session)     │     │
│   │   ─ 提供 ServiceRegistry (DB / Logger / Sync)  │     │
│   └────┬───────┬───────┬───────┬──────────────────┘     │
│        ▼       ▼       ▼       ▼                       │
│   ┌────────┐ ┌─────────┐ ┌─────────┐ ┌────────┐        │
│   │server- │ │shadow-  │ │openclaw-│ │  ...   │        │
│   │sync    │ │folk     │ │feed     │ │        │        │
│   │plugin  │ │plugin   │ │plugin   │ │        │        │
│   └────────┘ └─────────┘ └─────────┘ └────────┘        │
└────────────────────────────────────────────────────────┘
            │                    ▲
            │ HTTP /api/*        │ IPC settings:*
            ▼                    │
   ┌────────────────────────────────────────┐
   │       Desktop (Electron)               │
   │   ┌────────────────────────────────┐   │
   │   │   UI Plugin Host               │   │
   │   │   ─ 拉取插件 UI manifest        │   │
   │   │   ─ 渲染 settings 区块          │   │
   │   │   ─ 路由 IPC                    │   │
   │   └────────────────────────────────┘   │
   └────────────────────────────────────────┘
```

**核心理念**：
1. 插件是**带有清单的目录**，主程序通过清单了解它能做什么
2. 主程序提供**事件总线 + 服务注册表 + 扩展点接口**
3. 插件通过扩展点声明式地"挂"到主程序上，不主动 import 主程序内部模块

---

## 3. 插件清单（Plugin Manifest）

每个插件根目录必须有一个 `plugin.json`：

```json
{
  "id": "server-sync",
  "name": "服务器同步",
  "description": "把本地记忆同步到远程服务器，让多台电脑共享一份记忆",
  "version": "1.0.0",
  "entry": "./index.ts",
  "uiEntry": "./ui.ts",
  "capabilities": {
    "subscribesEvents": ["observation:created", "summary:created", "session:started"],
    "providesEndpoints": ["/api/sync/status", "/api/sync/test", "/api/sync/rescan", "/api/sync/reset"],
    "ownsTables": ["sync_queue"],
    "settingsSection": {
      "title": "服务器同步",
      "subtitle": "让多台电脑共享一份记忆",
      "order": 20
    }
  },
  "config": {
    "schema": "./config-schema.json",
    "envVars": {
      "AGENTMEM_PLUGIN_SERVER_SYNC_ENABLED": "enabled",
      "AGENTMEM_PLUGIN_SERVER_SYNC_URL": "url",
      "AGENTMEM_PLUGIN_SERVER_SYNC_TOKEN": "token"
    }
  }
}
```

字段说明：

| 字段 | 含义 |
|---|---|
| `id` | 全局唯一，用作配置命名空间、IPC channel 前缀 |
| `entry` | Worker 端入口（导出 `createPlugin()`） |
| `uiEntry` | Desktop 端 UI 入口（导出 `createUIPlugin()`），可选 |
| `capabilities.subscribesEvents` | 订阅哪些事件 |
| `capabilities.providesEndpoints` | 注册哪些 HTTP endpoint |
| `capabilities.ownsTables` | 拥有哪些 SQLite 表（删除插件时也保留这些表，避免数据丢失） |
| `capabilities.settingsSection` | 在 Settings UI 渲染区块的元信息 |
| `config.schema` | JSON Schema 文件路径，用于配置校验和 UI 自动生成 |
| `config.envVars` | 主程序启动子进程时把哪些 env 注入给 worker |

---

## 4. Worker 端 ABI

### 4.1 Plugin 接口

```ts
// src/plugins/types.ts

export interface Plugin {
  /** 来自 manifest，运行时只读 */
  readonly manifest: PluginManifest;

  /**
   * 初始化阶段（Worker 启动后立即调用，但 HTTP server 尚未启动）
   * 用于：注册 endpoint、订阅事件、迁移自己拥有的表
   */
  init?(ctx: PluginContext): Promise<void> | void;

  /**
   * 启动阶段（HTTP server 已就绪）
   * 用于：启动后台任务（如 SyncQueue worker、定时器）
   */
  start?(ctx: PluginContext): Promise<void> | void;

  /**
   * 停止阶段（Worker 关闭前）
   * 用于：清理后台任务、flush 队列
   */
  stop?(ctx: PluginContext): Promise<void> | void;

  /** 配置变更通知（用户在 Settings 改了配置） */
  onConfigChanged?(newConfig: unknown, ctx: PluginContext): Promise<void> | void;

  /** 事件订阅 */
  onEvent?(event: AgentMemoryEvent, ctx: PluginContext): Promise<void> | void;

  /** HTTP endpoint 处理 */
  handleRequest?(req: PluginRequest, res: PluginResponse, ctx: PluginContext): Promise<void> | void;
}

/** 插件构造函数签名 */
export type PluginFactory = (manifest: PluginManifest) => Plugin;
```

### 4.2 PluginContext（主程序提供给插件的能力）

```ts
export interface PluginContext {
  /** 插件自己的 logger，自动加 [plugin:<id>] 前缀 */
  readonly logger: Logger;

  /** 当前生效的配置（已合并默认值 + 用户覆盖） */
  readonly config: Record<string, unknown>;

  /** 数据库（只读访问 + 通过 ownsTables 声明的表的写权限） */
  readonly db: PluginDatabaseAccessor;

  /** 主程序提供的服务（按需注入，避免插件直接 import 主程序模块） */
  readonly services: {
    sessions: SessionService;     // 查询 session
    observations: ObservationService;  // 查询 observation
    summaries: SummaryService;
  };

  /** 事件总线（插件之间也可以通过它通信） */
  readonly bus: EventBus;

  /** 设备身份（device_id, device_name） */
  readonly identity: DeviceIdentity;

  /** 数据目录（getDataDir 的结果，但插件应该用子目录） */
  readonly pluginDataDir: string;  // ~/.agent-memory/plugins/<id>/
}
```

**关键设计**：
- 插件**不能** `import { getDatabase } from '../sqlite/Database'`——必须通过 `ctx.db`
- `ctx.db` 对非自己 owned 的表只开放只读 prepared statements，写操作会抛 `ForbiddenTableError`

### 4.3 事件总线契约

```ts
export interface AgentMemoryEvent {
  type: EventType;
  timestamp: number;
  payload: unknown;
}

export type EventType =
  | 'session:started'         // 会话开始
  | 'session:completed'       // 会话结束
  | 'observation:created'     // 一条新 observation 写入 SQLite
  | 'summary:created'         // 一条新 summary 写入 SQLite
  | 'config:changed'          // 配置变更（任何插件的）
  | 'worker:shutting-down';   // Worker 即将关闭

export interface ObservationCreatedPayload {
  id: number;
  memorySessionId: string;
  project: string;
  type: string;
  createdAtEpoch: number;
  sourceIde: string;
  // 不包含原文——按需从 services.observations 查
}
```

**取舍**：
- 事件 payload **故意不带详细数据**，避免主程序为了广播事件做大量 JSON 序列化
- 插件需要详情时主动调 `ctx.services.observations.getById(id)`
- 这种设计让 server-sync 的 `enqueue` 调用从 WorkerService 内移到插件里，主程序只负责发事件

### 4.4 HTTP endpoint 注册

`PluginHost` 在 Worker 启动时遍历所有插件的 `capabilities.providesEndpoints`，把请求路由到对应插件的 `handleRequest`：

```ts
// src/plugins/PluginHost.ts 内伪代码
const route = this.endpointTable.match(url.pathname);
if (route) {
  return route.plugin.handleRequest!(req, res, route.plugin.context);
}
// 走主程序内置 endpoint
```

冲突规则：
- 同一 endpoint 被两个插件声明 → **加载阶段就报错，拒绝启动**
- 插件 endpoint 不能和主程序内置 endpoint 冲突（`/api/observations/*`, `/api/summaries/*`, `/api/search/*`, `/api/timeline/*`, `/health` 等）

### 4.5 数据库表所有权

```ts
// 插件 init 阶段
ctx.db.ensureTable('sync_queue', {
  schema: `
    CREATE TABLE IF NOT EXISTS sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      ...
    )
  `,
  indices: [
    `CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status, next_retry_at)`,
  ],
  migrations: {
    '1.0.1': `ALTER TABLE sync_queue ADD COLUMN priority INTEGER NOT NULL DEFAULT 10`,
  },
});
```

**重要约束**：
- 插件**不能**修改 `observations / session_summaries / sdk_sessions` 这些核心表的 schema
- 卸载插件不删除其 owned tables（避免数据丢失），但会从 manifest registry 中除名
- 重新安装会触发 migration 而非重建

---

## 5. Desktop 端 ABI

### 5.1 UIPlugin 接口

```ts
// desktop/src/plugins/types.ts
export interface UIPlugin {
  readonly manifest: PluginManifest;

  /** 渲染 Settings 区块（返回 HTML 字符串或挂载到 DOM 的函数） */
  renderSettingsSection(container: HTMLElement, ctx: UIPluginContext): void;

  /** 暴露给 main 进程的 IPC handlers */
  registerIpcHandlers?(ctx: UIPluginContext): void;
}

export interface UIPluginContext {
  /** 通过 worker HTTP API 请求插件自己的 endpoint */
  callPluginEndpoint(path: string, options?: RequestInit): Promise<unknown>;

  /** 读写插件自己命名空间下的配置 */
  getConfig(): Promise<unknown>;
  saveConfig(partial: Record<string, unknown>): Promise<void>;

  /** 弹 toast / 状态行（通过 host 提供，避免 UI 风格不一致） */
  setStatus(level: 'info' | 'success' | 'warning' | 'error', message: string): void;

  /** 监听配置变更广播（其它窗口/进程改了配置） */
  onConfigChanged(callback: (newConfig: unknown) => void): () => void;
}
```

### 5.2 settings.html 改造

当前 `settings.html` 中**写死的"服务器同步"块**（行 689-783）和**写死的"ShadowFolk 上传"块**全部移除，改为：

```html
<!-- 主结构 -->
<div class="section" id="generalSection"> ... 通用设置 ... </div>
<div class="section" id="ideSection"> ... IDE 关联 ... </div>
<div class="section" id="aiSection"> ... AI 配置 ... </div>

<!-- 插件区块自动插入到这里 -->
<div id="pluginSections"></div>
```

启动时由 `UIPluginHost` 拉取插件清单，按 `capabilities.settingsSection.order` 排序后调用每个插件的 `renderSettingsSection()`。

### 5.3 IPC 路由

主进程的 `SettingsWindow.ts` 不再直接 handle `server:apply-invite` / `server:test` 这些 channel，改为：

```ts
ipcMain.handle('plugin:invoke', async (_, pluginId: string, action: string, args: unknown) => {
  const plugin = uiPluginHost.get(pluginId);
  return plugin.invoke(action, args);
});
```

插件的 `registerIpcHandlers()` 在自己内部维护 action 表。

---

## 6. 配置管理

### 6.1 配置存储结构

`desktop-config.json` 改造：

```jsonc
{
  // 主程序核心配置（不变）
  "port": 3847,
  "openAtLogin": true,
  "globalShortcut": "CmdOrCtrl+Shift+M",
  "apiProvider": "timiai",
  "apiKey": "...",
  "apiModel": "gpt-5.4",

  // 插件配置统一在 plugins 命名空间下
  "plugins": {
    "server-sync": {
      "enabled": false,
      "url": "",
      "token": "",                  // 加密存储
      "userName": "",
      "deviceName": ""
    },
    "shadowfolk-upload": {
      "enabled": false,
      "dailyTime": "23:30",
      "workspaces": [],
      "workspaceAliases": []
    }
  }
}
```

### 6.2 启动时配置加载顺序

1. 读取 `desktop-config.json`
2. 对每个插件：
   - 取出 `plugins[<id>]`
   - 用插件 `config.schema` 校验（无效值用默认值）
   - 解密敏感字段（按 schema 中标 `encrypted: true` 的字段）
3. 构造 `getWorkerEnv()` 时遍历每个插件的 `manifest.config.envVars`，注入对应 env

### 6.3 兼容性迁移

旧版 `desktop-config.json` 中：
- `serverEnabled / serverUrl / serverToken / serverUserName / deviceName` → `plugins.server-sync.*`
- `shadowfolkEnabled / shadowfolkDailyTime / shadowfolkWorkspaces / shadowfolkWorkspaceAliases` → `plugins.shadowfolk-upload.*`

迁移在 `getConfig()` 第一次调用时做一次性检测，迁移完写回新 key + 删旧 key + 备份原文件到 `desktop-config.backup.<timestamp>.json`。

---

## 7. 插件加载流程

### 7.1 内置插件目录

```
src/plugins/
├── server-sync/
│   ├── plugin.json
│   ├── config-schema.json
│   ├── index.ts                  ← Worker entry
│   ├── ui.ts                     ← Desktop entry
│   └── ui.html                   ← Settings 区块的 HTML 模板
├── shadowfolk-upload/
│   ├── plugin.json
│   ├── ...
└── registry.ts                   ← 列出所有内置插件
```

### 7.2 加载顺序

```
Worker 启动:
1. PluginHost.discover()       — 扫描 src/plugins/registry.ts 列出的插件
2. PluginHost.validate()       — 校验 manifest schema、检测 endpoint 冲突
3. PluginHost.initAll()        — 串行调用每个插件的 init()
4. WorkerService.start()       — 启动 HTTP server
5. PluginHost.startAll()       — 启动后台任务
```

### 7.3 卸载流程

```
1. PluginHost.stopAll()        — 反向顺序调用 stop()
2. WorkerService.shutdown()    — 关闭 HTTP server
```

---

## 8. 首批迁移：server-sync 插件

### 8.1 目录结构

```
src/plugins/server-sync/
├── plugin.json
├── config-schema.json
├── index.ts                  ← createPlugin()
├── SyncQueue.ts              ← 从 src/services/sync/ 搬过来
├── RemoteClient.ts           ← 从 src/services/sync/ 搬过来
├── invite-parser.ts          ← 从 desktop/src/config/ 搬过来
├── handlers/
│   ├── status.ts             ← /api/sync/status
│   ├── test.ts               ← /api/sync/test
│   ├── rescan.ts             ← /api/sync/rescan
│   └── reset.ts              ← /api/sync/reset
├── ui.ts
├── ui.html
└── README.md
```

### 8.2 改造对照

| 原代码位置 | 改造后位置 | 备注 |
|---|---|---|
| `src/services/sync/SyncQueue.ts` | `src/plugins/server-sync/SyncQueue.ts` | 只改 import 路径 |
| `WorkerService` 中的 `this.syncQueue.enqueue(...)` 调用（3 处） | 改为 `this.bus.emit('observation:created', ...)`，由插件订阅 | 主程序解耦 |
| `WorkerService.handleSyncStatus/Test/Rescan/Reset` (4 个 handler) | 移到插件 handlers/ | 通过 endpoint 路由 |
| `desktop/src/windows/SettingsWindow.ts` 的 7 个 `server:*` IPC | 移到插件 ui.ts 的 `registerIpcHandlers` | 走 `plugin:invoke` 路由 |
| `desktop/src/config/inviteParser.ts` | `src/plugins/server-sync/invite-parser.ts` | 插件自包含 |
| `desktop/src/main.ts` 中 `cmem://` 协议 handler | 改为：协议命中时找 owns `cmem://` 协议的插件 | 协议注册也通过 manifest 声明 |
| `AppConfig` 中 5 个 server-* 字段 | 删除，改成 `plugins.server-sync.*` | 兼容性迁移在 7.6.3 |
| `getWorkerEnv()` 中 `CODEBUDDY_MEM_REMOTE_URL/TOKEN/SYNC_ENABLED` | 由插件 manifest 声明 | env 注入插件化 |
| `settings.html` 689-783 行 | 删除，改为插件 UI 区块 | UI 插件化 |

### 8.3 插件入口示例

```ts
// src/plugins/server-sync/index.ts
import type { Plugin, PluginContext, PluginFactory } from '../../core/plugins/types.js';
import { SyncQueue } from './SyncQueue.js';
import { RemoteClient } from './RemoteClient.js';
import * as handlers from './handlers/index.js';

export const createPlugin: PluginFactory = (manifest) => {
  let syncQueue: SyncQueue | null = null;

  const plugin: Plugin = {
    manifest,

    async init(ctx) {
      const { enabled, url, token } = ctx.config as ServerSyncConfig;
      if (!enabled || !url || !token) {
        ctx.logger.info('Plugin disabled or not configured, skipping init');
        return;
      }
      const remote = new RemoteClient({ baseUrl: url, token });
      syncQueue = new SyncQueue(ctx.db.raw('sync_queue'), remote);
    },

    async start(ctx) {
      syncQueue?.startWorker();
    },

    async stop() {
      await syncQueue?.flush();
      syncQueue?.stopWorker();
    },

    async onEvent(event, ctx) {
      if (!syncQueue) return;
      switch (event.type) {
        case 'observation:created':
          syncQueue.enqueue('observation', event.payload.id, ...);
          break;
        case 'summary:created':
          syncQueue.enqueue('summary', event.payload.id, ...);
          break;
        case 'session:started':
          syncQueue.enqueue('session', event.payload.id, ...);
          break;
      }
    },

    async handleRequest(req, res, ctx) {
      const route = req.url.pathname;
      if (route === '/api/sync/status')   return handlers.status(req, res, ctx, syncQueue);
      if (route === '/api/sync/test')     return handlers.test(req, res, ctx);
      if (route === '/api/sync/rescan')   return handlers.rescan(req, res, ctx, syncQueue);
      if (route === '/api/sync/reset')    return handlers.reset(req, res, ctx, syncQueue);
    },
  };

  return plugin;
};
```

---

## 8.5 第二批迁移：shadowfolk-upload 插件

shadowfolk-upload 比 server-sync 更复杂，**它已经是双形态**：项目内有 TypeScript 实现（`src/services/shadowfolk/`），项目外有独立 Python CLI（`plugins/shadowfolk-upload-plugin/`）。插件化要做的是把 TS 部分从 WorkerService 里剥出来，并对齐 manifest，让两种形态都成为合法的插件载体。

### 8.5.1 现状摸底

| 维度 | 现状 |
|---|---|
| TS 实现 | `src/services/shadowfolk/ShadowFolkUploader.ts`、`PushHistoryStore.ts`、`schedule.ts`（北京时区每日定时） |
| HTTP endpoint | `WorkerService` 中 7 个 `/api/shadowfolk/*` handler |
| 定时器 | `WorkerService.startShadowFolkTimer()` + `scheduleNextShadowFolkRun()` |
| 触发链路 | 不依赖 observation 入库事件，**纯定时拉取** + 手动 push |
| 配置来源 | `AppConfig.shadowfolk.{enabled,dailyTime,workspaces,workspaceAliases}` + `~/.shadow/config.json`（auth） + 一组 `CODEBUDDY_MEM_SHADOWFOLK_*` env |
| 持久化 | `~/.agent-memory/shadowfolk-push-history.json`（独立文件，不进 SQLite） |
| 工作区映射 | `workspaceAliases`：把 git 工作区路径映射到记忆里的 `project` 前缀（含嵌套仓库剔除） |
| Python 形态 | `plugins/shadowfolk-upload-plugin/` 一个独立 CLI 包，也能 `once` / `daemon` 跑同一逻辑，被 README 称为"pure-script uploader"，但**未被主程序加载** |
| 上游 API | ShadowFolk Server 的 `/api/push/raw`、`/api/push/push-records/{path}` |

**关键差异（和 server-sync 对比）：**
1. server-sync 是**数据驱动**（observation 入库即广播），shadowfolk-upload 是**时间驱动**（每日定时）
2. server-sync 的目标是"多设备共享同一份记忆"，shadowfolk-upload 的目标是"按工作区把记忆 + Git 上下文打包推送到外部系统"
3. shadowfolk 已经有**和插件框架平行存在的脚本形态**（Python CLI + `~/.shadow/config.json`），插件化后要避免协议二选一，应该让两种形态共享同一份契约

### 8.5.2 插件化后的目录结构

```
src/plugins/shadowfolk-upload/
├── plugin.json
├── config-schema.json
├── index.ts                    ← createPlugin()
├── ShadowFolkUploader.ts       ← 从 src/services/shadowfolk/ 搬过来
├── PushHistoryStore.ts         ← 同上（JSON 文件继续放 dataDir 下）
├── schedule.ts                 ← 同上（北京时区定时计算）
├── workspace-aliases.ts        ← 工作区→记忆 project 映射 + 嵌套仓库剔除
├── handlers/
│   ├── status.ts               ← /api/shadowfolk/status
│   ├── workspace-validate.ts   ← /api/shadowfolk/workspaces/validate
│   ├── workspace-aliases.ts    ← /api/shadowfolk/workspaces/suggest-aliases
│   ├── config.ts               ← /api/shadowfolk/config
│   ├── push.ts                 ← /api/shadowfolk/push
│   ├── history.ts              ← /api/shadowfolk/history
│   └── replay.ts               ← /api/shadowfolk/replay
├── ui.ts                       ← UI 注册：settings 区块 + Plugins Tab 卡片
├── ui.html                     ← settings 区块模板（包含每日时间、工作区列表、别名编辑、立即推送、历史记录）
└── README.md
```

### 8.5.3 manifest 关键字段

shadowfolk-upload 的 manifest 比 server-sync 用到更多扩展点，是检验框架完整度的好用例：

```json
{
  "id": "shadowfolk-upload",
  "name": "ShadowFolk Upload",
  "version": "1.0.0",
  "category": "exporter",
  "lifecycle": ["init", "start", "stop", "onConfigChanged"],
  "extensionPoints": {
    "scheduler": {
      "trigger": "daily",
      "timezone": "Asia/Shanghai",
      "configPath": "dailyTime"
    },
    "httpEndpoints": [
      "/api/shadowfolk/status",
      "/api/shadowfolk/workspaces/validate",
      "/api/shadowfolk/workspaces/suggest-aliases",
      "/api/shadowfolk/config",
      "/api/shadowfolk/push",
      "/api/shadowfolk/history",
      "/api/shadowfolk/replay"
    ],
    "settingsSection": {
      "title": "ShadowFolk 上传",
      "icon": "upload",
      "view": "ui.html"
    },
    "pluginsTabCard": {
      "title": "ShadowFolk Upload Plugin",
      "summary": "把本地记忆按定时间隔推送到 ShadowFolk。不影响主同步链路。"
    },
    "ownsFiles": ["shadowfolk-push-history.json"],
    "readsCoreTables": ["observations", "session_summaries", "sessions"]
  },
  "config": {
    "namespace": "plugins.shadowfolk-upload",
    "schema": "config-schema.json"
  }
}
```

> **新增扩展点**（用于支撑这个插件，server-sync 用不到，但要在框架里预留）：
> - `scheduler` — 声明式定时器，框架统一管理（避免每个插件自己起 setTimeout）
> - `pluginsTabCard` — 在 Settings → Plugins Tab 显示一张可启用/停用的卡片（即截图里的样式）
> - `ownsFiles` — 插件拥有 dataDir 下哪些文件（用于卸载时备份）
> - `readsCoreTables` — 声明只读访问哪些核心表（DBAccessor 据此放权）

### 8.5.4 改造对照

| 原代码位置 | 改造后位置 | 备注 |
|---|---|---|
| `src/services/shadowfolk/ShadowFolkUploader.ts` | `src/plugins/shadowfolk-upload/ShadowFolkUploader.ts` | 仅改 import |
| `src/services/shadowfolk/PushHistoryStore.ts` | `src/plugins/shadowfolk-upload/PushHistoryStore.ts` | 文件路径继续走 `ctx.dataDir`，由 `ownsFiles` 声明 |
| `src/services/shadowfolk/schedule.ts` | `src/plugins/shadowfolk-upload/schedule.ts` | 直接搬 |
| `WorkerService` 中 7 个 `handleShadowFolk*` | 插件 `handlers/*.ts` | 由 PluginHost 路由 |
| `WorkerService.startShadowFolkTimer / scheduleNextShadowFolkRun` | 改为框架 `Scheduler` 服务，按 manifest `scheduler` 字段调度 | 多个插件共用同一个 Scheduler |
| `WorkerService.shadowfolkOverride / shadowfolkStatus` 状态 | 移到插件实例内部状态 + `ctx.runtimeState` | 不污染主服务 |
| `AppConfig.shadowfolk.{enabled,dailyTime,workspaces,workspaceAliases}` | `plugins.shadowfolk-upload.{enabled,dailyTime,workspaces,workspaceAliases}` | 旧 key 兼容 3 版本 |
| `~/.shadow/config.json`（auth） | **保持不变** | 这是与 Python CLI 共享的"用户态机器配置"，跨插件载体 |
| `CODEBUDDY_MEM_SHADOWFOLK_*` env（4 个） | manifest `envVars` 声明，由框架注入子进程 | 兼容 1 版本，下版本删 |
| `settings.html` 中 ShadowFolk 区块 | 删除，改为插件 `ui.html` 经 `settingsSection` 渲染 | UI 插件化 |
| `settings.html` 中 Plugins Tab 那张卡片 | 改为读 `pluginsTabCard` 字段动态渲染（截图里的"ShadowFolk Upload Plugin"卡） | 任何后续插件都能复用 |

### 8.5.5 与 Python CLI 形态的统一

shadowfolk-upload 插件化后必须保留"独立 Python 脚本也能运行"的能力，便于无 Electron 环境（如 CI、Linux 服务器）使用。统一方案：

| 关注点 | TS 插件 | Python CLI | 共享契约 |
|---|---|---|---|
| 上游 API | `/api/push/*` | `/api/push/*` | 同一个 ShadowFolk 后端 contract |
| auth 配置 | 读 `~/.shadow/config.json` | 读 `~/.shadow/config.json` | 同一文件 |
| 工作区清单 | `plugins.shadowfolk-upload.workspaces` | CLI `--upload-config` 文件中的 `workspaces` 数组 | 字段名对齐 |
| 推送游标 | `shadowfolk-push-history.json`（dataDir 下） | ShadowFolk Server 的 `push-records` API（远程） | **TS 版下一阶段也改用远程游标，统一信源** |
| 状态文件 | 不需要（GUI 直接读插件内存） | `statusFile` 路径 | TS 版可选支持，方便外部监控 |
| 日志 | 走 `ctx.logger` | 走 stdout | — |

**未决问题**：TS 插件的 `PushHistoryStore`（本地 JSON）和 Python 版用的远程 push-records 是两个信源。下一步建议**TS 版也切到远程游标**，删除本地 JSON，避免两形态长期分叉。在评审会议上拍板。

### 8.5.6 双载体的 manifest 等价性

为了让 Python CLI 也能被识别成"同一个插件的不同载体"，约定：

- `plugins/shadowfolk-upload-plugin/plugin.json` 拷贝一份到 Python 包同目录
- manifest 字段中加 `runtimes: ["node", "python"]`
- 框架加载时只挂载 `runtimes` 包含 `node` 的那部分扩展点；Python 形态由用户在外部进程独立运行，不进入主程序生命周期

这样两边的 ID、版本号、配置 schema 都来自同一个 manifest，避免漂移。

---

## 9. 工作量分解

| 任务 | 估时 | 依赖 |
|---|---|---|
| **阶段 1：插件框架骨架** | | |
| `src/core/plugins/types.ts` 接口定义 | 0.5d | — |
| `src/core/plugins/PluginHost.ts` Worker 端运行时 | 1d | types |
| `src/core/plugins/EventBus.ts` | 0.5d | types |
| `src/core/plugins/PluginContext.ts`（DB accessor 含表权限隔离） | 1d | types |
| `desktop/src/plugins/UIPluginHost.ts` | 1d | types |
| 单元测试（PluginHost / EventBus / DBAccessor） | 1d | 上述 |
| **阶段 2：WorkerService 改造** | | |
| 抽出事件发射点（observation/summary/session 入库后 `bus.emit`） | 0.5d | EventBus |
| HTTP endpoint 路由表改造（先匹配插件 endpoint，再走内置） | 0.5d | PluginHost |
| `getWorkerEnv()` 改造支持插件 envVars | 0.5d | PluginHost |
| **阶段 3：server-sync 插件** | | |
| 把 `src/services/sync/` 搬到 `src/plugins/server-sync/` | 0.5d | 阶段 1 |
| 编写 plugin.json + config-schema.json | 0.5d | — |
| 实现 init/start/stop/onEvent/handleRequest | 1d | 阶段 1 |
| UI 部分（ui.ts + ui.html） | 1d | UIPluginHost |
| 配置迁移逻辑（旧字段 → 新命名空间） | 0.5d | — |
| **阶段 4：shadowfolk-upload 插件** | | |
| 把 `src/services/shadowfolk/` 搬到 `src/plugins/shadowfolk-upload/` | 0.5d | 阶段 1 |
| 编写 plugin.json（含 scheduler / pluginsTabCard / ownsFiles / readsCoreTables）+ config-schema.json | 0.5d | 框架 |
| 框架补 `Scheduler` 服务（声明式定时器，多插件共用） | 1d | 阶段 1 |
| 框架补 `pluginsTabCard` 渲染机制 | 0.5d | UIPluginHost |
| 7 个 endpoint 拆到 handlers/ + UI 区块迁移 | 1d | 阶段 1-2 |
| 配置迁移（旧 `shadowfolk.*` → `plugins.shadowfolk-upload.*`） | 0.5d | — |
| 与 Python CLI manifest 对齐（`runtimes` 字段、共享 `~/.shadow/config.json`） | 0.5d | — |
| **阶段 5：回归 + 文档** | | |
| 端到端回归（同步链路、Cmem invite、补传、断开） | 1d | — |
| 更新 README / CHANGELOG / 插件开发指南 | 0.5d | — |
| **总计** | **15d** | |

加上不可避免的 buffer，**预计 16-18 个工作日**。原因：shadowfolk-upload 暴露出框架还需要补两个能力（声明式 Scheduler、pluginsTabCard 渲染机制），属于"用例反推框架"必要的投入，但避免了未来每个插件各自重新实现一遍。

---

## 10. 风险与未决问题

### 10.1 风险

| 风险 | 缓解 |
|---|---|
| WorkerService 改造范围大，回归坏现有同步链路 | 每个迁移步骤都保留旧代码做 A/B 对比；通过 `AGENTMEM_USE_LEGACY_SYNC=true` env 切回旧实现 |
| 配置迁移失败导致用户失联 | 自动备份 `desktop-config.backup.<ts>.json`；失败时回滚到旧 key |
| 插件之间事件订阅顺序导致 bug（如先于 SyncQueue 启动就 enqueue） | EventBus 实现"启动屏障"，所有插件 start() 完成前事件挂起 |
| Settings UI 改造可能影响其它窗口 | 先做插件 UI host 双轨，旧 section 不删，灰度切换 |

### 10.2 未决问题

1. **协议注册（cmem://）该不该插件化？**
   - 倾向：是。但操作系统层注册需要主程序代理（Electron 限制），所以 manifest 声明 + main.ts 转发
2. **多插件订阅同一事件的顺序如何保证？**
   - 倾向：按 manifest 中 `order` 字段（默认 100），数值小的先收到
3. **插件能否调用其它插件的服务？**
   - 倾向：通过 `ctx.bus` 发自定义事件，**不允许直接 import 其它插件**
4. **shadowfolk-upload 的本地推送游标（JSON）vs 远程 push-records（API）该统一到哪一边？**（来自 §8.5.5）
   - 倾向：统一到**远程游标**，删除本地 JSON，避免 TS 形态和 Python 形态长期分叉
   - 风险：远程 API 抖动会影响推送幂等性，需要确认 ShadowFolk Server 端的 push-records 写入语义
5. **Scheduler 服务的精度和时区问题**
   - 现实现是北京时间每日定时（`schedule.ts`），插件框架的 Scheduler 是否要支持 cron 语法、跨时区、漂移修正？
   - 倾向：v1 只支持 `daily + 时区`，cron 等高级用法 v2 再加
6. **Python CLI 形态与 TS 插件的版本协同**（来自 §8.5.6）
   - manifest 同步谁来保证？建议在 release 流程加校验：`plugins/shadowfolk-upload-plugin/plugin.json` 与 `src/plugins/shadowfolk-upload/plugin.json` 必须 `id`/`version` 一致

---

## 11. 评审检查清单

提交评审时确认以下问题已答复：

- [ ] 插件 manifest 字段是否完整？是否需要增加 `permissions`、`dependsOn`？
- [ ] `PluginContext` 暴露的服务接口是否够用？是否过宽？
- [ ] 事件 payload 设计是否合理（精简 vs 全量）？
- [ ] 数据库表所有权约束（核心表只读、owned table 可写）是否能在 SQLite 层强制？
- [ ] 配置迁移的兼容性窗口要保留多久（建议至少 3 个版本）？
- [ ] UI 插件化对截图、文档体系的影响范围？
- [ ] **Scheduler 扩展点**的能力边界（仅 daily / 还是引入 cron）— 见 §8.5.3、§10.2.5
- [ ] **pluginsTabCard 渲染机制**：所有插件是否都要在 Plugins Tab 出卡片，还是按 manifest 选择性显示
- [ ] **shadowfolk-upload 推送游标统一方案**：本地 JSON 还是远程 API（影响插件化是否要做数据迁移）— 见 §10.2.4
- [ ] **双载体（TS 插件 + Python CLI）的 manifest 同步机制**是否要在 release 流程加校验 — 见 §10.2.6

---

## 12. 后续展望

如果首批迁移顺利，可以继续把以下能力插件化：

- **OpenClaw Feed** （目前在 `src/integrations/openclaw-plugin/`，迁到 `src/plugins/openclaw-feed/`）
- **MCP Server**（`src/servers/mcp-server.ts` → 插件化的 MCP runtime）
- **Chroma 向量同步**（`src/services/sync/ChromaSync.ts` → 独立插件）
- **导出能力**（`src/services/export/` → 导出插件，可扩展更多格式）

最终目标：**主程序变薄，只做核心记忆引擎（hooks + observation + summary + 注入）；所有外部连接、同步、推送、UI 扩展都是插件**。
