# PRD：桌面端 OpenClaw 关联

> 日期：2026-04-27
> 关联设计：`2026-04-27-desktop-openclaw-design.md`

## 背景

当前 npm 版已经通过 `agent-memory install openclaw` 支持 OpenClaw Gateway 集成，会写入 `~/.openclaw/plugins/agent-memory/config.json`。桌面 App 的“IDE 关联”只接入 CodeBuddy 插件版、Cursor、CodeBuddy IDE、Claude Code 等 hooks 型 IDE，未展示 OpenClaw，导致本机已有 OpenClaw 时 App 版无法扫描和关联。

## 目标

让桌面 App 能检测本机 OpenClaw，并通过设置页一键写入 OpenClaw 插件配置，便于对比测试 npm 版和 App 版。

## 范围

### 范围内

- 设置页“IDE 关联”展示 OpenClaw Gateway。
- 检测 `~/.openclaw` 配置目录，或 `openclaw` 命令是否存在。
- 点击“关联/安装”时写入 `~/.openclaw/plugins/agent-memory/config.json`。
- 点击“断开/移除”时删除 App 写入的 OpenClaw 插件配置。
- 默认配置指向桌面端 worker：`127.0.0.1:<当前端口>`。

### 范围外

- 不实现 OpenClaw 插件代码分发格式调整。
- 不改 npm 版 `OpenClawInstaller` 的现有行为。
- 不新增 OpenClaw 服务器或 Gateway 启停管理。
- 不处理通知渠道 token 配置。

## 用户故事

- 作为维护者，我希望打开桌面 App 设置页时能看到 OpenClaw Gateway 是否已检测到。
- 作为维护者，我希望点击关联后能直接让 OpenClaw 使用桌面 worker 的记忆能力。
- 作为维护者，我希望 npm 版和 App 版可以分别测试同一个 OpenClaw 配置落点。

## 成功标准

- 本机存在 `~/.openclaw` 或 `openclaw` 命令时，设置页展示 OpenClaw Gateway。
- 关联后生成 `~/.openclaw/plugins/agent-memory/config.json`。
- 状态显示从“未关联”变为“已关联”。
- 桌面端 TypeScript 构建通过。
