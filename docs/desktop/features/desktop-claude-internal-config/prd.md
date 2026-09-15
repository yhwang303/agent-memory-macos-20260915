# 桌面端 Claude Internal 可配置化需求分析

## 背景

当前 `agent-memory` 的源码层已经可以通过环境变量切换到 `claude-code` 提供者，并兼容腾讯内网的 `claude-internal` 命令。

但桌面端安装包（Electron `exe`）仍然只支持 API 型提供商：

- `TIMIAI`
- `OpenAI`
- `Anthropic`

这导致用户虽然安装了桌面版，也无法在图形界面中配置 `claude-internal`，只能通过源码或手动改环境变量绕行，和桌面端“开箱即用”的目标不一致。

## 问题定义

当前桌面端存在三个问题：

1. 设置页没有 `claude-code / claude-internal` 选项。
2. 桌面端本地配置没有保存 CLI 路径的能力。
3. 桌面端启动 Worker 时没有透传 `CODEBUDDY_MEM_PROVIDER` 与 `CODEBUDDY_MEM_CLAUDE_CODE_PATH`。

结果是：**用户在 `exe` 中只能配置 API，不能自己配置本地 CLI provider。**

## 目标

1. 用户可以在桌面端设置页直接选择 `Claude Code` 模式。
2. 用户可以自己配置 CLI 路径，例如：
   - `claude`
   - `claude-internal`
   - `C:\Users\xxx\AppData\Roaming\npm\claude-internal.cmd`
3. 桌面端保存后可自动重启 Worker，并让新配置立即生效。
4. API 模式与现有用户配置保持兼容，不破坏旧行为。

## 用户故事

1. 作为腾讯内网用户，我希望在桌面版设置里直接选择 `Claude Code Internal`，并填写 `claude-internal` 或其路径，而不是改源码。
2. 作为外部用户，我希望仍然可以继续使用 `TIMIAI/OpenAI/Anthropic`，不受新配置影响。
3. 作为普通用户，我希望界面会根据 provider 自动显示相关字段，而不是总让我看到不适用的 API Key 输入框。

## 范围

### 包含

- 桌面端设置页增加 `Claude Code` provider
- 桌面端配置存储增加 CLI 路径字段
- Worker 启动环境变量透传 CLI provider 配置
- UI 根据 provider 动态切换字段显示
- 重新打包 Windows `exe`

### 不包含

- 自动探测系统中所有 Claude CLI 路径
- 自动安装 `claude` / `claude-internal`
- 在桌面端直接管理 Claude 登录态

## 功能需求

### FR-1 Provider 可选项扩展

桌面端“服务提供商”新增：

- `Claude Code`

### FR-2 CLI 路径可配置

当用户选择 `Claude Code` 时：

- 隐藏 API Key 输入框
- 显示 CLI 路径输入框
- 支持用户输入命令名或绝对路径

示例：

- `claude`
- `claude-internal`
- `C:\Users\cloudboyguo\AppData\Roaming\npm\claude-internal.cmd`

### FR-3 Worker 环境透传

当 provider 为 `claude-code` 时，桌面端启动 Worker 必须透传：

- `CODEBUDDY_MEM_PROVIDER=claude-code`
- `CODEBUDDY_MEM_CLAUDE_CODE_PATH=<用户配置值>`

并清空不相关的 API key 环境变量，避免混淆。

### FR-4 配置兼容

- 历史 API 用户升级后，原有配置继续可用
- 未配置 CLI 路径时，默认使用 `claude`

### FR-5 交互体验

- provider 切换后，表单动态变化
- `Claude Code` 模式下模型字段改为只读说明或禁用状态
- 保存后自动生效

## 验收标准

- [ ] `exe` 设置页中可看到 `Claude Code` provider
- [ ] 用户可输入 `claude-internal` 或绝对路径
- [ ] 保存设置后桌面端重启 Worker，日志显示使用 `claude-code` provider
- [ ] API provider 旧能力不受影响
- [ ] 重新打包后的 `exe` 包含上述能力
