# claude-mem → agent-memory 集成 · Handoff 文档

**接手日期**：2026-04-22
**分支**：`feat/claude-mem-integration`（基于 master，已领先 30 commits）
**仓库**：`E:\Github\agent-memory`
**HEAD**：`2fd03f4`（M3 完成后）

---

## 总体目标

把 claude-mem v12.3.8 的关键特性合并进 agent-memory，用**单条分支顺序推进 5 个里程碑**，最终一次性合回 master 并发布 `.exe`。

| ID | 名称 | 状态 |
|---|---|---|
| M1 | 图片语义修复（Claude Code transcript 读取） | ✅ 完成 |
| M2 | RAG + SQLite 双重查询（Chroma + bge-m3） | ✅ 完成 |
| M3 | 新平台批量接入（11 个 IDE/CLI） | ✅ 完成 |
| M4 | OpenClaw 网关插件 | ✅ 完成 |
| M5 | 运行时迁移 + AGPL 切换 + .exe 打包 | ✅ 完成 |

---

## 必读文档（按阅读顺序）

1. **顶层路线图**：`docs/superpowers/specs/2026-04-21-00-top-level-roadmap.md`
   - 全局约束、依赖关系、合入条件、风险登记表
2. **M1 规格 + plan**：
   - `docs/superpowers/specs/2026-04-21-m1-image-semantics-design.md`
   - `docs/superpowers/plans/2026-04-21-m1-image-semantics.md`
3. **M2 规格 + plan**（刚完成，附完成状态表）：
   - `docs/superpowers/specs/2026-04-21-m2-rag-hybrid-search-design.md`
   - `docs/superpowers/plans/2026-04-21-m2-rag-hybrid-search.md`
4. **M3/M4/M5 规格**（已 brainstorm，尚未产出 plan）：
   - `docs/superpowers/specs/2026-04-21-m3-multi-platform-adapters-design.md`
   - `docs/superpowers/specs/2026-04-21-m4-openclaw-gateway-design.md`
   - `docs/superpowers/specs/2026-04-21-m5-runtime-migration-design.md`
5. **待用户确认事项清单**：`docs/superpowers/TODO.md`（所有需要人工决策的条目都在这里）
6. **claude-mem 源码参考**：`claude-mem/`（AGPL-3.0，本地只读，不 track；直接复制代码到 agent-memory 已获用户授权）

---

## 全局约束

| 项 | 决定 |
|---|---|
| 运行时 | **Node.js only**（未来要 pkg 成 .exe；claude-mem 的 Bun API 要在 M5 重写） |
| 许可证 | agent-memory 最终切到 **AGPL-3.0**（M5 正式切；当前仍是 MIT，但允许直接复制 claude-mem 源码） |
| RAG 向量化 | **chroma-mcp**（Python 侧车，uv 管理）+ `bge-m3`（中文 embedding） |
| 数据存储 | SQLite 主库不变（`~/.agent-memory/agent-memory.db`）；Chroma 在 `~/.agent-memory/chroma/` |
| 分支策略 | **一条分支顺序推 M1→M5，最后单次合入** |
| 交付 | .exe 产品 + 源码（AGPL） |

---

## 工作方式

**Subagent-Driven Development**（`superpowers:subagent-driven-development` skill）：
- 每个 task 派发一个 fresh implementer subagent，粘贴完整 task 文本
- implementer 完成后，派发 **spec-compliance reviewer**，发现偏差让同一 implementer 修
- 再派发 **code-quality reviewer**，两轮都通过才进下一个 task
- 简单/机械 task 可以把 spec+quality 合并成一次 reviewer 节约预算

**测试**：`npx tsx --test <file>` 或 `npm test`（Node's built-in test runner + tsx）
**类型检查**：`npm run typecheck`（`tsc --noEmit`）
**提交约定**：`feat(m<N>):` / `fix(m<N>):` / `refactor(m<N>):` / `test(m<N>):` / `docs(m<N>):`
**已知 flaky**：`tests/viewer-api.test.ts` 2 条 assertion 失败 **早于本分支就存在**，别去修也别因此觉得自己破坏了什么

---

## M1 / M2 交付清单（已完成）

