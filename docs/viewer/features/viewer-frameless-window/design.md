# AgentMem-Viewer 无边框窗口设计

> 配套 PRD：[`2026-04-23-viewer-frameless-window-prd.md`](./2026-04-23-viewer-frameless-window-prd.md)

## 总体方案

把 viewer 从"系统浏览器加载远程 URL"改成"Electron BrowserWindow + frame:false + loadFile"，并在 `viewer.html` 里加一条**自绘 HUD 标题栏**用作窗口控制 + 拖动区。

```text
TrayManager.openViewer / QuickPanel.openViewer
   ↓ ipc / 直接调用
ViewerWindow.show({ tab, id })
   ↓ loadFile(viewer.html)
viewer.html
   ├── 自绘标题栏
   │     ├── -webkit-app-region: drag （logo / 标题区）
   │     └── -webkit-app-region: no-drag （min / max / close 按钮）
   │           └── window.viewerAPI.minimize / toggleMaximize / close (preload IPC)
   └── 业务区（沿用现有 viewer 全部 DOM / JS）
         └── fetch http://127.0.0.1:{port}/api/...
```

## 设计原则

1. **零侵入业务**：viewer 内部 Tab / 列表 / 详情逻辑不动，只在最外层"套一个 HUD 标题栏"
2. **单例窗口**：避免出现多个 viewer 同时跑
3. **关闭 ≠ 销毁**：默认关闭只 hide，下次打开秒开（与 SettingsWindow 一致）
4. **状态可恢复**：bounds 记忆，符合桌面 App 习惯
5. **平台差异显式处理**：macOS 红绿灯靠 CSS padding 让位，Windows / Linux 用自绘按钮

## 文件改动

| 文件 | 类型 | 改动 |
|------|------|------|
| `desktop/src/windows/ViewerWindow.ts` | **新增** | Electron BrowserWindow 封装：`show({ tab?, id? })` / `hide` / IPC handlers / bounds 持久化 |
| `desktop/src/preload-viewer.ts` | **新增** | 通过 `contextBridge` 暴露 `window.viewerAPI`：`minimize` / `toggleMaximize` / `close` / `getPlatform` |
| `desktop/src/main.ts` | 改 | 初始化 `viewerWindow`；新增 IPC `viewer:open`（来自 quick-panel） |
| `desktop/src/tray/TrayManager.ts` | 改 | "打开记忆浏览器" 改为 `viewerWindow.show()`，去掉 `shell.openExternal` |
| `desktop/src/windows/QuickPanel.ts` | 改 | 暴露一个回调 / IPC，让 quick-panel.html 触发 `viewer:open` |
| `desktop/src/windows/quick-panel.html` | 改 | "打开完整浏览器 →" 与 "卡片点击" 改为 `window.quickAPI.openViewer({ tab, id })`，不再 `window.open` |
| `desktop/src/preload-quick.ts`（新增/或扩展现有方式） | 改 | 暴露 `quickAPI.openViewer` |
| `web/viewer.html` | 改 | 顶部新增 HUD 标题栏（drag + 按钮）；按钮调用 `window.viewerAPI`；macOS 平台 padding 预留 |
| `desktop/package.json` | 可能 | 新增 `preload-viewer` 编译配置（沿用现有 tsconfig 即可） |

> 注：避免引入 `electron-store`，bounds 持久化沿用现有 `desktop/src/config/store.ts` 模式（如果它已经基于 JSON 文件，就在同一个 config 里加一个 `viewerBounds` 字段）。

## 关键实现

### ViewerWindow

```ts
// desktop/src/windows/ViewerWindow.ts （示意，非全文）
export class ViewerWindow {
  private window: BrowserWindow | null = null;
  private isQuitting = false;

  show(opts?: { tab?: 'summaries' | 'observations' | 'sessions'; id?: string }): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      this.navigate(opts);
      return;
    }

    const saved = getConfig().viewerBounds; // { x, y, width, height } | undefined

    this.window = new BrowserWindow({
      width: saved?.width ?? 1100,
      height: saved?.height ?? 760,
      x: saved?.x,
      y: saved?.y,
      minWidth: 720,
      minHeight: 520,
      frame: false,                          // ← 关键：去掉系统标题栏
      backgroundColor: '#0a1014',            // 与 ShadowFolk 底色一致，避免白色闪烁
      autoHideMenuBar: true,                 // Windows 下兜底再隐藏菜单
      title: 'AgentMem Viewer',
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: false,
        preload: path.join(__dirname, '..', 'preload-viewer.js'),
      },
    });

    // macOS 想要"无边框但保留红绿灯"，可以改成下面（PRD 已定：保留红绿灯位置）
    // titleBarStyle: 'hiddenInset',

    const htmlPath = path.join(__dirname, '..', '..', '..', 'web', 'viewer.html');
    const query: Record<string, string> = { port: String(getConfig().port) };
    if (opts?.tab) query.tab = opts.tab;
    if (opts?.id) query.id = opts.id;
    this.window.loadFile(htmlPath, { query });

    this.window.once('ready-to-show', () => this.window?.show());

    this.window.on('close', (e) => {
      if (!this.isQuitting && this.window) {
        e.preventDefault();
        this.persistBounds();
        this.window.hide();
      }
    });

    // 拖动 / 缩放结束后增量保存 bounds
    ['resize', 'move'].forEach((evt) =>
      this.window!.on(evt as any, debounce(() => this.persistBounds(), 400)),
    );
  }

  private navigate(opts?: { tab?: string; id?: string }): void {
    if (!this.window) return;
    if (!opts || (!opts.tab && !opts.id)) return;
    // 通过 webContents 通知 viewer.html 切换
    this.window.webContents.send('viewer:navigate', opts);
  }

  destroy(): void {
    this.isQuitting = true;
    this.window?.destroy();
    this.window = null;
  }
}
```

