# PRD：无头 npm 部署（Linux / macOS 服务端）

> 日期：2026-04-23
> 提出方：cloudboyguo
> 关联设计：`2026-04-23-headless-npm-deploy-design.md`

---

## 一、背景

OpenClaw 等聊天网关型 Agent 主要运行在 Linux/macOS 服务器上。当前 `agent-memory` 的发布形态是 **Electron 桌面安装包**（NSIS / DMG），强依赖 GUI，不适用于无头服务器。

服务器场景只需要：
- 接收 hooks / MCP / OpenClaw 推过来的记录
- 本地 SQLite 落库
- 异步上传到**已存在**的个人服务端（`E:\github\agent-memory-backend`，npm 名 `agent-mem-server`，仓库 `Be1Human/AgentMem_Backend`）
- **不需要** 系统托盘、QuickPanel、设置窗口

### 个人服务端现状（重要）

服务端**已完整实现且与客户端契约完全匹配**，无需重写：

| 能力 | 端点 | 说明 |
|---|---|---|
| 接收同步 | `POST /api/v1/sync/{sessions\|observations\|summaries}` | 与客户端 `RemoteClient` 完全对齐 |
| 鉴权 | `Authorization: Bearer <token>` | 多用户隔离，token 在管理后台生成 |
| 健康探针 | `GET /health` + `GET /api/v1/whoami` | 客户端 doctor 命令直接复用 |
| 聚合视图 | `/api/v1/aggregate/*`、`/api/v1/viewer/*` | 服务端 web 控制台已实现 |
| 部署 | `bash <(curl install.sh)` 一键 / Docker Compose | 端口 8848，支持 amd64/arm64 |

**结论**：本次只做**客户端**改造，让它能在 Linux/macOS 上以 npm 形式部署并对接现有服务端。

---

## 二、目标

**让运维同学只用一行 `npm i -g agent-memory` 就能在 Linux / macOS 跑起核心记忆服务，并把数据汇总到个人服务端。**

---

## 三、用户故事

### US-1 · OpenClaw 集成方

```bash
ssh deploy@bot-server
npm i -g agent-memory
agent-memory doctor             # 体检：node 版本 / sqlite / 端口
agent-memory init               # 写默认配置
export CODEBUDDY_MEM_REMOTE_URL=https://memory.example.com
export CODEBUDDY_MEM_REMOTE_TOKEN=xxx
agent-memory worker start       # 起 HTTP worker
agent-memory install openclaw   # 写 OpenClaw 配置
```

期望：worker 后台跑、observation 入本地 sqlite、SyncQueue 后台批量上传到 remote。

### US-2 · daemon 化运维

```bash
agent-memory daemon install --systemd
sudo systemctl enable --now agent-memory
journalctl -u agent-memory -f
```

期望：开机自启 + 崩溃自拉起，日志走 journald。

### US-3 · 多机汇总查看

部署在 3 台 Linux 上的 OpenClaw 实例，记录全部上传到同一个 `memory.example.com`，运维在浏览器打开服务端 viewer 看聚合数据。

> 服务端实现 **不在本次范围**，本次只保证客户端 sync 通畅、协议稳定。

---

## 四、范围

### 范围内（IN）

| 项 | 说明 |
|---|---|
| Linux x64 / arm64 npm 全局安装 | Node ≥ 18 |
| macOS x64 / arm64 npm 全局安装 | 同上，与 Electron 版互不影响 |
| 核心 CLI / Worker / MCP / Hooks | 已存在，需补齐跨平台行为 |
| `agent-memory doctor` 体检命令 | 检查 node / sqlite / 端口 / 远端连通 |
| `agent-memory daemon install` | 生成 systemd unit 或 launchd plist |
| Worker 真正可停（pid + signal） | 当前 `stop` 只打印说明 |
| `npm publish` 前打包验证 | 排除 desktop / web / release / 文档大件 |
| OpenClaw Linux 安装路径 | 验证 `~/.openclaw/` 配置写入 |

### 范围外（OUT）

| 项 | 备注 |
|---|---|
| 服务端 receiver / viewer 实现 | **已存在**：`Be1Human/AgentMem_Backend`，本次直接对接，不改 |
| Electron 桌面端 | 保持 Windows/macOS 现状，npm 包不引入 electron |
| Windows npm 部署 | 暂不重点支持，能跑但不写运维脚本 |
| Chroma 向量库 | 仍走"无 uvx 自动降级 SQLite-only" |
| Web Viewer | 桌面端继续 ship；服务端 viewer 由 backend 提供 |

---

## 五、非功能需求

| 类别 | 指标 |
|---|---|
| 安装时长 | `npm i -g` 在干净 Linux 容器 ≤ 60s（含 sqlite 编译/下载 prebuilt） |
| 内存占用 | worker idle 常驻 ≤ 80 MB |
| 上传可靠性 | 离线时入队，恢复后 ≤ 30s 内补传完成 |
| 数据安全 | Token 仅走环境变量或 600 权限文件，不入日志 |
| 平台支持 | linux-x64 / linux-arm64 / darwin-x64 / darwin-arm64 |

---

## 六、成功标准

1. 在干净的 `node:20-bookworm` Docker 容器里：`npm i -g agent-memory` → `agent-memory doctor` 全绿 → `worker start` → `curl /health` 返回 200
2. OpenClaw 插件在 Linux 上完整跑通一次 session（beforeAgentStart → SSE → agentEnd）
3. 配 remote URL 后，本地新增 observation 在 30 秒内出现在远端 sync API 收到的请求里（用 mock server 验证）
4. `kill -TERM <pid>` 后 worker 优雅退出，未完成的 sync 任务保留在 `sync_queue` 表
5. `npm pack` 输出的 tarball 不含 `desktop/`、`web/`、`release/`、原始 png 等大件，体积 ≤ 2 MB

---

## 七、风险

| 风险 | 缓解 |
|---|---|
| better-sqlite3 在 Linux 旧 glibc 编译失败 | doctor 提前检测；文档列出 `apt install build-essential python3` |
| arm64 缺 prebuilt | 列入兼容矩阵，必要时 fallback 编译 |
| 用户漏配 REMOTE_URL，数据只在本地堆积 | doctor 给出警告；`worker start --warn-on-no-remote` |
| OpenClaw `ObservationFeed` 未绑定 channel（探查发现的现存 bug） | 设计阶段顺手修 |
| 服务端协议变更 | 客户端 `RemoteClient` 加 `?api_version=v1` 显式版本 |

---

## 八、待用户确认

- [ ] 是否需要同时支持 **本地无 remote 的纯单机服务端模式**（只录不传）
- [ ] daemon 安装是仅 systemd，还是也覆盖 launchd / OpenRC
- [ ] npm 包名是否沿用 `agent-memory`，还是另发 `@codebuddy/mem-headless` 区分
- [ ] OpenClaw 在服务器上的配置目录约定（`~/.openclaw/` vs `/etc/openclaw/`）
- [ ] 是否在 `agent-memory doctor` 中加一条"自动从 `cmem://` 邀请链接配置 remote"（服务端 admin 控制台已生成这种链接）
