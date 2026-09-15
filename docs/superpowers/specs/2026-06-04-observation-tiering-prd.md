# PRD：Observation 分档蒸馏（Observation Tiering）

> 状态：Ready for implementation　|　创建：2026-06-04　|　范围：`src/services/worker`、`src/sdk`、`src/services/sqlite`、`src/services/context`

## Problem Statement

记忆系统目前把**每一个**钩子事件（shell 命令、文件编辑、MCP 调用、agent 回复等）都送进同一个高级模型（`CODEBUDDY_MEM_MODEL`，默认 gpt-5.4）做完整蒸馏，写出 title / narrative / facts / concepts 一整套。

这带来两个问题：

1. **好模型被浪费在垃圾上**：大量事件本身没有有效信息——空命令（只有耗时）、粘贴截图触发的图片 file_edit、空 file_edit、MCP 空结果——却同样调用 gpt-5.4，被硬编出一段"本次操作属于典型…具有参考价值"的套话。
2. **记录有效性差，污染召回**：本项目（`e:/github/agent-memory`）3043 条 observation 中，约 61% 标题与他人重复、约 37% narrative 是套话、约 51% 是 shell 命令复述。跨全部 ~29600 条记录中，"空命令"一类就占约 16%（每个项目都有）。而召回（`handleContextInject`）是"按时间倒序取最近 N 条、不看价值"，于是这些垃圾会被注入到每一次 prompt 上下文里，挤掉真正有价值的记忆（如"用户写了一篇 wiki"这种召回时极有价值的内容）。

根因不在模型，而在流水线：钩子层几乎不过滤、prompt 强制"几乎全记"（`YOU MUST RECORD ALMOST EVERYTHING`）、无去重、召回不分价值。

## Solution

引入**三档蒸馏（Tiering）**，在服务端 `processObservation` 调用 LLM **之前**用一个确定性分类器决定每个事件的处理强度：

- **Tier 0 · 丢弃**：无有效负载或纯噪音的事件，直接不入库、不调 LLM。
- **Tier 1 · 模板留痕**：低价值但值得留面包屑的机械操作，用确定性模板拼一条轻量记录入库，**不调 LLM**。
- **Tier 2 · 模型精写**：真正有价值的事件才调 LLM。Tier 2 内部再按价值分流到两个模型：**高级（gpt-5.4）** 用于推理/结论/写文档；**中级（便宜模型）** 用于普通代码编辑、MCP 业务结果等。

同时改写 Tier 2 的 prompt 根除套话，并让默认召回**只吃 Tier 2**（trace 仅用于显式时间线查询或 Tier 2 不足时兜底）。

从用户视角：模型钱主要花在值得的事件上；注入到对话里的历史记忆变干净、信息密度高；"我哪天写过什么文档/改过哪个模块"这类面包屑仍可显式查到。

## User Stories

