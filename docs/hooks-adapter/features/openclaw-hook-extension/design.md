# 设计文档：OpenClaw 插件 hook 覆盖范围扩展

> 日期：2026-04-28
> 关联需求：`2026-04-28-OpenClaw插件hook覆盖扩展-需求文档.md`

## agent-memory 的 summary 准入标准（核心机制）

> 这是判定 OpenClaw 是否合格接入 agent-memory 的「尺子」。改 hook 之前先把尺子立清楚。

### 触发标准（按频率高 → 低）

| 触发源 | 何时触发 | 端点 | 频率 |
|---|---|---|---|
| **`stop` hook**（IDE 各 adapter 都注册） | agent **每一轮回复结束**就触发一次 | `POST /api/session/end` | **高频，每条消息一次** |
| `sessionEnd` hook | IDE composer / 会话窗口关闭 | `POST /api/session/end` | 低频 |
| OpenClaw plugin `agent_end` hook | OpenClaw 每次 attempt 结束 | **应当**调 `POST /api/session/end` | 中频 |

> 关键：summary 不是「session 结束才生成」，而是 **每轮 agent 回复完都重新生成一条**。同一个 `memory_session_id` 在 `session_summaries` 表里会**累积多行**（INSERT，不 UPDATE），按 `created_at_epoch DESC` 取最新就是当前画面。

### 入选标准

- 必须有 ≥ 1 条 observation（最长等 30s，超时跳过，不生成 summary）
- 没 observation = 这次会话「没发生过值得记忆的事」→ 不写假 summary
- observation 超过 20 条只取最近 20 条（防 prompt 过长 LLM 超时）

### 内容质量标准

- LLM 必须输出 `<summary>` XML 块，含 8 字段：`request / investigated / learned / media_context / meta_intent / completed / next_steps / notes`
- **拒收门槛**：任何主字段精确等于以下 6 串之一，整条 summary 拒绝写库：
  - `Session completed` / `Various files and tools` / `Information gathered during session` / `Tasks completed` / `Tool Execution` / `Tool was executed successfully`
- 全中文、聚焦用户意图，不罗列文件路径

### 并发去重标准

- `pendingSummaries` Map 按 `memory_session_id` 防「同时跑多个 generateSummary」
- 不防「先后触发」——所以连续 5 条消息 = 顺序产生 5 条 summary 行

### 字段聚合标准

- `files_read` / `files_edited` 由 worker **从 observations 聚合**，不取 LLM 输出
- `prompt_number` / `discovery_tokens` 当前固定 0

### 一句话

> **每次 agent 回复结束 → `POST /api/session/end` → 有 obs 就让 LLM 压成 8 字段一条新 summary 入库；没 obs 或命中占位符就拒绝写**。

---

## 现状

### 服务运行状态

| 组件 | 端口 | 状态 |
|---|---|---|
| OpenClaw Gateway | `127.0.0.1:18789` | LaunchAgent 管理，已运行 |
| OpenClaw Control UI | `127.0.0.1:18789/control`、`18791/` | 已运行 |
| Agent Memory Worker | `127.0.0.1:3847` | 桌面 App 子进程，已运行（PID 7729） |

### 现有插件已注册的 hook（5 个）

| Hook | 实现位置 | 当前行为 | 实测效果 |
|---|---|---|---|
| `gateway_start` | `src/integrations/openclaw-plugin/hooks/gatewayStart.ts` | `GET /api/readiness` 唤醒 worker | OK |
| `before_agent_start` | `hooks/beforeAgentStart.ts` | `POST /api/session/start` | OK，session 落库 |
| `before_prompt_build` | `hooks/beforePromptBuild.ts` | 注入 `/api/context/inject` 内容（60s 缓存） | OK |
| `tool_result_persist` | `hooks/toolResultPersist.ts` | `POST /api/observation`，type=`tool_output` | **请求发出 OK，但 gateway 持续打 warning** |
| `agent_end` | `hooks/agentEnd.ts` | `POST /api/summary` + `POST /api/session/complete` | **summary 与 complete 全部 400 失败**（见下） |

### OpenClaw 全部 31 个 hook（按场景分类）

引用自 `/opt/homebrew/lib/node_modules/openclaw/dist/plugin-sdk/src/plugins/hook-types.d.ts`：

