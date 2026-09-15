# 12 · agent-memory summary 触发标准被误读

## 现象
- 用户问"`agent_end` 为什么一直不会被调用？条件是什么？"——把问题归因到"hook 没触发"。
- 我第一版回答 summary 标准时写成"必须 session 显式结束才会触发"。
- 用户立刻反例：「我所有的对话都没结束，但是都有总结」——直接证伪。

## 根本原因
两层误读叠加。

### 1. 关于 `agent_end` 的触发条件
去 OpenClaw `dist/` grep `runAgentHarnessAgentEndHook`，发现 **per-attempt 触发**（一条用户消息 → 一次 LLM 回合结束 → 一次 `agent_end`），三处调用入口：

| 路径 | 适用 |
| --- | --- |
| `cli-runner-*.js` | `openclaw agent` CLI 命令 |
| `extensions/codex/run-attempt-*.js` | GPT-5.2-Codex 等 codex provider |
| `selection-*.js`（嵌入式默认） | anthropic-claude / openai / minimax / google 等所有非 codex provider |

"`agent_end` 一直不会被调用"是**观察错觉**——实际触发了，只是请求被 worker 400 拒掉（详见 [11 篇](./11-OpenClaw插件调错summary端点永远400.md)），看起来像没触发。

### 2. 关于 summary 的真实触发频率
summary 不是"session 结束才生成"。grep 调用链能看到：

| 触发源 | 频率 | 端点 |
| --- | --- | --- |
| IDE `stop` hook（Cursor / Claude Code / CodeBuddy / Gemini-CLI / OpenCode 都注册） | **每条 agent 回复一次** | `/api/session/end` |
| IDE `sessionEnd` hook | composer 关闭一次 | `/api/session/end` |
| OpenClaw plugin `agent_end` | 每个 attempt 一次 | `/api/session/end` |

同一个 `memory_session_id` 在 `session_summaries` 表里 **INSERT 多行**（不 UPDATE），按 `created_at_epoch DESC` 取最新就是当前画面。

这就是为什么"对话没结束也有总结"——每发一条消息、agent 回完就触发一次新 summary，session 表里的 status 与 summary 的存在与否完全解耦。

## 解决
- 把"每轮触发"标准写进设计文档 `2026-04-28-OpenClaw插件hook覆盖扩展-设计文档.md` 的"agent-memory 的 summary 准入标准（核心机制）"一节，作为后续判定的尺子。
- 完整标准包括：触发标准（按频率高低三档）/ 入选标准（必须 ≥1 条 obs，最长等 30s）/ 内容质量标准（8 字段非占位符）/ 并发去重标准（pendingSummaries 仅防同时跑）/ 字段聚合标准（files 字段 worker 聚合非 LLM 输出）。
- OpenClaw 的 agent_end 路径修正端点（见 11 篇），让它至少能进 summary 生成流程。

## 教训
- 诊断异步链路前**先穷举调用链**再下结论。一次 `grep "/api/session/end"` 可以避免一篇回答里的所有错。
- 不要把"用户没观察到现象"等同于"代码没执行"——优先去服务端（worker DB / log）拿 ground truth。
- 触发频率类的判断不能凭直觉，必须实证：看 INSERT 语句、看时间戳分布、看是否累积成多行。
