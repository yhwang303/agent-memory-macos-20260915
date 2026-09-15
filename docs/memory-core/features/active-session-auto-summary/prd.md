# 需求文档：active 会话闲置自动总结

> 日期：2026-04-28
> 关联设计：`2026-04-28-active会话闲置自动总结-设计文档.md`

## 背景

当前 worker 端的 session 状态翻转和 summary 生成完全依赖外部主动调用 `/api/session/end` 或 `/api/session/complete`：

- Cursor / Claude Code / IDE hooks 路径：通过 hooks-cli 的 `session-end` 事件触发，正常。
- OpenClaw `agents.run` 主路径（CLI / TUI / cron / boot check）：通过 plugin 的 `agent_end` hook 触发，正常。
- **OpenClaw 跟 main agent 直接对话（Control UI / 联系人 chat）**：OpenClaw 把 main agent 当**常驻会话**，每条用户消息都续在同一个 `content_session_id=agent:main:main` 里，不主动结束。结果：
  - session.status 永远是 `active`
  - 永远不会触发 summary 生成
  - viewer 看到一堆"裸 observation"但没有总览

实测举证：
- session `agent:main:main` 自 `2026-04-28T09:26:05.444Z` 起 status 一直是 `active`，下面已堆了 3 条 observation（"你好"/日常问候/"我喜欢吃鱼"），没有任何 summary 出来。
- summaries 表里其他 session 的 title 也大量为空，这是另一个问题（LLM 配额耗尽），本期**不处理**。

## 目标

让 worker 自身具备"闲置即结束"的能力：

1. 在没有任何外部信号的情况下，**周期性**扫描 active 会话。
2. 对长时间无新 observation 的 session，自动调用现有 summary 生成路径，并把 status 翻成 `completed`。
3. 不增加 LLM 调用风暴，不影响真在跑的 session。
4. 配置可关闭、可调阈值；默认开启、默认值合理。

## 范围

### 范围内

- 在 `WorkerService` 内增加一个轻量的"闲置会话扫描器"。
- 扫描周期、闲置阈值、单次最大处理数都通过配置 + 环境变量调整。
- 扫描结果走与 `handleSessionEnd` 一致的内部逻辑（复用 `pendingSummaries` 去重、复用 `generateSummary` 调用、复用 `updateSessionStatus`）。
- 单元测试覆盖：扫描决策、并发去重、失败兜底。
- 手工 E2E：让 main agent 对话挂置 5 分钟，确认 status 自动翻成 `completed` 且 summary 出现一条。

### 范围外

- 不改 OpenClaw plugin（不在 plugin 端做轮询；plugin 已经够薄）。
- 不重写 summary 生成逻辑（继续复用 `SDKAgent.generateSummary`）。
- 不解决 LLM title 为空的问题（属于 provider 配额，单独跟）。
- 不做"按 prompt_counter / observation 条数"的总结（仅按时间维度）。
- 不动 channel 路径（`message_received` 已经触发过 session/start，正常）。

## 用户故事

- 作为重度 OpenClaw 用户，我跟 main agent 在 Control UI 闲聊半小时后离开，回来在 viewer 能看到这个 session 的 summary，而不是一堆碎 observation。
- 作为开发者，新创建的 active session 短期内不会被错杀（哪怕我 30 秒没动）。
- 作为运维者，我可以一键关闭这个特性（出问题时降级），也可以把阈值调到"半小时"以适应更慢的工作节奏。
- 作为成本敏感方，闲置扫描每次只对**确实无活动**的 session 调一次 LLM，不会重复调；多 worker 部署也不会重复触发。

## 成功标准

1. **正确性**：
   - 一个 active session，最近一条 observation 距今 ≥ 5 分钟（默认阈值），扫描器在下一轮扫到后**生成 summary 并把 status 翻成 `completed`、`completed_at` 非空**。
   - 一个 active session，最近一条 observation 距今 < 5 分钟，**保持 active**，扫描器跳过。
   - 一个 session 已经处于 `completed`，扫描器**永不重复处理**。
2. **去重**：扫描器跟外部 `/api/session/end` 调用走同一个 `pendingSummaries` Map，并发触发同一 session 时只生成一次 summary。
3. **稳定性**：
   - LLM 失败时 status **不**翻成 `completed`，下一轮扫描会再次尝试（但有最少间隔，避免风暴）。
   - 扫描自身崩溃不会让 worker 进程退出（顶层 try/catch + logger.error）。
4. **可关性**：环境变量 `IDLE_SUMMARY_ENABLED=false` 或配置 `idleSummary.enabled=false` 时，扫描器**完全不启动**。
5. **可观测**：每次扫描结束写一行 `INFO` 日志（扫到几条、处理几条、跳过几条）；每次成功结束一个 session 写一行 `INFO`。
6. **零回归**：`npm run typecheck` / `npm run check` / 现有 worker 与 plugin 单测全绿。

## 配置项

| 名称 | 默认 | 说明 |
|---|---|---|
| `IDLE_SUMMARY_ENABLED` | `true` | 主开关，环境变量优先 |
| `IDLE_SUMMARY_THRESHOLD_MS` | `300000`（5 分钟） | 距最后一条 observation 超过这个时长才结束 |
| `IDLE_SUMMARY_SCAN_INTERVAL_MS` | `60000`（1 分钟） | 扫描周期 |
| `IDLE_SUMMARY_MAX_PER_SCAN` | `5` | 单次扫描最多处理多少个 session（防风暴） |
| `IDLE_SUMMARY_RETRY_BACKOFF_MS` | `300000`（5 分钟） | 同一 session 失败后多久才允许下次重试 |

## 非目标

- 不实现配置热更新（修改后需要重启 worker）。
- 不实现"按 idle 阈值×系数滑动"的智能算法（一刀切就够用）。
- 不实现跨设备同步唯一性（worker 是本机进程，不需要分布式锁）。

## 风险

| 风险 | 缓解 |
|---|---|
| 误杀真在跑的 long-running CLI 会话 | 阈值 5 分钟 + 用"最后一条 observation 时间"判断，而不是 started_at；正常 agent 跑工具时每分钟都有新 observation |
| 启动时一次性扫到大量历史 active session 把 LLM 打爆 | `IDLE_SUMMARY_MAX_PER_SCAN=5` 限流，且 `pendingSummaries` 去重 |
| LLM 配额耗尽 → 反复重试 → 反复 429 | 加 `IDLE_SUMMARY_RETRY_BACKOFF_MS`，同一 session 失败后 5 分钟内不再扫 |
| 扫描线程崩溃影响 worker | 顶层 try/catch + setInterval handle 不抛异常 |

## 验收方式

按"成功标准"逐条 checklist；其中第 1 条用一段实测数据交付：

```text
T=0:00  POST /api/session/start sessionId=test-idle-X  → 200
T=0:00  POST /api/observation sessionId=test-idle-X    → 200
T=5:30  扫描器自动触发                                  → status='completed', completed_at 非空
T=5:30  GET /api/viewer/summaries 命中 1 条 msid=...    → 通过
```
