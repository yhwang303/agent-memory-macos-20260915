# Electron 托盘守护者 — 设计文档

## 概述

为 AgentMemory 构建一个 Electron 桌面托盘应用，解决三个核心用户痛点：

1. **服务状态不可见** — 用户不知道后台 Worker 是否在运行
2. **重启后遗忘** — 电脑重启后忘记手动启动服务
3. **前端体验割裂** — 记忆浏览器在系统浏览器中打开，与工作流断开

目标用户：普通开发者，期望开箱即用。

## 核心决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 技术框架 | Electron | 跨平台成熟，功能完备，社区生态大 |
| 架构模式 | Electron 管理 Worker（独立进程） | Worker 可脱离 Electron 独立运行，架构更健壮 |
| 前端策略 | 托盘快速面板 + Web Viewer 并存 | 快速查询走托盘，深度浏览走 Web |
| 分发方式 | 安装包（.exe / .dmg）+ Git 源码 | 普通用户用安装包，开发者用源码 |

## 项目结构

在现有仓库中新增 `desktop/` 目录，作为独立模块：

```
agent-memory/
├── src/                    # 现有代码（不修改）
├── web/                    # 现有 viewer.html（仅去掉 Sessions 标签）
├── desktop/                # 新增：Electron 托盘应用
│   ├── package.json        # Electron 独立依赖
│   ├── main.ts             # Electron 主进程入口
│   ├── tray/
│   │   ├── TrayManager.ts  # 托盘图标与菜单管理
│   │   └── icons/          # 托盘图标资源（绿/红/黄/灰，各平台格式）
│   ├── worker/
│   │   └── WorkerManager.ts # Worker 子进程生命周期管理
│   ├── windows/
│   │   ├── QuickPanel.ts   # 快速搜索面板窗口管理
│   │   ├── quick-panel.html # 快速面板 UI（原生 HTML/CSS/JS）
│   │   ├── SettingsWindow.ts # 设置窗口管理
│   │   └── settings.html    # 设置窗口 UI（AI 配置 + 通用设置）
│   ├── config/
│   │   └── store.ts        # 用户配置持久化（端口、自启等）
│   └── assets/             # 图标、图片资源
├── dist/                   # Worker 编译产物（不动）
└── ...
```

关键原则：
- `desktop/` 有独立 `package.json`，Electron 依赖不污染主项目
- Worker、Hook、MCP 代码零改动
- TypeScript 全栈一致

---

## 模块设计

### 1. WorkerManager — Worker 进程管理

核心职责：启动、监控、重启 Worker 子进程。

#### Worker 路径解析

Worker 入口文件路径根据运行模式动态解析：

```typescript
function getWorkerPath(): string {
  if (app.isPackaged) {
    // 打包模式：Worker 在 resources/worker/ 下
    return path.join(process.resourcesPath, 'worker', 'bin', 'worker.js');
  } else {
    // 开发模式：相对于仓库根目录
    return path.join(__dirname, '..', '..', 'dist', 'bin', 'worker.js');
  }
}
```

#### 启动流程

```
Electron 启动 → 检测端口是否被占用
  ├── 已占用 → GET /health，检查响应中 service === "agent-memory" → 接管监控
  ├── 已占用但非 Worker → 弹通知，提示端口冲突
  └── 未占用 → fork(getWorkerPath(), ["start"], { env }) → 等待 /health 返回 200
```

#### 具体职责

1. **启动** — `child_process.fork()` 拉起 Worker，通过 env 传递端口配置：`{ ...process.env, CODEBUDDY_MEM_PORT: String(config.port) }`
2. **健康检查** — 每 10 秒轮询 `GET http://127.0.0.1:{port}/health`，验证响应中 `service` 字段，连续 3 次失败判定 dead
3. **崩溃自动重启** — 进程退出或健康检查失败时自动重启，最多 5 次，间隔递增（3s → 6s → 12s → 24s → 48s）
4. **优雅停止（跨平台）**：
   - 首选：通过 IPC channel 发送 `child.send('shutdown')` 通知 Worker 自行关闭
   - Mac fallback：SIGTERM → 等待 5 秒 → SIGKILL
   - Windows fallback：`child.kill()` 强制终止（Windows 不支持 Unix 信号）
   - Worker 侧需新增 IPC shutdown 监听（这是对现有代码的**唯一小改动**）
5. **端口冲突** — 非 Worker 进程占用端口时，弹系统通知，不强杀
6. **日志** — Worker 的 stdout/stderr 写入 `~/.agent-memory/logs/worker.log`，单文件最大 10MB，保留最近 3 个轮转文件

