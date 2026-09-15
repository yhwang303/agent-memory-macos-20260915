# 设计文档：无头 npm 部署

> 日期：2026-04-23
> 关联 PRD：`2026-04-23-headless-npm-deploy-prd.md`

---

## 一、架构定位

```
┌─────────────────────────────────────────┐
│  Linux / macOS 服务器                    │
│  npm i -g agent-memory                  │
│  ┌────────────────────────────────────┐ │
│  │ agent-memory CLI                   │ │
│  │  ├── worker  (HTTP :3847)          │ │
│  │  ├── mcp     (stdio)               │ │
│  │  ├── doctor / init / install       │ │
│  │  └── daemon install (systemd/...)  │ │
│  └────────────┬───────────────────────┘ │
│               │                         │
│  ┌────────────▼───────────────────────┐ │
│  │ ~/.agent-memory/                  │ │
│  │   ├── agent-memory.db (SQLite)    │ │
│  │   ├── device.json                  │ │
│  │   ├── settings.json                │ │
│  │   └── worker.pid                   │ │
│  └────────────┬───────────────────────┘ │
│               │ SyncQueue (HTTP)        │
└───────────────┼─────────────────────────┘
                │ Bearer token
                ▼
   ┌──────────────────────────────────────┐
   │ AgentMem Backend (已存在 / 复用)       │
   │   Be1Human/AgentMem_Backend           │
   │   :8848                                │
   │   POST /api/v1/sync/sessions          │
   │   POST /api/v1/sync/observations      │
   │   POST /api/v1/sync/summaries         │
   │   GET  /health  /api/v1/whoami        │
   │   GET  /api/v1/aggregate/* viewer/*    │
   │   一键安装 install.sh / Docker Compose │
   └──────────────────────────────────────┘
```

**核心原则**：本次只动客户端；服务端**复用现有 backend**（接口契约已 100% 对齐），npm 包零 Electron 依赖。

---

## 二、包拆分策略

| 包 | 角色 | 平台 | 改造 |
|---|---|---|---|
| `agent-memory`（根） | npm 发布的无头核心 | linux / macOS / windows | **本次重点** |
| `desktop/` | Electron 桌面端 | windows / macOS | 不改，继续走 electron-builder |

根 `package.json`：
- `files: ["dist"]` 已正确，确认不会带 desktop / web / release
- 增加 `.npmignore` 双保险，明确排除：`desktop/`、`web/`、`release/`、`release5/`、`source-data/`、`build-resources/`、`docs/`、`tests/`、`*.log`、`*.exe`
- 增加 `prepublishOnly` 脚本：`npm run build && npm run check:bun && npm test`

---

## 三、CLI 命令补齐

新增 / 改造的子命令（基于现有 `src/cli.ts` 扩展）：

| 命令 | 行为 | 实现位置 |
|---|---|---|
| `agent-memory doctor` | 检查 node 版本、sqlite 加载、端口占用、远端连通、device.json | `src/cli/doctor.ts`（新） |
| `agent-memory init` | 创建 `~/.agent-memory/` + 写默认 `settings.json` + 生成 `device.json` | `src/cli/init.ts`（新） |
| `agent-memory worker start/stop/status` | start: 写 pid → spawn detached；stop: 读 pid → SIGTERM；status: 读 pid + ping `/health` | 改 `src/bin/worker.ts` |
| `agent-memory daemon install --systemd` | 渲染 unit 模板到 `~/.config/systemd/user/agent-memory.service` | `src/cli/daemon.ts`（新） |
| `agent-memory daemon install --launchd` | 渲染 plist 到 `~/Library/LaunchAgents/` | 同上 |
| `agent-memory install openclaw` | 已存在，验证 Linux 路径正确 | `src/cli/install.ts` |
| `agent-memory version` | 已存在 | – |

CLI 解析建议沿用现有手写 argv 切片（不引入 commander，控制依赖体积）。

---

## 四、Worker 进程治理

当前 `src/bin/worker.ts` 的 `stop` 只打印说明 —— 必须改为真停。

```ts
// 新流程
start:
  1. 检查 ~/.agent-memory/worker.pid 是否存在且进程仍活 → 已运行就退出
  2. spawn(node, [worker-server.js], { detached: true, stdio: 'ignore' }).unref()
  3. 写 pid 到 worker.pid
  4. 轮询 /health 至 200 或超时 10s

stop:
  1. 读 worker.pid
  2. process.kill(pid, 'SIGTERM')
  3. 等待最多 10s，确认 pid 消失
  4. 删除 worker.pid

status:
  1. 读 pid → 进程存在？→ ping /health
  2. 输出 { pid, port, uptime, sync_queue_pending }
```

