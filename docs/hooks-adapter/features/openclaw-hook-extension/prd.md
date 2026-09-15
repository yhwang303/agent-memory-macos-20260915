# 需求文档：OpenClaw 插件 hook 覆盖范围扩展

> 日期：2026-04-28
> 关联设计：`2026-04-28-OpenClaw插件hook覆盖扩展-设计文档.md`

## 背景

当前 `agent-memory` 插件已经写入 `~/.openclaw/plugins/agent-memory/`，并向 OpenClaw 注册了 5 个 hook（`gateway_start`、`before_agent_start`、`before_prompt_build`、`tool_result_persist`、`agent_end`）。实测下列入口的对话能正常落到 SQLite：

- `openclaw agent --message ...`（CLI）
- `openclaw chat` / TUI
- Cron 触发的内部任务（capability-evolver、hourly-self-evolution 等）

但用户在 OpenClaw Control UI（`http://127.0.0.1:18789/control`）跟联系人（如 `兰伊`）的聊天**完全没被记录**。`grep "现在在做"` 在 gateway 日志里 0 命中，确证这条路径不经过现有 hook。

进一步排查 OpenClaw plugin SDK，发现 OpenClaw 总共暴露 31 个 hook，插件目前只覆盖 5 个。Channel 路径走的是 `inbound_claim` → `message_received` → `dispatcher` → 可选 `agents.run`，其中 `message_received`、`message_sent` 两个核心 hook 完全没被插件监听。

此外现有 5 个 hook 实现也有两个小瑕疵：

1. `tool_result_persist` 是 OpenClaw 标记的 sync hook，但插件 handler 写成了 `async`，gateway 日志反复打印 `returned a Promise; result was ignored`（请求实际能发出，仅返回值被丢）。
2. `agent_end` 调用了 `/api/session/complete`，但 worker 端没把 session.status 翻成 `completed`，sessions 表里这些会话长期处于 `active`。

## 目标

1. 让所有"用户能跟 AI 对话的入口"都被 agent-memory 捕获，落到同一份记忆库里。
2. 修复现有 hook 的 sync/async 不匹配，消除 gateway 日志噪音。
3. 修复 session 状态完结的小瑕疵，让 viewer 能区分 active vs completed。
4. 不改变现有用户配置文件结构，部署版升级零迁移成本。

## 范围

### 范围内

- 在 `agent-memory` 插件中增量 register 关键缺失 hook：
  - `message_received`（**P0**：解决截图场景）
  - `message_sent`（**P0**：成对，记录助手回复）
  - 其余 hook 按下方"分级"列表评估
- 修复 `tool_result_persist` async/sync 不匹配（改为 sync wrapper + 内部 fire-and-forget）。
- 修复 worker 在收到 `/api/session/complete` 时把 session.status 翻成 `completed`。
- 同步更新源码 `src/integrations/openclaw-plugin/` 与部署版 `~/.openclaw/plugins/agent-memory/index.js`（部署版可直接热替换，不必等下次 npm 包发版）。
- 兼容性兜底：所有新 hook 在 worker 不可达时**必须不抛异常、不阻塞 OpenClaw 主流程**。

### 范围外

- 不改动 OpenClaw 本体或 plugin SDK。
- 不实现 channel 消息的反向写回（即不让 agent-memory 主动给 channel 发消息）。
- 不为新增 hook 改 viewer UI（先把数据落对，前端展示后续单独需求）。
- 不处理远程 worker（仅本机 `127.0.0.1`）。
- 不改 prompt-injection 类 hook（`before_prompt_build` 已有，其它高风险 hook 暂不动）。

### Hook 分级（最终交付集由"成功标准"段确认）

| 级别 | Hook | 触发时机 | 落库目标 |
|---|---|---|---|
| **P0**（本期必做） | `message_received` | channel 收到一条入站消息 | 写入 observation，type=`channel_inbound` |
| **P0** | `message_sent` | channel 真正发出一条消息 | 写入 observation，type=`channel_outbound` |
| **P1**（本期可选） | `llm_input` | 每次 LLM 调用前 | 写入 observation，type=`llm_input`（仅 prompt 摘要 + token 数） |
| **P1** | `llm_output` | 每次 LLM 调用后 | 写入 observation，type=`llm_output`（仅 lastAssistant 摘要 + usage） |
| **P2**（暂不做） | `before_tool_call` / `after_tool_call` | 工具调用前后 | 已有 `tool_result_persist` 覆盖大部分场景，本期不做 |
| **P2** | `subagent_*` | 子 agent 生命周期 | 跟父子关系建模相关，单独需求 |
| **P2** | `session_start` / `session_end` | OpenClaw 内部 session 生命周期 | 本期通过 `before_agent_start` + `agent_end` 推断已够用 |

## 用户故事

- 作为重度用户，我在 Control UI 跟"兰伊"等本地联系人聊天的内容应该被 agent-memory 记录，下次回看 viewer 能找到。
- 作为开发者，gateway 日志里不应该再频繁出现 `agent-memory ... returned a Promise; ignored` 的 warning。
- 作为运维者，sessions 表里跑完的会话状态应该是 `completed` 而不是永久 `active`。
- 作为插件作者，新加 hook 不需要等 npm 包发版，热替换 `~/.openclaw/plugins/agent-memory/index.js` 即可生效。

## 成功标准

1. 在 Control UI 跟"兰伊"发送一条消息，5 秒内：
   - `/api/viewer/observations?limit=20` 里能看到该消息内容（type=`channel_inbound`）。
   - 助手回复也能看到一条（type=`channel_outbound`）。
2. 跑一次 `openclaw agent --message "测试"`，gateway 日志在该时间窗口内：
   - **不再**出现 `agent-memory ... returned a Promise; this hook is synchronous and the result was ignored`。
3. `agent_end` 触发完毕后，对应 session 在 `/api/viewer/sessions` 中 `status` 字段为 `completed`，`completed_at` 非空。
4. Worker 关闭/不可达时（手动 `kill 7729`），重新跑 `openclaw agent` 不报错、对话仍能完成（只是不落库），gateway 日志不出现栈追踪。
5. 源码与部署版一致：`src/integrations/openclaw-plugin/index.ts` 编译产物与 `~/.openclaw/plugins/agent-memory/index.js` 行为等价。
6. 新增 P1 段 `llm_input` / `llm_output` 是否落地由代码评审决定；P0 必须落地。
7. `npm run check` / `npm run typecheck` / 现有 `tests/integrations/openclaw-plugin*.test.ts` 全绿。

## 非目标

- 不新增 prompt-injection 行为（不改 `before_prompt_build` 现有逻辑）。
- 不替换现有 worker API 路径，只新增 observation 类型。
- 不引入 channel→agent 的反向调用。

## 已知风险

| 风险 | 缓解 |
|---|---|
| `message_received` 触发频率高（telegram/discord 群消息），可能 spam observation 表 | 加 `obs_type` 过滤、worker 端按 project 限速、配置 `syncMemoryFileExclude`-like 黑名单（如群聊） |
| `llm_input` / `llm_output` 包含敏感 prompt | 默认只存 `text.slice(0, 2000)` 摘要 + token usage；可配置开关 |
| 热替换 `index.js` 时 OpenClaw 已加载旧版本 | 修改后用 `openclaw plugins registry --refresh` + `openclaw gateway restart` 二选一 |
| 新 hook 内 fetch 失败把异常抛回 OpenClaw | 全局 try/catch，失败仅日志、不阻断 |

## 验收方式

按"成功标准"逐条 checklist；其中第 1 条用截图 + observation id 直接证据交付。