#### 状态机

```
                ┌──────────┐
                │  stopped  │
                └─────┬─────┘
                      │ start()
                      ▼
                ┌──────────┐   health OK    ┌──────────┐
                │ starting  │ ────────────→ │  running  │
                └─────┬────┘                └─────┬─────┘
                      ▲                           │ health fail × 3
                      │ auto-restart (≤5次)       │ 或 进程异常退出
                      │                           ▼
                      │                     ┌──────────┐
                      └──────────────────── │   dead    │
                                            └──────────┘
```

完整状态转换表：

| 当前状态 | 触发条件 | 目标状态 | 说明 |
|---------|---------|---------|------|
| stopped | 用户点"启动" / Electron 启动 | starting | 重置重启计数器 |
| starting | /health 返回 200 | running | — |
| starting | 超时 30s 无响应 | dead | 触发自动重启 |
| starting | 用户点"停止" | stopped | 取消启动，kill 子进程 |
| running | 健康检查连续 3 次失败 | dead | 触发自动重启 |
| running | Worker 进程退出 | dead | 触发自动重启 |
| running | 用户点"停止" | stopped | 发送 shutdown 信号 |
| dead | 重启次数 < 5 | starting | 自动重启，递增间隔 |
| dead | 重启次数 ≥ 5 | dead (保持) | 弹通知，等待用户操作 |
| dead | 用户点"启动" | starting | 重置重启计数器 |

#### 对外事件

- `status-changed`: `'stopped' | 'starting' | 'running' | 'dead'`
- `restart-attempt`: `{ attempt: number, maxAttempts: number }`
- `error`: `{ message: string }`

---

### 2. TrayManager — 系统托盘

#### 图标状态

| 状态 | 图标 | 含义 |
|------|------|------|
| running | 绿色 | Worker 正常运行 |
| starting | 黄色 | 启动中 |
| dead | 红色 | 已停止/崩溃 |
| stopped | 灰色 | 用户手动停止 |

#### 右键菜单

```
┌──────────────────────────────────────┐
│  AgentMemory   v1.0.0          │
│  ● 服务运行中 (uptime: 2h)          │
│ ──────────────────────────────────── │
│  🔍 快速搜索              Ctrl+Shift+M │
│  📋 打开记忆浏览器                    │
│ ──────────────────────────────────── │
│  ▶ 启动服务  /  ⏹ 停止服务           │
│  🔄 重启服务                          │
│ ──────────────────────────────────── │
│  ⚙ 设置...                            │
│ ──────────────────────────────────── │
│  📁 打开日志目录                      │
│  退出                                 │
└──────────────────────────────────────┘
```

#### 系统通知

- Worker 崩溃：`"AgentMemory 服务异常，正在自动重启 (1/5)..."`
- 重启全部失败：`"服务多次重启失败，请检查日志"`
- 端口冲突：`"端口 3847 被占用，无法启动服务"`

#### 全局快捷键

- 默认：`CmdOrCtrl+Shift+M` → 唤起快速搜索面板
- 用户可在 `AppConfig.globalShortcut` 中自定义
- 注册失败时（被其他应用占用）：降级为仅托盘点击触发，弹通知提示用户可在设置中更换快捷键

---

### 3. QuickPanel — 快速搜索面板

定位：Spotlight / Alfred 式的快速查询入口。

#### 窗口特性

- 尺寸：480 × 520px，无边框，圆角，阴影
- 位置：托盘图标附近（Windows 右下角，Mac 右上角）
- 行为：失焦自动隐藏（不销毁，下次秒开）
- 技术：`BrowserWindow` 加载本地 HTML，通过 `fetch` 调 Worker HTTP API

#### UI 布局

```
┌─────────────────────────────────────┐
│  🔍 [搜索记忆...                ]  │  ← 自动聚焦
│  ┌─ 筛选: [全部 ▾] [项目 ▾]  ────┐ │  ← 可选过滤器
│  │                                │ │
│  │  📝 修复了登录页的样式问题       │ │  ← Summary 列表
│  │     agent-memory · 2小时前     │ │
│  │                                │ │
│  │  💡 发现 SQLite WAL 模式的坑    │ │
│  │     shadow-folk · 昨天          │ │
│  │                                │ │
│  │  🔧 重构了 Hook 的编码处理      │ │
│  │     agent-memory · 3天前       │ │
│  │                                │ │
│  └────────────────────────────────┘ │
│  最近 12 条  ·  打开完整浏览器 →    │  ← 底部
└─────────────────────────────────────┘
```

