# Claude-code CLI 提供者 需求分析

## 背景

当前 agent-memory 的记忆梳理（Observation 提取 + Summary 生成）完全依赖 OpenAI 兼容的 HTTP API（默认为腾讯 TIMIAI 平台）。这意味着用户必须持有 API Key 且能访问对应端点，才能让记忆系统正常工作。

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) 是 Anthropic 官方提供的 AI 编程助手 CLI 工具，用户在本地安装并登录后可直接使用 `claude` 命令调用 Claude 模型，**无需配置 API Key 或管理额度**（按 Anthropic 账号订阅计费）。

腾讯内网场景下还存在 `claude-internal` 命令。它是对 Claude Code 的内部封装，参数形式与官方 `claude` 略有差异，尤其是在 `-p` 非交互模式下更适合通过**位置参数**传入 prompt，而不是仅依赖 stdin。

## 问题与机会

| 问题 | 当前影响 |
|------|---------|
| 依赖 HTTP API Key | 新用户配置门槛高，企业防火墙可能拦截 |
| 默认端点为腾讯内部服务 | 外部用户无法使用默认配置 |
| 无离线/本地模式 | 无法在没有外网的环境中运行 |

**机会**：支持 Claude Code CLI 作为备用 AI 提供者，用户只需安装 claude CLI 并完成 Anthropic 登录，即可零配置启动记忆系统。

## 目标

1. **支持 claude CLI 作为 AI 后端**：通过调用 `claude` 命令行工具执行记忆提取和会话总结，与 HTTP API 路径完全等效。
2. **低配置门槛**：用户只需设置一个环境变量 `CODEBUDDY_MEM_PROVIDER=claude-code` 即可切换到 CLI 模式。
3. **与现有流程兼容**：Prompt 模板、XML 解析逻辑、数据库写入等完全复用，无需修改。
4. **健壮的错误处理**：超时控制、进程异常退出、claude 未安装等情况均有明确错误提示。

## 用户故事

1. **作为一名外部开发者**，我已安装 claude CLI 并登录 Anthropic 账号，我希望不配置任何 API Key 就能让 agent-memory 正常工作，所以我只需要设置 `CODEBUDDY_MEM_PROVIDER=claude-code`。
2. **作为一名企业用户**，公司网络无法访问 TIMIAI 等 API 端点，但我可以使用已部署的 claude CLI，我希望系统能通过 CLI 方式调用 AI。
3. **作为一名开发者**，当 HTTP API 调用失败时，我希望系统能提供清晰的错误信息，而不是静默失败。

## 非目标

- 不支持 claude CLI 的流式输出（当前记忆提取不需要流式处理）
- 不实现 claude CLI 的自动安装逻辑
- 不支持通过 MCP 工具调用 claude（当前不需要工具调用能力）
- 不修改 Prompt 内容（完全复用现有模板）

## 功能需求

### FR-1 提供者切换机制

- 通过环境变量 `CODEBUDDY_MEM_PROVIDER` 选择 AI 提供者：
  - `api`（默认）：调用 HTTP OpenAI 兼容 API（当前行为）
  - `claude-code`：调用本地 claude CLI

### FR-2 claude CLI 调用

- 支持通过 `CODEBUDDY_MEM_CLAUDE_CODE_PATH` 自定义 claude 二进制路径（默认为 `claude`，腾讯内网可配置为 `claude-internal`）
- 以非交互模式（`-p` flag）调用 claude CLI
- 官方 `claude` 默认通过 stdin 传入 prompt；`claude-internal` 通过位置参数传入 prompt
- 输出格式为纯文本
- 支持超时控制（复用 `CODEBUDDY_MEM_TIMEOUT` 配置）

### FR-3 启动自检

- Worker 启动时对 claude-code 提供者执行连通性验证：
  - 检查 `claude` 命令是否可用
  - 发送简单测试 prompt 验证是否能正常响应
  - 验证失败时输出明确错误日志，但不阻止 Worker 启动

### FR-4 错误处理

| 场景 | 期望行为 |
|------|---------|
| claude 命令未找到 | 抛出明确错误：`claude CLI not found, please install it` |
| claude 进程超时 | kill 子进程，抛出超时错误 |
| claude 非零退出码 | 抛出含 stderr 内容的错误 |
| claude 输出为空 | 抛出空响应错误 |

## 配置项总览

| 环境变量 | 默认值 | 说明 |
|---------|-------|------|
| `CODEBUDDY_MEM_PROVIDER` | `api` | AI 提供者：`api` 或 `claude-code` |
| `CODEBUDDY_MEM_CLAUDE_CODE_PATH` | `claude` | claude CLI 二进制路径；腾讯内网可设为 `claude-internal` |
| `CODEBUDDY_MEM_TIMEOUT` | `60000` | 调用超时（ms），对两种提供者均生效 |

## 验收标准

- [ ] 设置 `CODEBUDDY_MEM_PROVIDER=claude-code` 后，Observation 提取和 Summary 生成均通过 claude CLI 完成
- [ ] 与 HTTP API 模式产出的数据格式完全一致（XML 解析通过）
- [ ] claude 命令不存在时给出可读错误提示
- [ ] 超时场景能正确 kill 子进程并上报错误
- [ ] 默认行为（HTTP API 模式）不受影响