| 场景 | Hook |
|---|---|
| Gateway 生命周期 | `gateway_start`*、`gateway_stop` |
| Agent 生命周期 | `before_agent_start`*、`before_agent_reply`、`before_agent_finalize`、`agent_end`* |
| Prompt 构建 | `before_model_resolve`、`before_prompt_build`* |
| LLM 调用 | `model_call_started`、`model_call_ended`、`llm_input`、`llm_output` |
| 工具调用 | `before_tool_call`、`after_tool_call`、`tool_result_persist`* |
| Channel 收发 | `inbound_claim`、**`message_received`**、`message_sending`、**`message_sent`**、`before_dispatch`、`reply_dispatch` |
| 历史持久化 | `before_message_write`、`session_start`、`session_end` |
| 子 Agent | `subagent_spawning`、`subagent_delivery_target`、`subagent_spawned`、`subagent_ended` |
| 上下文压缩 | `before_compaction`、`after_compaction`、`before_reset` |
| 安装 | `before_install` |

`*` 标记为当前已注册的 5 个。

### 入口 → hook 触发矩阵

| 用户入口 | 走哪条路径 | 触发现有 hook？ | 落库？ |
|---|---|---|---|
| `openclaw agent --message ...`（CLI） | `agents.run` 主路径 | 全部触发 | 是 |
| `openclaw chat` / TUI | `agents.run` | 全部触发 | 是 |
| Cron 内部任务（capability-evolver 等） | `agents.run` | 全部触发 | 是 |
| **Control UI 跟"兰伊"等联系人聊天** | **channel 路径**（`inbound_claim` → `message_received` → dispatcher） | **0 个触发** | **否** |
| 其它 channel（Telegram/iMessage/Discord） | 同上 | 0 个触发 | 否 |
| 子 agent 触发（`subagent_*`） | 父 agent 内部 | 0 个 subagent_ hook，但父 agent 走主路径 | 父会落，子不会单独落 |

### OpenClaw 当前实现 vs Summary 标准（对照）

| 标准维度 | 标准要求 | OpenClaw 当前实现 | 是否符合 |
|---|---|---|---|
| 触发频率 | 每轮回复结束（高频，对齐 `stop`） | 仅 `agent_end`，**单 attempt 才一次**；连续多 turn 会话期间不再触发 | ⚠️ 频率偏低，但语义上仍可工作 |
| 触发端点 | `POST /api/session/end`（worker 自动调 `generateSummary`） | `POST /api/summary`（**这是「手动提交已有 summary」的端点**） | ❌ 端点用错 |
| 请求 body | `{ sessionId, reason? }`（worker 内部生成 summary） | `{ sessionId, project }`，**没有 `summary` 字段** | ❌ 缺字段 |
| handleSummary 校验 | `if (!sessionId \|\| !summary) → 400` | 永远缺 `summary` | ❌ **永远 400 失败** |
| 实际后果 | LLM 自动生成 8 字段 summary 写库 | **OpenClaw 来源的会话从未生成过 summary**（数据库里全部 0 行） | ❌ |
| 状态翻转 | `/api/session/end` 内部一并把 status 翻 `completed` | `/api/session/complete` 字段名不兼容（`session_id` vs `sessionId`），400 失败 | ❌ |

**结论：OpenClaw 当前实现完全不符合 agent-memory 的 summary 标准。** 看起来调用了两个 endpoint，实际**两个都被 worker 拒掉**，session 永远 active、summary 永远没有。

### 已发现的 bug（本期一并修）

1. **`tool_result_persist` async/sync 不匹配**
   - SDK 类型签名：`(event, ctx) => PluginHookToolResultPersistResult | void`（同步）
   - 当前实现：`async (event, ctx) => { await postJson(...) }`
   - 后果：gateway 日志频繁打印 `agent-memory ... returned a Promise; this hook is synchronous and the result was ignored`。请求**实际能发出**（fetch 在 await 前已构建并入队），仅返回值被 OpenClaw 忽略。

2. **`agent_end` 调用 `/api/summary` 端点用错**
   - 当前：`agentEnd.ts:72` 发 `POST /api/summary { sessionId, project }`
   - worker 端：`/api/summary` 是 **手动提交已生成 summary** 的端点，要求 body 含 `summary` 对象，否则 400
   - 正确做法：应当发 `POST /api/session/end { sessionId }`，由 worker 内部走 `generateSummary` → LLM 自动产 summary → 写库
   - 后果：OpenClaw 来源的会话从未产生过 LLM-generated summary（数据库 `session_summaries` 表里 `source_ide='openclaw'` 行 = 0）