#### 交互逻辑

1. **打开时** — 默认显示最近 Summaries（调 `/api/viewer/summaries?limit=10`）
2. **输入关键词** — 300ms 防抖，调 `/api/search_like?query=xxx&type=summaries`，Summaries 结果排前
3. **点击某条** — 系统浏览器打开 Viewer 并定位（`/viewer.html?tab=summaries&id=123`）。注意：Viewer 需新增 URL 参数解析功能，读取 `tab` 和 `id` 参数自动切换标签并滚动定位。
4. **"打开完整浏览器"** — `shell.openExternal('http://localhost:{port}/viewer.html')`
5. **Esc / 失焦** — 隐藏面板

#### 不做的事情

- 不在面板内编辑/删除记忆
- 不做记忆详情展开
- 不做高级搜索语法

---

### 4. 配置管理（store.ts）

使用 `electron-store` 持久化用户配置：

```typescript
interface AppConfig {
  port: number;              // Worker 端口，默认 3847
  openAtLogin: boolean;      // 开机自启，默认 true
  globalShortcut: string;    // 快捷键，默认 'CmdOrCtrl+Shift+M'
  maxRestartAttempts: number; // 最大重启次数，默认 5
  healthCheckInterval: number; // 健康检查间隔 ms，默认 10000
  apiProvider: 'timiai' | 'openai' | 'anthropic'; // AI 服务商，默认 'timiai'
  apiKey: string;            // AI API Key（加密存储）
  apiBaseUrl: string;        // 自定义 API 地址（可选，高级用户）
  apiModel: string;          // 模型名称，默认 'gpt-4o-mini'
}
```

配置文件位置：`~/.agent-memory/desktop-config.json`

**API Key 安全存储：** 使用 Electron 的 `safeStorage` API 加密存储 API Key，避免明文写入配置文件。`safeStorage` 在 Windows 上使用 DPAPI、Mac 上使用 Keychain，由操作系统级别保护。

#### 设置窗口

点击托盘菜单"设置"打开一个独立的 `BrowserWindow`（约 500 x 480px），分为两个区域：

```
┌─────────────────────────────────────────┐
│  ⚙ 设置                           ✕    │
│ ─────────────────────────────────────── │
│                                         │
│  🤖 AI 配置                             │
│  ┌───────────────────────────────────┐  │
│  │  服务商:  [TIMIAI    ▾]           │  │
│  │  API Key: [••••••••••••••]  👁    │  │
│  │  模型:    [gpt-4o-mini   ▾]      │  │
│  │  API 地址: [https://... ] (可选)  │  │
│  │           [验证连接]              │  │
│  └───────────────────────────────────┘  │
│                                         │
│  🔧 通用                                │
│  ┌───────────────────────────────────┐  │
│  │  ☑ 开机自动启动                   │  │
│  │  服务端口: [3847        ]         │  │
│  │  快捷键:   [Ctrl+Shift+M] [修改] │  │
│  └───────────────────────────────────┘  │
│                                         │
│              [保存]  [取消]              │
└─────────────────────────────────────────┘
```

**交互细节：**

- **服务商切换** — 选择 TIMIAI / OpenAI / Anthropic，自动填充对应的默认 API 地址和可用模型列表
- **API Key 输入** — 默认遮盖显示，点击眼睛图标切换明文/遮盖
- **验证连接** — 点击后调用 Worker 的 `verifyApiConnection()`（已有此方法），显示成功/失败提示
- **保存** — 将配置写入 `electron-store`（API Key 通过 `safeStorage` 加密），重启 Worker 使新配置生效
- **端口修改** — 保存后自动重启 Worker

#### 环境变量传递

WorkerManager fork Worker 时，从 AppConfig 读取 AI 配置并注入环境变量：

```typescript
const env = {
  ...process.env,
  CODEBUDDY_MEM_PORT: String(config.port),
  TIMIAI_API_KEY: config.apiProvider === 'timiai' ? decrypt(config.apiKey) : '',
  OPENAI_API_KEY: config.apiProvider === 'openai' ? decrypt(config.apiKey) : '',
  ANTHROPIC_API_KEY: config.apiProvider === 'anthropic' ? decrypt(config.apiKey) : '',
  OPENAI_BASE_URL: config.apiBaseUrl || '',
  OPENAI_MODEL: config.apiModel || ''
};
child_process.fork(workerPath, ['start'], { env });
```

