# 01 · macOS 菜单栏托盘图标消失

## 现象
- 启动桌面端后，macOS 顶部菜单栏看不到 AgentMemory 图标。
- 在 Windows 上正常显示。

## 根本原因
- 直接把应用主图标（512×512 PNG）塞给 `Tray`，macOS 渲染时按原尺寸截取，结果显示成"一团模糊"或干脆被系统判定为非法尺寸而不绘制。
- macOS 菜单栏的合法尺寸是 **22×22**（@2x 为 44×44），并且建议使用模板图（template image）以适配亮/暗主题。

## 解决
1. `scripts/process-icons.cjs` 增加生成 `icon-*-tray.png`（22×22）的步骤。
2. `desktop/src/tray/TrayManager.ts` 在 macOS 优先加载托盘小图，并对 `nativeImage` 调用 `resize({ width: 22, height: 22 })` 兜底。
3. 重新打包 mac DMG，菜单栏图标恢复显示。

## 教训
- 平台托盘图标必须按系统规范出独立尺寸资源，不能复用应用大图。
- macOS 还要考虑 template image（黑色透明 + `setTemplateImage(true)`）以适配深色菜单栏。
