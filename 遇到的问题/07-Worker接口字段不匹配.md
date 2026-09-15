# 07 · Worker 接口字段不匹配（`Session start missing required fields`）

## 现象
- 调试 OpenClaw → Agent Memory 链路时，手工 curl `/api/session/start`，worker 日志报：
  ```
  Session start missing required fields
  ```
- 但 OpenClaw 真实运行时也偶发同样报错。

## 根本原因
- `WorkerService.handleSessionStart` 期望的字段是 `sessionId` / `userPrompt` / `project` 这些 camelCase 名字。
- 早期插件代码里有的地方写成 `session_id` / `user_prompt`（snake_case），有的地方又写 `prompt`，与 worker 不一致直接被拒。

## 解决
- 统一插件 hook 里 `postJson` 调用的 payload 字段：
  - `sessionId`（不是 `session_id`）
  - `userPrompt`（不是 `prompt`）
  - `project` / `sourceIDE` / `metadata`
- `pickSessionId(event, ctx)` 兜底从 `event.session_id` / `event.sessionId` / `ctx.sessionId` / `ctx.sessionKey` 里挑一个，最后 fallback 到 `openclaw-<ts>`，避免空值。

## 教训
- 跨边界（IPC / HTTP）的字段名要么严格统一命名风格，要么在入口处做一次 schema 校验+归一化。
- worker 的入参文档要和插件实现绑定（同一份 type/schema），否则改一边就漏。
