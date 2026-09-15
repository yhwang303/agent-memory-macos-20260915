# 14 · summary 早于 agent_response observation 入库导致错配

## 现象

- Viewer 中看到 observation `#22245`：
  - 标题：`定位记忆抽取将提及文件误记为已编辑的问题`
  - 类型：`debugging`
  - 时间：`2026-05-07 16:38:00`
- 但附近显示的 summary `#2478` 内容却是：
  - `用户想确认记忆远端同步是否会覆盖或同步所有项目，而不是只针对当前项目。`
  - 该内容明显对应另一个问题，和 `#22245` 的“文件误记为已编辑”主题不匹配。
- 表面看像是“这条 observation 没有生成 summary”，或者“summary 生成错了主题”。

更准确的结论是：`#2478` 不是 `#22245` 的 summary，而是同一个长 `memory_session_id` 下，在 `#22245` 入库之前最新生成的一条 summary。`#22245` 本身没有触发出一条新的匹配 summary。

## 实证时间线

本机 SQLite 查询结果：

| 对象 | ID | memory_session_id | created_at |
| --- | ---: | --- | --- |
| summary | `2478` | `mem-1778052921160-tw4d1` | `2026-05-07T08:37:48.999Z` |
| observation | `22245` | `mem-1778052921160-tw4d1` | `2026-05-07T08:38:00.963Z` |

也就是说，summary 先在 `08:37:48.999Z` 写入；`#22245` 这条 observation 到 `08:38:00.963Z` 才完成 AI 抽取并入库，晚了约 12 秒。

worker 日志也能还原同一条链路：

1. `08:37:48.999Z`：`=== Summary STORED successfully === {"sumId":2478,"memorySessionId":"mem-1778052921160-tw4d1"}`
2. `08:38:00.963Z`：AI 才返回 observation 抽取结果，标题为 `定位记忆抽取将提及文件误记为已编辑的问题`
3. `08:38:00.964Z`：`=== Observation STORED successfully === {"obsId":22245,...}`

因此 `#2478` 的内容和 `#22245` 对不上，不是偶然的 LLM 摘要质量问题，而是生成顺序和绑定粒度共同造成的结构性错配。

## 当前机制

### 1. summary 的触发入口

`src/hooks-cli.ts` 中 `stop` / `sessionEnd` hook 都会调用：

- `client.summarizeSession(sessionId)`
- 最终请求 worker 的 `POST /api/session/end`

`src/services/worker/client.ts`：

```ts
await fetch(`${this.baseUrl}/api/session/end`, {
  method: 'POST',
  body: JSON.stringify({
    sessionId,
    reason: 'session_complete'
  })
});
```

`src/services/worker/WorkerService.ts` 的 `/api/session/end` handler 会快速返回 `200`，然后后台调用：

```ts
const summaryPromise = this.sdkAgent.generateSummary(memorySessionId, session.project);
```

### 2. observation 的入库路径

同一轮 agent 回复结束时，hook 会先尝试把 assistant 回复作为 `agent_response` observation 发给 worker。

但 `/api/observation` 也是异步后台处理：HTTP 请求先 accepted，真正写库要等 `SDKAgent.processObservation()` 调 LLM 抽取完成。

这意味着：

- hook 端认为 observation 请求已经发出；
- worker 端还没真正把 observation 写入 SQLite；
- `/api/session/end` 已经开始基于当前已有 observations 生成 summary。

### 3. generateSummary 只等“有没有 observation”，不等“本轮 observation 是否到位”

`src/services/worker/SDKAgent.ts::generateSummary()` 的当前逻辑是：

- 最多等 30 秒，直到该 `memory_session_id` 下有至少 1 条 observation；
- 一旦发现已有 observation，就立即继续生成 summary；
- 它不知道“当前这轮 agent_response observation 是否已经入库”。

在长 session 中，这个条件几乎永远立即成立，因为历史 observation 已经很多了。于是 summary 会拿旧 observation 生成，而不会等待本轮刚发出的 `agent_response` observation。

## 根本原因

这是两个设计问题叠加。

### 问题 1：summary 与 observation 的异步竞态

`agent_response` observation 的 AI 抽取耗时较长，本例耗时约 17 秒；summary 生成只看到“该 session 已经有 observation”，所以在当前轮 observation 入库前就开始生成。

结果是：

