# 记忆系统全面升级需求分析

## 背景

当前 `agent-memory` 是一套面向 Cursor/CodeBuddy 的本地记忆系统，采用 SQLite + LLM 结构化抽取的架构，通过 IDE Hooks 采集对话与工具轨迹，经 HTTP Worker 写入 observations / session_summaries，用 FTS5 全文检索。

经过实际使用和对前沿记忆系统（Mem0、Zep/Graphiti、Letta/MemGPT、Cognee、Hindsight、LangMem 等）的调研，发现当前系统在**使用体验**和**记忆能力**两个层面均存在显著痛点，需要系统性升级。

## 问题陈述

问题分为两大类共 12 项：

### A 类：使用体验问题

使用体验直接影响系统的可用性和用户留存，是"能不能用起来"的前提。

#### A1. 安装配置流程复杂

现状：
- CodeBuddy 上需要在 Knot 平台手动配置 Hooks 节点。
- Cursor 需要手动编辑 `.cursor/hooks.json`，路径写死绝对路径，换机器必须手改。
- MCP Server 需要手动写入 `~/.cursor/mcp.json`。
- `.env.local` 需要手动创建和填入 API Key。
- 虽有 `scripts/setup.js` 和 `install.bat`，但配置步骤多、出错点多。

对比：
- OpenClaw 等工具提供一键安装，`npx` 直接运行。
- VS Code 扩展一键安装，零配置即可使用。
- 可以通过 Cursor Skills 让 IDE Agent 自动完成安装，用户只需说"帮我安装 agent-memory"。

#### A2. 启动流程不够自动化

现状：
- Worker 需要用户手动执行 `npm run worker:start` 或 `start-worker.bat`。
- 每次开机后需重新启动，经常忘记。
- `WorkerClient.ensureRunning()` 仅做健康检查，不会自动拉起 Worker。
- Worker 挂掉后无自恢复机制。
- `worker:restart` 命令在 CLI 中没有对应实现（`switch` 无 `restart` 分支）。

对比：
- 系统服务（Windows Service / macOS launchd）可开机自启。
- VS Code 扩展随 IDE 启动自动激活。
- Docker Compose 提供 `restart: always` 策略。

#### A3. 数据采集不完整

现状：
- 无法获取完整的多轮对话历史，只能拿到每次 hook 触发时的单条数据。
- Shell 输出截断为 5000 字符、MCP 结果 5000 字符、文件 diff 3000 字符。
- `sessionStart` / `sessionEnd` 虽有代码实现但 hooks.json 未配置。
- 会话对齐依赖 IDE 传入的 `session_id`，弱一致性风险。
- Worker 未启动时数据静默丢失。

对比：
- ChatGPT Memory 可获取完整对话上下文。
- Zep 的 Episode 子图保存完整原始事件。

#### A4. IDE 不会主动调用记忆

现状：
- 记忆注入依赖 `beforeSubmitPrompt` hook 被动触发。
- IDE（Cursor/CodeBuddy）不会主动去搜索和回忆相关记忆。
- 缺少 Skills 配置让 IDE Agent 天然地使用记忆。
- 用户需要手动提醒 AI "去查查之前的记录"。

对比：
- ChatGPT 自动在每条消息的 system prompt 中注入所有记忆。
- Claude 的 memory 工具让 Agent 自主决定何时读写记忆。
- Letta/MemGPT 中 Agent 自主管理内存，自主决定何时检索。

#### A5. 跨平台配置不统一

现状：
- hooks.json 写死 Windows 路径 `E:/agent-memory/dist/hooks-cli.js`。
- 使用 `cmd /c "chcp 65001 >nul && ..."` 的 Windows 专用命令。
- CodeBuddy 与 Cursor 的集成方式不同，需要分别配置。
- 多台机器间配置无法同步。

对比：
- npm 全局包 + `npx` 可跨平台透明运行。
- VS Code 扩展自动适配不同操作系统。

### B 类：记忆系统能力问题

记忆能力决定了"记忆好不好用"，是系统价值的核心。

#### B1. 无语义/向量检索（最高优先级）

