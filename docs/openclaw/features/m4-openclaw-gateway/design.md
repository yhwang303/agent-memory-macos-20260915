# M4 · OpenClaw 网关插件

**里程碑**：M4（路线图第 4/5 步）
**工作量**：~4 个工作日
**前置**：M2（需要 `/api/context/inject` 已有 RAG 后端）
**后继**：M5

---

## 1. 问题陈述

OpenClaw 是 **聊天网关**（Telegram/Discord/Slack 上运行的 agent runtime），其 embedded runner 直接调 Anthropic API、**不启动 Claude Code 进程**，所以本地 hook 链路完全走不通。

agent-memory 需要一个 OpenClaw 插件，让网关里跑的 Agent 也能享有持久记忆 + 跨会话 context 注入 + 实时观察推送。

## 2. 设计范围

完全参照 claude-mem 的 OpenClaw 插件（`claude-mem/openclaw/` 子目录 + `claude-mem/src/integrations/openclaw-plugin/`），移植到 agent-memory。

## 3. 架构

```
OpenClaw Gateway (Node process)
  │
  ├─ before_agent_start ───► POST /api/sessions/init
  ├─ before_prompt_build ──► GET  /api/context/inject (cached 60s)
  ├─ tool_result_persist ──► POST /api/sessions/observations
  ├─ agent_end ─────────────► POST /api/sessions/summarize
  └─ gateway_start ────────► 清空 session tracking + context cache
                                  │
                                  ▼
                       agent-memory Worker (localhost:37777)
                           ├─ /api/sessions/init
                           ├─ /api/sessions/observations
                           ├─ /api/sessions/summarize
                           ├─ /api/sessions/complete
                           ├─ /api/context/inject  ← M2 提供
                           └─ /stream (SSE: new_observation)
                                  │
                                  ▼
                       Observation Feed 服务（可选）
                           └─ Telegram/Discord/Slack/Signal/WhatsApp/LINE
```

## 4. 模块清单

### 4.1 Worker 端新增（或升级）端点

| 端点 | 方法 | 作用 | 已有？ |
|---|---|---|---|
| `/api/sessions/init` | POST | 创建 session | M1 已有等价功能，需扩展 `project` 字段 |
| `/api/sessions/observations` | POST | 录入 observation | 已有 |
| `/api/sessions/summarize` | POST | 触发 summary | 已有 |
| `/api/sessions/complete` | POST | 关闭 session | 新增 |
| `/api/context/inject` | GET | 拉 context markdown | 新增（M2 可能已准备骨架） |
| `/stream` | GET (SSE) | 新 observation 推送 | 新增 |
| `/api/health` | GET | 健康检查 | 已有 |
| `/api/readiness` | GET | 就绪检查 | 新增 |

### 4.2 Context 注入端点

```ts
// GET /api/context/inject?project=<name>&limit=20
// 输出 markdown timeline:
//
// ## Recent Context (<project>)
//
// ### 2026-04-21
// - [obs] 修复了 Worker 端口冲突问题
// - [sum] 完成了 M1 图片语义修复
// ...
```

实现：
- 先查 `session_summaries` 最近 N 条
- 再查高 `discovery_tokens` 的 observations
- M2 就绪后，可选加上"与当前上下文向量相似"的记忆

60s 内存 LRU 缓存，按 project key。

### 4.3 SSE /stream 端点

Worker 内部 EventEmitter：observation 写库成功后 `emit('new_observation', {...})`。`/stream` 端点 subscribe 并以 SSE 格式写回。

### 4.4 OpenClaw 插件本体

