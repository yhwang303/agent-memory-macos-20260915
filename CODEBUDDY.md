# AgentMemory 项目说明

## 项目概述

这是一个为 CodeBuddy Agent 提供跨会话持久化记忆的插件系统。

## 核心架构

用户操作 CodeBuddy Agent
       |
[Hook Plugin Layer] 捕获 11 种生命周期事件
       | (HTTP)
[Worker Service] Express API 处理
       |
[SDK Agent] AI 子进程压缩为结构化观察
       | (XML 解析)
[Storage] SQLite + ChromaDB 持久化
       |
[ContextBuilder] 下次会话注入上下文

## 目录结构

- src/hooks/ - CodeBuddy Hook 处理器
- src/sdk/ - AI SDK prompts 和 parser
- src/services/sqlite/ - 数据库操作
- src/services/worker/ - Worker HTTP 服务
- src/services/context/ - 上下文构建
- src/servers/ - MCP Server
- src/types/ - TypeScript 类型定义

## 关键文件

| 文件 | 职责 |
|-----|------|
| src/hooks/index.ts | Hook 入口和路由 |
| src/sdk/prompts.ts | AI 提示词构建 |
| src/sdk/parser.ts | XML 响应解析 |
| src/services/worker/WorkerService.ts | Worker 主服务 |
| src/services/sqlite/SessionStore.ts | 会话存储 |
| src/services/context/ContextBuilder.ts | 上下文构建 |
| src/servers/mcp-server.ts | MCP 搜索服务 |

## 数据库表

- sessions - 会话记录
- observations - 观察记录（核心）
- summaries - 会话总结
- pending_messages - 待处理消息队列

## 开发规范

1. 所有 Hook 处理器返回 JSON 格式
2. Worker API 使用 RESTful 风格
3. 错误处理使用统一的 Error 类型
4. 日志使用分级输出（debug/info/warn/error）

## 文档管理规则

本仓库的 `docs/` 按 **模块 → features/bugs → 需求目录** 三级组织。
任何 PRD、设计文档、bug 分析都必须遵守此范式，**source of truth 在 [docs/README.md](docs/README.md)**。

新增文档时：

1. 不要在 `docs/` 根目录直接创建文件
2. 不要使用日期前缀命名需求目录（如 `2026-05-14-xxx/`），日期信息进 git 历史
3. 需求目录内文件名只允许：`prd.md` / `design.md` / `plan.md` / `analysis.md`（及同名 `.pdf` 附件）
4. 优先调用 Skill：
   - 新功能/演进 → `/add-feature-doc`
   - bug/缺陷分析 → `/add-bug-doc`
5. 不确定归属哪个模块时，按 [docs/README.md §二](docs/README.md) 的边界判定原则；横跨多模块时归到主要落地模块，其他用相对链接交叉引用，不复制文档
6. 新增需求后同步更新 `docs/README.md` 的"当前模块索引"节
