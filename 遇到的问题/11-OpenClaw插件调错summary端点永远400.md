# 11 · OpenClaw 插件调错 summary 端点导致永远 400

## 现象
- OpenClaw 来源的会话（`source_ide=openclaw`）在 `session_summaries` 表里**始终为 0 条**，从来没出现过 LLM-generated summary。
- `sdk_sessions` 表里 OpenClaw 来源的 session **永远 `status=active`**、`completed_at=null`，看上去"永远没结束"。
- 但是 `observations` 表正常有 `agent_response` / `tool_output` 落库——表现是"前半截写得进，后半截全失败"，gateway 也没明显报错。

## 根本原因
plugin `agentEnd.ts:72` 调的是错的端点：

```typescript
await fetch(`${baseUrl}/api/summary`, {
  body: JSON.stringify({ sessionId, project: config.project }),
});
```

worker 这两个端点名字接近但语义**完全相反**：

| 端点 | 用途 | 校验 |
| --- | --- | --- |
| `POST /api/summary` | **手动提交**一条已经生成好的 summary | 必须 body 含 `summary` 对象，否则 400 |
| `POST /api/session/end` | **触发** worker 走 `generateSummary` 自动生成 | 只需 `sessionId` |

plugin 把上面那个调成了下面那个的语义，永远缺 `summary` 字段 → 被 worker `if (!sessionId || !summary) return 400` 拒掉 → OpenClaw 来源的会话**从未跑过 LLM summary 生成流程**。

下一行 `/api/session/complete` 同时也因字段大小写不一致（`session_id` vs `sessionId`）400，导致状态翻转也失败，**两条调用全部静默失败**。

## 解决
1. `agentEnd.ts` 改用 `/api/session/end`：

   ```typescript
   await fetch(`${baseUrl}/api/session/end`, {
     body: JSON.stringify({ sessionId, reason: 'openclaw_agent_end' }),
   });
   ```

2. 删掉冗余的 `/api/session/complete` 调用——`/api/session/end` 内部已经一并把 status 翻 completed 并设置 `completed_at`。
3. 同步修改 `src/services/integrations/OpenClawInstaller.ts` 和 `desktop/src/services/OpenClawRegistrar.ts` 两份内嵌的 `PLUGIN_INDEX_JS` 模板，避免源码与部署版分叉。
4. 已部署版 `~/.openclaw/plugins/agent-memory/index.js` 直接热替换。
5. 单测加断言锁定：必须打 `/api/session/end`，禁止再调 `/api/summary` / `/api/session/complete`。

实测：CLI 触发一次 `openclaw agent --message "ping"`，2 分 19 秒内 session 翻 `completed`、summary id 入库、8 字段全填满。

## 教训
- API 端点命名相近不代表语义相近。改 plugin 前必须先把 worker 该端点的契约（前 5 行 handler 校验逻辑）拉出来比对。
- "调用发出 ≠ 数据到位"。fetch 都返回了、没人抛异常，但 worker 400 拒收——必须有 e2e 验证（viewer 接口 + DB 直查）兜底，不能只看客户端调用日志。
