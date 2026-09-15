# M2 · RAG + SQLite 双重查询

**里程碑**：M2（路线图第 2/5 步）
**工作量**：~5 个工作日
**前置**：无（可与 M1 并行，但实施上仍在 M1 之后）
**后继**：M3 的新平台 context 注入、M4 OpenClaw 的 `/api/context/inject` 均依赖本里程碑

---

## 1. 问题陈述

当前 agent-memory 的查询能力：
- SQLite FTS5 全文检索：`observations_fts` + `summaries_fts`
- 关键词匹配：精确但**语义泛化能力差**，对"用户问'上次那个报错'"这类模糊意图命中率低
- MCP 工具 `search` 仅走 FTS5

claude-mem 已实现的混合搜索（参考 `src/services/worker/search/`）：
- `SQLiteSearchStrategy`（同 agent-memory 现状）
- `ChromaSearchStrategy`（向量相似度）
- `HybridSearchStrategy`（两路结果 reciprocal rank fusion）
- `SearchOrchestrator` 统一路由

## 2. 方案设计

### 2.1 架构

```
MCP search 工具 / Worker /api/search
         │
         ▼
┌─────────────────────────┐
│  SearchOrchestrator     │
│                         │
│  mode: 'sqlite' |       │
│        'chroma' |       │
│        'hybrid' (default)│
└───┬─────────────┬───────┘
    │             │
    ▼             ▼
┌─────────┐   ┌──────────────────┐
│ SQLite  │   │ ChromaSearch     │
│ FTS5    │   │   Strategy       │
└─────────┘   └────┬─────────────┘
                   │ MCP over stdio
                   ▼
             ┌───────────────────┐
             │ chroma-mcp (Python)│
             │  Python + uv       │
             │  embedding: bge-m3 │
             └───────────────────┘
                   │
                   ▼
             ~/.config/agent-memory/chroma/
```

### 2.2 移植清单（直接从 claude-mem 复用，AGPL 已允许）

| 源 | 目标 | 备注 |
|---|---|---|
| `claude-mem/src/services/sync/ChromaSync.ts` | `src/services/sync/ChromaSync.ts` | 观察/摘要写入即时同步到 Chroma |
| `claude-mem/src/services/sync/ChromaMcpManager.ts` | `src/services/sync/ChromaMcpManager.ts` | chroma-mcp 进程管理 |
| `claude-mem/src/services/worker/search/` 整目录 | `src/services/worker/search/` | 3 策略 + Orchestrator + ResultFormatter |
| `claude-mem/scripts/wipe-chroma.cjs` | `scripts/wipe-chroma.cjs` | 清空向量库工具 |

### 2.3 chroma-mcp 启动封装

新增 `src/services/sync/ChromaProcessManager.ts`：
- 检测 `uv` 是否可用；缺失时引导用户安装（Windows 走 `winget install astral-sh.uv`，其他平台 `curl -LsSf https://astral.sh/uv/install.sh`）
- 启动命令：
  ```bash
  uvx chroma-mcp \
    --client-type persistent \
    --data-dir <data>/chroma \
    --embedding-function bge-m3 \
    --model-cache-dir <data>/models
  ```
- 首次启动下载 `bge-m3` 模型（~2GB），显式提示用户
- 健康检查：30s poll，失败后降级到"SQLite-only 模式"

### 2.4 中文嵌入模型

默认 `bge-m3`（BAAI 出品，多语言，中文 benchmark 优秀）。配置文件 `~/.config/agent-memory/settings.json` 允许覆盖：

```json
{
  "rag": {
    "enabled": true,
    "embedding_model": "bge-m3",
    "fallback_mode": "sqlite-only",
    "hybrid_weights": { "sqlite": 0.4, "chroma": 0.6 }
  }
}
```

备选列表（不建议默认）：
- `paraphrase-multilingual-MiniLM-L12-v2`（小，快，精度一般）
- `text-embedding-3-small`（OpenAI，需 API key，不本地）

### 2.5 数据同步管线

每条 observation / session_summary 落 SQLite 后，异步入队到 `ChromaSync.syncDocument()`：

```ts
// src/services/worker/SDKAgent.ts 的 insertObservation 后
await this.chromaSync?.syncObservation(observationId);

// insertSummary 后
await this.chromaSync?.syncSummary(summaryId);
```

初次启动 / 数据迁移时，`ChromaSync.bulkReindex()` 全量灌库。进度条通过 Worker 的 `/api/sync/status` 暴露。

### 2.6 MCP search 工具升级

`src/servers/mcp-server.ts` 的 `search` 工具参数扩展：

```ts
search({
  project: string,
  query: string,
  mode?: 'hybrid' | 'sqlite' | 'chroma' = 'hybrid',
  limit?: number = 20,
  dateStart?: string,
  dateEnd?: string,
  obs_type?: string[]
}) → results
```

