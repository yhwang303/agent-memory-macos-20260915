# 项目对比报告：rohitg00/agentmemory vs AgentMemory (agent-memory)

> 生成日期：2026-05-13

## 一、项目概览

| 维度 | rohitg00/agentmemory | AgentMemory (agent-memory) |
|------|---------------------|------------------------------|
| **GitHub** | https://github.com/rohitg00/agentmemory | 私有仓库 (E:\Github\agent-memory) |
| **包名** | `@agentmemory/agentmemory` | `agent-memory` |
| **版本** | v0.9.11 | v2.0.7 |
| **作者** | Rohit Ghumare | 内部团队 |
| **许可证** | Apache-2.0（宽松，商业友好） | AGPL-3.0-only（强 copyleft） |
| **定位** | 通用 AI Agent 持久化记忆系统 | 面向 CodeBuddy 的无头记忆客户端插件 |
| **语言** | TypeScript (ESM) | TypeScript (ESM) |
| **运行时** | Node.js >= 20 | Node.js >= 18 |

---

## 二、核心架构对比

### 2.1 引擎/运行时

| 维度 | rohitg00/agentmemory | AgentMemory |
|------|---------------------|---------------|
| **核心引擎** | **iii-engine**（独立进程，WebSocket 通信，端口 49134） | **内嵌 Express.js Worker Service**（HTTP API，端口 3847） |
| **架构模式** | Function/Trigger/Worker 三原语模型（`sdk.registerFunction`、`sdk.registerTrigger`） | Hooks → Worker → AI SDK → SQLite 直连管道 |
| **状态管理** | iii-engine StateModule（KV 存储，SQLite 文件） | 直接使用 better-sqlite3 操作 SQLite |
| **进程模型** | iii-engine 独立守护进程 + agentmemory 注册为 worker | 单进程 Worker Service (Express) |
| **Docker 支持** | 完整 docker-compose（iii-engine + init 容器 + 卷管理） | 无 Docker 配置 |

**关键差异：** rohitg00 的架构依赖 iii-engine 作为基础设施层，所有功能通过 Function/Trigger 原语注册；AgentMemory 采用更传统的 Express.js 微服务架构，没有外部引擎依赖。

### 2.2 数据流

**rohitg00/agentmemory:**
```
IDE Hook Scripts (standalone Node.js, stdin JSON)
       ↓ HTTP REST
[iii-engine API (port 3111)]
       ↓ WebSocket
[Registered Functions (mem::observe, mem::compress, etc.)]
       ↓
[KV State Store (iii-engine managed SQLite)]
       ↓
[MCP Server / REST API / Viewer]
```

**AgentMemory:**
```
IDE Adapters (TypeScript, 内嵌进程)
       ↓ HTTP REST
[Express Worker Service (port 3847)]
       ↓ 直调
[AI SDK Client (OpenAI/Anthropic/Tencent)]
       ↓ XML 解析
[SQLite (better-sqlite3 直连)]
       ↓
[MCP Server / REST API / Web Viewer]
```

---

## 三、功能模块对比

### 3.1 MCP Tools

| 维度 | rohitg00/agentmemory | AgentMemory |
|------|---------------------|---------------|
| **MCP 工具数** | **44 个**（8 个默认可见，`AGENTMEMORY_TOOLS=all` 开启全部） | 约 5-8 个（search, timeline, context 等） |
| **MCP Resources** | 6 个 | 无 |
| **MCP Prompts** | 3 个 | 无 |
| **工具注册机制** | `src/mcp/tools-registry.ts` 集中注册 | `src/servers/mcp-server.ts` 直接定义 |

### 3.2 核心功能