跨平台细节：
- Linux/macOS：直接 `process.kill`
- Windows：fallback 到 `taskkill /PID /F`（已有先例）

---

## 五、SyncQueue 在无头场景的强化

现状已实现入队 / 重试 / 批量。无头服务器下补：

1. **优雅退出钩子**：worker 收 SIGTERM 时，先 `await syncQueue.flushNow({ timeoutMs: 5000 })` 再退出，避免最后一批数据丢失。
2. **离线持久化**：已存在 `sync_queue` 表，确认 `priority` 字段正确生效（master 合并时已加列）。
3. **回压**：远端连续失败 5 次后，背景任务暂停 30s 再试（防火灾告警）。
4. **可观测**：`/api/sync/status` 已有，无头模式下加日志行 `[SYNC] pending=N synced=M failed=K`，每分钟一次。

---

## 六、Linux 兼容性改造

| 风险点 | 处置 |
|---|---|
| `better-sqlite3@12.6.2` 预编译矩阵 | CI 矩阵增加 linux-x64 / linux-arm64 / darwin-arm64，验证 `npm i -g` 不触发本机编译；记录到 doctor |
| `desktop/scripts/ensure-worker-sqlite-binary.js` | 与 npm 包无关，不动 |
| `process.platform === 'win32'` 散点 | 全部检查一遍，确认 else 分支在 Linux 行为正确（adapters/SDKAgent/IDE 检测） |
| 路径分隔符 | 全用 `path.join`，禁止字符串拼 `/`；新增 ESLint 规则可选 |
| Shell 调用 | 移除 `cmd.exe` 路径或包成 `process.platform` 分支 |
| 端口 3847 占用 | doctor 检测 + 文档说明改用 `CODEBUDDY_MEM_WORKER_PORT` |

---

## 七、daemon 模板

### systemd（user 级）

```ini
# ~/.config/systemd/user/agent-memory.service
[Unit]
Description=AgentMemory Worker
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/env node {{installPath}}/dist/bin/worker.js start --foreground
Restart=on-failure
RestartSec=5
Environment=CODEBUDDY_MEM_REMOTE_URL={{remoteUrl}}
Environment=CODEBUDDY_MEM_REMOTE_TOKEN={{remoteToken}}

[Install]
WantedBy=default.target
```

CLI 渲染时 `{{installPath}}` 通过 `require.resolve('agent-memory')` 推断，token 默认留空让用户自填。

`worker start --foreground` 需要新加：不 detach、不写 pid，直接占住前台供 systemd 接管。

### launchd（macOS）

省略，结构对应 `~/Library/LaunchAgents/com.codebuddy.mem.plist`。

---

## 八、OpenClaw 在 Linux 的接入

1. **配置目录**：约定 `${OPENCLAW_HOME:-~/.openclaw}/plugins/agent-memory.json`
2. **插件分发方式**：`agent-memory install openclaw` 把 `dist/integrations/openclaw-plugin/index.js` 软链或拷贝到 OpenClaw 的 `plugins/` 目录
3. **修复探查发现的 bug**：`src/integrations/openclaw-plugin/index.ts` 创建 `ObservationFeed` 后未调用 `setChannel()`；按 `config.observationFeed.channel` 实例化对应 channel（telegram/discord/slack）并绑定
4. **健康检查**：插件 `gatewayStart` 时调 `GET /api/readiness`；非 200 则进入降级（只本地存，不阻塞 OpenClaw）

---

## 九、文件改动清单

### 新增

```
src/cli/doctor.ts
src/cli/init.ts
src/cli/daemon.ts
src/cli/templates/systemd.service.tpl
src/cli/templates/launchd.plist.tpl
.npmignore
docs/DEPLOY-LINUX.md     ← 不主动建，让用户决定是否需要
```

### 修改

```
src/cli.ts                              加子命令分发
src/bin/worker.ts                       真停 + foreground 模式 + pid 管理
src/integrations/openclaw-plugin/index.ts   绑定 ObservationFeed channel
src/services/sync/SyncQueue.ts          flushNow + 回压
package.json                            prepublishOnly + bin 校验 + keywords/repository 完善
```

### 不动

```
desktop/                所有
web/                    所有
src/services/worker/    主体不动，仅 graceful-shutdown 钩子
```

---

## 十、发布到内部 npm 镜像

不走 GitHub Actions，本地执行即可（仓库在内网，公开 CI 暂不可达）。

### 一次性配置 registry