3. **`/api/session/complete` 字段大小写不一致导致永久 active**
   - 部署版 `~/.openclaw/plugins/agent-memory/index.js:122` 发送 `{ sessionId }`
   - worker `WorkerService.handleSessionComplete` 期望 `{ session_id }`，缺失即 `400 session_id required`
   - 后果：sessions 表里所有 OpenClaw 来源的 session 永远 `status='active'`，summary 已生成但状态没翻
   - 同名问题对照：`handleSessionStart` 期望 `sessionId`（camelCase），`handleObservation` 期望 `sessionId`（camelCase），`handleSummary` 也是 camelCase——只有 `handleSessionComplete` 是 snake_case，明显是历史遗留不一致

4. **源码 `src/integrations/openclaw-plugin/index.ts` 与部署版 `~/.openclaw/plugins/agent-memory/index.js` 字段命名不一致**
   - 源码（如 `agentEnd.ts:14`）发的是 `session_id`（snake_case）+ `metadata.agent_id`
   - 部署版发的是 `sessionId`（camelCase）+ `metadata.agent_id`
   - 后果：源码改动不会自动反映到部署版，两套实现分叉

## 方案

### 总体思路

**最小侵入式扩展**：在现有插件代码里增量增加 hook，不改架构、不动 worker 路由结构，只新增 observation type 与一个字段大小写兼容补丁。

### 改动 1：新增 P0 hook（`message_received` + `message_sent`）

定位：`src/integrations/openclaw-plugin/hooks/messageReceived.ts`、`messageSent.ts`（新增），并在 `index.ts` 注册；同步把对应实现复刻到部署版 `~/.openclaw/plugins/agent-memory/index.js`。

`messageReceived.ts` 草稿：