这样 Worker 代码中已有的 `SDKAgent` 环境变量读取逻辑完全不需要改动。

---

## Viewer 调整

网页版 Viewer（`web/viewer.html`）的改动：

1. **去掉 Sessions 标签页** — 移除 Sessions tab 及相关代码
2. **默认展示 Summaries** — 打开页面首先看到 Summaries 列表
3. **Observations 作为第二标签** — 保留 Observations 浏览功能
4. **URL 参数定位** — 支持 `?tab=summaries&id=123` 参数，自动切换到指定标签并滚动到指定记录（供 QuickPanel 跳转使用）

---

## 打包分发

### 工具：electron-builder

| 平台 | 产物 | 说明 |
|------|------|------|
| Windows | `AgentMemoryory-Setup-x.x.x.exe` (NSIS) | 双击安装，创建开始菜单 + 桌面快捷方式 |
| Mac | `AgentMemoryory-x.x.x.dmg` | 拖入 Applications |

### 安装包内容物

```
安装目录/
├── AgentMemory.exe (.app)
├── resources/
│   ├── worker/                    # 编译好的 Worker
│   │   ├── bin/worker.js
│   │   ├── servers/mcp-server.js
│   │   ├── hooks-cli.js
│   │   └── ...
│   ├── web/                       # viewer.html 等
│   └── node_modules/              # Worker 运行依赖
└── ...
```

用户不需要安装 Node.js — Electron 内置的 Node 运行时直接跑 Worker。

### 原生模块处理（better-sqlite3）

`better-sqlite3` 是 C++ 原生模块，编译时绑定 Node.js ABI 版本。Electron 内置 Node 版本与系统 Node 不同，直接打包会崩溃。

解决方案：在 `electron-builder` 配置中使用 `@electron/rebuild` 自动重编译原生模块：

```json
{
  "build": {
    "npmRebuild": true,
    "nodeGypRebuild": false,
    "buildDependenciesFromSource": true
  }
}
```

同时在 `desktop/package.json` 中配置 postinstall hook：`"postinstall": "electron-rebuild"`。

此配置确保 `better-sqlite3` 针对 Electron 的 Node ABI 重新编译。CI/CD 打包时需要对应平台的编译工具链（Windows: Visual Studio Build Tools, Mac: Xcode Command Line Tools）。

### 开机自启

```typescript
app.setLoginItemSettings({
  openAtLogin: true,
  openAsHidden: true
});
```

Windows/Mac 通用，用户可在托盘设置中切换。

### 首次安装体验

```
安装完成 → 自动启动 Electron → 弹出欢迎提示（含"是否开机自启"选项）
  → 用户确认 → 启动 Worker → 托盘出现绿色图标
  → 系统通知: "AgentMemory 已启动，服务运行在 localhost:3847"
```

### 升级策略

第一版：用户手动下载新安装包覆盖安装。NSIS 安装器在检测到运行中的进程时会提示用户关闭后继续。
未来：可集成 `electron-updater` 实现自动更新（不在本次范围）。

### 开发者模式

```bash
cd desktop/
npm install
npm run dev        # 开发模式，热重载
npm run build      # 打包安装程序
```

---

## 不在本次范围

- 自动更新（electron-updater）
- VSCode / Cursor 扩展集成
- 面板内编辑/删除记忆
- 高级搜索语法
- Linux 支持（可后续按需添加）

## 依赖清单

### desktop/package.json 主要依赖

- `electron` — 框架
- `electron-builder` — 打包
- `@electron/rebuild` — 原生模块重编译（better-sqlite3）
- `electron-store` — 配置持久化
- `typescript` — 开发

### 现有依赖（不变）

Worker 侧所有依赖（better-sqlite3、@modelcontextprotocol/sdk 等）保持不变。

---

## 对现有代码的微小改动

虽然设计目标是"现有代码零改动"，但有两处微小的必要改动：

1. **Worker 新增 IPC shutdown 监听** — 在 `src/bin/worker.ts` 中增加 `process.on('message', msg => { if (msg === 'shutdown') gracefulShutdown(); })`，使 Electron 可以跨平台优雅关闭 Worker。不影响非 Electron 场景（无 IPC 时此监听无效）。

2. **Viewer 新增 URL 参数解析** — 在 `web/viewer.html` 中增加启动时读取 `?tab=` 和 `?id=` 参数的逻辑，自动切换标签和定位。不影响无参数时的默认行为。
