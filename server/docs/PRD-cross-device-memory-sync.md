# PRD：跨设备记忆同步与汇总

> 版本: 1.0.0
> 最后更新: 2026-04-19
> 状态: 草案

---

## 一、背景与动机

### 1.1 现状

AgentMemory 目前已支持 4 个 AI 编程助手平台（Cursor / CodeBuddy 插件版 / CodeBuddy IDE / Claude Code）的 Hooks 记忆功能。通过适配器模式，各 IDE 的操作行为被统一采集为结构化的 Observation，并生成会话 Summary，存储在本地 SQLite 中。

### 1.2 痛点

1. **数据孤岛**：每台设备的记忆独立存储在各自的 `~/.agent-memory/agent-memory.db`，跨设备无法共享
2. **全景缺失**：用户可能在 Mac 上用 Cursor、在 Windows 上用 CodeBuddy IDE、在远程服务器上用 Claude Code，无法获得"今天我做了什么"的全局视图
3. **跨平台困难**：macOS / Windows / Linux 三端数据格式相同但物理隔离
4. **无法导出**：记忆数据锁在 SQLite 里，无法以可读格式（如 Markdown）导出归档或分享

### 1.3 需求来源

来自内部讨论（见 `server/docs/需求列表.md`）：

- "能否做一个公共工具，让我的每台机器，每个 IDE 都能 hook 到并存储在云上"
- "隐私可以按账号分 db"
- "甚至可以考虑支持每个人配置自己的云数据库"
- "原始数据才是最珍贵的"

---

## 二、目标用户与角色

| 角色 | 描述 |
|:---|:---|
| 开发者（个人） | 在多台设备、多个 IDE 上日常编码，希望回顾当天/本周的工作轨迹 |
| 团队 Leader（未来） | 希望了解团队成员的工作情况概览（Phase 3+，需多用户支持） |

---

## 三、用户场景

### 场景 1：跨设备工作记忆汇总

> 小明早上在公司 Mac 上用 Cursor 做了一个功能模块，下午回家后在 Windows 上用 Claude Code 继续。晚上他想看"今天我做了什么"——打开 agent-mem-server 的 Web 页面，看到一整天的时间线，包含两台设备、两个 IDE 的所有会话和操作。

### 场景 2：Markdown 日报导出

> 周五下午，小明要写周报。他打开 agent-mem-server 的导出页面，选择本周日期范围，按日期分组导出 Markdown。每天一个章节，每个章节下按时间线列出所有会话总结和关键操作。直接粘贴到文档里就是周报。

### 场景 3：按 IDE 平台查看工作分布

> 小明想知道自己这周在 Cursor vs Claude Code 上花了多少时间。他选择按 IDE 分组导出，得到按平台分类的工作记忆。

### 场景 4：离线工作 + 后续同步

> 小明在飞机上用笔记本编码，没有网络。所有 Hook 数据照常写入本地 SQLite。落地后连上 Wi-Fi，同步队列自动把积压的数据上行到服务端。

### 场景 5：个人自部署

> 小明不想把编码数据放在公共服务上。他在自己的 NAS / VPS 上 `docker run` 一行命令启动 agent-mem-server，配一个 Token，各设备指向这个地址就行。

---

## 四、功能性需求

### FR-1：客户端同步队列

- FR-1.1：Worker Service 写入本地 SQLite 成功后，将实体（Session / Observation / Summary）入队到同步队列
- FR-1.2：同步队列基于本地 SQLite 表，支持断网积压、指数退避重试、批量发送
- FR-1.3：每条同步记录携带 `client_uuid`（幂等 key），服务端用 `(device_id, client_uuid)` 去重
- FR-1.4：同步成功后更新本地记录的 `synced_at` 字段
- FR-1.5：未配置远端 URL 时，同步模块完全空转，不影响现有功能

### FR-2：设备与 IDE 标记

- FR-2.1：每台设备首次启动时自动生成 `device_id`（UUID），持久化到 `~/.agent-memory/device.json`
- FR-2.2：支持配置 `device_name`（如 "mac-work"、"win-home"）
- FR-2.3：每条 Observation / Summary / Session 记录携带 `device_id` 和 `source_ide`（cursor / codebuddy / codebuddy-ide / claude-code）

### FR-3：服务端同步接收

