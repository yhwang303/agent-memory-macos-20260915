# shadwmonitor-pyinstaller-bundle — PRD

> 下期需求。本期 `desktop-monitor-plugin` 已交付"启用即启动"逻辑层
> （ProcessManager + ConfigBridge + 启用向导），假设用户本地有 Python。
> 本期通过 PyInstaller 把 ShadwMonitor 打成 Windows 单文件，跟桌面端一起分发，
> 让用户连 Python 都不用装。

## 背景

`plugins/shadwmonitor/` 当前需要：
1. 用户本机装 Python 3.10+
2. `pip install -r requirements.txt`（含 paddleocr / opencv / mss 等大依赖，~500MB）
3. 设 `.env` 的 API key
4. 桌面端 Settings 启用插件

只有 (1)(2) 是用户能感知的不便。要做到"装完 agent-mem 桌面端就能用"，需要把
ShadwMonitor 本体打成可独立执行的二进制。

## 目标

- 用户安装 agent-mem 桌面端后，不需要装 Python 即可启用 ShadwMonitor 插件
- 安装包体积可接受（< 800MB；含 OCR 模型）
- 桌面端能像启动 python 那样 spawn 这个 .exe；命令行参数完全兼容（capture / web）

## 范围

### 包含

- 在 `plugins/shadwmonitor/` 下新增 `shadwmonitor.spec`（PyInstaller 配置）
- 处理 hiddenimports：rapidocr-onnxruntime / mss / cv2 / pywin32 / mcp / aiosqlite / httpx
- datas：config/settings.yaml 模板、static/index.html、OCR 模型文件
- onedir 模式（onefile 启动慢，每次解压到 temp）
- 输出位置：`plugins/shadwmonitor/dist/shadwmonitor/`（含 .exe + 一堆 .dll/.pyd）
- CI 集成：`.github/workflows/release.yml` 加 Python build job（matrix 限定 Windows-x64）
- Windows installer 整合：把 `plugins/shadwmonitor/dist/shadwmonitor/` 复制进
  打包产物 `release-artifacts/v<version>/windows/AgentMemory-Setup-<version>.exe` 内部
- `ShadwMonitorProcessManager.ts` 在 frozen 模式下 spawn `shadwmonitor.exe` 而不是
  `python` + `src/main.py`

### 不包含

- macOS / Linux 打包（Windows-first；ShadwMonitor 用了 pywin32，本就 Windows-only）
- ShadwMonitor 代码层重构（保持插件原有结构）
- 自动升级（依赖 agent-mem 主体的 update 流程，跟 .exe 一起更新）

## 验收标准

- [ ] 在一台**全新无 Python** 的 Windows 11 上装 AgentMemory-Setup-x.exe，启用插件 → 截屏 + L1 全流程跑通
- [ ] 安装包总大小 ≤ 800MB
- [ ] PyInstaller spec 文件 commit 进仓库，CI 能自动重新打包
- [ ] 失败回滚：如果 `shadwmonitor.exe` 未找到（用户开发模式），ProcessManager 自动回退到 `python src/main.py`

## 风险与未决事项

- **RapidOCR 模型路径**：默认从 user dir 下载；frozen 模式要确认模型查找路径
- **opencv-python 体积**：~70MB；尝试用 opencv-python-headless 减小
- **paddleocr** vs **rapidocr-onnxruntime**：项目 requirements.txt 同时列了，实际只用 rapidocr；可移除 paddleocr 减小 ~200MB
- **pywin32 in frozen 模式**：常见踩坑点（com、win32api 等）
- **代码签名**：未签名的 .exe Windows SmartScreen 会弹警告，EV 证书是单独议题

## 依赖

- 本期 `desktop-monitor-plugin` 必须先落地（提供 ProcessManager 接口）
- `release-automation` 需求里的 Windows installer 链路必须打通
