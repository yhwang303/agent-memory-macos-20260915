# desktop-monitor-plugin — 设计

> ShadwMonitor 已快照迁入 `plugins/shadwmonitor/` 作为内置插件，
> 与 `plugins/shadowfolk-upload-plugin/` 同层并列。
> 插件保留自治链路（截屏 / OCR / 蒸馏 / 8080 Web）；
> 与 agent-mem 主体通过 HTTP（POST /api/observation）解耦协作。

## 总体方案

```
agent-memory/  (monorepo)
├── src/                                        ← agent-mem TS 主体（不动核心）
│   └── services/worker/                          /api/observation, observations 表, FTS5, Chroma
├── desktop/src/windows/settings.html          ← Plugins 标签新增 ShadwMonitor 卡
├── desktop/src/tray/                          ← 托盘新增 ShadwMonitor 状态线
├── web/viewer.html                            ← 新增 ShadwMonitor 一级 Tab
└── plugins/
    ├── shadowfolk-upload-plugin/              ← 同层并列的已有插件
    └── shadwmonitor/                          ← 本插件（从 ShadwMonitor 仓库迁入）
        ├── src/
        │   ├── main.py                        ─ capture / web 入口
        │   ├── perception/ ocr/ agent/        ─ 截屏 / OCR / 蒸馏（不动）
        │   ├── storage/                       ─ SQLite 自有存储
        │   ├── web/                           ─ 8080 Web 端（不动）
        │   └── agent_mem_bridge/              ─ 桥接子模块
        │       ├── state.py                     持久化 last_mirrored_id + retry 队列
        │       ├── mapper.py                    MomentSummary → ObservationPayload
        │       ├── poster.py                    轮询 + POST + 退避重试
        │       ├── mcp_server.py                stdio MCP, screen_query_* 工具
        │       └── stats_api.py                 HTTP, 供 viewer 拉聚合数据
        ├── config/settings.yaml               ─ 含 agent_mem: 配置节
        ├── data/                              ─ 运行时（gitignored）
        └── README.md                          ─ 插件接入说明

                ┃                                ┃
                ┃ HTTP POST /api/observation     ┃ HTTP GET /api/shadw/*
                ┃ (Python plugin → TS Worker)    ┃ (browser → Python plugin)
                ┗━━━━━━━━━━━━━━┓     ┏━━━━━━━━━━━━┛
                               ▼     ▲
                        agent-mem Worker 3847
                        agent-mem viewer.html

                        Plugin 自己也跑 stdio MCP
                                  ▲
                          ┌───────┴───────┐
                          │ Claude/Cursor │
                          └───────────────┘
```

## 关键决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 插件形态 | monorepo 内置插件 `plugins/shadwmonitor/`，与 shadowfolk-upload-plugin 同层 | 一次 clone 拿全部能力；版本随 agent-mem 联动 |
| 桥接代码位置 | 插件内部 `src/agent_mem_bridge/` | 跟原 ShadwMonitor 主链路解耦；只在插件目录内可见 |
| Hook 模式 | **零侵入轮询** — bridge 独立 poll `moment_summaries` 表 | 不动 Distiller / Database 原代码；重启可续传 |
| 镜像粒度 | 仅 L1 moment | 5 分钟粒度适合 observation；L2/L3 与 agent-mem summary 概念冲突 |
| 失败恢复 | 本地 SQLite retry_queue + 指数退避 | 跟 shadowfolk-push-history-replay 模式一致 |
| memory_session_id | `desktop-monitor-YYYY-MM-DD` | 按日期天然分桶 |
| project 字段 | 配置项 `scope`，默认 `desktop-monitor` | ShadwMonitor 无 project 概念 |
| MCP 拓扑 | 客户端独立注册两个 MCP | 零中转；ShadwMonitor MCP 可独立使用 |
| MCP 工具命名 | 全部加 `screen_` 前缀 | 避免与 agent-mem `search`/`timeline` 冲突 |
| viewer 数据源 | **混合模式**：search/列表用 agent-mem 已镜像数据；时间线/应用排行/统计用 ShadwMonitor stats_api | 已镜像数据可跨 IDE 召回；聚合数据保持 ShadwMonitor 是 source of truth |
| Settings 配置写入 | 桌面端直接读写 ShadwMonitor 的 `config/settings.yaml` | 用户不用切窗口；保留 ShadwMonitor 配置文件作为 ground truth |
| 视觉标识 | `#ffaa33` 琥珀色，贯穿 viewer Tab / Settings 卡 / 托盘 / search 命中条 | 跟 self-evolve 紫色形成对照，用户一眼分辨 |

