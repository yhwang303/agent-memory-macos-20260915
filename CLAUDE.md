# Agent Memory - Project Instructions

## 沟通规范

- 当用户询问系统状态时，应主动检查端口、进程和健康检查接口，提供明确的运行状态报告

## 用户偏好

（暂无记录）

## 代码风格

（暂无记录）

## 工作流规范

（暂无记录）

## 技术栈偏好

（暂无记录）

<!-- self-evolve rules start -->
<!-- Last updated: 2026-05-29 by self-evolve -->

<!-- self-evolve:managed:start -->
## 工作流规范
- 每当 WorkerService 中新增 HTTP API endpoint，必须同步在 mcp-server.ts 中注册对应的 MCP tool。tool 名称使用 snake_case。

## 用户偏好
- 桌面端设置页中的任何异步操作必须：1) 操作期间禁用按钮并显示 loading；2) 失败时显示具体错误；3) 超时(>10s)时自动恢复按钮并提示。

## 技术栈偏好
- 插件（src/plugins/*/）不允许直接 import src/services/sqlite/Database.ts。必须通过 PluginContext.db 访问数据库，以保证表权限隔离和未来的可插拔性。

## 代码规范
- 在 TypeScript 代码中，优先使用 ?. 和 ?? 操作符，而非 if (obj && obj.prop) 的冗长写法。例外：需要区分 null 和 undefined 时。

<!-- self-evolve:managed:end -->
<!-- self-evolve rules end -->