1. 作为记忆系统使用者，我希望空命令（只有耗时、无命令文本）的事件**不被记录**，这样数据库和召回里不再有"记录到一次终端命令执行事件"这类空壳。
2. 作为使用者，我希望粘贴截图触发的图片 file_edit（Cursor `workspaceStorage` 缓存 PNG）**不被记录**，因为它对召回零价值。
3. 作为使用者，我希望图片/二进制后缀（`.png .jpg .svg .pdf .zip .exe .dll` 等）的 file_edit **不被记录**。
4. 作为使用者，我希望无 `file_path` 或 diff 为空的 file_edit **不被记录**。
5. 作为使用者，我希望空正文或返回空 JSON `{}` 的 agent_response **不被记录**。
6. 作为使用者，我希望 MCP 只读查询且**返回空结果**的事件**不被记录**。
7. 作为使用者，我希望临时文件（如 `COMMIT_EDITMSG`、`*.tmp`、提交消息临时文件）的编辑**不被记录**。
8. 作为使用者，我希望同一会话内与近期记录**完全重复**的事件**不被记录**。
9. 作为使用者，我希望只读检查类命令（`git status/log/diff`、`ls`、`cat`、`head/tail`、`grep`、`find` 等，exit=0）被**模板留痕**而非调用 LLM 精写。
10. 作为使用者，我希望成功的打包/构建命令被**模板留痕**（失败则精写）。
11. 作为使用者，我希望指向真实源码但 diff 缺失/极短的文件编辑被**模板留痕**（"编辑了 X 文件"）。
12. 作为使用者，我希望 MCP 只读查询（`get/list/search/read/query/fetch` 前缀）有结果时被**模板留痕**。
13. 作为使用者，我希望极短（<40 字）且无代码/结论的 agent_response 被**模板留痕**而非精写。
14. 作为使用者，我希望 trace（Tier 1）记录依然可被显式"我做过什么/时间线"查询检索到，保留面包屑价值。
15. 作为使用者，我希望 agent 的回复/思考/transcript（有实质内容）走**高级模型（gpt-5.4）**精写，因为决策与结论是记忆的价值主体。
16. 作为使用者，我希望 shell 报错（exit≠0）走**高级模型**，因为它是 debugging 价值所在。
17. 作为使用者，我希望写文档/markdown（带实质 diff）走**高级模型**，因为"写了关于 X 的文档"这种语义召回时最有价值。
18. 作为使用者，我希望普通源码编辑（带实质 diff）、MCP 业务结果、打包/测试失败走**中级（便宜模型）**，控制成本。
19. 作为使用者，我希望便宜模型可通过新配置项 `CODEBUDDY_MEM_MODEL_LIGHT` 指定，型号留空时有合理回退。
20. 作为使用者，我希望 Tier 2 产出的 narrative 写"做了/发现了/决定了什么及结果"，而**不出现**"本次操作属于典型…""具有参考价值""对后续…很重要""记录此类操作有助于"这类套话。
21. 作为使用者，我希望 facts 只含内容/结论性事实，**不含**执行耗时、钩子类型、连接参数、"参数为空"、"这是一次 XX 事件"这类噪音。
22. 作为使用者，我希望每条 observation 带一个 `tier` 字段，便于按价值检索与排序。
23. 作为使用者，我希望默认注入到 prompt 的记忆上下文**只取 Tier ≥2**，trace 不污染每次对话。
24. 作为使用者，我希望 Tier 2 记录不足以填满注入窗口时，trace 可作为兜底补充。
25. 作为现有数据的拥有者，我希望迁移**不影响历史数据**——旧记录一律默认 `tier=2`，召回行为对历史零变化。
26. 作为使用者，我希望分类规则**优先看有没有有效负载**（命令文本/diff/结果），空负载无论事件类型一律往下踢。
27. 作为运维者，我希望处理图片的 shell 脚本（生成图标、分析图像亮度、批量生图）**不被误判为图片垃圾**，仍按 shell 规则正常处理。
28. 作为使用者，我希望分类器在无法判断时**保守 fail-open 到 Tier 2**，避免误丢有价值记录。

## Implementation Decisions

### 架构与分层

- 分档发生在**服务端** `SDKAgent.processObservation`，在 `callAI()` **之前**。这是唯一收口点，能访问会话历史做去重，且把判断挡在昂贵调用前。不在分散的钩子层做。
- **总原则**：先看有效负载（command / diff / 结果），空负载无论类型一律往下踢；再按事件类型与内容判断档位。
- 档位规则只能依赖钩子层确定性输入（`observationType`、`toolName`、`toolInput`、`toolOutput` 的 exit_code/output/diff、文件路径），**不得**依赖 LLM 输出的语义类型（discovery/debugging 等）。

### 新建深模块

**`ObservationClassifier`（纯函数，无 I/O）**

接口（来自设计讨论，编码决策而非示例代码）：

```
classify(event: NormalizedEvent, recentSignatures: string[]): ClassifyResult

NormalizedEvent = { observationType, toolName, toolInput, toolOutput }
ClassifyResult  = { tier: 0 | 1 | 2, model?: 'high' | 'light', dropReason?: string, signature: string }
```

- 所有规则收进该函数后面：空负载、图片/二进制后缀、`workspaceStorage` 截图、临时文件、只读命令集合、打包成功/失败、文档 vs 代码、MCP 只读（`get/list/search/read/query/fetch` 前缀）vs 业务、MCP 空结果、琐碎/空 agent_response、会话内去重。
- 去重通过入参 `recentSignatures`（调用方从 `getObservationsBySession` 派生）保持函数纯净；函数同时回吐本事件的 `signature`（`toolName` + 归一化 `toolInput` 的哈希）。
- Tier 2 时附带 `model`：高级=`'high'`（写文档/markdown、agent 回复/思考/transcript、shell 报错、内容多的新建文件）；中级=`'light'`（普通源码编辑、MCP 业务结果、打包/测试失败）。
- 无法判断时 fail-open 到 `{ tier: 2, model: 'high' }`。

**`TraceFormatter`（纯函数，无 I/O）**

接口：

```
formatTrace(event: NormalizedEvent): { title: string; facts: string; type: string }
```

- 用钩子已有的结构化字段（command 前若干字、file_path 相对路径、exit_code）确定性拼装，narrative 留空，`type` 记原始 tool 类型。零 LLM。

### 改动现有模块