| 功能 | rohitg00/agentmemory | AgentMemory |
|------|---------------------|---------------|
| **观察记录** | ✅ `mem::observe` + 压缩 | ✅ Hook 捕获 + AI 压缩 |
| **会话管理** | ✅ 完整生命周期 | ✅ 完整生命周期 |
| **全文搜索** | ✅ BM25 + 混合搜索 + 查询扩展 | ✅ FTS5 全文搜索 |
| **向量搜索** | ✅ 多 Provider（OpenAI/Cohere/Gemini/Voyage/本地 ONNX） | ❌ 无向量搜索 |
| **知识图谱** | ✅ 时序图 + 图检索 | ❌ 无 |
| **记忆压缩/结晶** | ✅ `mem::crystallize` + `mem::consolidate` + 流式压缩 | ✅ AI 压缩为 Observation |
| **自动遗忘** | ✅ `mem::auto-forget` + 基于访问频率的淘汰 | ❌ 无自动遗忘 |
| **记忆去重** | ✅ `fingerprintId()` 内容寻址去重 | ❌ 无 |
| **分支感知** | ✅ `mem::branch-aware` — Git 分支级别记忆隔离 | ❌ 无 |
| **隐私管理** | ✅ `mem::privacy` 隐私策略 | ❌ 无 |
| **审计日志** | ✅ `mem::audit` + 审计策略文档 | ❌ 无 |
| **治理/RBAC** | ✅ 有规划（Q4 2026） | ❌ 无 |
| **导出/导入** | ✅ `mem::export-import` + Obsidian 导出 | ❌ 无 |
| **健康监控** | ✅ `src/health/monitor.ts` + 阈值告警 | ❌ 基础 health check |
| **遥测** | ✅ OpenTelemetry 集成 | ❌ 无 |
| **评估系统** | ✅ `src/eval/` — 质量评估 + 自纠正 + 指标存储 | ❌ 无 |
| **Benchmark** | ✅ LongMemEval 基准测试（95.2% R@5） | ❌ 无 |
| **工作记忆** | ✅ `mem::working-memory` — 短期 + 长期分层 | ❌ 扁平存储 |
| **记忆槽** | ✅ `mem::slots` — 固定槽位注入 | ❌ 无 |
| **模式识别** | ✅ `mem::patterns` + `mem::routines` | ❌ 无 |
| **哨兵/信号** | ✅ `mem::sentinels` + `mem::signals` | ❌ 无 |
| **图像记忆** | ✅ 多模态（CLIP嵌入 + 视觉搜索 + 图像存储 + 配额管理） | ✅ 基础图像上下文保留 |
| **上下文注入** | ✅ 智能上下文构建 | ✅ ContextBuilder + HistoryRetriever |
| **Web Viewer** | ✅ 内置 viewer server | ✅ Web Viewer (HTML/JS) |

### 3.3 IDE/Agent 支持

| 维度 | rohitg00/agentmemory | AgentMemory |
|------|---------------------|---------------|
| **Hook 数量** | 12 个 | 11 个 |
| **Skill 数量** | 4 个（forget/recall/remember/session-history） | 无 |
| **Claude Code** | ✅ Plugin 插件 | ✅ Adapter |
| **Codex CLI** | ✅ Plugin 插件 | ❌ |
| **Cursor** | ❌ | ✅ Adapter |
| **Windsurf** | ❌ | ✅ Adapter |
| **OpenClaw** | ✅ 集成 | ✅ Adapter |
| **Gemini CLI** | ❌ | ✅ Adapter |
| **Copilot CLI** | ❌ | ✅ Adapter |
| **Goose/Crush/Roo** | ❌ | ✅ Adapter |
| **Hermes** | ✅ 集成（Python） | ❌ |
| **Pi** | ✅ 集成 | ❌ |
| **Adapter 总数** | 3-4 | **13+** |

---

## 四、代码规模对比

| 维度 | rohitg00/agentmemory | AgentMemory |
|------|---------------------|---------------|
| **src/ TS 文件数** | ~140 | ~95 |
| **src/ 代码行数** | ~29,055 行 | ~15,534 行 |
| **测试文件数** | 86 | 25+ |
| **测试代码行数** | ~19,284 行 | ~5,188 行 |
| **测试用例数** | 699+ | 未统计 |
| **REST 端点数** | 104 | ~15 |
| **src/ 模块数** | 14 个子目录 | 13 个子目录 |

### 代码量总结

rohitg00/agentmemory 的源代码量约为 AgentMemory 的 **1.87 倍**，测试代码量约为 **3.72 倍**。rohitg00 在功能丰富度和测试覆盖率上明显更高。

---

## 五、AI Provider 对比