- 当前轮回答被成功抽成了 observation；
- 但它错过了本轮 summary 的生成窗口；
- observation 入库后不会自动反向触发一次 summary 重算。

### 问题 2：summary 绑定粒度太粗

summary 当前只按 `memory_session_id` 聚合，不按单轮消息、`generation_id` 或 prompt turn 绑定。

本例中的 `memory_session_id` 是一个从 5 月 6 日开始的长会话：

```text
mem-1778052921160-tw4d1
```

同一个 session 下已经积累了多轮不同主题的问题，包括：

- 远端同步是否覆盖所有项目；
- 进程内定时同步机制；
- Shadow 推送脚本与同步架构；
- 文件误记为已编辑；
- CVM 后端安装与连接配置。

如果 Viewer 只是按同一个 `memory_session_id` 找“最新 summary”，就很容易把上一轮或旧主题 summary 展示在当前 observation 附近，造成“驴唇不对马嘴”的观感。

## 为什么不是这些原因

### 不是 observation 不合格

`#22245` 已经正常入库，类型、标题、叙事内容都完整，不是被抽取过滤掉。

### 不是 summary 生成失败

`#2478` summary 成功写库并同步，只是它生成时看不到稍后才入库的 `#22245`。

### 不是远端同步问题

这次排查用的是本机库 `~/.agent-memory/agent-memory.db` 的 ground truth。CVM 远端数据库中没有 `id=22245`，说明截图来自本机 Viewer，不是远端后端生成了错误 summary。

### 不是 LLM 胡写主题

`#2478` 的内容和它生成时可见的旧 observations 是一致的；问题在于它不应该被理解为 `#22245` 的 summary。

## 影响

- Viewer 中 observation 与 summary 可能错配，尤其是长会话、多轮问题混在同一个 `memory_session_id` 下时。
- 用户会误以为 summary 没生成、生成错了，或者 observation 没被正确消费。
- 后续远端同步会把错配后的 summary 和 observation 都同步出去，跨设备看到的也是同样的混乱关系。
- 当前 summary 的 `files_read` / `files_edited` 聚合也会受错配影响，把旧 observations 的文件列表带到新问题附近。

## 修复目标

后续修复应该满足：

1. 当前轮 agent 回复抽取出的 `agent_response` observation 必须能被当前轮 summary 看见。
2. summary 应该有足够的信息区分“它总结的是哪一轮”，而不只是属于哪个长 session。
3. Viewer 不应把同 session 的任意最新 summary 当成某条 observation 的对应 summary。

## 完整修复方案

不要做只改 Viewer 展示的“止血”方案。完整解决必须同时改三个层面：

1. 数据模型上引入“轮次”概念，让 observation 和 summary 能精确归属到同一轮用户请求/agent 回复。
2. 生成链路上引入“当前轮 observation 完成屏障”，让 summary 在生成前确认本轮 `agent_response` observation 已经入库。
3. Viewer 查询上只按明确的轮次绑定展示 summary，不再用“同 session 最新 summary”做隐式关联。

### 1. 新增 turn 级数据模型

新增一个稳定的轮次标识 `turn_id`。优先用 IDE 提供的 `generation_id`，没有时用 `content_session_id + prompt_number` 或 worker 生成的递增序号兜底。

推荐字段：

```sql
ALTER TABLE observations ADD COLUMN turn_id TEXT;
ALTER TABLE observations ADD COLUMN generation_id TEXT;
ALTER TABLE observations ADD COLUMN turn_role TEXT;

ALTER TABLE session_summaries ADD COLUMN turn_id TEXT;
ALTER TABLE session_summaries ADD COLUMN generation_id TEXT;
ALTER TABLE session_summaries ADD COLUMN covered_observation_ids TEXT;
ALTER TABLE session_summaries ADD COLUMN summary_status TEXT DEFAULT 'complete';
```

字段语义：

| 字段 | 表 | 用途 |
| --- | --- | --- |
| `turn_id` | observations / session_summaries | 同一轮用户请求、工具调用、agent 回复、summary 的共同归属键 |
| `generation_id` | observations / session_summaries | IDE 原始 generation 标识，用于排查和跨系统对齐 |
| `turn_role` | observations | 区分 `user_prompt`、`tool_event`、`agent_response`、`thought` 等来源角色 |
| `covered_observation_ids` | session_summaries | 明确记录本条 summary 实际覆盖了哪些 observation |
| `summary_status` | session_summaries | 标记 `complete` / `partial_timeout` / `failed`，避免静默错配 |

