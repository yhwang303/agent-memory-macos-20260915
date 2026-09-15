# Desktop macOS 打包需求分析

## 背景

当前仓库里的桌面端打包能力主要停留在 Windows 侧：

- `desktop/package.json` 虽然已经声明了 `build:mac`，但缺少可直接复用的 macOS 打包流程。
- 桌面端安装包依赖根目录 `dist/` 的 Worker 产物和 `build-resources/` 里的 Node 运行时，现有流程依赖人工预处理，容易出现漏构建或打入错误平台二进制的问题。
- 仓库中存在被纳管的 `desktop/build-resources/node.exe`，这类生成物会干扰跨平台打包。

这导致在 Windows 开发环境里，虽然可以维护桌面代码，但没有一条稳定、可重复执行的 macOS 出包链路。

## 问题定义

需要为桌面端补齐一套 macOS 打包流程，使仓库具备以下能力：

- 可以稳定产出 macOS 安装包（`.dmg`）。
- 本地脚本和 CI 流程都能自动准备 Worker 产物与当前平台的 Node 运行时。
- 不再依赖仓库里残留的 Windows 二进制文件来完成 macOS 打包。

## 目标

1. 提供可执行的 macOS 打包入口，支持至少一条标准流程成功产出 `.dmg`。
2. 让桌面端打包脚本自动构建根目录 Worker 产物，避免 `desktop/` 单独执行时拿到陈旧 `dist/`。
3. 在 CI 中增加 macOS runner 打包能力，支持从 Windows 开发机触发构建并下载产物。
4. 清理并忽略 `build-resources/` 下的临时 Node 二进制，避免跨平台污染。

## 非目标

- 本次不处理 macOS 应用签名与 notarization。
- 本次不接入自动发布到 GitHub Release。
- 本次不扩展 Linux 打包。

## 用户故事

- 作为项目维护者，我希望在仓库中直接触发 macOS 打包流程，而不是手动找一台 Mac 再拼接命令。
- 作为开发者，我希望执行桌面端打包脚本时，Worker 代码会自动先构建，避免把旧产物带进安装包。
- 作为发布人员，我希望 x64 和 arm64 的 macOS 包都能分开产出并清楚区分。

## 功能需求

### 1. 本地打包入口

- 桌面端需要保留 `build:mac` 入口。
- 额外提供可区分架构的入口，例如 `build:mac:x64` 与 `build:mac:arm64`。
- 打包前必须自动执行根目录构建，确保 `../dist` 为最新版本。

### 2. 构建资源管理

- `desktop/scripts/bundle-node.js` 在复制当前平台 Node 运行时前，必须先清理 `build-resources/` 下的旧二进制。
- `build-resources/` 必须加入忽略规则，避免生成物再次被纳管。

### 3. CI 打包流程

- 新增 GitHub Actions 工作流，支持手动触发。
- 工作流需要在 macOS runner 上安装根目录和 `desktop/` 的依赖。
- 工作流至少产出一个 `.dmg` 并作为 artifact 上传。
- 若支持多架构，artifact 名称需要能区分 x64 / arm64。

## 约束

- 仓库当前没有 lockfile，CI 不能依赖 `npm ci`，应使用 `npm install`。
- `better-sqlite3` 为原生模块，必须在对应平台 runner 上完成安装/重编译。
- 未配置 Apple 开发者证书时，CI 应以未签名方式出包，避免签名阶段失败。

## 验收标准

1. 在 `desktop/` 下执行 macOS 构建命令时，会先自动构建根目录 Worker，再开始 Electron 打包。
2. `build-resources/` 中只保留当前平台的 Node 二进制，不会混入历史平台文件。
3. 仓库新增 GitHub Actions macOS 打包工作流，触发后能上传 `.dmg` 产物。
4. 仓库中不再保留 `desktop/build-resources/node.exe` 这类生成二进制文件。