| Provider | rohitg00/agentmemory | AgentMemory |
|----------|---------------------|---------------|
| **Anthropic (Claude)** | ✅ | ✅ |
| **OpenAI (GPT-4o)** | ❌（通过 OpenRouter） | ✅ |
| **Tencent TIMIAI** | ❌ | ✅ |
| **OpenRouter** | ✅ | ❌ |
| **MiniMax** | ✅ | ❌ |
| **Cohere (Embedding)** | ✅ | ❌ |
| **Gemini (Embedding)** | ✅ | ❌ |
| **Voyage (Embedding)** | ✅ | ❌ |
| **本地 ONNX (Embedding)** | ✅ (@xenova/transformers) | ❌ |
| **CLIP (图像嵌入)** | ✅ | ❌ |
| **Agent SDK** | ✅ (@anthropic-ai/claude-agent-sdk) | ❌ |
| **Fallback Chain** | ✅ 弹性降级 + 断路器 | ❌ |

---

## 六、项目生态对比

| 维度 | rohitg00/agentmemory | AgentMemory |
|------|---------------------|---------------|
| **npm 包** | 3 个（主包 + MCP + fs-watcher） | 1 个（agent-memory） |
| **官方网站** | ✅ Next.js on Vercel | ❌ |
| **桌面应用** | ❌ | ✅ Electron 系统托盘 |
| **Plugin 系统** | ✅ `.claude-plugin` + `.codex-plugin` 标准插件 | ✅ plugins/ 目录（ShadowFolk） |
| **连接器** | ✅ fs-watcher, GitHub (计划中) | ❌ |
| **社区治理** | ✅ GOVERNANCE.md + CONTRIBUTING.md + CODE_OF_CONDUCT.md + SECURITY.md | ❌ |
| **公开路线图** | ✅ 12 个月路线图（Q2 2026 - Q1 2027） | ❌ |
| **CI/CD** | ✅ CI + 多平台 Release + npm 发布 | ✅ CI + 多平台 Release |
| **Benchmark** | ✅ LongMemEval + Quality + Scale + Real Embeddings | ❌ |
| **文档站** | ✅ 含 README 52K+ 字 | ✅ README + PROJECT_OVERVIEW + QUICKSTART |

---

## 七、依赖对比

### rohitg00/agentmemory 核心依赖
```json
{
  "@anthropic-ai/claude-agent-sdk": "^0.2.56",
  "@anthropic-ai/sdk": "^0.39.0",
  "@clack/prompts": "^1.2.0",
  "dotenv": "^16.4.7",
  "iii-sdk": "^0.11.2",         // 核心引擎SDK
  "zod": "^4.0.0"
}
// 可选: @xenova/transformers, onnxruntime-node/web
```

### AgentMemory 核心依赖
```json
{
  "@modelcontextprotocol/sdk": "^1.25.1",
  "better-sqlite3": "^12.6.2",    // SQLite 直连
  "express": "^4.18.2",           // HTTP 服务
  "iconv-lite": "^0.7.2"
}
```

**关键差异：** rohitg00 依赖 `iii-sdk` 作为核心运行时，AgentMemory 依赖 `express` + `better-sqlite3` 自建服务。rohitg00 的依赖更轻量（运行时依赖仅 6 个），但需要额外启动 iii-engine 进程。

---

## 八、src/ 目录结构对比

### rohitg00/agentmemory (14 模块)
```
src/
├── eval/              # 质量评估 & 自纠正（独有）
├── functions/         # 70+ iii-engine functions（核心业务逻辑，独有）
├── health/            # 健康监控 & 阈值（独有）
├── hooks/             # 生命周期钩子
├── mcp/               # MCP 服务器
├── prompts/           # AI 提示词模板
├── providers/         # 多 AI Provider + Embedding Provider（独有）
├── replay/            # 会话回放（独有）
├── state/             # 混合搜索 + 向量索引 + 状态管理（独有）
├── telemetry/         # OpenTelemetry（独有）
├── triggers/          # REST API + 事件触发器
├── utils/             # 工具函数
├── viewer/            # Web 可视化
└── [顶层文件]         # cli.ts, config.ts, auth.ts, types.ts 等
```

### AgentMemory (13 模块)
```
src/
├── adapters/          # 13+ IDE 适配器（独有优势）
├── bin/               # CLI 入口
├── cli/               # 安装向导 & CLI
├── config/            # 配置加载
├── hooks/             # 生命周期钩子
├── integrations/      # 外部集成（ShadowFolk）
├── sdk/               # AI SDK 客户端（OpenAI/Anthropic/Tencent）
├── servers/           # MCP 服务器
├── services/          # Worker + SQLite + Context 服务
├── shared/            # 共享工具（paths, logger）
├── types/             # TypeScript 类型定义
├── utils/             # 工具函数
└── [无独立 viewer 目录]
```

