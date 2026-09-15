# 设计：ShadowFolk 上传插件

> 日期：2026-05-07
> 关联需求：将本地 agent-memory 记忆以第三方插件形式自动上传到 ShadowFolk，保留纯脚本上传逻辑，不改动 agent-memory 现有自动同步链路。

## 目标

新增一个独立的 `shadowfolk-upload-plugin`，负责消费本地 agent-memory 记忆并上传到 ShadowFolk 服务端。插件不参与本地采集，不写入 agent-memory 数据库，不改造现有 `SyncQueue` / `RemoteClient` / `getSyncConfig`。

该插件的职责是把已有的 `shadow-push.py` 产品化、常驻化：

- 继续使用纯脚本逻辑，不在客户端引入 LLM。
- 读取本地 `agent-memory.db` 中的 `observations` 和 `session_summaries`。
- 按 workspace / git root / 服务端 push-record 游标导出增量。
- 上传到 ShadowFolk `/api/push/raw`。
- 支持 Linux 无 UI 运行，也支持 Windows 上带 UI 管理。

## 非目标

- 不把 ShadowFolk 上传逻辑合入 agent-memory 本体的远端同步。
- 不新增或修改 agent-memory SQLite schema。
- 不复用 agent-memory 的 `sync_queue` 作为 ShadowFolk 上传队列。
- 不让 OpenClaw 插件或 OpenClawInstaller 承担上传职责；OpenClaw 插件仍属于本地采集适配器。
- 不在本地生成 ShadowFolk 中文任务摘要；摘要仍由 ShadowFolk 服务端异步处理。

## 架构

插件分为管理层和上传后端：

```text
Windows UI / 管理层
  - 配置 server、token、workspace、interval
  - 启停自动上传
  - 手动触发上传
  - 展示最近状态、错误、日志
        |
        v
Uploader Backend（Python）
  - 复用并重构 shadow-push.py
  - 读取 ShadowFolk 配置
  - 定位 git root、branch、remote
  - 查询服务端 push-record
  - 只读导出 agent-memory.db 增量
  - POST /api/push/raw
  - 更新服务端 push-record
```

Linux 运行形态以 CLI / daemon 为主：

```text
shadowfolk-upload --workspace /repo --once
shadowfolk-upload daemon --config ~/.shadow/upload.json
systemd -> shadowfolk-upload daemon
```

Windows 运行形态以 UI 管理为主，但上传核心仍调用同一个 Python 后端：

```text
Windows UI
  -> 读写配置
  -> 启动 / 停止后端进程
  -> 调用 once 上传
  -> 读取状态文件和日志
```

## 后端设计

后端以现有 `shadow-push.py` 为基础拆分模块：

- `config`：读取全局配置和 workspace 级配置。
- `git_context`：获取 git root、branch、remote、commit 增量、diff 统计，并排除嵌套仓库。
- `memory_export`：只读连接 `agent-memory.db`，按 `project LIKE git_root%` 和 `last_observation_id` / `last_summary_id` 导出增量。
- `shadow_client`：封装 `GET /api/push/push-records/{project_path}`、`POST /api/push/raw`、`PUT /api/push/push-records/{project_path}`。
- `runner`：提供 `once` 和 `daemon` 两种运行模式。

`once` 模式执行一次上传后退出；`daemon` 模式按配置间隔循环执行。每次循环只负责发现和上传增量，没有增量时安静跳过。

## 配置

保留现有 ShadowFolk 配置习惯，并新增上传插件配置。

全局认证配置：

```json
{
  "server": "https://shadowfolk.example.com",
  "api_token": "sf_example_token",
  "memory_db": "C:/Users/name/.agent-memory/agent-memory.db"
}
```

上传插件配置：

```json
{
  "enabled": true,
  "intervalSeconds": 60,
  "workspaces": [
    "E:/Github/agent-memory"
  ],
  "retry": {
    "maxAttempts": 5,
    "baseDelaySeconds": 30,
    "maxDelaySeconds": 1800
  }
}
```

workspace 级 `.shadow/config.json` 可以覆盖 `project_id`、`server` 或其它 ShadowFolk 项目绑定信息。

## 数据流

一次上传的数据流：

```text
读取配置
  -> 定位 workspace 的 git root
  -> GET push-record
  -> 根据 last_commit_hash 收集 commits / stats
  -> 根据 last_observation_id / last_summary_id 读取本地记忆
  -> 无增量则退出
  -> POST /api/push/raw
  -> 成功后 PUT push-record
  -> 写本地状态和日志
```

ShadowFolk 服务端继续作为游标真源。插件本地只保存运行状态、最近错误、最近成功时间，不替代服务端 push-record。

## 错误处理

- 读取配置失败：退出并提示缺少字段。
- 找不到 git root：该 workspace 标记失败，不影响其它 workspace。
- 找不到 memory DB：退出或在 UI 中显示配置错误。
- 服务端 401 / 403：停止自动重试，提示 token 或权限问题。
- 网络错误或 5xx：按指数退避重试。
- 上传成功但更新 push-record 失败：记录警告，下次可能重复上传同一批数据，依赖服务端幂等处理。

幂等键优先由 ShadowFolk 服务端基于项目路径、原始 observation / summary id、created_at 或 batch_id 处理。客户端不修改 agent-memory 源表，也不写 `synced_at`。

## 与 agent-memory 的边界

插件只依赖 agent-memory 的既有产物：

- `agent-memory.db`
- `observations`
- `session_summaries`
- `project` 路径字段

插件不依赖：

- `SyncQueue`
- `RemoteClient`
- `CODEBUDDY_MEM_REMOTE_*`
- OpenClaw 插件安装器
- agent-memory Desktop 的 server sync 设置

未来如果 agent-memory 提供稳定只读导出 API，插件可以把 `memory_export` 从 SQLite 读取切换为 Worker API 读取，但这不是 MVP 前提。

## UI 范围

Windows UI 是管理壳，不承载上传业务逻辑：

- 配置服务器、token、workspace、interval。
- 展示每个 workspace 的最近上传时间、最近错误、增量数量。
- 提供“立即上传”“启用自动上传”“停用自动上传”。
- 展示后端日志路径和基础诊断信息。

UI 通过子进程、本地状态文件或本地轻量 HTTP 与 Python 后端通信。MVP 可先使用子进程 + 状态文件，避免过早引入长期运行的本地 API。

## 测试

- 单元测试：配置合并、git commit 范围、嵌套仓库排除、SQLite 增量查询、payload 构造。
- 集成测试：使用临时 SQLite 和 fake ShadowFolk HTTP server 验证 push-record、上传、更新游标。
- 跨平台冒烟：Windows 路径大小写、中文路径、PowerShell 编码；Linux systemd 启动和日志输出。
- 回归测试：无新增数据时不上传；403 不重试；5xx 会退避重试。

## 风险

- 直接读 SQLite 会耦合 agent-memory 表结构；通过模块隔离读取层，未来可替换为 Worker API。
- 服务端 push-record 更新失败会导致重复上传；需要服务端保持幂等。
- Windows UI 打包 Python runtime 会增加分发复杂度；MVP 可先要求用户已有 Python，产品化阶段再做内置 runtime。
- 多 workspace 同时运行时要避免同一个 workspace 被多个插件实例重复上传。