## A. 插件本体 · 桥接核心（`plugins/shadwmonitor/src/agent_mem_bridge/`）

### 数据映射（mapper.py）

`MomentSummary` → ObservationPayload：

| agent-mem 字段 | 来源 | 示例 |
|---|---|---|
| `session_id` | `desktop-monitor-` + `time_start[:10]` | `desktop-monitor-2026-05-23` |
| `project` | `config.agent_mem.scope`，默认 `desktop-monitor` | `desktop-monitor` |
| `type` | 固定 | `screen_moment` |
| `title` | 截断 `summary` 前 60 字 | `用户在 VS Code 编辑 main.py` |
| `narrative` | `summary` 完整文本 | `2026-05-23 14:25-14:30 用户在 VS Code...` |
| `meta_intent` | `f"应用: {'; '.join(app_names)}"` | `应用: Code.exe` |
| `concepts` | `app_names` + `['screen-activity']` | `["Code.exe", "screen-activity"]` |
| `files_read` | 由 capture_ids 反查 `screenshot_path` 列表 | `["data/screenshots/2026-05-23/14-25-13.png"]` |
| `created_at` | `time_end` | `2026-05-23T14:30:00` |

### 轮询模式（poster.py）

```
poster 协程主循环（默认 30s 一轮）:
  1. SELECT id FROM agent_mem_bridge.bridge_state WHERE k='last_mirrored_moment_id'
  2. SELECT * FROM moment_summaries WHERE id > last_id ORDER BY id ASC LIMIT 50
  3. for each new moment:
     a. mapper.to_payload(moment) → ObservationPayload
     b. POST /api/observation
        ├─ 2xx → UPDATE last_mirrored_moment_id = moment.id
        └─ 失败 → INSERT INTO retry_queue
  4. 处理 retry_queue 中 next_attempt_at <= now 的条目，指数退避 1/2/4/8…60s 上限
```

### 状态持久化（state.py）

新增 SQLite 表（在插件既有 `data/ai_monitor.db` 里加表）：

```sql
CREATE TABLE IF NOT EXISTS bridge_state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS bridge_retry_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  moment_id INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  UNIQUE(moment_id)
);
CREATE INDEX IF NOT EXISTS idx_retry_next ON bridge_retry_queue(next_attempt_at);
```

### MCP 工具（mcp_server.py）

stdio 模式，复用现有 `QueryEngine`：

| MCP 工具 | 参数 | 包装的 QueryEngine 方法 |
|---|---|---|
| `screen_query_daily` | `date: str` | `get_daily_summary(date)` |
| `screen_query_session` | `date: str` | `get_sessions_for_day(date)` |
| `screen_query_moments` | `time_start: str, time_end: str` | 时间范围查 moments |
| `screen_query_by_time` | `timestamp: str, window_minutes: int = 60` | `query_by_time(timestamp)` |
| `screen_get_capture` | `capture_id: int` | `get_capture_detail(capture_id)`（返回路径 + Zone-Map，不返 base64）|

### stats_api.py（挂到插件既有 8080 Web 服务）

agent-mem viewer 调这几个端点拉取聚合数据：

| 端点 | 返回 |
|---|---|
| `GET /api/shadw/stats/today` | `{l1_count, capture_count, active_hours, mirrored_count, retry_count, last_sync_at}` |
| `GET /api/shadw/timeline/today` | `[{app, time_start, time_end}, ...]` 用于时间线视图 |
| `GET /api/shadw/apps/today` | `[{app, l1_count, duration_seconds}, ...]` 用于应用排行 |
| `GET /api/shadw/moments?date=YYYY-MM-DD&limit=N` | 列出该日的 L1 列表（含 capture 缩略路径） |
| `GET /api/shadw/health` | `{enabled, bridge_alive, worker_reachable, last_post_at, retry_count}` |

### 配置（追加到 `plugins/shadwmonitor/config/settings.yaml`）

