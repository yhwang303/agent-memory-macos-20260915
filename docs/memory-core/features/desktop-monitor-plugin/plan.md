# desktop-monitor-plugin — 实施计划

> 拆 4 个 Phase 推进；每个 Phase 完成都可以独立验证。
> ShadwMonitor 已快照迁入 `plugins/shadwmonitor/`，全部实施都在 `D:\UGIT\agent-memory` 单一仓库内进行。

## Phase 0 · 插件迁入（✓ 已完成）

把 ShadwMonitor 整个项目从 `D:\UGIT\ShadwMonitor` 快照拷贝到 `plugins/shadwmonitor/`，排除 `.git/` / `__pycache__/` / `ai_monitor_release.zip` 等。`.gitattributes` 移除（由 agent-mem 主目录统管 LFS），其余文件原样保留。

## Phase 1 · 桥接核心（✓ 已完成）

**目标**：bridge 能把今天产生的 L1 moment 自动 POST 到 agent-mem 的 `/api/observation`。

### 文件清单

| 文件 | 状态 | 说明 |
|---|---|---|
| `plugins/shadwmonitor/src/agent_mem_bridge/__init__.py` | 新增 | 包入口（懒加载） |
| `plugins/shadwmonitor/src/agent_mem_bridge/state.py` | 新增 | bridge_state + bridge_retry_queue 两张表 |
| `plugins/shadwmonitor/src/agent_mem_bridge/mapper.py` | 新增 | MomentSummary → ObservationPayload |
| `plugins/shadwmonitor/src/agent_mem_bridge/poster.py` | 新增 | 轮询 + POST + 重试主协程 |
| `plugins/shadwmonitor/config/settings.yaml` | 改 | 追加 `agent_mem:` 节 |
| `plugins/shadwmonitor/src/config.py` | 改 | 解析 `agent_mem` 子结构 |
| `plugins/shadwmonitor/src/main.py` | 改 | 在 `run_capture()` 末尾按 enabled 挂 poster |
| `plugins/shadwmonitor/requirements.txt` | 改 | 显式加 `httpx>=0.27.0` |

### 验收

- 启动 `python plugins/shadwmonitor/src/main.py capture` + 等待出现一条 L1 → 5 分钟内 agent-mem `/api/observations` 能查到对应 `type=screen_moment` 记录
- kill agent-mem Worker，连续产生 3 条 L1 → 重启 Worker → 30 秒内 3 条都进库
- 关闭 `agent_mem.enabled` → 插件行为与迁入前完全一致

## Phase 2 · MCP server + stats_api

**目标**：Claude/Cursor 能主动查屏幕记忆；agent-mem viewer 能拉到 ShadwMonitor 的聚合数据。

### 文件清单

| 文件 | 状态 | 说明 |
|---|---|---|
| `plugins/shadwmonitor/src\agent_mem_bridge\mcp_server.py` | 新增 | stdio MCP，暴露 5 个 `screen_*` 工具 |
| `plugins/shadwmonitor/src\agent_mem_bridge\stats_api.py` | 新增 | FastAPI router，挂到 Web 服务 |
| `plugins/shadwmonitor/src\web\app.py` | 改 | 注册 stats_api router |
| `plugins/shadwmonitor/examples\claude-desktop-mcp.json` | 新增 | MCP 客户端配置示例 |

### 验收

- Claude Desktop 配置 ShadwMonitor MCP → 提问 "我今天下午在干啥" → 模型调用 `screen_query_daily`/`screen_query_by_time` 拿到结果
- `curl http://localhost:8080/api/shadw/stats/today` 返回 JSON，字段齐全

## Phase 3 · agent-mem viewer 集成

**目标**：viewer.html 出现 ShadwMonitor 独立 Tab，渲染 mockup Stage 2 的全部内容。

### 文件清单

| 文件 | 状态 | 说明 |
|---|---|---|
| `web\viewer.html` | 改 | 加 ShadwMonitor main tab + sub-tabs + 数据拉取逻辑 |
| `web\shadw-tab.js` | 新增 | ShadwMonitor Tab 的渲染逻辑（也可内联到 viewer.html）|

### 数据获取策略

- Overview 统计卡 + 时间线 + 应用排行：从 ShadwMonitor stats_api（`http://localhost:8080/api/shadw/*`）拉，跨域处理：要么 ShadwMonitor stats_api 允许 CORS，要么 agent-mem Worker 加一个代理端点 `/api/proxy/shadw/*` 中转
- Today / All Moments 列表：优先 agent-mem `/api/search?type=screen_moment`；如果 ShadwMonitor 在线再调 stats_api 拿 Zone-Map 等富字段
- ShadwMonitor 离线降级：只展示 agent-mem 已镜像的数据，Overview 顶部出现"ShadwMonitor 当前离线，部分数据不可见"提示条

### 验收

- 跟 mockup Stage 2 视觉一致（颜色、布局、4 格统计卡、时间线、应用排行、moment 卡片）
- ShadwMonitor 不在线时降级正确，无空白页或报错

## Phase 4 · 桌面端 Settings + 托盘集成

**目标**：用户在 agent-mem 桌面端就能开关 ShadwMonitor 桥接、看健康状态。

### 文件清单

| 文件 | 状态 | 说明 |
|---|---|---|
| `desktop\src\windows\settings.html` | 改 | Plugins 标签加 ShadwMonitor Bridge 卡 |
| `desktop\src\services\ShadwMonitorConfigBridge.ts` | 新增 | 读写 ShadwMonitor settings.yaml 的 agent_mem 节 |
| `desktop\src\preload-settings.ts` | 改 | 暴露 ShadwMonitor 配置桥的 IPC |
| `desktop\src\windows\quick-panel.html` | 改 | Plugins 段加 ShadwMonitor 状态线 |
| `desktop\src\tray\TrayManager.ts` | 改 | 推送 ShadwMonitor 健康状态到面板 |

### 验收

- Plugins 卡能自动检测 ShadwMonitor 路径 / 显式选目录
- 改 endpoint / scope / 镜像粒度后保存到 ShadwMonitor 的 settings.yaml，原有 perception/ocr/agent 等节不丢
- 健康指标 4 格按实时数据更新，"立即同步" 按钮触发 bridge 立即扫一轮
- 托盘琥珀点 + `N today` 计数随状态变化

## Phase 5 · 接入文档 + 端到端验证

### 文件清单

| 文件 | 状态 | 说明 |
|---|---|---|
| `plugins\desktop-monitor-bridge\README.md` | 新增 | 用户视角接入指南 |
| `plugins/shadwmonitor/docs\agent-mem-bridge.md` | 新增（建议） | 桥接架构说明 |

### 端到端验证

按 prd.md 验收标准的全部 12 条挨个跑一遍。

## 推进策略

- **Phase 1 完成后停下来**，把 mockup 跟实际数据对一遍，再做 Phase 2-4
- Phase 3 和 Phase 4 视觉相关性高，可以连续做
- 不在本期处理：截屏频率优化 / 跨设备 / 隐私二次过滤（PRD §风险中已记，作为下一期需求）