```bash
# 在 ~/.npmrc 里指向内部镜像（示例，实际地址按公司 npm 私服填）
@cloudboyguo:registry=https://mirrors.tencent.com/npm/
//mirrors.tencent.com/npm/:_authToken=${INTERNAL_NPM_TOKEN}

# 或一次性环境变量
export NPM_CONFIG_REGISTRY=https://mirrors.tencent.com/npm/
```

### 发布流程（每次）

```bash
git checkout master && git pull
npm version patch                 # 自动 bump + 打 git tag
npm pack --dry-run                # 检查产物清单（应只含 dist/）
npm publish --registry=https://mirrors.tencent.com/npm/
git push origin master --tags
```

`prepublishOnly` 脚本会自动跑 `tsc + check:bun`，跑不过会拒绝发布。

### 服务器端安装（接收方）

```bash
npm config set registry https://mirrors.tencent.com/npm/   # 一次性
npm i -g agent-memory
agent-memory init
export CODEBUDDY_MEM_REMOTE_URL=http://your-backend:8848
export CODEBUDDY_MEM_REMOTE_TOKEN=xxx
agent-memory doctor
agent-memory worker start
agent-memory install openclaw
```

### 备选：tarball 直装（没 npm 私服时）

```bash
# 本地
npm pack
scp agent-memory-*.tgz user@server:/tmp/

# 服务器
npm i -g /tmp/agent-memory-*.tgz
```

---

## 十一、迁移路径

对现有 v2.0.2 用户零影响：
- 桌面端用户继续装 `AgentMemory-Setup-2.0.x.exe`，行为不变
- 服务器场景新增 `npm i -g agent-memory` 通道
- 同一台机器先装桌面端、再 npm install -g 也能共存（worker 端口冲突由 doctor 检测）

数据库 schema 完全兼容（无新增列，仅强化现有 `sync_queue.priority`）。

---

## 十一·5、与现有 backend 的对接验证清单

服务端来源：`Be1Human/AgentMem_Backend`（本机路径 `E:\github\agent-memory-backend`）

| 客户端 | 服务端 | 状态 |
|---|---|---|
| `RemoteClient.syncBatch('session', items)` → `POST /api/v1/sync/sessions` | `handleSyncSessions(body, res, user)` | ✅ 字段一致 |
| `RemoteClient.syncBatch('observation', items)` → `POST /api/v1/sync/observations` | `handleSyncObservations` | ✅ |
| `RemoteClient.syncBatch('summary', items)` → `POST /api/v1/sync/summaries` | `handleSyncSummaries` | ✅ |
| `RemoteClient.testConnection()` → `GET /health` | `handleRequest /health` | ✅ |
| `RemoteClient.testAuth()` → `GET /api/v1/whoami` | `whoami` 分支 | ✅ |
| `Authorization: Bearer <token>` | `resolveUserByToken(req)` | ✅ |
| body：`{ items: [{ client_uuid, device_id, source_ide, ...payload }] }` | `ON CONFLICT (device_id, client_uuid) DO UPDATE` | ✅ |

**doctor 命令**应直接复用上述探针：先 `/health` 再 `/api/v1/whoami`，给出明确报错（401/403/网络/配置缺失分类）。

**邀请链接**：服务端 admin 控制台支持 `cmem://` 协议邀请链接（含 url + token），可考虑在 `agent-memory init` 加 `--invite cmem://...` 一步导入。

---

## 十二、里程碑（建议）

| 里程碑 | 内容 | 估时 |
|---|---|---|
| **D1** | doctor + init + worker 真停 + .npmignore + prepublishOnly | 0.5 天 |
| **D2** | daemon install (systemd 优先) + Linux CI matrix | 0.5 天 |
| **D3** | OpenClaw channel 绑定修复 + Linux 端到端测试 | 0.5 天 |
| **D4** | 文档 + 首次 npm publish dry-run | 0.5 天 |

总计约 **2 人天**，不含服务端实现。

---

## 十三、待你拍板的设计点

1. **包名策略**：沿用 `agent-memory` 一个包同时支持 GUI 用户（仅装 desktop 时不会触发 npm 路径）和服务器用户？还是新开 `@codebuddy/mem-core`？
2. **daemon 优先级**：systemd-only 先行（覆盖 90% Linux），launchd 二期？
3. **doctor 是否要默认 ping remote**：如果未配，是 warn 还是 silent
4. **OpenClaw 插件分发**：软链 vs 拷贝 vs 让 OpenClaw 自己 require('agent-memory/openclaw')
5. **是否需要 Docker 镜像**：`docker pull codebuddy/mem` 作为 npm 之外的另一条路径