```yaml
agent_mem:
  enabled: false                         # 默认关，用户显式打开
  endpoint: "http://127.0.0.1:3847"      # agent-mem Worker
  scope: "desktop-monitor"               # observation.project
  poll_interval_seconds: 30              # 轮询新 moment 的间隔
  batch_size: 50                         # 单次最多镜像几条
  retry_max_attempts: 10
  retry_initial_delay_seconds: 1
  retry_max_delay_seconds: 60
  mirror:
    moment: true
    session: false                       # L2 预留位
    daily: false                         # L3 预留位
```

### 集成到 main.py（插件入口）

`plugins/shadwmonitor/src/main.py` 的 `run_capture()`，在 `asyncio.gather` 调用前根据配置挂入 bridge poster：

```python
bridge_poster = None
if config.agent_mem.enabled:
    from src.agent_mem_bridge import BridgePoster
    bridge_poster = BridgePoster(config.agent_mem, db_path)
    await bridge_poster.init()
    components.append(bridge_poster)

# gather:
coros = [window_monitor.run(db), ..., distiller.schedule()]
if bridge_poster is not None:
    coros.append(bridge_poster.run())
await asyncio.gather(*coros)
```

`run_web()` 末尾增加 `stats_api` 路由注册（FastAPI router）。

> 注：这部分代码已在 Phase 1 实现完成，下次启动 `python plugins/shadwmonitor/src/main.py capture` 时即生效。

## B. agent-mem 侧 · 展示层集成

### viewer 集成（`web/viewer.html`）

参考 `docs/self-evolve/features/self-evolve-plugin/ui-design.html`：

- 顶部 main-tabs 增加 `ShadwMonitor` 一级 Tab（琥珀色调，含 badge 显示今日 L1 数）
- 进入后 plugin-header（琥珀色）：显示进程在线 / 镜像率 / 上次同步
- sub-tabs：Overview / Today · N / All Moments / Captures

**数据来源**：

| sub-tab / 视图 | 数据来源 |
|---|---|
| 全局搜索命中 `type=screen_moment` 的 observation | agent-mem 既有 `/api/search` |
| Today / All Moments 列表 | 优先 agent-mem `/api/search?type=screen_moment&date=...`；若 ShadwMonitor 在线则用 stats_api 的 `/api/shadw/moments` 拿更全字段（Zone-Map 等）|
| Overview 统计卡 / 时间线 / 应用排行 | ShadwMonitor stats_api（仅当 enabled 且在线；否则降级为只展示 agent-mem 端能算出的数字）|
| Captures（截图浏览） | ShadwMonitor stats_api + 截图静态路径 |

### Settings 集成（`desktop/src/windows/settings.html`）

Plugins 标签页加 ShadwMonitor Bridge 配置卡：
- 字段：ShadwMonitor 路径（自动检测 `D:\UGIT\ShadwMonitor` / 用户选目录）/ endpoint / scope / 镜像粒度 pills
- 健康指标：进程在线 / 今日镜像 / 重试队列 / 上次同步（4 格，定期刷新 `/api/shadw/health`）
- 操作按钮：立即同步 / 查看日志 / 回放离线队列 / 打开 ShadwMonitor Web

### 桌面端配置桥（`desktop/src/services/ShadwMonitorConfigBridge.ts`，新增）

```ts
class ShadwMonitorConfigBridge {
  async readConfig(): Promise<ShadwMonitorAgentMemConfig>  // 解析 settings.yaml 的 agent_mem 节
  async writeConfig(cfg: ShadwMonitorAgentMemConfig): Promise<void>  // 写回 yaml，保留其余节
  async ping(): Promise<{alive: boolean, version?: string}>  // GET /api/shadw/health
}
```

注意：写 yaml 时需保留注释和其他节（用 `yaml` lib 的 round-trip 模式或 js-yaml + 自定义序列化）。

### 托盘集成（`desktop/src/tray/TrayManager.ts` + `quick-panel.html`）

Plugins 段加一行 ShadwMonitor Bridge：
- 琥珀点 = 在线 / 红点 = 离线 / 灰点 = 未启用
- 右侧 `N today` 或 `retry N` / `offline`
- 点击跳转 viewer 的 ShadwMonitor Tab

## 接口变更总览

### agent-mem 侧

