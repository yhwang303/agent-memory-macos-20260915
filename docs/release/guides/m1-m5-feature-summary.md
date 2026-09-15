# agent-memory M1–M5 功能总结

**日期**：2026-04-22  
**分支**：`feat/claude-mem-integration`  
**基线**：`8708ff1`（M2 完成后）→ `e58b222`（M5 完成后）  
**Commits**：18 个（M3: 10, M4: 4, M5: 4），加上此前 M1: 8, M2: 18

---

## M1 · 图片语义修复

**问题**：Claude Code 会话中包含图片（截图/设计稿/错误截图等），但生成 summary 时图片描述丢失，导致后续会话无法回忆图片内容。

**方案**：读取 Claude Code 的 transcript 文件（JSONL），提取 assistant 最后一条消息中对图片的文字描述，注入到 summary 生成 prompt 中。

**关键文件**：
- `src/shared/transcript-parser.ts` — 尾读 JSONL，提取 assistant 最后消息
- `src/hooks/transcript-observation-common.ts` — Stop/PreCompact 共享 transcript 读取
- `src/hooks/stop-transcript.ts` / `pre-compact.ts` / `attachments.ts`
- `src/sdk/prompts.ts` — `buildSummaryPrompt` 增加 Agent Last Response 段

**验证方法**：
1. 在 Claude Code 中打开一张图片，让 Claude 描述它
2. 会话结束后检查 `~/.agent-memory/agent-memory.db` 中对应 session 的 summary
3. summary 应包含图片内容的描述

---

## M2 · RAG 混合搜索

**问题**：纯 SQLite FTS5 对中文语义理解有限，"修复了端口冲突" 搜不到 "解决了端口占用问题"。

**方案**：引入 Chroma 向量库（通过 `chroma-mcp` Python 侧车）+ `bge-m3` 中文 embedding 模型，与 FTS5 用 RRF（Reciprocal Rank Fusion）融合排序。

**关键能力**：
- 三种搜索模式：`sqlite`（纯FTS5）、`chroma`（纯向量）、`hybrid`（混合，默认）
- 无 Python/uv 时自动降级到 sqlite-only
- `/api/search?mode=hybrid` 新参数
- `settings.json` 可配置 `rag.enabled`、`embedding_model`、`hybrid_weights`

**验证方法**：
- 需要安装 uv + bge-m3 模型（约 2GB），或跳过此功能使用纯 SQLite

---

## M3 · 多平台 IDE 适配器

**新增 11 个平台**，加上原有的 Cursor/Claude Code/CodeBuddy，共 16 个：

| 平台 | 接入方式 | 适配器文件 |
|------|---------|-----------|
| Windsurf | Hooks (camelCase, 同 Cursor) | `src/adapters/windsurf.ts` |
| Gemini CLI | Hooks (PascalCase, 同 Claude Code) | `src/adapters/gemini-cli.ts` |
| OpenCode | Hooks (PascalCase) | `src/adapters/opencode.ts` |
| Codex CLI | Transcript (无 hooks) | `src/adapters/codex-cli.ts` |
| Cursor | 升级：增加 transcript 支持 | `src/adapters/cursor.ts` (修改) |
| Copilot CLI | MCP-only | `McpIntegrations.ts` |
| Antigravity | MCP-only | `McpIntegrations.ts` |
| Goose | MCP-only | `McpIntegrations.ts` |
| Crush | MCP-only | `McpIntegrations.ts` |
| Roo Code | MCP-only | `McpIntegrations.ts` |
| Warp | MCP-only | `McpIntegrations.ts` |

**安装器**：`BaseHooksInstaller` 抽象基类 + 6 个具体 installer，支持备份 + 深度合并配置。

**CLI 命令**：
```bash
agent-memory install --all     # 自动检测并安装
agent-memory install cursor    # 安装指定 IDE
agent-memory status            # 查看所有平台状态
agent-memory uninstall <id>    # 卸载
```

---

## M4 · OpenClaw 网关插件

**场景**：OpenClaw 是聊天网关（Telegram/Discord/Slack 上的 agent），不启动 Claude Code 进程，hook 链路走不通。

**方案**：为 Worker 新增 3 个端点 + EventEmitter + 完整 OpenClaw 插件：

| 新端点 | 用途 |
|--------|------|
| `POST /api/session/complete` | 关闭 session |
| `GET /api/readiness` | 深度就绪检查 |
| `GET /stream` | SSE 实时推送 observation/summary |

**插件结构**（`src/integrations/openclaw-plugin/`）：
- 5 个 hooks：`beforeAgentStart` / `beforePromptBuild` / `toolResultPersist` / `agentEnd` / `gatewayStart`
- 3 个通知通道：Telegram / Discord / Slack
- SSE 消费者 + 指数退避重连
- EmojiAssigner（同 agent 同 emoji）

---

## M5 · 运行时迁移 + AGPL + 打包

| 项目 | 状态 |
|------|------|
| Bun API 检查 | ✅ src/ 中零 Bun API |
| AGPL-3.0 切换 | ✅ LICENSE + NOTICE + package.json |
| 统一 CLI | ✅ `src/cli.ts`（doctor/version/install/status） |
| pkg 配置 | ✅ `@yao-pkg/pkg` 三平台目标 |
| CI/CD | ✅ `.github/workflows/ci.yml` + `release.yml` |
| 迁移指南 | ✅ `docs/MIGRATION.md` |

---

## 测试指标

| 指标 | 值 |
|------|-----|
| 总测试数 | 276 |
| Pass | 273 |
| Fail | 2（pre-existing viewer-api，非本次改动） |
| Skip | 1（Chroma 集成，需 uv） |
| TypeScript 类型检查 | 0 错误 |
| Bun API 残留 | 0 |

---

## 待手工验证

- [ ] Claude Code 图片语义：10 组含图片会话，summary 命中 ≥ 8/10
- [ ] 各 IDE 配置路径真实性
- [ ] OpenClaw 真实 gateway 集成
- [ ] .exe 冷启动
- [ ] Telegram/Discord/Slack 推送
