# desktop-monitor-plugin — PRD

> ShadwMonitor 已快照迁移到 `plugins/shadwmonitor/`，作为 agent-mem 的**内置插件**。
> 本需求覆盖：插件本体（继承自原 ShadwMonitor）+ agent-mem 主仓的展示层集成。

## 背景

ShadwMonitor 是一个独立的桌面屏幕活动感知系统：截屏采集（mss + OpenCV 变化检测）、PaddleOCR + Zone-Map 空间结构化、L1 时刻 / L2 时段 / L3 日 三级 LLM 蒸馏、SQLite 自有存储、Web 查看端（8080）、渐进式披露 QueryEngine。

之前以独立仓库形态存在时，它与 agent-mem **完全脱节**：用户在 agent-mem 全局搜索框搜"昨天看到的 TS2304 报错"召不回屏幕记录；Claude/Cursor 也不能在编码会话中主动取屏幕活动上下文。

**当前形态**：ShadwMonitor 已经快照迁入 `plugins/shadwmonitor/`，与 `plugins/shadowfolk-upload-plugin/` 同层并列，作为 agent-mem 的"插件家族"成员。它保留自治的截屏/OCR/蒸馏链路与 8080 Web 端；通过内部 `agent_mem_bridge/` 子模块跟 agent-mem 主体打通。

## 目标

- agent-mem 的全局搜索能命中 ShadwMonitor 产出的关键记忆（粗粒度提示）
- Claude / Cursor 等 AI 客户端能主动按需下钻 ShadwMonitor 的细节（截图 / Zone-Map / 时段聚合）
- 两个系统**保持独立运行、独立部署、独立演进**，桥接层故障不传染
- ShadwMonitor 原有功能与 UI 不动；agent-mem 几乎零代码改动

## 用户故事 / 使用场景

- 在 Cursor 中问"昨天下午看到的那个 TypeScript 编译错误"→ agent-mem 命中一条 L1 摘要 hint，AI 顺着 MCP 下钻拿到 Zone-Map 和原图路径
- 在 IDE 外执行操作（看文档、聊天、刷设计稿）→ 仍能被 ShadwMonitor 捕获并最终在 agent-mem 搜索时间维度提示
- ShadwMonitor 进程崩溃 → IDE 内的常规记忆链路（Hook → Observation → Summary）**毫无影响**
- agent-mem Worker 停机 → ShadwMonitor 自身仍正常工作，桥接消息本地排队待重发

## 范围

### 包含

#### A. 插件本体（`plugins/shadwmonitor/`，含内部桥接子模块 `src/agent_mem_bridge/`）

- 从原 ShadwMonitor 仓库快照迁入；保留 capture / OCR / 蒸馏 / 自有 8080 Web 端
- 内部桥接子模块 `src/agent_mem_bridge/`：
  - `state.py` — SQLite 持久化"已镜像 moment_id 水位"和"重试队列"，bridge 重启后能续传
  - `mapper.py` — 把 `MomentSummary` dataclass 转为 agent-mem 的 ObservationPayload
  - `poster.py` — **零侵入轮询模式**：定期查 `moment_summaries` 表里 `id > last_mirrored_id` 的新记录，POST 到 agent-mem `/api/observation`；带本地重试队列 + 指数退避
  - `mcp_server.py` — 把现有 `QueryEngine` 包装成 stdio MCP server，暴露 `screen_query_*` 系列工具
  - `stats_api.py` — HTTP 接口（挂到本插件既有的 8080 Web 服务），供 agent-mem viewer 拉取：今日时间线、应用排行、统计数字
- `config/settings.yaml` 含 `agent_mem:` 配置节

#### B. agent-mem 侧（展示层集成，核心逻辑零改动）

- **viewer 集成**（`web/viewer.html`）— 添加一个 ShadwMonitor 一级 Tab（参考 self-evolve 的 Plugin Tab 范式），包含 Overview / Today / All Moments / Captures 4 个 sub-tab；Overview 含统计卡 + 时间线 + 应用排行；颜色用 `--accent-amber: #ffaa33` 区分
- **桌面端 Settings 集成**（`desktop/src/windows/settings.html`）— Plugins 标签页加 ShadwMonitor Bridge 配置卡（开关 + ShadwMonitor 路径 + endpoint + 镜像粒度 pills + 健康指标 + 操作按钮）
- **桌面端托盘集成**（`desktop/src/tray/TrayManager.ts`、`quick-panel.html`）— Plugins 段加 ShadwMonitor 状态线（琥珀色点 + `N today` 计数）
- **桌面端配置桥接**（`desktop/src/services/ShadwMonitorConfigBridge.ts`，新增）— 从 settings UI 读写 ShadwMonitor 的 `config/settings.yaml` 中 `agent_mem:` 节
- **接入文档**（`plugins/desktop-monitor-bridge/README.md`）— 用户视角的安装与配置流程

