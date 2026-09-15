# 09 · OpenClaw agent 命令挂起，拿不到 `agent_end`

## 现象
- 用 `openclaw agent` 跑测试对话验证记忆链路时，命令长时间挂在那里。
- gateway 握手失败 → fallback 到 embedded 模式 → 本地 agent 跑了一会儿但**始终不触发 `agent_end` hook**，于是 observation 没落库，看起来"插件没记"。

## 根本原因
- `agent_end` hook 由 OpenClaw 在助手回合结束时主动调用；如果：
  - 模型一直没 finish（超时/挂起）；
  - 或者 agent 走到了异常路径直接退出；
  
  hook 就不会触发，整条记忆链路看起来"哑火"。
- 这不是插件的 bug，但容易被误判成"agent-memory 没接到事件"。

## 解决思路
- 暂时通过直接 curl `/api/observation` 验证 worker 侧链路（确认到 SQLite 的写入路径正常）。
- 在网关稳定的环境（合法 API key、正常网络）重新跑 `openclaw agent`，等真正的 `agent_end` 触发后再看 DB 出现 `openclaw-gateway` 项目下的 observation。
- 后续可以考虑给插件加 `before_agent_start` 时的"placeholder 写入"，至少先记录"这次尝试发生过"，而不是等 `agent_end` 才记，这样 agent 挂起也能留痕。

## 教训
- 验证集成链路时要分清"哪一段静默"：worker 没收到 vs hook 没触发 vs 模型没回。
- 长链路诊断可以先在**最近的下游**手工触发（curl `/api/observation`），证伪/证实最容易的一段。