---

## 九、核心差异总结

### rohitg00/agentmemory 的优势

1. **功能深度远超** — 44 个 MCP Tools、70+ iii Functions、知识图谱、向量搜索、自动遗忘、记忆去重、分支感知等高级功能
2. **搜索能力强大** — BM25 + 向量搜索 + 混合搜索 + 查询扩展 + reranker，支持 7 种 Embedding Provider
3. **多模态记忆** — CLIP 嵌入、视觉搜索、图像配额管理
4. **工程质量高** — 699+ 测试用例、LongMemEval 基准测试（95.2% R@5）、OpenTelemetry 遥测
5. **社区建设完善** — Apache-2.0 开源、公开路线图、社区治理文档、官方网站、Benchmark 透明
6. **弹性架构** — Provider fallback chain + 断路器 + 弹性调用
7. **Docker 原生** — 完整 docker-compose 部署方案

### AgentMemory 的优势

1. **IDE 覆盖面广** — 13+ IDE/Agent 适配器 vs rohitg00 的 3-4 个集成
2. **桌面应用** — Electron 系统托盘管理（rohitg00 没有）
3. **架构简单** — 无外部引擎依赖，Express + SQLite 一键启动
4. **中国市场适配** — 支持腾讯 TIMIAI API、中文注释/文档
5. **部署门槛低** — 不需要额外的 iii-engine 守护进程
6. **ShadowFolk 插件** — 桌面端云同步/上传功能

### 共同点

1. 都是 **TypeScript/Node.js** 技术栈
2. 都采用 **Hook 系统**捕获 IDE 生命周期事件
3. 都通过 **AI 压缩**原始操作为结构化 Observation
4. 都提供 **MCP Server** 支持
5. 都有 **Web Viewer** 可视化
6. 都支持 **Claude Code** 集成
7. 都使用 **SQLite** 作为本地存储

---

## 十、设计理念差异

| 维度 | rohitg00/agentmemory | AgentMemory |
|------|---------------------|---------------|
| **设计哲学** | "深度优先" — 追求记忆系统的完备性和学术级搜索质量 | "广度优先" — 追求最大化 IDE 覆盖和用户易用性 |
| **抽象层次** | 高度抽象（iii-engine 三原语） | 务实直接（Express + SQLite） |
| **开源策略** | Apache-2.0，社区驱动，标准 Foundation 路径 | AGPL-3.0，商业保护，内部主导 |
| **可扩展性** | 通过 iii-engine 注册新 Function/Trigger | 通过添加 Adapter/Plugin |
| **目标用户** | 开源社区 + 企业自部署 | CodeBuddy 生态 + 多 IDE 用户 |
| **成熟度** | v0.x（功能快速迭代中） | v2.x（产品化阶段） |

---

## 十一、可借鉴/参考的功能点

以下是 rohitg00/agentmemory 中 AgentMemory **尚未实现但值得关注**的功能：

| 优先级 | 功能 | 价值 |
|--------|------|------|
| 🔴 高 | **向量搜索 + 混合检索** | 显著提升记忆召回质量，当前仅有 FTS5 |
| 🔴 高 | **记忆去重** (`fingerprintId`) | 避免重复 Observation 占用存储和干扰检索 |
| 🟡 中 | **自动遗忘 + 访问频率淘汰** | 防止数据库无限膨胀 |
| 🟡 中 | **分支感知** | Git 分支级别记忆隔离，避免跨分支信息污染 |
| 🟡 中 | **记忆结晶/压缩** | 长期记忆层级化管理 |
| 🟡 中 | **工作记忆（短期/长期分层）** | 更智能的上下文窗口管理 |
| 🟢 低 | **Benchmark 系统** | 量化记忆质量，有助于优化迭代 |
| 🟢 低 | **Obsidian 导出** | 增加数据可移植性 |
| 🟢 低 | **OpenTelemetry** | 生产环境可观测性 |
| 🟢 低 | **Docker 部署** | 降低服务端部署复杂度 |

---

*本报告通过对比两个项目的源码、文档、配置和 Git 历史自动生成。*