- **`buildObservationPrompt`（`src/sdk/prompts.ts`）**：删除整段「## CRITICAL: Default to RECORD / ALWAYS RECORD / ONLY SKIP / Key Principle」；narrative 指令由"发生了什么以及为什么重要"改为"改了/发现了/决定了什么，以及具体结果"，并加入套话黑名单；facts 指令收紧为"仅内容/结论性事实"，明确禁止耗时、钩子类型、连接参数、"参数为空"、事件复述。**中级与高级共用同一模板**，不做详尽度区分，唯一差异是调用的模型。
- **`SDKAgent.processObservation`**：编排流程——构造 `NormalizedEvent` → 从会话历史派生 `recentSignatures` → `classify()` → 按结果分支：Tier 0 直接 `return null`（不入库、不调 LLM）；Tier 1 调 `TraceFormatter` 拼记录、`insertObservation`（`tier=1`、不调 LLM）；Tier 2 调 `callAI()`（按 `model` 选 gpt-5.4 或 light）、解析、`insertObservation`（`tier=2`）。
- **模型选择**：新增配置项 `CODEBUDDY_MEM_MODEL_LIGHT`（经 desktop `buildWorkerEnv()` 透传，与 `CODEBUDDY_MEM_MODEL` 同源管理）；未配置时回退到 `CODEBUDDY_MEM_MODEL`。
- **Schema 迁移（`src/services/sqlite`）**：`ALTER TABLE observations ADD COLUMN tier INTEGER DEFAULT 2`。旧数据自动为 2；`insertObservation` 写入实际 tier。
- **召回（`getObservationsByProject` / `handleContextInject` / `src/services/context/builder.ts`）**：默认查询条件加 `tier >= 2`；当 Tier 2 结果不足配置的 N 条时，按时间倒序用 Tier 1 trace 兜底补足。

### 历史数据

- **不做回溯清理**（用户决定 A）。旧数据全部 `tier=2`，召回对历史零影响；旧垃圾随新干净记录进入而被"最近优先"窗口自然挤出。

## Testing Decisions

**好测试的标准**：只测外部行为（输入事件 → 档位/模型/产出），不测实现细节；纯函数优先，避免 mock I/O。

**要测的模块：**

1. **`ObservationClassifier`（重点）**：覆盖每条规则的判定——
   - Tier 0：空命令 shell、无 path/空 diff file_edit、空/空 JSON agent_response、空 facts、图片二进制后缀、`workspaceStorage` 截图、临时文件、MCP 空结果、会话内重复。
   - Tier 1：只读命令、打包成功、无 diff 的真实文件编辑、MCP 只读查询有结果、极短 agent_response。
   - Tier 2 高级：agent 回复/思考、shell 报错、写文档带 diff。
   - Tier 2 中级：普通源码编辑带 diff、MCP 业务结果、打包失败。
   - 边界：处理图片的 shell 脚本不被误判为图片垃圾；无法判断时 fail-open 到 Tier 2 高级。
2. **`TraceFormatter`**：给定事件，断言模板产出的 title/facts/type，且 narrative 为空、无套话。
3. **Schema 迁移**：迁移后旧行 `tier=2`、新列存在、可写入 0/1/2。

**测试先例（仓库内同类）：**
- 纯解析/逻辑单测：`tests/transcript-parser.test.ts`、`tests/shared/codex-transcript-parser.test.ts`
- prompt 测试：`tests/build-summary-prompt.test.ts`、`tests/prompts-media-context.test.ts`
- 迁移测试：`tests/sdk-sessions-migration.test.ts`、`tests/services/sync/chroma-sync-state-migration.test.ts`
- 召回/检索：`tests/worker/search/sqlite-strategy.test.ts`

**可选（不强制）**：`processObservation` 编排的集成测试——偏集成、成本高收益低，本期不要求。

## Out of Scope

- 历史 ~29600 条数据的回溯清理或删除（决定保持不动）。
- Tier 2 内部超过两级的模型路由、或基于 LLM 的"门卫"价值打分。
- `discovery_tokens` 字段的真正实现（继续保持占位，本期用独立的 `tier` 字段而非复用它）。
- 钩子层（`hooks-cli.ts`）的前置过滤改造（统一在服务端处理）。
- 召回的语义/向量检索排序改造（仅改默认注入的价值过滤；Chroma/混合检索策略不在本期）。
- 便宜模型的具体型号选型（仅提供配置项，型号由运维填）。

## Further Notes

- 数据依据（抽样自本地 `agent-memory.db`）：本项目 3043 条中 ~61% 标题重复、~37% 套话；全局 ~29600 条中"空命令"约 16%（每项目都有）、`workspaceStorage` 截图 file_edit 约 834 条、MCP 空结果多见。两轮共 140 条随机抽查显示按本规则约 74% 可降级到 Tier 0/1、约 25% 留 Tier 2，未见有价值记录被误降。
- 已接受的残差（不为其加规则）：通过 shell（`sed`/`echo`）改代码会被降到 Tier 1，靠后续 agent 回复兜底语义；打包"带警告但成功"算 Tier 1、警告细节会丢。
- 设计原则可复用到其他事件源：核心是"先看有效负载、空负载一律下踢"，对 shell/file_edit/mcp/agent_response 统一适用。
