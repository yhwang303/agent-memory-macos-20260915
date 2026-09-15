# 桌面端版本更新提示设计

## 总体方案

```
App 启动（延迟 15s）
      ↓
UpdateChecker.fetchLatest()
  → GET https://YOUR_SERVER/api/releases/latest
      ↓
semver 比较：latest > current?
  否 → 结束，24h 后重试
  是 → emit('update-available', UpdateInfo)
      ↓
    ┌────────────────────────────────┐
    │                                │
    ▼                                ▼
showNotification()           TrayManager.setUpdateInfo()
  dismissedVersion == latest?   → 托盘菜单顶部插入更新条目
  是 → 跳过                     → 点击 → shell.openExternal(downloadPage)
  否 → Notification.show()
        点击 → openExternal
        关闭 → setConfig({ dismissedVersion })
```

## 文件改动

| 文件 | 改动 |
|------|------|
| `desktop/src/services/UpdateChecker.ts` | **新增**，封装版本检查逻辑 |
| `desktop/src/config/store.ts` | 新增 `dismissedVersion?: string` 字段 |
| `desktop/src/tray/TrayManager.ts` | 新增 `setUpdateInfo()` 方法；`updateMenu()` 插入更新条目 |
| `desktop/src/main.ts` | 创建 `UpdateChecker` 实例，监听事件，传入 TrayManager |

## UpdateChecker 设计

### 接口

```typescript
export interface UpdateInfo {
  version: string;       // "2.0.11"
  releaseNotes?: string; // 可选，简短说明
  downloadPage: string;  // 统一下载页 URL
  releasedAt?: string;   // ISO 时间，可选
}

class UpdateChecker extends EventEmitter {
  start(): void                         // 启动定时检查
  getLatestInfo(): UpdateInfo | null    // 供外部读取当前最新版本信息
  destroy(): void                       // 清理定时器
  // 事件: 'update-available' -> UpdateInfo
}
```

### 版本比较

使用手写 semver 比较，不引入额外依赖：

```typescript
function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const [la, lb, lc] = parse(latest);
  const [ca, cb, cc] = parse(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}
```

### 通知逻辑

```typescript
// 区分"点击"和"关闭"，只有关闭（未点击）才记 dismissedVersion
let clicked = false;
notif.on('click', () => { clicked = true; shell.openExternal(downloadPage); });
notif.on('close', () => { if (!clicked) setConfig({ dismissedVersion: version }); });
```

### 网络请求

- 超时 10 秒（`AbortSignal.timeout(10_000)`）
- User-Agent: `AgentMemory/{appVersion}`
- 失败静默 catch，不影响任何主流程

## TrayManager 改动

```typescript
// 新增字段
private latestUpdate: UpdateInfo | null = null;

// 新增方法
setUpdateInfo(info: UpdateInfo): void {
  this.latestUpdate = info;
  this.updateMenu();
}

// updateMenu() 头部插入（有更新时）
...(this.latestUpdate ? [
  {
    label: `🆕 新版本 v${this.latestUpdate.version} 可用 → 去下载`,
    click: () => shell.openExternal(this.latestUpdate!.downloadPage),
  },
  { type: 'separator' as const },
] : []),
```

## main.ts 改动

```typescript
// workerManager.start() 之后
const updateChecker = new UpdateChecker();
updateChecker.on('update-available', (info) => trayManager.setUpdateInfo(info));
updateChecker.start();

// before-quit 清理
updateChecker.destroy();
```

## Config 改动

```typescript
// AppConfig 新增字段（可选，无 default 值）
dismissedVersion?: string;

// getConfig() 新增
dismissedVersion: store.get('dismissedVersion') as string | undefined,
```

---

## 服务端 API 需求（给服务端开发）

> 以下是桌面端 UpdateChecker 依赖的接口规范，请服务端实现。

### 接口

```
GET /api/releases/latest
```

### 响应格式

```json
{
  "version": "2.0.11",
  "releaseNotes": "修复了 xxx；新增 yyy",
  "downloadPage": "https://your-domain.com/download",
  "releasedAt": "2026-05-23T10:00:00Z"
}
```

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `version` | string | ✅ | semver 格式，如 `2.0.11`，不需要 `v` 前缀 |
| `downloadPage` | string | ✅ | 统一下载页 URL，所有平台跳这里 |
| `releaseNotes` | string | ❌ | 简短更新说明，桌面端暂未展示，预留 |
| `releasedAt` | string | ❌ | ISO 8601 时间戳，预留 |

### 非功能要求

| 要求 | 说明 |
|------|------|
| **CORS** | 需允许所有来源（`Access-Control-Allow-Origin: *`），桌面端通过 `fetch` 直接调用 |
| **缓存** | 建议返回 `Cache-Control: public, max-age=3600`，减少服务端压力 |
| **HTTPS** | 必须 HTTPS，HTTP 会被 Electron 的安全策略限制 |
| **HTTP 状态码** | 正常返回 `200`；服务异常返回 `5xx`（客户端会静默忽略） |
| **响应大小** | 保持轻量（< 1KB），桌面端每 24h 拉取一次 |

### 管理端（如何发版）

当你发布新版本时，只需更新服务端的 `version` 字段为最新版本号，以及对应的 `downloadPage`。推荐做法：

- 维护一个 `releases` 表或静态 JSON 配置
- 发布新版时更新 `latest` 记录
- 无需保存历史版本（桌面端只消费 `latest`）

### 示例 curl 验证

```bash
curl -s https://YOUR_SERVER/api/releases/latest | python3 -m json.tool
```

期望输出：
```json
{
  "version": "2.0.11",
  "releaseNotes": "...",
  "downloadPage": "https://...",
  "releasedAt": "2026-05-23T10:00:00Z"
}
```
