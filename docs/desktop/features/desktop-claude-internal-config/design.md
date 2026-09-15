# 桌面端 Claude Code 配置设计（已重定向）

> **注意**：此文档原方案（将 Claude Code 作为 API Provider）已废弃。
> 
> 正确需求：将 Claude Code 作为第四种 IDE 接入 hooks 系统。
> 
> 相关设计已合并到 [claude-code-provider-design.md](./2026-04-08-claude-code-provider-design.md) 中。

## 桌面端需要的配置变更

桌面端 UI 需要在"IDE 管理"界面中新增 Claude Code 的注册/注销支持：

1. **IDEType 新增 `claude-code`**
2. **detectIDEs 新增 `~/.claude` 目录探测**
3. **设置页面展示 Claude Code IDE 选项**（与 CodeBuddy、Cursor、CodeBuddy IDE 并列）
4. **注册按钮**：向 `~/.claude/settings.json` 写入 hooks 配置
5. **注销按钮**：清除 hooks 配置中的 agent-memory 条目

不涉及 API Provider 选择器的任何修改，现有的 API Key / 模型配置界面完全不变。

## Claude Internal（腾讯内网版）支持

6. **IDEType 新增 `claude-internal`**
7. **detectIDEs 新增 `~/.claude-internal` 目录探测**
8. **设置页面 IDE 列表展示 Claude Internal 选项**（与 Claude Code 独立显示）
9. **IDE_LABEL 新增 `'claude-internal': 'Claude Internal'`**
10. **register/unregister 支持 `claude-internal` 类型**（写入 `~/.claude-internal/settings.json`）
11. **proxy cmd 使用独立文件名 `agentmemory-claude-internal-hook.cmd`**（避免与 Claude Code 官方版冲突）

两者 hooks 格式完全一致，仅配置目录不同。详细设计见 [claude-code-provider-design.md](./2026-04-08-claude-code-provider-design.md) 第十一章。
