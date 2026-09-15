# 需求文档：Self-Evolve 内置插件

> 日期：2026-05-23
> 关联设计：[design.md](./design.md)

## 背景

Agent-Mem 目前解决的是**情景记忆**问题：捕获每次 Agent 会话里发生了什么（shell 命令、文件编辑、MCP 调用），压缩成结构化 observation，下次会话时自动注入上下文。

Self-Evolve 解决的是**语义记忆**问题：从会话历史中提炼出值得长期复用的工作规范（Rules）和技能（Skills），写回 IDE 配置文件，让 Agent 在任何会话里都能遵循这些规范。

两者**高度互补**：Agent-Mem 记录"历史上做了什么"，Self-Evolve 提炼"以后应该怎么做"。两者目前是独立项目，用户需要安装、配置、维护两套服务，存在以下痛点：

- 两套 Hooks 需要分别注册到 IDE，新 IDE 适配要做两遍
- 两个后台进程（port 3847 + port 3849），两份 SQLite 数据库，两份配置文件
- 两个 Web Viewer，两套 MCP 工具，体验割裂
- Self-Evolve 依赖 Agent-Mem 已经捕获的原始事件，数据来源有重叠

本期目标：**将 Self-Evolve 的核心能力以内置插件的形式嵌入 Agent-Mem**，复用已有的 Hooks、会话数据、进程、配置和 UI，消除重复。

---

## 目标

1. 用户安装 Agent-Mem 后**无需额外安装 Self-Evolve**，即可获得 Rules/Skills 自动进化能力。
2. 会话结束后，进化引擎自动从 Agent-Mem 已存储的 observations 中提炼 Rules/Skills，**无需额外的 Hook 注册**。
3. 所有配置在 Agent-Mem 的单一配置文件中管理，新增 `plugins.selfEvolve` 配置块。
4. Rules/Skills 可在 Agent-Mem 的 Web Viewer 中查看和审核，**无需单独打开 Self-Evolve Viewer**。
5. Self-Evolve 的 MCP 工具（get_rules、get_skills、approve/reject）通过 Agent-Mem 的 MCP Server 暴露。

---

## 范围

### 范围内

- **插件模块** `src/plugins/self-evolve/`：移植 EvolveEngine、CriticEngine、PlatformWriter、ContextBuilder 核心引擎，适配 Agent-Mem 的数据层
- **数据库扩展**：在 Agent-Mem 的 SQLite 中新增 `evolved_rules`、`evolved_skills`、`evolution_log`、`natural_selection` 四张表
- **Worker 桥接**：会话结束（`runSummaryFlow` 完成）后自动触发 `SelfEvolvePlugin.evolveSession()`
- **数据输入适配**：EvolveEngine 改为消费 Agent-Mem 的 observations + session summary（替代原始的 prompt/response/file_edit/shell events）
- **配置扩展**：`settings.ts` 增加 `SelfEvolvePluginConfig` 类型和读取逻辑
- **MCP 工具扩展**：Agent-Mem 的 MCP Server 增加 `get_rules`、`get_skills`、`get_evo_history`、`approve_artifact`、`reject_artifact` 五个工具
- **Web Viewer 扩展**：现有 `viewer.html` 增加 Rules、Skills、Evolution Log 三个标签页
- **手动触发 API**：`POST /api/self-evolve/trigger`、`GET /api/self-evolve/status`
- **人工审核 API**：`GET /api/self-evolve/review/pending`、`POST /api/self-evolve/review/approve`、`POST /api/self-evolve/review/reject`
- **文档**：更新 README、添加配置说明

### 范围外

- Self-Evolve 独立安装包、安装脚本（`scripts/setup.mjs` 等）不迁移
- Self-Evolve 的 Windows 托盘管理（`TrayManager.ts`）不迁移（Agent-Mem 有自己的托盘）
- Self-Evolve 独立 HTTP 服务（port 3849）不保留，功能全部合并进 Agent-Mem Worker
- 不维护 Self-Evolve 旧数据库（`~/.self-evolve/self-evolve.db`）的兼容性
- CriticEngine 的定期审计调度器（`critic.schedule_interval_ms`）**本期暂缓**，仅支持生成时即时审计
- Natural Selection（用户自定义约束）管理 UI 本期不做，仅支持通过 API 和配置文件操作
- 不改动现有 IDE Adapter（8 个适配器无需修改）
- 不修改现有 Hook 处理逻辑

---

## 用户故事

**U1 · 自动进化**
作为 Agent-Mem 用户，当我完成一次 Bug 修复会话后，我希望系统自动分析这次会话并提炼出一条"排查此类 Bug 的规范"，下次 Agent 会话时无需我再解释同样的背景。

**U2 · 统一管理**
作为用户，我不想同时维护两个后台进程和两份配置文件。我希望在 Agent-Mem 的设置界面里打开或关闭 Self-Evolve 功能。

**U3 · 规则审核**
作为对 AI 自动生成内容有质量要求的用户，我希望进化后的 Rules/Skills 先进入待审核状态，我在 Viewer 里批准后才写入 IDE 配置文件。