现状：
- 仅有 SQLite FTS5 全文索引 + LIKE 多 token 兜底，本质是词法匹配。
- `getChromaPath` 存在但未使用，`buildSemanticContext` 名为语义实为 FTS。
- 无法理解同义词、上下位关系等语义关联。

对比：
- Zep/Graphiti：语义向量 + 全文 + 图遍历 + 模糊搜索，四路混合检索。
- Mem0：向量搜索缩小候选 + 图遍历。
- Cognee：14 种检索模式。
- Hindsight：四策略融合，LongMemEval 达 91.4%。

典型场景：用户问"上次修那个登录相关的 bug 怎么解决的"，系统只能匹配"登录""bug"这两个词，无法关联到"认证失败""token 过期""session 超时"等语义相关记忆。

#### B2. 无记忆冲突消解与自进化

现状：
- 记忆以追加为主，无通用更新/合并 API。
- `hasObservationFactInSession` 仅做同会话内 facts 全文相等去重。
- 跨会话的矛盾/重复记忆无法自动识别。

对比：
- Mem0：LLM 驱动的 ADD/UPDATE/DELETE/NOOP 四操作决策。
- Cognee memify：修剪陈旧节点、强化频繁连接、添加派生事实。
- Letta/MemGPT：Agent 自主编辑 Core Memory。

典型场景：用户半年前偏好 Tab 缩进，现在改用空格缩进，两条矛盾记忆同时存在；同一解决方案在不同会话中被重复记录多次。

#### B3. 无时间衰减与生命周期管理

现状：
- 记忆只有 `created_at` 时间戳，无优先级、无衰减、无失效标记。
- `discovery_tokens` 字段在插入路径中多为 0，未见衰减逻辑。
- 旧记忆和新记忆同等权重。

对比：
- Zep/Graphiti：双时间模型（数据库事务时间 + 现实世界时间），记忆可被新信息显式失效。
- Cognee memify：基于使用信号重新加权边。
- Hindsight reflect：推理更新信念。

典型场景：一年前的过时技术方案和昨天的最新方案同等权重地被注入上下文。

#### B4. 无知识图谱能力

现状：
- 所有记忆是扁平的 observation 记录。
- `concepts` 只是逗号分隔的标签字符串，无法表达实体关系。

对比：
- Mem0-Graph：有向标签图表示实体关系。
- Zep/Graphiti：三层子图（社区/实体/事件），Neo4j 存储。
- Cognee：六阶段管道自动构建知识图谱。

典型场景：无法回答"这个模块的历史修改涉及了哪些关联模块和开发者"。

#### B5. 上下文注入策略粗糙

现状：
- Worker `/api/context/inject` 固定取最近 10 条 observations + 3 条 summaries。
- 用 `ceil(len/4)` 粗略估算 token。
- `ContextBuilder` 的 `truncateToFit` 仅按顺序截断。
- 无法按当前任务相关性动态选择注入内容。

对比：
- ChatGPT：4 层注入架构，按优先级组装。
- Claude：Just-in-Time Context Retrieval，按需拉取。
- Letta/MemGPT：Agent 自主管理上下文窗口。

典型场景：做前端开发时，注入了不相关的后端 observation（因为更新），关键前端偏好因太旧被截断。

#### B6. 认知记忆分类过于简单

现状：
- `observation.type` 为 `discovery/bugfix/feature/learning` 等扁平标签。
- 缺少语义记忆、情景记忆、程序性记忆等认知分类。
- 不同类型记忆无法差异化处理。

对比：
- LangMem：语义记忆（事实）、情景记忆（经历）、程序性记忆（行为模式）。
- Hindsight：世界事实 / 经验事实 / 观察模式 / 心智模型四层。
- Letta/MemGPT：Core / Conversational / Archival 三层。

#### B7. 缺少记忆置信度和来源追溯

现状：
- 观察来源不明确，无法追溯"从哪次对话、基于什么证据得出"。
- 无置信度评分。
- 冲突记忆无法判断哪条更可信。

对比：
- Zep/Graphiti：Episode 子图保存原始事件，可完整溯源。
- Cognee：边权重基于使用信号动态调整。