```typescript
import type { OpenClawPluginConfig } from '../config.js';

export async function messageReceived(
  baseUrl: string,
  config: OpenClawPluginConfig,
  event: { session_id?: string; sessionId?: string; channel?: string;
           from?: string; text?: string; raw?: any; [key: string]: any },
  ctx: { sessionId?: string; sessionKey?: string; [key: string]: any }
): Promise<void> {
  const sessionId = event?.session_id || event?.sessionId
    || ctx?.sessionId || ctx?.sessionKey
    || `openclaw-channel-${Date.now()}`;
  const text = (event?.text ?? '').toString().slice(0, 4000);
  if (!text) return;

  try {
    await fetch(`${baseUrl}/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        project: config.project,
        userPrompt: text,
        sourceIDE: 'openclaw',
        metadata: { source: 'openclaw-channel', channel: event?.channel, from: event?.from },
      }),
    });
    await fetch(`${baseUrl}/api/observation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        toolName: 'channel_inbound',
        toolInput: { channel: event?.channel, from: event?.from },
        toolOutput: text,
        observationType: 'channel_inbound',
        sourceIDE: 'openclaw',
      }),
    });
  } catch {
    // Worker unreachable — non-blocking
  }
}
```

`messageSent.ts` 同型，`observationType='channel_outbound'`、不再 start session（沿用 received 的 sessionId）。

### 改动 2：修复 `tool_result_persist` async/sync 不匹配

把 handler 改成同步函数 + 内部 fire-and-forget：

```typescript
// hooks/toolResultPersist.ts
export function toolResultPersist(
  baseUrl: string,
  config: OpenClawPluginConfig,
  event: { session_id?: string; tool_name?: string; result?: string; [key: string]: any },
  ctx: { sessionId?: string; [key: string]: any }
): void {
  const toolName = event?.tool_name || 'tool';
  if (config.syncMemoryFileExclude.includes(toolName)) return;

  // Fire-and-forget；不返回 Promise，让 OpenClaw sync hook 检查通过
  void fetch(`${baseUrl}/api/observation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: event?.session_id || ctx?.sessionId || 'openclaw-unknown',
      toolName,
      toolOutput: (event?.result || '').toString().slice(0, 2000),
      observationType: 'tool_output',
      sourceIDE: 'openclaw',
    }),
  }).catch(() => { /* swallow */ });
}
```

`index.ts` 注册时同步包装：

```typescript
tool_result_persist: (event: any, ctx: any) => {
  toolResultPersist(baseUrl, config, event, ctx); // 不 return Promise
},
```

部署版 `index.js` 同样改成 `api.on('tool_result_persist', (event, ctx) => { void postJson(...) })`，去掉外层 `async`。

### 改动 3：修复 `/api/session/complete` 字段大小写

两处都修，**优先服务端**（影响最小）：

**worker 端**（`src/services/worker/WorkerService.ts:970`）：

```typescript
private async handleSessionComplete(req, res) {
  const body = await this.parseBody(req);
  const sessionId = body.sessionId ?? body.session_id; // 兼容两种命名
  if (!sessionId) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'sessionId required' }));
    return;
  }
  updateSessionStatus(sessionId, 'completed');
  res.statusCode = 200;
  res.end(JSON.stringify({ success: true, sessionId }));
}
```

**插件端**（部署版 `index.js:122` + 源码 `agentEnd.ts:21`）：

统一改为 camelCase：`{ sessionId }`，跟其它 endpoint 一致。

### 改动 4：可选 P1（`llm_input` / `llm_output`）

留两个空函数 stub + feature flag `config.captureLLMIO`（默认 `false`），代码评审时再决定是否打开。Stub 实现：

```typescript
api.on('llm_input', (event, ctx) => {
  if (!config.captureLLMIO) return;
  void postJson(root + '/api/observation', {
    sessionId: pickSessionId(event, ctx),
    toolName: 'llm_input',
    toolOutput: textOf(event?.prompt || event?.messages).slice(0, 2000),
    observationType: 'llm_input',
    sourceIDE: 'openclaw',
  });
});
```

`llm_output` 同型。

### 改动 5：把 `agent_end` 的 summary 调用改到正确端点（**关键**）

把 `agentEnd.ts` 里调 `/api/summary` 的那段，换成 `/api/session/end`，让 worker 内部走 `generateSummary` 自动生成 summary：

```typescript
await fetch(`${baseUrl}/api/session/end`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessionId, reason: 'openclaw_agent_end' }),
});
```

注意：
- `/api/session/end` 内部已经包含「写 summary」+「翻 status=completed」+「设 completed_at」三件事，所以**改完之后 `/api/session/complete` 那条调用可以删掉**（避免重复触发，节省一次 HTTP）
- 同步更新 `OpenClawInstaller.ts` 的 `PLUGIN_INDEX_JS` 模板，让部署版 `index.js` 也一起改
- 如果想让 OpenClaw 也对齐 IDE 的「每轮触发」高频频率，需要额外注册 `before_agent_finalize` 或 `llm_output` 作为 stop 等价物（**本期不做**，仅修正 `agent_end` 这一条）

### 改动 6：源码 vs 部署版统一

由于部署版 `index.js` 是 npm package install 时由 `OpenClawInstaller` 写出的，本期补一个 verification 步骤：

1. 修改 `OpenClawInstaller.ts` 中 `INDEX_JS_TEMPLATE` 字符串（即写入到磁盘的内容），让它跟最新 hook 集合保持一致。
2. **手动**对当前活跃环境执行一次 `cp` 或重新跑 `OpenClaw 关联`，把新版 `index.js` 推进 `~/.openclaw/plugins/agent-memory/`。
3. 长期方案：让 `OpenClawInstaller` 在每次启动时检查 `index.js` 哈希，跟 template 不一致就覆盖（**本期不做**，避免覆盖用户自定义）。

## 数据模型

新增 observation `type` 取值（写入 `observations.type` 字段）：

| type | 来源 hook | 说明 |
|---|---|---|
| `channel_inbound` | `message_received` | 用户从 channel 发来的消息原文 |
| `channel_outbound` | `message_sent` | agent 通过 channel 发出的消息 |
| `llm_input`（可选） | `llm_input` | LLM prompt 摘要 |
| `llm_output`（可选） | `llm_output` | LLM 响应摘要 |

无新表、无 schema migration。

## 配置变更

`OpenClawPluginConfig` 增加可选字段：

```typescript
export interface OpenClawPluginConfig {
  // ... existing fields
  captureChannel?: boolean;   // 默认 true，控制 message_received/sent 是否落库
  captureLLMIO?: boolean;     // 默认 false，控制 llm_input/output 是否落库
}
```

`config-schema.json`、`DEFAULT_CONFIG` 同步更新。

## 测试计划

### 自动测试

`tests/integrations/openclaw-plugin.test.ts` 增补：

1. `message_received` 触发时调用 worker 的 `/api/session/start` 与 `/api/observation`，参数包含 `observationType: 'channel_inbound'`。
2. `message_sent` 触发时调用 `/api/observation`，`observationType: 'channel_outbound'`，且不再调用 `/api/session/start`。
3. `tool_result_persist` handler 返回值类型是 `undefined`（不是 Promise）。
4. worker `/api/session/complete` 同时接受 `sessionId` 和 `session_id`。

### 手工 E2E

1. **先决条件**：worker 已运行（`curl http://127.0.0.1:3847/health` 200）。
2. 重启 OpenClaw Gateway：`openclaw gateway restart`。
3. 打开 Control UI（`http://127.0.0.1:18791/`），跟"兰伊"发"测试一下"。
4. 5 秒内 `curl 'http://127.0.0.1:3847/api/viewer/observations?limit=5'`，预期 top-1 是 `type=channel_inbound`、内容含"测试一下"。
5. 等待"兰伊"回复，预期出现 `type=channel_outbound`。
6. 跑 `openclaw agent --agent main --session-id "verify-$(date +%s)" --message "ping"`，等结束后 `curl 'http://127.0.0.1:3847/api/viewer/sessions?limit=5'`，预期对应 session `status='completed'`。
7. 同时间窗口 `tail -100 ~/Library/Logs/openclaw/gateway.log`，**不应再看到** `returned a Promise` 警告。
8. 关掉 worker（`kill 7729`），再跑 `openclaw agent --message "no-worker"`，预期：对话仍能完成、gateway 日志无栈追踪、不阻塞。

