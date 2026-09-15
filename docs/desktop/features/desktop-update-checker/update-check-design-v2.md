# AgentMemory - 检查更新功能 设计文档

> 版本: v2.0 (修正版)  
> 日期: 2026-05-25  
> 当前客户端版本: 2.0.11  
> 发布服务器: http://21.214.82.219:3850 (agent-memory-website)

---

## 一、需求概述

### 1.1 功能目标

| 编号 | 需求 | 优先级 | 状态 |
|------|------|--------|------|
| R1 | 客户端启动后自动检查是否有新版本 | P0 | ✅ 已实现 |
| R2 | 发现新版本时弹出系统通知 | P0 | ✅ 已实现 |
| R3 | 用户点击通知可跳转下载 | P0 | ✅ 已实现 |
| R4 | 用户可手动触发检查更新(托盘菜单) | P1 | ✅ 已实现 |
| R5 | 用户可跳过/忽略某个版本 | P1 | ✅ 已实现 |

### 1.2 非功能需求

- 检查请求延迟 15s 后执行, 不影响启动速度
- 检查频率: 每 24 小时一次 + 支持手动触发
- 网络异常时静默失败, 不干扰用户
- 按平台返回对应安装包 (Windows/macOS-arm64/macOS-x64)
- **不依赖用户任何配置, 装完即生效**

---

## 二、系统架构

### 2.1 整体流程

```
┌──────────────────┐       GET /api/latest/win       ┌─────────────────────────────┐
│  Electron 客户端  │  ────────────────────────────►  │  官网发布服务器               │
│                  │                                  │  http://21.214.82.219:3850  │
│  UpdateChecker   │  ◄────────────────────────────  │  (agent-memory-website)    │
│                  │  { version, downloadUrl, ... }   │                             │
│  地址写死在代码中  │                                  │  通过 admin 上传安装包即发布  │
└──────────────────┘                                  └─────────────────────────────┘
```

### 2.2 关键设计决策

| 决策点 | 方案 | 原因 |
|--------|------|------|
| 服务器地址 | 写死在客户端代码中 | 这是官方发布服务器, 不应由用户配置 |
| 通信方式 | HTTP 轮询 | 更新检查是低频场景, 无需长连接 |
| 服务端 | 复用官网已有接口 | `/api/latest/:platform` 已满足需求 |
| 个人后端 | 不参与 | 个人后端只做数据同步, 与版本发布无关 |

---

## 三、接口对接

### 3.1 官网已有接口 (无需改动)

#### 查询某平台最新版本

```
GET http://21.214.82.219:3850/api/latest/:platform
```

**platform 取值:** `win` | `mac-arm64` | `mac-x64` | `linux-x64`

**Response 200:**
```json
{
  "success": true,
  "release": {
    "filename": "AgentMemory-Setup-2.0.12.exe",
    "version": "2.0.12",
    "platform": "win",
    "platformLabel": "Windows",
    "arch": "x64",
    "size": "85.3 MB",
    "sizeBytes": 89456789,
    "date": "2026-05-25",
    "downloadUrl": "/api/download/AgentMemory-Setup-2.0.12.exe"
  }
}
```

**Response 404 (无该平台发布):**
```json
{
  "success": false,
  "error": "No release found for platform: win"
}
```

#### 下载安装包

```
GET http://21.214.82.219:3850/api/download/:filename
```

直接返回文件流。

### 3.2 管理端发布流程 (已有)

通过官网 admin 面板上传安装包 → 文件落入 `releases/` 目录 → 客户端自动可检测。

或通过构建流水线: admin 触发构建 → 自动 git pull + npm build → 产物复制到 releases/ → 完成。

---

## 四、客户端实现

### 4.1 核心代码

文件: `desktop/src/services/UpdateChecker.ts`

```typescript
// 官方发布服务器地址（固定，不依赖用户配置）
const RELEASE_SERVER = 'http://21.214.82.219:3850';

function getClientPlatform(): string {
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  }
  return `linux-${process.arch}`;
}
```

### 4.2 请求流程

1. 确定平台标识 (`win` / `mac-arm64` / `mac-x64`)
2. 请求 `http://21.214.82.219:3850/api/latest/{platform}`
3. 解析响应, 取出 `release.version`
4. 与 `app.getVersion()` 比较
5. 有新版本 → 弹出系统通知
6. 用户点击通知 → 打开 `{RELEASE_SERVER}{release.downloadUrl}` 下载

### 4.3 触发时机

| 时机 | 行为 |
|------|------|
| 启动后 15s | 自动检查一次 |
| 每 24h | 定时轮询 |
| 托盘菜单 "检查更新" | 手动触发, 无论结果都给用户反馈 |

### 4.4 忽略版本

用户关闭通知(未点击下载) → 将该版本号存入 `dismissedVersion` → 不再对同版本弹窗。

---

## 五、文件改动清单

### 客户端 (agent-memory)

| 文件 | 改动 |
|------|------|
| `desktop/src/services/UpdateChecker.ts` | 重写: 写死官网地址, 对接 `/api/latest/:platform` |
| `desktop/src/tray/TrayManager.ts` | 新增 "检查更新" 菜单项 + handler |
| `desktop/src/main.ts` | 初始化 UpdateChecker, 绑定事件, 退出清理 |

### 官网发布服务器 (agent-memory-website)

**无需改动** — 已有 `GET /api/latest/:platform` 接口。

### 个人后端 (agent-memory-backend)

**无需改动** — 不参与版本发布。

---

## 六、发布新版本操作流程

当你发布新版本时:

1. 打包生成安装包 (如 `AgentMemory-Setup-2.0.12.exe`)
2. 上传到官网 admin (`http://21.214.82.219:3850/admin`)
3. 文件落入服务器 `releases/` 目录
4. 所有客户端下次检查时自动发现新版本

无需手动调用任何接口, 无需修改数据库。

---

## 七、安全与兼容性

| 风险点 | 应对 |
|--------|------|
| 服务器不可达 | 10s 超时 + 静默失败, 不影响使用 |
| 中间人攻击 | 后续可升级为 HTTPS |
| 旧版客户端无此功能 | 不影响, 只是不会弹通知 |
| 某平台无安装包 | 404 响应 → 静默跳过 |