#### C. 全局约定

- 镜像范围**仅 L1 moment**（5 分钟粒度），不镜像 L2/L3
- `memory_session_id` 使用按日期划分：`desktop-monitor-YYYY-MM-DD`
- `observation.project` 用配置项 `agent_mem.scope`（默认 `desktop-monitor`）
- MCP 连接拓扑：**独立注册**，AI 客户端同时连 agent-mem MCP 与 ShadwMonitor MCP 两个端点
- 视觉：ShadwMonitor 在所有 agent-mem UI 中用 **`#ffaa33` 琥珀色** 作为统一标识色

### 不包含

- 修改 ShadwMonitor 原有的 Web UI / 数据库表 / 蒸馏链路
- 修改 agent-mem 的 `observations` 表结构或 `/api/observation` 接口
- L2/L3 摘要镜像（保持两边语义清晰）
- 默认在 `beforeSubmitPrompt` 注入屏幕记忆（仅供搜索 + MCP 主动查询，避免 Prompt 被无关桌面活动稀释）
- 跨设备 ShadwMonitor 实例的聚合
- 桌面端 Settings UI 集成（属于后续阶段需求，不在本期范围）

## 验收标准

### 桥接核心（A 类）

- [ ] ShadwMonitor 在配置开启 `agent_mem.enabled=true` 后，每产生一条 L1 moment 就会在 agent-mem 的 `observations` 表里出现一条 `type="screen_moment"` 的记录
- [ ] agent-mem 的 `/api/search?q=<关键词>` 能在结果列表中召回上述 L1 摘要（FTS5 命中），结果含截图本地路径
- [ ] Worker 离线 ≥ 5 分钟期间 ShadwMonitor 持续工作，恢复后 30 秒内补齐离线期间未发送的 L1
- [ ] ShadwMonitor 桥接关闭时，agent-mem 一切如常；ShadwMonitor 本身也一切如常
- [ ] Claude Desktop / Cursor 同时配置两个 MCP 后能调用 `screen_query_*` 工具

### viewer 集成（B 类）

- [ ] `viewer.html` 顶部出现独立的 ShadwMonitor Tab（琥珀色高亮，含今日 moment 数 badge）
- [ ] ShadwMonitor Tab 内 Overview 子页正确显示：4 格统计卡（今日 L1 / 今日截图 / 活跃时长 / 镜像率）、今日时间线、应用使用排行
- [ ] Today 子页按时间倒序列出当日所有 L1 moment 卡片，每张可展开看 Zone-Map 和截图缩略图
- [ ] 全局搜索结果中 screen_moment 类型条目有"→ 跳转 ShadwMonitor Tab"链接

### 桌面端集成（B 类）

- [ ] Settings → Plugins 标签页能看到 ShadwMonitor Bridge 配置卡，可配置路径 / endpoint / scope / 镜像粒度
- [ ] 配置卡显示 4 项健康指标（进程在线 / 今日已镜像 / 重试队列 / 上次同步），实时更新
- [ ] "立即同步一次" 按钮触发 bridge 重新检查并 POST 未镜像的 L1
- [ ] 托盘快速面板 Plugins 段出现 "ShadwMonitor Bridge"，琥珀色点 + `N today` 计数

### 文档（B 类）

- [ ] `plugins/desktop-monitor-bridge/README.md` 写清楚 5 分钟内可上手的配置流程

## 风险与未决事项

- **重复声音**：L1 摘要镜像到 agent-mem 后，用户在 IDE 中获得 agent-mem 召回 + 又通过 MCP 拿到 ShadwMonitor 详情，可能出现轻度信息冗余 → 由 design 通过摘要长度上限和"仅返回 narrative + 截图路径"控制
- **隐私边界**：ShadwMonitor 已有 `excluded_processes`，桥接层是否要二次过滤（如只镜像编码相关应用？）— 倾向于尊重 ShadwMonitor 既有过滤，桥接不二次过滤
- **MCP 工具命名冲突**：agent-mem MCP 已有 `search` 等工具；ShadwMonitor MCP 命名是否需要前缀（如 `screen_*`）避免 Claude 混淆 → 倾向加 `screen_` 前缀
- **FTS5 中文召回质量**：L1 摘要全是中文，FTS5 中文分词可能召回不佳；是否要同步 Chroma 向量化（M2 RAG 能力）— 暂依赖 Worker 现有 Chroma 自动同步流程，不在本期定制
- **scope/project 字段**：ShadwMonitor 没有"项目"概念，镜像时该 project 字段填什么？候选：固定 `desktop-monitor` / ShadwMonitor 侧前台应用主路径推断 / 配置项指定