### IPC 设计

| Channel | 方向 | 入参 | 行为 |
|---------|------|------|------|
| `viewer:minimize` | renderer → main (invoke) | — | `BrowserWindow.minimize()` |
| `viewer:toggle-maximize` | renderer → main (invoke) | — | 已最大化则 `unmaximize`，否则 `maximize` |
| `viewer:close` | renderer → main (invoke) | — | `window.hide()`（实际不销毁） |
| `viewer:get-platform` | renderer → main (invoke) | — | 返回 `process.platform`，前端用于 mac padding |
| `viewer:open` | renderer → main (invoke)（来自 quick-panel） | `{ tab?, id? }` | `viewerWindow.show(opts)` |
| `viewer:navigate` | main → renderer (send) | `{ tab?, id? }` | viewer.html 收到后切换 tab / 滚动到 id |

### preload-viewer.ts

```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('viewerAPI', {
  minimize:        () => ipcRenderer.invoke('viewer:minimize'),
  toggleMaximize:  () => ipcRenderer.invoke('viewer:toggle-maximize'),
  close:           () => ipcRenderer.invoke('viewer:close'),
  getPlatform:     () => ipcRenderer.invoke('viewer:get-platform'),
  onNavigate:      (cb: (opts: { tab?: string; id?: string }) => void) =>
    ipcRenderer.on('viewer:navigate', (_e, opts) => cb(opts)),
});
```

### viewer.html 结构改造

仅在 `<body>` 顶部插入：

```html
<header class="hud-titlebar" id="hudTitlebar">
  <div class="hud-titlebar__drag">
    <span class="hud-titlebar__logo">◆</span>
    <span class="hud-titlebar__title">AGENTMEM // VIEWER</span>
  </div>
  <div class="hud-titlebar__actions">
    <button class="hud-btn" id="btnMin"  title="最小化">—</button>
    <button class="hud-btn" id="btnMax"  title="最大化">▢</button>
    <button class="hud-btn hud-btn--close" id="btnClose" title="关闭">✕</button>
  </div>
</header>
```

CSS 关键点：

```css
.hud-titlebar {
  -webkit-app-region: drag;          /* 整条可拖 */
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 0 14px;
  background: var(--bg-void);
  border-bottom: 1px solid var(--hud-border);
  user-select: none;
}
.hud-titlebar__actions { -webkit-app-region: no-drag; display: flex; gap: 4px; }
.hud-btn {
  width: 36px; height: 28px;
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid transparent;
  font-family: var(--font-body);
  cursor: pointer;
}
.hud-btn:hover { background: var(--accent-dim); color: var(--accent-primary); }
.hud-btn--close:hover { background: var(--accent-alert); color: #fff; }

/* macOS 红绿灯避让 */
body[data-platform="darwin"] .hud-titlebar__drag { padding-left: 80px; }
body[data-platform="darwin"] .hud-titlebar__actions { display: none; }
```

JS 桥接（仅在 `window.viewerAPI` 存在时绑定，保证仍能用浏览器直接打开 viewer.html 调试）：

```js
if (window.viewerAPI) {
  window.viewerAPI.getPlatform().then(p => document.body.dataset.platform = p);
  document.getElementById('btnMin').onclick   = () => window.viewerAPI.minimize();
  document.getElementById('btnMax').onclick   = () => window.viewerAPI.toggleMaximize();
  document.getElementById('btnClose').onclick = () => window.viewerAPI.close();
  window.viewerAPI.onNavigate(({ tab, id }) => {
    if (tab) switchTab(tab);
    if (id)  scrollToItem(id);
  });
} else {
  // 浏览器调试模式：隐藏标题栏，用浏览器自带的
  document.getElementById('hudTitlebar').style.display = 'none';
}
```