**U4 · 透明可查**
作为用户，我希望在同一个 Viewer 里同时看到历史 observations 和当前生效的 Rules/Skills，理解为什么 Agent 会遵守某条规范（能追溯到哪次会话触发了它）。

**U5 · 无感降级**
作为用户，我关闭 Self-Evolve 插件后，Agent-Mem 的记忆功能完全不受影响，只是不再自动进化 Rules/Skills。

**U6 · 跨平台写入**
作为同时使用 Claude Code 和 Cursor 的用户，我希望进化的 Rules 能同时写入 `CLAUDE.md` 和 `.cursor/rules/self-evolved.mdc`，不需要手动维护两份文件。

---

## 成功标准

1. **自动触发**：会话结束后，若 `plugins.selfEvolve.enabled=true`，进化在 `runSummaryFlow` 完成后 **5 秒内**开始，不阻塞 summary 生成。
2. **数据写入**：进化完成后，`evolved_rules` 和 `evolved_skills` 表有新记录；若 `review_mode=auto`，对应平台文件（如 `CLAUDE.md`）同步更新。
3. **不重复进化**：同一 session 的 `evolved` 标记写入后，不会再次触发进化（除非强制重进化）。
4. **审核流程**：`review_mode=manual` 时，新 Rule/Skill 的 `audit_status='pending'`，在 `POST /api/self-evolve/review/approve` 调用前不写入文件。
5. **插件开关**：`plugins.selfEvolve.enabled=false` 时，Worker 启动后不创建任何 SelfEvolve 相关资源，现有 memory 功能零影响。
6. **零 Hook 重复**：不需要在 IDE 配置中为 Self-Evolve 单独注册任何 Hook，完全复用 Agent-Mem 的现有 Hooks。
7. **MCP 工具可用**：通过 Agent-Mem 的 MCP Server，Agent 可调用 `get_rules`、`get_skills` 拿到进化结果。
8. **零回归**：`npm run typecheck` / `npm run check` / 现有单测全绿；现有 `beforeSubmitPrompt` 等 Hooks 行为无变化。

---

## 配置项

| 键名 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `plugins.selfEvolve.enabled` | boolean | `false` | 插件总开关，默认关闭（安全默认） |
| `plugins.selfEvolve.reviewMode` | `'auto' \| 'manual' \| 'quality_gate'` | `'manual'` | 进化结果处理模式 |
| `plugins.selfEvolve.qualityGateThreshold` | number | `70` | quality_gate 模式下的质量分数门限（0-100） |
| `plugins.selfEvolve.targetPlatforms` | string[] | `['claudecode']` | 写入哪些平台的配置文件（可多选） |
| `plugins.selfEvolve.maxContextRules` | number | `20` | 注入会话上下文的最大规则数 |
| `plugins.selfEvolve.criticOnGenerate` | boolean | `true` | 生成新 Rule/Skill 后是否立即触发 CriticEngine |
| `plugins.selfEvolve.aiModel` | string | 继承全局 AI 配置 | 进化分析使用的模型，可单独指定 |

---

## 非目标

- 不实现 Self-Evolve 的全部 natural_selection 管理 UI（本期 API-only）
- 不迁移 Self-Evolve 的 electron installer
- 不保证与旧版 `~/.self-evolve/` 数据格式的向后兼容
- 不实现自动将旧 Self-Evolve 数据库迁移到 Agent-Mem

---

## 风险

| 风险 | 严重度 | 缓解 |
|---|---|---|
| 进化调用 LLM 费用叠加 | 中 | 默认 `enabled=false`，用户主动开启；`review_mode=manual` 用户有感知 |
| 进化失败导致 summary 流程异常 | 高 | 进化异步执行，不阻塞 summary；顶层 try/catch，失败只记日志 |
| observations 作为 EvolveEngine 输入质量不如原始 events | 中 | observations 已经过 AI 压缩提炼，信噪比反而更高；若有信息损失可在 prompt 里补充结构 |
| PlatformWriter 写入 CLAUDE.md 破坏用户手工内容 | 高 | 继承 Self-Evolve 的"托管区/手动区"分段机制，用 HTML 注释标记边界，手工区完全不动 |
| 与现有 ShadowFolk 同步冲突（CLAUDE.md 同时被修改） | 低 | PlatformWriter 写入是追加/更新托管区，ShadowFolk 同步的是 observations；两者操作的字段不重叠 |

---

## 验收方式

```text
T=0:00  在 Claude Code 中执行一次带文件编辑的任务（生成至少 1 条 observation）
T=0:00  Claude Code stop hook 触发 → Agent-Mem 完成 summary 生成
T=0:05  GET /api/self-evolve/status → { "status": "evolving" | "completed" }
T=0:30  GET /api/self-evolve/review/pending → 返回 ≥ 1 条待审 Rule
T=0:30  POST /api/self-evolve/review/approve { id: X } → 200
T=0:31  查看 CLAUDE.md → 托管区内出现新规则
T=0:31  GET MCP tool "get_rules" → 返回该规则
T=0:31  viewer.html Rules 标签页 → 展示该规则，点击可查来源 session
```
