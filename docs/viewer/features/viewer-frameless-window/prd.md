# AgentMem-Viewer 无边框窗口需求分析

## 背景

当前 `web/viewer.html`（AgentMem-Viewer 记忆查看器）通过托盘菜单 "打开记忆浏览器" 启动，实现方式是：

```ts
// desktop/src/tray/TrayManager.ts:108-111
{
  label: '打开记忆浏览器',
  click: () => shell.openExternal(`http://127.0.0.1:${config.port}/viewer.html`),
  enabled: isRunning,
}
```

即把页面 URL 交给系统默认浏览器（Chrome / Edge / Brave 等）打开。结果是：

1. 浏览器自带白色 / 浅色的窗口标题栏 + 菜单栏（截图里看到的 "AgentMem-Viewer" + `File Edit View Window Help`），与 viewer 内部的 ShadowFolk 深空 HUD 风格（`#0a1014` 底色 + `#00d4aa` 青绿色高亮）严重不协调。
2. 用户感知上像是"被踢出 App"，而不是 App 自带功能。
3. 如果用户默认浏览器是 Chrome，会出现 "新建标签页" 之类的额外干扰。
4. 无法做应用级行为（例如关闭 viewer 不影响后台 Worker、与托盘联动、统一 ICON 等）。

QuickPanel / SettingsWindow / SetupWizard 都是 Electron BrowserWindow，唯独 viewer 走了系统浏览器，体感不一致。

## 目标

把 AgentMem-Viewer 改造成**应用内的无边框 Electron 窗口**，与 ShadowFolk 主题一致，并保留现有 viewer 的所有功能（Tabs、本机/全部项目过滤、URL 参数 `?tab=&id=` 跳转、导出 MD 等）。

## 用户故事

1. 作为日常使用者，我点 "打开记忆浏览器" 时，希望出现的是一个深空 HUD 风格的独立窗口，而不是浏览器标签页。
2. 作为窗口操作者，我希望能像普通桌面 App 一样**拖动、最小化、关闭**这个窗口。
3. 作为多次使用者，我希望第二次打开时，窗口位置和大小记得我上次的设置（不是次次都跳到屏幕中央）。
4. 作为 QuickPanel 用户，我点 "打开完整浏览器 →" 时，希望也是同一个应用内窗口，而不是系统浏览器。

## 功能需求

### FR-1 应用内 Viewer 窗口

新增 `ViewerWindow`（Electron `BrowserWindow`）：

- `frame: false`（无系统标题栏 / 菜单栏）
- 加载本地 `viewer.html`（`loadFile`）而非走 HTTP，避免再依赖系统浏览器
- 数据请求仍指向 `http://127.0.0.1:{port}/api/...`（与现在一致）
- 默认尺寸：1100 × 760，可缩放，最小尺寸 720 × 520
- 单例：重复点击 "打开记忆浏览器" 只显示同一个窗口（show + focus），不会开多个

### FR-2 自定义标题栏（HUD 风格）

`viewer.html` 顶部新增一条**自绘标题栏**，包含：

| 元素 | 行为 |
|------|------|
| ShadowFolk Logo + `AGENTMEM // VIEWER` 标题 | 标识 + 拖动区（CSS `-webkit-app-region: drag`） |
| 右侧：最小化按钮 | 通过 IPC `viewer:minimize` 调用 `BrowserWindow.minimize()` |
| 右侧：最大化 / 还原按钮 | IPC `viewer:toggle-maximize` |
| 右侧：关闭按钮 | IPC `viewer:close`（默认只 hide，不真正销毁，便于下次秒开） |

按钮区域 `-webkit-app-region: no-drag`，避免按下按钮被识别为窗口拖动。

### FR-3 入口收编

替换两处入口：

1. `desktop/src/tray/TrayManager.ts` 中 "打开记忆浏览器" 改为调用 `viewerWindow.show()`，不再 `shell.openExternal`
2. `desktop/src/windows/quick-panel.html` 中 "打开完整浏览器 →" 与 "卡片点击跳转 viewer" 改为通过 IPC 通知主进程 `viewer:open`，并带上 `tab` / `id` 参数

### FR-4 窗口状态记忆

- 关闭（其实是 hide）时记录 bounds 到 `electron-store`
- 下次 `show()` 时恢复 bounds
- 第一次打开时居中

### FR-5 平台适配

- macOS：标题栏左上方为系统红绿灯按钮区域预留 80px 内边距，避免按钮挡住 logo / 拖动响应
- Windows / Linux：自定义按钮区域显示在右上方
- 透明、毛玻璃**不做**（避免性能 / 兼容性问题，深空底色已经足够）

## 非目标

- 不做多窗口（只单例）
- 不引入 React / 框架，仍是单文件原生 HTML/JS
- 不实现"Always on top"、"全屏"等 Power-User 功能
- 不修改 viewer 内部已有 Tab / 列表 / 详情 业务逻辑
- 不改 `shell.openExternal` 之外的功能（例如让卡片打开外链等）
- 不做窗口动画、不引入额外字体

## 验收标准

- [ ] 点托盘 "打开记忆浏览器" 弹出的是应用内无边框窗口，标题栏是 HUD 风格，无任何白色系统边框 / 菜单栏
- [ ] 拖动顶部标题栏可以移动窗口；点击右上角按钮可最小化、最大化/还原、关闭
- [ ] 关闭后再打开，能恢复上次窗口大小与位置
- [ ] QuickPanel 中点 "打开完整浏览器 →" 与点卡片跳转，都进入同一个应用内 ViewerWindow，并正确切换到对应 tab / 选中 id
- [ ] viewer 内部所有原有功能（500 Summaries / Observations / Sessions Tab、本机数据过滤、项目过滤、Refresh、导出 MD）保持可用
- [ ] macOS 下系统红绿灯按钮不与 viewer 顶部内容重叠
- [ ] 首次启动时窗口居中显示