### 入口收编

#### TrayManager

```ts
// 之前
click: () => shell.openExternal(`http://127.0.0.1:${config.port}/viewer.html`),
// 之后（构造函数注入 onOpenViewer 回调，与 onShowQuickPanel 同模式）
click: () => this.onOpenViewer(),
```

`main.ts` 里：

```ts
const viewerWindow = new ViewerWindow();
trayManager = new TrayManager(
  workerManager,
  (anchorBounds) => quickPanel.toggle(anchorBounds),
  () => settingsWindow.show(),
  () => viewerWindow.show(),               // ← 新增第 4 个回调
);
```

#### QuickPanel

`quick-panel.html` 里 `window.open(...)` 改为：

```js
window.quickAPI.openViewer({ tab, id });
```

主进程 IPC：

```ts
ipcMain.handle('viewer:open', (_e, opts) => viewerWindow.show(opts));
```

## bounds 持久化

复用 `desktop/src/config/store.ts`，在 `AppConfig` 中加：

```ts
viewerBounds?: { x: number; y: number; width: number; height: number };
```

`setConfig({ viewerBounds })`，节流 400ms 写。无需新增 `electron-store` 依赖。

## 平台差异

| 平台 | frame | titleBarStyle | 自定义按钮 | 说明 |
|------|-------|---------------|-----------|------|
| Windows | `false` | — | 显示 | autoHideMenuBar 兜底 |
| Linux   | `false` | — | 显示 | 同 Windows |
| macOS   | `false` | — | 显示（与 Win 一致） | **决策（用户确认 fully_frameless）：不保留系统红绿灯，全平台统一自绘 HUD 按钮** |

> 备选（未采纳）：macOS 用 `titleBarStyle: 'hiddenInset'` 保留系统红绿灯；用户明确选择全平台统一无边框 + 自绘按钮，本期不实现。

## 验证方案

| 场景 | 预期 |
|------|------|
| 点托盘 "打开记忆浏览器" | 弹出无边框 HUD 风格 viewer 窗口；无白色标题栏 / 菜单栏 |
| 顶部 logo 区拖动 | 窗口跟随移动 |
| 点最小化按钮 | 窗口最小化到任务栏 |
| 点最大化按钮 | 窗口铺满工作区，再点恢复原大小 |
| 点关闭按钮 | 窗口隐藏；再点托盘"打开记忆浏览器"立即出现且 bounds 恢复 |
| 改变窗口大小后关闭再打开 | 大小一致 |
| QuickPanel 点 "打开完整浏览器 →" | 同一个 ViewerWindow 出现，tab 与点击时一致 |
| QuickPanel 点某个 summary 卡片 | 同一个 ViewerWindow 出现，tab=summaries，滚到对应 id |
| viewer 内部所有原有功能 | 不受影响（Tabs / 项目过滤 / Local 过滤 / Refresh / 导出 MD） |
| macOS（如可测） | 红绿灯不被 logo 挡住，自定义按钮不出现 |
| 浏览器直接访问 `http://127.0.0.1:3847/viewer.html`（调试） | HUD 标题栏自动隐藏，原 viewer 全功能可用 |

## 风险与回退

| 风险 | 缓解 |
|------|------|
| `loadFile` 后 viewer 内 fetch 仍走 `http://127.0.0.1:{port}`，跨协议（file → http） | viewer 已显式使用 `BASE = http://127.0.0.1:${port}`，且 `webSecurity: false`，与现有 quick-panel.html 同模式，无新增风险 |
| Windows 下 `frame:false` 后默认菜单仍残留 | `autoHideMenuBar: true` + 不调用 `Menu.setApplicationMenu` 即可 |
| 关闭按钮误销毁导致状态丢失 | 默认 `e.preventDefault() + hide()`；`before-quit` 才真正 destroy |
| 无边框后用户找不到关闭按钮 | HUD 标题栏右侧固定 3 个按钮，hover 高亮 |
| macOS 红绿灯与自绘按钮冲突 | macOS 隐藏自绘按钮，仅用系统红绿灯 |
| 老版本用户习惯于"在浏览器里看"，需要外链 | 在 HUD 标题栏右上保留一个可选 "在浏览器中打开 ↗" 按钮（**本期不做**，记入未来增强） |

## 改造分阶段

1. **P1 主流程**：新增 `ViewerWindow` + `preload-viewer.ts`；改 TrayManager；viewer.html 加 HUD 标题栏与 IPC
2. **P2 入口收编**：QuickPanel 改 `window.open` → IPC `viewer:open`
3. **P3 状态记忆**：bounds 持久化进 `store.ts`
4. **P4 平台打磨**：macOS 红绿灯 + padding；Windows / Linux 按钮 hover 细节

P1 即可达到"看不到白色边框"的核心目标。
