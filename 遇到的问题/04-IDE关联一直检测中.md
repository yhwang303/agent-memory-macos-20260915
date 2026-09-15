# 04 · "IDE 关联"一直卡在"检测中"

## 现象
- 打开「设置 → IDE 关联」面板，状态一直显示"检测中…"，不会变成"已连接/未连接"。
- 重启桌面端也无效。

## 根本原因
- 渲染进程通过 IPC 调用 `detectIDEs`，主进程内部要去扫多个 IDE 的安装路径与配置文件；其中某条路径在 macOS 上读取被系统挂起（例如非 sandbox 环境读 `Application Support` 子目录），整个 Promise 永远不 resolve。
- 没有超时兜底，UI 端的"检测中"状态永远不会切换。

## 解决
1. `desktop/src/windows/settings.html` 中 `loadIDEStatus` 用 `withTimeout(promise, 5000)` 包裹 IPC 调用，超时即降级为"未检测到"并显示具体错误。
2. preload 里增加 `window.electronAPI` 是否存在的检查，避免在隔离上下文异常时静默失败。
3. 主进程侧的 `detectIDEs` 后续可继续优化，但 UI 端先做兜底，问题面立刻可控。

## 教训
- IPC 调用必须永远带超时；UI 状态机要为"超时/异常"留位置，不要只有"成功/失败"。
- 任何会阻塞的系统调用（文件系统遍历、网络请求）都要在异步边界外加 watchdog。