| 变更 | 影响 |
|---|---|
| `web/viewer.html` 顶部加 main tab + 子页 | 仅前端，不动 Worker API |
| `desktop/src/windows/settings.html` 加 Plugins 卡 | 仅前端 |
| `desktop/src/services/ShadwMonitorConfigBridge.ts` 新文件 | 仅 IPC 层 |
| `desktop/src/tray/TrayManager.ts` 加状态线 | 仅托盘渲染 |
| `/api/observation` / observation schema | **零变更** |

### 插件本体（`plugins/shadwmonitor/`）

| 变更 | 影响 |
|---|---|
| 从原 ShadwMonitor 仓库快照迁入 | 全新增（一次性） |
| `src/agent_mem_bridge/` 新子模块 | 已实现 |
| `src/main.py` 在 enabled 时挂 poster | +13 行（已实现） |
| `src/web/app.py` 注册 stats_api router | +2 行（待 Phase 2） |
| `config/settings.yaml` 追加 `agent_mem:` 节 | 已实现 |
| 原有 capture / OCR / distill / 数据库 / 既有 Web | **零变更** |

## 打包分发 · 已知问题

`desktop/package.json` 的 `win.extraResources` 已把 `plugins/shadwmonitor/` 整目录嵌进
Windows installer 产物（排除 `data/`、`__pycache__/`、`.env` 等运行时产物）；
打包后位于 `<install>/resources/plugins/shadwmonitor/`。
`ShadwMonitorConfigBridge.defaultPluginRoot()` 在 `app.isPackaged` 模式下指向这里。

### Known issue：write-to-resources 在 ProgramFiles 是只读的

- 当用户把桌面端装到 `%PROGRAMFILES%`（NSIS 默认入口）时，`resources/` 是
  受 UAC 保护的，普通进程没有写权限
- `ShadwMonitorConfigBridge.writeAgentMem()` 调 `fs.writeFile` 会失败
- 临时缓解：NSIS 的 `oneClick: false` 允许用户改安装目录到自己的目录（如
  `C:\Users\<name>\AppData\Local\Programs\...`），此时 resources 可写
- **正式方案（下期需求）**：首次启用时把 `resources/plugins/shadwmonitor/`
  镜像到 `~/.agent-memory/plugins/shadwmonitor/`（用户可写副本），所有读写都走
  这个副本；从 resources 拉取只发生在版本更新时

### Mac 端尚未打包

- `mac.extraResources` 目前不含 `plugins/shadwmonitor/` —— ShadwMonitor 当前用
  `pywin32`，Windows-only，装到 mac 也跑不动
- Mac 支持本身是下期需求（PyObjC 替代 + 截屏权限），届时再把它加进
  `mac.extraResources`

## 兼容性与迁移

- 插件已从原 `D:\UGIT\ShadwMonitor` 快照迁入 `plugins/shadwmonitor/`，原仓库保留不动作为 backup
- bridge `enabled=false`（默认）时插件行为与迁入前完全一致；agent-mem 主体也不感知
- bridge 首次 enable 时**不补传历史 L1**（避免把几个月的旧 moment 一次灌爆 agent-mem）；从 `enabled=true` 起算
- bridge 升级时 `bridge_state` 表带 schema_version 字段，自动迁移

## 测试策略

### ShadwMonitor 侧

- 单元：`mapper.to_payload(MomentSummary)` 各字段映射；边界（空 app_names / 极长 summary / 空 capture_ids）
- 单元：`state.RetryQueue` 入队 / 出队 / 退避递增 / 永久失败
- 集成：mock 一个 HTTP server 接 `/api/observation`，验证 poster 能从空表→插 3 条 moment→镜像→更新 last_mirrored_id

### agent-mem 侧

- viewer：手工启动 `npm run worker:start` + 打开 `/viewer.html`，验证 ShadwMonitor Tab 渲染与降级（ShadwMonitor 不在线时仍能显示已镜像数据）
- Settings：手工切到 Plugins 标签，验证读 / 写 ShadwMonitor `settings.yaml` 不丢失其他配置节
- 托盘：观察状态切换（启用 → 禁用 → 离线 → 异常）下托盘点的颜色变化

### 端到端

- ShadwMonitor 启动 → 桥接打开 → 等 10 分钟 → agent-mem search "VS Code" 能召回 → Claude MCP `screen_query_by_time` 能下钻
- agent-mem Worker kill → ShadwMonitor 继续工作 → 5 分钟后重启 Worker → 30 秒内 retry queue 清空