```
src/integrations/openclaw-plugin/
  ├── index.ts                # 插件入口，注册 5 个事件 handler
  ├── config-schema.json      # OpenClaw 插件配置 schema（移植 openclaw.plugin.json）
  ├── hooks/
  │   ├── beforeAgentStart.ts
  │   ├── beforePromptBuild.ts
  │   ├── toolResultPersist.ts
  │   ├── agentEnd.ts
  │   └── gatewayStart.ts
  ├── feed/
  │   ├── ObservationFeed.ts       # SSE 消费者 + 指数退避重连
  │   ├── channels/
  │   │   ├── telegram.ts
  │   │   ├── discord.ts
  │   │   ├── slack.ts
  │   │   ├── signal.ts
  │   │   ├── whatsapp.ts
  │   │   └── line.ts
  │   └── EmojiAssigner.ts
  ├── commands/
  │   ├── status.ts               # /agent_mem_status
  │   └── feed.ts                 # /agent_mem_feed
  └── README.md
```

## 5. 配置

```json
{
  "plugins": {
    "agent-memory": {
      "enabled": true,
      "config": {
        "project": "my-gateway",
        "syncMemoryFile": true,
        "syncMemoryFileExclude": ["debugger"],
        "workerPort": 37777,
        "workerHost": "127.0.0.1",
        "observationFeed": {
          "enabled": false,
          "channel": "telegram",
          "to": "123456789",
          "botToken": "optional"
        }
      }
    }
  }
}
```

## 6. 安装器

`src/services/integrations/OpenClawInstaller.ts`：
- 检测 `~/.openclaw` 存在
- 写 gateway 的 `plugins` 段（YAML/JSON）
- 复制 `src/integrations/openclaw-plugin/` 到 `~/.openclaw/plugins/agent-memory/`
- 启动 Worker（若未启动）

## 7. 测试计划

### 7.1 单元

- 每个 channel adapter 独立可测（mock HTTP）
- `ObservationFeed` 重连退避
- `EmojiAssigner` 一致性（同 agent id 同 emoji）

### 7.2 集成

- 启动本地 OpenClaw dev gateway（docker-compose.dev.yml）
- 跑 5 轮对话，验证：
  - observations 写入 agent-memory SQLite
  - `/api/context/inject` 在下一轮 prompt build 返回非空
  - SSE 可订阅到新 observation
  - Telegram channel 能收到格式化推送

### 7.3 降级

- Worker 不可达 → `/api/readiness` 30 次重试 → exit 0 不 block 网关
- SSE 断连 → 指数退避 1s→30s

## 8. 文件清单（节选）

| 类目 | 数量 |
|---|---|
| 插件源码 | ~12 文件 |
| 通道适配器 | 6 |
| Worker 端新端点 | 4（/complete、/context/inject、/stream、/readiness） |
| 测试 | ~15 |
| 配置模板 / schema | 2 |

---

## 9. 非目标

- 不做 OpenClaw 自身运维（用户自备 gateway）
- 不支持 Pro 功能（license gate）
- 不接入非 IM 的通道（邮件/Webhook 另算）
- 不做端到端加密（OpenClaw 层负责）

---

## 10. 风险

| 风险 | 缓解 |
|---|---|
| OpenClaw 插件 ABI 变动 | 锁版本；在 README 记录兼容范围 |
| SSE 在某些反向代理下被 buffer | 参考 claude-mem：强制 `X-Accel-Buffering: no`、定期 keepalive ping |
| Worker 与 Gateway 部署在不同机器 | 放开 `workerHost` 为非 127.0.0.1，提供鉴权（Bearer token） |
| observation 洪泛推送把 Telegram 刷屏 | 每通道独立队列 + 1/s 限频 |

## 11. 验收标准

- [ ] 插件可装入真实 OpenClaw dev gateway
- [ ] 5 轮对话后 observation / summary 写入 agent-memory SQLite
- [ ] `/api/context/inject` 在第二轮能返回前一轮的 summary 摘要
- [ ] 至少 3 个 channel（telegram/discord/slack）端到端通
- [ ] 30 秒内的 SSE 断连能自动恢复

---

*下一里程碑：M5 运行时迁移 + 打包。*