约束建议：

```sql
CREATE INDEX IF NOT EXISTS idx_observations_turn_id
  ON observations(turn_id, created_at_epoch);

CREATE INDEX IF NOT EXISTS idx_summaries_turn_id
  ON session_summaries(turn_id, created_at_epoch);
```

如需避免同一轮重复 summary，可增加唯一约束或应用层 upsert：

```sql
-- 具体是否建唯一索引取决于是否保留重试历史。
-- 如果只保留每轮最新 summary，可以使用：
CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_turn_latest
  ON session_summaries(turn_id)
  WHERE turn_id IS NOT NULL;
```

### 2. hook 层贯穿 turn_id

所有 hook 事件都要把同一轮的 `turn_id` 带到 worker：

- `beforeSubmitPrompt`：创建或更新当前 turn，记录用户问题。
- tool hooks：把工具读写、MCP、shell 等 observation 写到同一个 `turn_id`。
- `stop` / `afterAgentResponse`：把 assistant 回复写成 `agent_response` observation，并仍然属于同一个 `turn_id`。
- `sessionEnd`：只作为会话生命周期事件，不再承担“猜当前轮”的职责。

生成规则：

```text
if input.generation_id exists:
  turn_id = `${session_id}:${generation_id}`
else:
  turn_id = `${session_id}:turn-${prompt_number}`
```

关键点：`turn_id` 必须在 `beforeSubmitPrompt`、`/api/observation`、`/api/session/end` 三条链路里一致。否则 summary 仍然无法知道自己该等哪一条 observation。

### 3. worker 增加当前轮 observation 完成屏障

`/api/observation` 不能只返回 accepted 后就完全失联。需要让 worker 能追踪某个 `turn_id` 下的关键 observation 是否完成。

建议在 worker 内维护一个轻量 pending map：

```ts
type PendingObservation = {
  turnId: string;
  role: 'agent_response' | 'user_prompt' | 'tool_event' | string;
  startedAt: number;
  promise: Promise<number | null>; // observation id
};
```

`processObservation()` 启动时注册 pending，写库成功后 resolve `obsId`，失败后 resolve `null` 并记录错误。

`/api/session/end` 接收：

```json
{
  "sessionId": "...",
  "turnId": "...",
  "generationId": "...",
  "reason": "session_complete"
}
```

然后调用：

```ts
await waitForTurnObservations(turnId, {
  requiredRoles: ['agent_response'],
  timeoutMs: 30000
});

await generateSummaryForTurn(memorySessionId, project, turnId);
```

等待规则：

- 必须等待当前 `turn_id` 下的 `agent_response` observation 完成。
- tool observations 不建议作为强制等待项，因为工具事件数量不稳定，且有些平台不会完整上报。
- 超时不能拿旧 summary 冒充成功，应该生成 `partial_timeout` summary 或直接失败并记录待重试任务。

### 4. summary 只总结当前 turn

新增或改造 `SDKAgent.generateSummary()`，不要继续只按 `memory_session_id` 取最近 20 条。

目标接口：

```ts
generateSummaryForTurn(memorySessionId: string, project: string, turnId: string): Promise<SummaryRow | null>
```

查询逻辑：

```sql
SELECT *
FROM observations
WHERE memory_session_id = ?
  AND turn_id = ?
ORDER BY created_at_epoch ASC;
```

如果确实需要历史上下文辅助 LLM 理解，可以额外传入“上下文 observations / summaries”，但必须和“本轮覆盖 observations”分开：

- `current_turn_observations`：本条 summary 的真实覆盖范围，必须写入 `covered_observation_ids`。
- `context_summaries`：辅助背景，不算作本条 summary 覆盖内容。

这样 summary 不会再把旧问题总结成当前 observation 的 summary。

### 5. summary 写库改为 turn 级 upsert

同一轮 summary 允许重试，但最终 Viewer 应该只看到该轮最新完整结果。

推荐应用层策略：

1. 先查是否存在同 `turn_id` summary。
2. 如果没有，插入。
3. 如果已有且新结果是 `complete`，更新或插入新版本并把旧版本标记为 superseded。
4. 如果新结果是 `partial_timeout`，不要覆盖已有 `complete`。

