# PRD：统一发布自动化

> 日期：2026-04-27
> 关联设计：`2026-04-27-release-automation-design.md`

## 背景

Agent Memory 现在同时存在三种发布形态：

- 根 npm 包 `agent-memory`：面向 Linux/macOS 无头部署、OpenClaw 插件版和 MCP/hooks。
- Windows 桌面安装包：Electron 托盘应用，负责本机 worker 生命周期、设置窗口和 Viewer。
- macOS 桌面安装包：Electron DMG，目标能力与桌面端一致。

当前打包入口分散：npm tarball 落在仓库根目录，Windows exe 落在 `desktop/release5/`，GitHub release workflow 仍是旧的 `pkg` 单文件 CLI 方案。每次修复后需要人工记住构建顺序、版本同步、产物位置和验证命令，容易漏打 npm 包或漏打桌面包。

## 目标

建立一套固定发布流程，让后续只需要执行一条发布命令或推送一个 tag，就能按规范产出 npm、Windows exe 和 macOS dmg，并生成 manifest/checksum 方便确认与分发。

## 范围

### 范围内

- 统一本地发布入口：npm tarball、Windows exe、macOS dmg。
- 统一产物目录：`release-artifacts/v<version>/`。
- 发布前检查：版本一致、CHANGELOG 有当前版本、核心测试和类型检查通过。
- 生成 `manifest.json` 和 `checksums.txt`。
- 改造 GitHub Actions，让 tag 发布覆盖 npm、Windows、macOS 三类产物。
- 新增项目 Cursor skill，后续用户说“打包/发布/发版”时按同一流程执行。

### 范围外

- 不自动执行 `npm publish`，除非用户明确要求。
- 不自动创建 git tag、commit 或 push，除非用户明确要求。
- 不处理代码签名、公证或付费证书接入。
- 不新增普通 README；只新增本 PRD、设计文档和项目 skill。

## 用户故事

### US-1：本地快速出包

作为维护者，我希望在 Windows 开发机执行 `npm run release:build:all`，自动得到 npm tarball 和 Windows exe，并明确提示 macOS 包应在 macOS 或 CI 中构建。

### US-2：tag 自动发布

作为维护者，我希望推送 `v2.0.2` 这样的 tag 后，CI 自动构建 npm tarball、Windows exe、macOS x64/arm64 dmg，并上传到 GitHub Release。

### US-3：后续 AI 代理不再靠记忆

作为维护者，我希望项目内有 `.cursor/skills/release-agent-memory/SKILL.md`，后续让 AI “打包一下”时自动按规范做 preflight、构建、汇总 manifest，而不是散落执行命令。

## 成功标准

- `npm run release:preflight` 能检查版本、CHANGELOG、git 状态和 tag 状态。
- `npm run release:build:all` 在 Windows 上能生成：
  - `release-artifacts/v<version>/npm/agent-memory-<version>.tgz`
  - `release-artifacts/v<version>/windows/AgentMemory-Setup-<version>.exe`
  - `release-artifacts/v<version>/manifest.json`
  - `release-artifacts/v<version>/checksums.txt`
- macOS 环境执行同一命令时能额外生成 macOS dmg。
- tag 触发的 GitHub Actions 能把 npm、Windows、macOS 产物汇总到 GitHub Release。
- 发布 skill 能指导后续代理：不主动 publish、不主动 commit、不把临时产物散落到根目录。

## 风险与约束

- Windows 本机无法构建 macOS dmg，必须在 macOS runner 或 macOS 机器上完成。
- macOS arm64/x64 交叉构建能力依赖 electron-builder 和 native module 准备情况，CI 中需要保留平台矩阵。
- `npm ci` 当前依赖 lockfile；如果仓库刻意不提交 lockfile，CI 需要改用 `npm install`。
- 产物目录应保持 git ignore，避免把大文件误提交。
