# Desktop macOS 打包设计

## 设计目标

围绕现有 Electron 桌面端，补齐一条稳定的 macOS 打包链路，同时尽量复用现有 Windows 打包配置，避免引入另一套独立发布体系。

## 现状分析

当前桌面端的 `electron-builder` 配置已经包含：

- `mac.target = dmg`
- `mac.icon = src/assets/icon.png`

但要真正形成可执行流程，还缺三件事：

1. 打包命令没有自动构建根目录 Worker，`extraResources.from = ../dist` 依赖手工准备。
2. `build-resources/` 中的 Node 运行时是生成物，当前仓库里残留了 Windows 的 `node.exe`。
3. 没有 macOS CI 工作流，Windows 开发机无法直接触发出包。

## 方案概览

### 1. 统一打包前置步骤

在 `desktop/package.json` 中抽出统一前置脚本：

- `prepare:worker`: 执行 `npm --prefix .. run build`
- `prepare:bundle`: 顺序执行 Worker 构建、桌面端 TS 构建、Node 运行时打包

随后让以下命令都复用这条前置链路：

- `build`
- `build:win`
- `build:mac`
- `build:mac:x64`
- `build:mac:arm64`

这样无论本地还是 CI，只要执行桌面端构建命令，就会拿到最新的根目录 `dist/`。

### 2. 清理 `build-resources/` 中的旧平台二进制

调整 `desktop/scripts/bundle-node.js`：

- 每次构建前先删除 `build-resources/node.exe` 和 `build-resources/node`
- 再根据当前 `process.platform` 复制 `process.execPath`

这样可以保证：

- Windows 打包时只会留下 `node.exe`
- macOS 打包时只会留下 `node`
- 同一个工作区切换平台构建时，不会把旧平台文件带进包里

同时将 `desktop/build-resources/` 加入 `.gitignore`，并移除仓库中已纳管的 `node.exe`。

### 3. 增加 GitHub Actions macOS 工作流

新增 `.github/workflows/desktop-macos-package.yml`，采用矩阵构建：

- `macos-13` 构建 `x64`
- `macos-14` 构建 `arm64`

每个 job 的执行步骤：

1. `actions/checkout`
2. `actions/setup-node` 安装 Node 20
3. 根目录 `npm install`
4. `desktop/` 目录 `npm install`
5. 执行 `npm run build:mac:x64` 或 `npm run build:mac:arm64`
6. 上传 `desktop/release/` 下的构建产物作为 artifact

### 4. 未签名出包策略

由于当前仓库没有 Apple 开发者证书配置，工作流内显式设置：

- `CSC_IDENTITY_AUTO_DISCOVERY=false`

这样 `electron-builder` 会跳过自动签名发现流程，优先保证 `.dmg` 能产出。对应风险是：

- 安装包为未签名产物
- 最终用户首次打开时可能看到 Gatekeeper 警告

该问题属于后续“签名 / notarization”专题，不纳入本次变更。

## 关键实现点

### 包名区分

为 `mac` 目标增加：

- `artifactName: "AgentMemory-${version}-${arch}.${ext}"`

目的：

- CI 同时上传 `x64` 与 `arm64` 产物时更容易区分
- 下载端无需靠 runner 名称猜测架构

### 为什么不用单个 `build:mac`

保留 `build:mac` 作为默认入口，但 CI 选择按架构显式调用：

- `build:mac:x64`
- `build:mac:arm64`

这样能减少 runner 默认架构变化带来的不确定性。

## 验证方案

### 静态验证

- 检查 `desktop/package.json` 中新的脚本链路是否闭环
- 检查 `.github/workflows/desktop-macos-package.yml` 是否引用正确目录
- 检查 `.gitignore` 和仓库文件删除是否生效

### 本地验证

在支持的环境中执行：

```bash
cd desktop
npm install
npm run build:mac
```

期望结果：

- 根目录 `dist/` 被重新构建
- `desktop/build-resources/` 中仅保留当前平台对应的 Node 二进制
- `desktop/release/` 下出现 `.dmg`

### CI 验证

手动触发 `Desktop macOS Package` 工作流，期望：

- `x64` 和 `arm64` 两个 job 均能完成
- 每个 job 都上传一份 `desktop-release-macos-*` artifact

## 风险与后续

- 未签名 `.dmg` 可用于内部验证和测试分发，但不适合直接作为面向外部用户的正式发布方案。
- 若后续需要正式商用分发，应继续补：
  - Apple Developer 证书接入
  - notarization
  - GitHub Release 自动上传