### M1（8 commits, `2269e32` → `56ffa56`）
- `src/shared/transcript-parser.ts`：尾读 JSONL，导出 `readLastAssistantMessage` / `readLastUserMessage` / `safeReadLastAssistantMessage`
- `src/hooks/transcript-observation-common.ts`：Stop + PreCompact 共享路径
- `src/hooks/stop-transcript.ts`、`src/hooks/pre-compact.ts`、`src/hooks/attachments.ts`
- `src/adapters/utils.ts::coalesceTranscriptPath`（适配 `transcript_path` / `transcriptPath` / `transcript` 三种 key）
- `src/adapters/claude-code.ts`：扩展 `EVENT_MAP` + `HOOKS_EVENTS`（+ PreCompact）
- `src/services/sqlite/Database.ts`：`sdk_sessions` 表加 `last_assistant_message` + `transcript_path` 列（via `EXPECTED_COLUMNS` 自动迁移机制）
- `src/sdk/prompts.ts::buildSummaryPrompt`：把 `lastAssistantSection` 接到总结 prompt
- `src/services/worker/SDKAgent.ts::generateSummary`：从 session 读 `last_assistant_message`
- 门控：`adapterEmitsTranscript = adapterId.startsWith('claude-')`（codebuddy-ide 目前被挡在门外）

### M2（18 commits, `8835de4` → `61f0cda`）
- **Config**：`src/config/settings.ts`（`loadSettings`，rag.enabled/embedding_model/fallback_mode/hybrid_weights/rrf_k）
- **Chroma 侧车栈**：
  - `src/services/sync/ChromaProcessManager.ts`（uv 检测 + uvx 拉起 chroma-mcp + SSL_CERT_FILE 透传 + SIGTERM/SIGKILL stop）
  - `src/services/sync/ChromaMcpManager.ts`（stdio JSON-RPC 客户端；`initialize` + `notifications/initialized`；stdout 关闭 → 挂起请求快速失败）
  - `src/services/sync/ChromaSync.ts`（`ensureCollection` / `syncObservation` / `syncSummary` / `bulkReindex` / `query` / `deleteObservation` / `deleteSummary`；删了 user_prompts）
- **Schema**：`chroma_sync_state(doc_id PK, synced_at, embedding_hash, status)` via `ensureChromaSyncState`
- **搜索层**：`src/services/worker/search/`
  - `types.ts`（SearchMode / SearchInput / RankedObservation / RankedSummary / SearchResults）
  - `SQLiteSearchStrategy.ts`（包现有 FTS5）
  - `ChromaSearchStrategy.ts`（通过 `ChromaSyncLike` 接口，用 `getObservationsByIds` / `getSummariesByIds` 注水）
  - `HybridSearchStrategy.ts`（RRF：`score = 1/(k+rank)`，k=60 默认）
  - `SearchOrchestrator.ts`（路由 + graceful degrade：chroma 挂了自动回落 sqlite）
  - `ResultFormatter.ts`（HTTP/MCP 响应规范化）
- **接入**：
  - `WorkerService` 增 `chromaProcess` / `chromaMcp` / `chromaSync` + `initChroma()`（fire-and-forget，启动不阻塞）+ 完成后 **rebuild searchOrchestrator** 激活 hybrid
  - `/api/search` 改走 Orchestrator，保持向后兼容字段（`success`/`results`/`count`）+ 新字段（`mode`/`fellBack`/`observations`/`summaries`）
  - `/api/sync/status` + `/api/sync/reindex`（202 + 后台）
  - MCP `search` 工具：schema 加 `mode` / `obs_type` / `dateStart` / `dateEnd`，数组走 `buildSearchParams` 逗号拼接
- **运维**：
  - `scripts/wipe-chroma.cjs` + `npm run wipe-chroma`
  - `tests/e2e/m2-search-integration.test.ts`（uv 缺失时自动 skip）
- **测试数**：全量 169 tests，166 pass，2 pre-existing fail，1 intentional skip。`npm run typecheck` 干净。

---

## 下一步：M3 —— 要做的事情

### 范围

**接入 11 个平台**（按 hooks / transcript / mcp 三类模板化）：

| 平台 | 接入方式 | 备注 |
|---|---|---|
| cursor（升级） | 现有适配器需要用 M2 的 transcript 读取能力补图片语义 | 已部分存在，需对齐 M1 改动 |
| opencode | TBD（看 spec） |  |
| windsurf | TBD |  |
| gemini-cli | TBD |  |
| codex-cli | transcript-based，复用 M1 的 `transcript-parser.ts` | 用户明确要求纳入 |
| copilot-cli | TBD |  |
| antigravity | TBD |  |
| goose | TBD |  |
| crush | TBD |  |
| roo-code | TBD |  |
| warp | TBD |  |