- FR-3.1：提供 `POST /api/v1/sync/sessions`、`/observations`、`/summaries` 接口
- FR-3.2：使用 `(device_id, client_uuid)` 做幂等，重复上行不产生重复数据
- FR-3.3：所有写接口需要 `Authorization: Bearer ${SHARED_TOKEN}` 鉴权

### FR-4：服务端聚合查询

- FR-4.1：按日期查询当日所有设备的时间线 `GET /api/v1/aggregate/daily?date=YYYY-MM-DD`
- FR-4.2：按时间范围、设备、IDE、项目多维筛选 `GET /api/v1/aggregate/timeline`
- FR-4.3：查看已注册设备列表 `GET /api/v1/viewer/devices`

### FR-5：Markdown 导出

- FR-5.1：服务端提供 `GET /api/v1/export/markdown` 接口
- FR-5.2：支持 `group_by` 参数：`date`（按日期）、`ide`（按 IDE 平台）、`project`（按项目）
- FR-5.3：支持 `format` 参数：`single`（单个 .md 文件）、`zip`（按分组生成多个 .md 打包）
- FR-5.4：支持 `from`、`to`、`ide`、`project` 筛选参数
- FR-5.5：客户端 Worker 也提供本地版导出接口 `GET /api/export/markdown`，用于未配置服务端的场景

### FR-6：Web 时间线

- FR-6.1：服务端提供极简 HTML 页面 `GET /web/`，展示时间线
- FR-6.2：页面内嵌导出按钮，可选择日期范围和分组方式下载 Markdown

### FR-7：Desktop 设置

- FR-7.1：Desktop 应用 Settings 页增加"远端服务器"分页
- FR-7.2：支持配置远端 URL、Token、设备名
- FR-7.3：提供连接测试和同步队列状态展示

---

## 五、非功能性需求

### NFR-1：隐私安全

- 所有 LLM 处理在客户端完成，服务端只接收成品 Observation / Summary，不接触原始 Hook 数据
- 支持 `CODEBUDDY_MEM_SYNC_REDACT_RAW` 开关，控制是否上行 Observation 中的原始 Shell 输出和文件 diff
- 单用户自部署模式，数据不经过任何第三方
- HTTPS 传输（用户自行配置反向代理 TLS）

### NFR-2：离线可用

- 客户端本地 SQLite 保留，所有核心功能（Hook 采集、MCP 查询、上下文注入）不依赖网络
- 同步队列在断网时无限积压，联网后自动重试

### NFR-3：性能

- 同步入队操作 < 1ms，不阻塞 Hook 处理
- 批量同步每次最多 100 条，避免单次请求过大
- 服务端单机支撑 10 台设备并发同步

### NFR-4：兼容性

- 客户端新增的表列通过 `EXPECTED_COLUMNS` 自动迁移，不需要手动 migration
- 未配置远端的客户端行为与改造前完全一致
- 服务端数据库 schema 与客户端对齐，便于理解和调试

### NFR-5：部署简单

- 服务端 Docker 一行命令启动
- 客户端只需配置 2 个环境变量（URL + Token）

---

## 六、MVP 范围（Phase 1）

### 包含

- 客户端同步队列（SyncQueue + RemoteClient）
- 设备/IDE 标记（identity.ts + 表增量列）
- 服务端同步接收 API（3 个 sync 接口 + 幂等）
- 服务端聚合查询 API（daily + timeline + devices）
- 服务端 Markdown 导出（按日期/IDE/项目分组）
- 客户端本地 Markdown 导出
- Docker 部署
- 极简 Web 时间线

### 不包含（后续阶段）

- 多用户 / OAuth / 注册登录
- PostgreSQL 后端
- 跨设备 MCP 查询
- 项目路径归一映射
- AI 二次汇总（每日/每周自动总结）
- Desktop 设置页（FR-7，可在 Phase 1.5 补充）

---

## 七、成功指标

| 指标 | 目标 |
|:---|:---|
| 同步延迟 | 本地写入 → 服务端可查 < 30 秒（网络正常时） |
| 离线恢复 | 断网 24 小时积压数据，联网后 5 分钟内全部同步完成 |
| 导出完整度 | 导出的 Markdown 包含所有会话总结和观察记录 |
| 部署耗时 | 从零到服务端可用 < 5 分钟（docker run） |
| 客户端零感知 | 未配置远端时，所有现有功能不受任何影响 |