新增 `timeline_by_similarity` 工具：以某条 summary/observation 为锚点，返回向量相似的其他记忆。

### 2.7 数据库 schema 变更

新表 `chroma_sync_state`（追踪同步状态）：

```sql
CREATE TABLE chroma_sync_state (
  doc_id TEXT PRIMARY KEY,          -- 'obs:123' / 'sum:456'
  synced_at INTEGER,
  embedding_hash TEXT,              -- 内容 hash，用于判断是否需要重嵌
  status TEXT                       -- 'pending' | 'synced' | 'failed'
);
```

---

## 3. 数据流

```
新 observation 插入 SQLite
         │
         ├─ chroma_sync_state 记 pending
         ▼
ChromaSync 后台任务（500ms 批处理）
         ├─ 从 SQLite 读 doc 原文
         ├─ MCP → chroma-mcp: add_documents
         ├─ chroma-mcp 内部 bge-m3 嵌入
         ├─ 返回 embedding_id
         └─ chroma_sync_state 标记 synced
```

**查询**：
```
MCP client → /api/search { query, mode: 'hybrid' }
         ▼
SearchOrchestrator.hybrid(query)
  ├─ SQLite FTS5 → [obsA, obsC, sumB]  (with rank)
  ├─ Chroma.query → [obsC, sumX, obsY] (with distance)
  └─ RRF merge → 最终排序
         ▼
ResultFormatter → 返回 JSON
```

---

## 4. 文件清单

| 文件 | 动作 |
|---|---|
| `src/services/sync/ChromaSync.ts` | **新增（移植）** |
| `src/services/sync/ChromaMcpManager.ts` | **新增（移植）** |
| `src/services/sync/ChromaProcessManager.ts` | **新增** |
| `src/services/worker/search/SearchOrchestrator.ts` | **新增（移植）** |
| `src/services/worker/search/strategies/SQLiteSearchStrategy.ts` | **新增（移植，适配现有 schema）** |
| `src/services/worker/search/strategies/ChromaSearchStrategy.ts` | **新增（移植）** |
| `src/services/worker/search/strategies/HybridSearchStrategy.ts` | **新增（移植）** |
| `src/services/worker/search/ResultFormatter.ts` | **新增（移植）** |
| `src/services/sqlite/migrations/00X_chroma_sync_state.sql` | 新增 |
| `src/services/worker/WorkerService.ts` | 编辑：`/api/search` 换 Orchestrator；新增 `/api/sync/status` 和 `/api/context/inject` |
| `src/servers/mcp-server.ts` | 编辑：`search` 扩展 + 新增 `timeline_by_similarity` |
| `src/bin/worker.ts` | 编辑：启动时初始化 ChromaProcessManager |
| `scripts/wipe-chroma.cjs` | **新增** |
| `tests/services/sync/chroma-mcp-manager.test.ts` | 新增 |
| `tests/worker/search/*.test.ts` | 新增（3 策略 + orchestrator 单测） |
| `tests/integration/chroma-vector-sync.test.ts` | 新增 |

---

## 5. 测试计划

### 5.1 单元

- 3 个 Strategy 各独立可测（mock MCP client）
- Orchestrator 的 RRF 权重合并

### 5.2 集成

- 启动真实 chroma-mcp → 灌 100 条中文 observation → 跑 10 条中文查询
- **目标指标**：Hybrid 模式相对纯 SQLite，top-5 recall 提升 ≥ 20%

### 5.3 降级路径

- 卸掉 Python/uv，启动 Worker，验证自动进入 `fallback_mode=sqlite-only` 且不报错
- 重装后，手动触发 `bulkReindex`，进度条可见

---

## 6. 非目标

- 不做在线增量训练
- 不做多租户向量隔离（复用 claude-mem 的 per-project collection 机制足够）
- 不在 .exe 中自带 Python（M5 统一处理可选依赖）

---

## 7. 风险

| 风险 | 缓解 |
|---|---|
| `uv` 不可用 / 受限网络下载不到模型 | 降级模式；文档提供离线模型包链接 |
| bge-m3 首次加载慢（~2GB） | 启动时提示；后续走缓存 |
| Chroma 与 SQLite 数据不一致 | `chroma_sync_state` 表 + 后台巡检任务 |
| Windows SSL 问题（claude-mem #590） | 复用 claude-mem 修复：ChromaMcpManager 透传 `SSL_CERT_FILE` |
| RRF 默认权重不合适 | 权重放配置，允许调优 |

---

## 8. 验收标准

- [ ] 3 种查询模式均可调用且返回结构一致
- [ ] 混合模式 recall@5 ≥ 纯 FTS5 + 20%
- [ ] chroma-mcp 异常不影响 SQLite 查询
- [ ] 增量同步延迟 < 2s
- [ ] 全量重建对 10k 记录 < 10 分钟

---

*下一里程碑：M3 新平台批量接入。*