**重要约束**：
- M3 **依赖 M1**（`transcript-parser.ts`、`transcript-observation-common.ts`、`coalesceTranscriptPath`）
- M3 **依赖 M2**（新平台的 observation 写入后会走 ChromaSync）
- 事件规范差异大，**不逐个手写**：按 hooks / transcript / mcp 三类做模板

### 工作流

1. **先读 spec**：`docs/superpowers/specs/2026-04-21-m3-multi-platform-adapters-design.md`（里面有每个平台的事件格式、transcript 路径模式、门控逻辑）
2. **产出 plan**：用 `superpowers:writing-plans` skill，输出到 `docs/superpowers/plans/2026-04-21-m3-multi-platform-adapters.md`
3. **执行**：用 `superpowers:subagent-driven-development`，预算 ~30–40 个 subagent dispatch
4. **每个平台的 smoke test** 要进 `tests/adapters/`；真实 IDE 回归记到 `docs/superpowers/reports/m3-smoke-<platform>.md`

### 需要用户确认的事（开始前）

（这些 spec 里可能已经答了，但执行前再核一遍）
- codebuddy-ide 是否解除 `claude-` prefix 门控？（M1 遗留，TODO.md 有）
- 11 个平台是否有某些本地环境装不了、需要跳过 smoke？
- 是否需要 .exe 以外的分发产物（npm package？）——可能影响 M3 适配器打包方式

---

## 后续里程碑（M4/M5）摘要

**M4 · OpenClaw 网关插件**（~4 工作日）
- 依赖 M2（注入 context 走 `GET /api/context/inject`，向量化数据由 ChromaSync 提供）
- 仅在显式启动 `agent-memory gateway` 子命令时启用（SSE 常驻 vs .exe 生命周期冲突）
- spec：`2026-04-21-m4-openclaw-gateway-design.md`

**M5 · 运行时迁移 + 打包**（~3 工作日）
- Bun API → Node（claude-mem 源码里残留的 Bun.serve / Bun.file 等要替换）
- LICENSE → AGPL-3.0，NOTICE 声明 claude-mem 来源（一次脚本批量处理所有文件头）
- pkg / nexe / vercel-pkg 打 .exe
- **降级策略**：.exe 不带 Python/uv，无 uv 时 Chroma 自动禁用，走 SQLite-only（M2 已预埋此路径，M5 只需验证）
- SSL 问题在 Windows（claude-mem issue #590）：M2 已透传 `SSL_CERT_FILE`，M5 验证
- spec：`2026-04-21-m5-runtime-migration-design.md`

---

## 合入 master 的条件（验收清单）

- [ ] 5 份子 spec 都已签字（M1 ✅ M2 ✅ M3/M4/M5 待）
- [ ] 5 份 plan 对应测试通过（M1 ✅ M2 ✅ M3/M4/M5 待）
- [ ] 10 个新 IDE smoke test 表全绿（M3）
- [ ] Claude Code 图片语义回归 ≥ 8/10（M1，**用户手工跑**）
- [ ] 混合查询 recall ≥ 纯 FTS5 baseline + 20%（M2，**用户手工判分**）
- [ ] .exe 冷启动成功（M5）
- [ ] LICENSE 更新为 AGPL-3.0，NOTICE 声明 claude-mem 来源（M5）

---

## 你（接手的 agent）第一件事

打开 `docs/superpowers/specs/2026-04-21-m3-multi-platform-adapters-design.md`，完整读一遍，然后调用 `superpowers:writing-plans` skill 产出 M3 的实施 plan。产出后走正常的 subagent-driven-development 流程。

**不要**：
- 切到 master 或新建其他分支
- 修 `tests/viewer-api.test.ts` 那 2 条 pre-existing 失败
- 跳过 review 步骤
- 把 claude-mem 的 Bun API 直接搬过来（先在 M3 里改成 Node；M5 会做系统性扫查）

**必须**：
- 继续在 `feat/claude-mem-integration` 上 commit
- 提交前跑 `npm test` + `npm run typecheck`
- 跨里程碑的用户决策加到 `docs/superpowers/TODO.md`，不要自行决定
- 保持 commit message 前缀约定（`feat(m3):` 等）
- 代码复用 M1 的 `transcript-parser.ts` 和 `coalesceTranscriptPath`，不要重写

祝顺利。