## 部署 / 灰度

- 修改后两条路径必须同步：
  - 源码 `src/integrations/openclaw-plugin/**` + worker `WorkerService.ts`（走 npm 包发版 / 桌面版重启）
  - 部署版 `~/.openclaw/plugins/agent-memory/index.js` + `~/.openclaw/plugins/agent-memory/config.json`（热替换 + `openclaw plugins registry --refresh` + `openclaw gateway restart`）
- 灰度策略：本机先跑通 7 步 E2E checklist，再随 v2.0.4 走 npm + 桌面双发布。

## 兼容性 / 回滚

- 新增 hook 全部 fire-and-forget，worker 不可用时不影响 OpenClaw。
- 新增 observation type 是开放枚举，viewer 现有列表会原样展示。
- 字段兼容补丁（`sessionId | session_id`）双向兼容，回滚不需要 schema 变更。
- 回滚方式：把 `index.js` 还原到上一个版本即可，配置文件无变更。

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| `message_received` event 字段在不同 channel 间结构不一 | observation 内容字段缺失 | `pickSessionId` + 多字段兜底；`text` 取不到时 early-return |
| 群聊大量 inbound 消息 spam observation 表 | 数据库膨胀 | 默认开启，但提供 `captureChannel=false` 关闭开关；后续可加按 channel 过滤 |
| 部署版 `index.js` 跟源码持续分叉 | 改动在源码生效但部署没动 | 本期手动同步；后续在 `OpenClawInstaller` 加 hash 校验 |
| `tool_result_persist` 改成 fire-and-forget 后日志看不到 fetch 错误 | 调试不便 | `.catch(err => logger.warn(...))` 留一行 warn 而不是完全静默 |
| `message_sending` 跟 `message_sent` 重复 | 不会，两者一前一后语义不同 | 本期只取 `message_sent`（"已发出"），不取 `sending`（"准备发"） |

## 验收清单（与需求文档一一对应）

- [ ] Control UI 跟"兰伊"对话 → `channel_inbound` + `channel_outbound` 落库
- [ ] gateway 日志不再出现 `returned a Promise` 警告
- [ ] `agent_end` 后对应 session `status=completed`、`completed_at` 非空
- [ ] **OpenClaw 来源的会话在 `session_summaries` 表里出现 LLM-generated 行**（含 `request / learned / completed` 等 8 字段，不再 0 条）
- [ ] worker 关闭时插件不抛异常、不阻塞 OpenClaw
- [ ] 源码与部署版 `index.js` 行为等价
- [ ] `npm run typecheck` / `npm run check` / `tests/integrations/openclaw-plugin*.test.ts` 全绿