## 目标

### 总体目标

将 `agent-memory` 从"能用的原型"升级为"好用的产品"，分阶段解决使用体验和记忆能力两个维度的问题。

### 分阶段目标

#### Phase 1：体验可用（解决"用不起来"）

1. 提供一键安装流程，最少步骤完成配置。
2. Worker 实现开机自启 + 自恢复，用户无需关心服务状态。
3. 完善数据采集链路，减少数据丢失。
4. 让 IDE Agent 能主动调用记忆。

#### Phase 2：检索升级（解决"找不到"）

1. 引入向量嵌入 + 语义检索，与 FTS5 形成混合检索。
2. 实现智能上下文注入，按相关性动态选择记忆。
3. 引入记忆置信度和来源标记。

#### Phase 3：记忆智能化（解决"不够聪明"）

1. 实现记忆冲突检测与自动消解。
2. 引入时间衰减与记忆失效机制。
3. 实现跨会话记忆合并与知识提炼。
4. 建立认知记忆分类体系。

#### Phase 4：知识图谱（解决"无关联"）

1. 构建实体-关系知识图谱。
2. 支持关系推理和图遍历检索。
3. 实现跨项目知识复用。

## 非目标

1. 不做多模态记忆（图片/音频/视频），当前场景以代码为主。
2. 不做多用户协作记忆共享。
3. 不更换 SQLite 为外部数据库（保持本地轻量部署优势）。
4. 不做完整的用户画像系统。

## 典型场景

### 场景 1：新用户首次安装

用户从 GitHub 克隆项目后，有三种安装方式：

方式 A（推荐）：在 Cursor 中对 Agent 说"帮我安装 agent-memory"，Agent 自动读取安装 Skill，逐步完成依赖安装、编译、配置环境变量、写入 Hooks 和 MCP 配置、启动 Worker 并验证。

方式 B：执行 `npx agent-memory setup`，交互式向导引导完成。

方式 C：双击 `install.bat`（Windows）或执行 `./install.sh`（macOS/Linux）。

无论哪种方式，最终效果：
- Hooks 和 MCP 配置自动写入。
- Worker 以系统服务方式自动注册，开机自启。
- 用户打开 Cursor 即可使用，无需额外操作。

### 场景 2：日常编码中自动回忆

用户在 Cursor 中开始新对话：
- `beforeSubmitPrompt` 自动触发记忆检索。
- 系统根据当前 prompt 做语义匹配，注入最相关的历史记忆。
- IDE Agent 通过 MCP 或 Skills 主动搜索记忆，无需用户提示。

### 场景 3：记忆自动进化

用户说"我现在改用 pnpm 了"：
- 系统识别到偏好变更。
- 自动查找之前的"使用 npm"记忆，标记为已失效。
- 新建"使用 pnpm"记忆，置信度高于旧记忆。
- 后续注入上下文时自动使用新偏好。

### 场景 4：语义关联检索

用户问"之前那个接口超时的问题怎么解决的"：
- 系统不仅匹配"接口""超时"关键词。
- 还能关联到"请求延迟""连接池满""数据库慢查询"等语义相关记忆。
- 按相关性和时间综合排序后注入。

## 验收标准

### Phase 1 验收

1. 新用户从零到可用不超过 3 个命令，或通过安装 Skill 一句话完成。
2. 系统重启后 Worker 自动恢复运行，无需人工干预。
3. `sessionStart` / `sessionEnd` hook 正常触发。
4. IDE Agent 能通过 MCP/Skills 主动调用记忆搜索。

### Phase 2 验收

1. 语义相关但关键词不同的记忆可被检索到。
2. 上下文注入的记忆与当前任务相关性显著提升。
3. 每条记忆可追溯到原始来源会话。

### Phase 3 验收

1. 矛盾的偏好记忆不会同时出现在上下文中。
2. 超过 N 天未被引用且无更新的记忆权重自动降低。
3. 重复记忆可被自动合并为一条。

### Phase 4 验收

1. 可通过"与模块 X 相关的所有修改"进行图遍历查询。
2. 跨项目的通用知识（如编码规范偏好）可自动复用。