如果暂时不想改成 UPDATE，也可以保留 INSERT 多行，但 Viewer 查询必须按：

```sql
WHERE turn_id = ?
ORDER BY
  CASE summary_status WHEN 'complete' THEN 0 ELSE 1 END,
  created_at_epoch DESC
LIMIT 1;
```

### 6. Viewer 只按 turn_id 展示关联 summary

Viewer 展示某条 observation 时，关联 summary 的查询必须变成：

```sql
SELECT *
FROM session_summaries
WHERE turn_id = :observation_turn_id
ORDER BY created_at_epoch DESC
LIMIT 1;
```

如果 observation 没有 `turn_id`，就显示“旧数据无轮次绑定”，不要回退到“同 session 最新 summary”。回退会重新引入错配。

对于历史数据，可以只保留 session 级浏览，不做 observation-summary 精确关联。

## 推荐落地顺序

1. **数据库迁移**：给 observations / session_summaries 增加 `turn_id`、`generation_id`、覆盖范围和状态字段。
2. **hook 透传**：在 `beforeSubmitPrompt`、observation hooks、`stop` / `sessionEnd` 中统一生成并传递 `turn_id`。
3. **worker pending map**：让 `/api/session/end` 可以等待当前轮 `agent_response` observation 完成。
4. **turn 级 summary**：新增 `generateSummaryForTurn()`，只总结当前 `turn_id` 的 observations。
5. **summary 写库语义**：记录 `covered_observation_ids` 和 `summary_status`，避免无法判断覆盖范围。
6. **Viewer 查询改造**：只按 `turn_id` 关联 summary；旧数据没有 `turn_id` 时明确显示为不可精确关联。
7. **兼容历史数据**：旧 rows 保持可搜索、可按 session 查看，但不再参与“当前 observation 对应 summary”的精确展示。

## 验证方法

### 手工复现

1. 使用一个已有很多历史 observations 的长 Cursor session。
2. 发起一个新问题，确保 assistant 回答会生成 `agent_response` observation。
3. 观察 worker 日志中这两类日志的先后顺序：
   - `=== Summary STORED successfully ===`
   - `=== Observation STORED successfully === {"obsId":...,"type":"debugging" | "agent_response"...}`
4. 如果 summary 时间早于当前轮 observation，而 Viewer 仍把它展示成关联 summary，则复现成功。

### 数据库断言

查询目标 observation：

```sql
SELECT id, memory_session_id, title, created_at_epoch
FROM observations
WHERE id = 22245;
```

查询同 session 最新 summary：

```sql
SELECT id, memory_session_id, request, created_at_epoch
FROM session_summaries
WHERE memory_session_id = 'mem-1778052921160-tw4d1'
ORDER BY created_at_epoch DESC
LIMIT 5;
```

修复后必须同时满足：

- 当前轮 `user_prompt`、tool observations、`agent_response` observation 和 summary 具有同一个 `turn_id`。
- 当前轮 summary 的 `covered_observation_ids` 包含本轮 `agent_response` observation id。
- 当前轮 summary 的 `created_at_epoch` 晚于或等于本轮必需 observations 的入库时间。
- Viewer 通过 `turn_id` 查询到的 summary 主题与当前 observation 所属问题一致。
- 对没有 `turn_id` 的历史数据，Viewer 不提供“当前 observation 对应 summary”的精确关联。

## 相关代码入口

- `src/hooks-cli.ts`
  - `handleStop()`
  - `handleSessionEnd()`
- `src/services/worker/client.ts`
  - `summarizeSession()`
- `src/services/worker/WorkerService.ts`
  - `handleSessionEnd()`
  - `/api/observation` 处理路径
- `src/services/worker/SDKAgent.ts`
  - `processObservation()`
  - `generateSummary()`
- `src/services/sqlite/observations.ts`
- `src/services/sqlite/summaries.ts`

## 教训

- 不能把“同 session 最新 summary”当成“当前 observation 的 summary”。
- 异步链路里，HTTP accepted 只代表请求接收成功，不代表 AI 抽取已经写库。
- 判断 summary 是否覆盖某条 observation，必须看数据库时间戳和 worker 日志，而不是只看 Viewer 中相邻卡片。
- 长会话下仅靠 `memory_session_id` 做聚合粒度太粗，后续需要 turn 级别的绑定字段。
