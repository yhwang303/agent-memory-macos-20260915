# 记忆系统全面升级设计方案

## 设计总则

1. 保持本地轻量部署优势，不引入外部数据库依赖（SQLite 为主存储不变）。
2. 分阶段交付，每阶段独立可用。
3. 向后兼容现有数据模型，扩展字段而非重构表结构。
4. 优先解决"用不起来"，再解决"用不好"。

---

## Phase 1：体验可用

### 一、一键安装与配置

提供三种安装方式，覆盖不同用户习惯：

#### 1.1 安装 Skill（推荐，零门槛）

设计方案：

在项目中提供 `.cursor/skills/install-agent-memory/SKILL.md`，用户克隆项目后，直接在 Cursor 中对 Agent 说"帮我安装 agent-memory"即可。Agent 会自动读取 Skill 并按步骤执行：

1. 运行 `npm install && npm run build`。
2. 从 `.env.local.example` 创建 `.env.local`，询问并填入 API Key。
3. 根据操作系统生成正确的 hooks.json 命令格式。
4. 配置 MCP Server。
5. 启动 Worker 并验证健康检查。
6. 提示用户重启 IDE。

优势：
- 用户无需记忆任何命令，只需一句自然语言。
- Agent 可根据当前系统环境自适应（路径、操作系统、已有配置合并）。
- 安装过程中的异常可由 Agent 自动排查和修复。
- Skill 随项目仓库分发，任何人克隆即可用。

Skill 文件路径：`.cursor/skills/install-agent-memory/SKILL.md`

#### 1.2 CLI 安装向导

设计方案：

保留并增强现有 `scripts/setup.js`，同时支持 `npx` 直接执行：

```
npx agent-memory setup
```

向导流程：

1. 检测运行环境（Node 版本、操作系统、已安装的 IDE）。
2. 交互式填入 API Key（支持 TIMIAI / OpenAI / Anthropic）。
3. 自动生成 `.env.local`。
4. 自动检测已安装的 IDE，选择性写入配置：
   - Cursor：写入 `.cursor/hooks.json` 和 MCP 配置（使用相对路径 + 变量而非写死绝对路径）。
   - CodeBuddy：写入对应 Hooks 配置。
5. 注册系统服务（见 1.2）。
6. 启动 Worker 并验证健康检查。

#### 1.3 一键脚本

保留现有 `install.bat`（Windows）和计划新增的 `install.sh`（macOS/Linux），适合不使用 Cursor 的场景。

#### 1.4 跨平台路径适配

设计方案：

hooks.json 中不再写死绝对路径，改为通过 CLI / Skill 动态生成。

配置模板使用 `__INSTALL_DIR__` 占位符，安装时替换为实际路径。同时为不同操作系统生成对应的命令格式：

- Windows：`cmd /c "chcp 65001 >nul && node ..."`
- macOS/Linux：`node ...`

影响模块：

- 新增 `.cursor/skills/install-agent-memory/SKILL.md`：安装 Skill（已创建）。
- 增强 `scripts/setup.js`：支持更多 IDE 和操作系统。
- 修改 `package.json`：`bin` 入口指向新 CLI。
- 新增 `src/cli/templates/`：各 IDE 的配置模板。

### 二、Worker 自动启动与自恢复

#### 2.1 方案评估

| 方案 | 优点 | 缺点 | 推荐 |
|------|------|------|------|
| A. 系统服务（Windows Service / launchd / systemd） | 开机自启、崩溃自恢复、后台静默运行 | 需要管理员权限安装，跨平台实现差异大 | Phase 1 首选 |
| B. IDE 扩展内嵌启动 | 随 IDE 启动，无需额外配置 | 需要开发 VS Code/Cursor 扩展 | Phase 1 备选 |
| C. WorkerClient 自动 spawn | 第一次调用时自动拉起 Worker | 首次启动延迟大 | 作为兜底方案 |
| D. 用户登录时启动脚本 | 实现简单 | 不够可靠 | 不推荐 |

#### 2.2 推荐方案：系统服务 + 自动 spawn 兜底

主方案——系统服务注册：

- Windows：使用 `node-windows` 注册为 Windows Service，或生成一个启动脚本放入 `shell:startup`。
- macOS：生成 `~/Library/LaunchAgents/com.agent-memory.worker.plist`。
- Linux：生成 `~/.config/systemd/user/agent-memory.service`。

通过 CLI 命令管理：

```
agent-memory service install    # 注册系统服务
agent-memory service uninstall  # 卸载系统服务
agent-memory service status     # 查看服务状态
```

兜底方案——WorkerClient 自动 spawn：

修改 `WorkerClient.ensureRunning()`，健康检查失败时自动 `spawn` Worker 子进程：

```typescript
async ensureRunning(): Promise<boolean> {
  try {
    await this.healthCheck();
    return true;
  } catch {
    return await this.autoSpawnWorker();
  }
}

private async autoSpawnWorker(): Promise<boolean> {
  const workerScript = path.join(__dirname, '../../bin/worker.js');
  const child = spawn('node', [workerScript, 'start'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env }
  });
  child.unref();
  // 等待 Worker 启动并重试健康检查
  await this.waitForHealthy(5000);
  return true;
}
```

影响模块：

- 新增 `src/cli/service.ts`：系统服务注册/卸载逻辑。
- 修改 `src/services/worker/client.ts`：`ensureRunning()` 增加自动 spawn。
- 修改 `src/bin/worker.ts`：增加 `restart` 分支实现。

#### 2.3 Worker 健康监控

增加 Worker 自检与进程守护：

- Worker 内部定时心跳写入 PID 文件（`~/.agent-memory/worker.pid`）。
- 启动时检查 PID 文件是否有残留僵尸进程。
- 系统服务配置 `restart on failure` 策略。

### 三、数据采集完善

#### 3.1 补全 Hooks 配置

将 `sessionStart` / `sessionEnd` 加入 hooks.json 配置模板：

```json
{
  "event": "sessionStart",
  "command": "node __INSTALL_DIR__/dist/hooks-cli.js sessionStart",
  "timeout": 10
},
{
  "event": "sessionEnd",
  "command": "node __INSTALL_DIR__/dist/hooks-cli.js sessionEnd",
  "timeout": 30
}
```

#### 3.2 数据丢失防护

设计方案：

1. **离线缓存**：Worker 不可达时，hooks-cli 将 observation 写入本地队列文件（`~/.agent-memory/pending-queue.jsonl`），Worker 恢复后批量重放。
2. **截断告警**：当 shell output / MCP 结果被截断时，在 observation 中标记 `truncated: true`，便于后续判断完整性。
3. **会话一致性**：hooks-cli 启动时生成唯一 `hook_instance_id`，与 Worker 端的 `memory_session_id` 做双向确认。

影响模块：

- 修改 `src/hooks-cli.ts`：增加离线缓存写入逻辑。
- 修改 `src/services/worker/WorkerService.ts`：增加队列重放端点 `POST /api/replay`。
- 修改 `src/types/database.ts`：observation 增加 `truncated` 字段。

### 四、IDE 主动调用记忆

#### 4.1 方案评估

| 方案 | 原理 | 优点 | 缺点 |
|------|------|------|------|
| A. MCP 工具自动注入 | Agent 通过 MCP 主动调用 `search`/`recall` | Agent 自主决策何时回忆 | 需要 Agent 知道 MCP 工具存在 |
| B. beforeSubmitPrompt 增强注入 | 每次提问自动注入相关记忆 | 无需 Agent 配合 | 被动，不够灵活 |
| C. Cursor Rules 引导 | 在 rules 中指导 Agent 使用记忆 MCP | 无代码修改 | 依赖 Agent 遵循指导 |
| D. Cursor Skills 配置 | 创建专用 Skill 教会 Agent 使用记忆 | 标准化、可复用 | 需要 Skill 市场支持 |

#### 4.2 推荐方案：MCP 增强 + Rules 引导 + beforeSubmitPrompt 智能注入

三管齐下：

**MCP 工具增强**：

丰富 MCP 工具描述，让 Agent 理解何时应该使用记忆：

```typescript
{
  name: "recall",
  description: "搜索用户的历史记忆和偏好。当需要了解用户的编码风格、项目背景、之前的解决方案、个人偏好时，应主动调用此工具。",
  inputSchema: {
    query: "搜索关键词或自然语言问题",
    scope: "all | current_project | preferences"
  }
}
```

**Cursor Rules 自动配置**：

安装时自动写入 `.cursor/rules/memory-agent.mdc`：

```markdown
# Memory Agent Rules
- 在回答涉及用户偏好、项目历史、之前解决方案的问题时，主动使用 agent-memory MCP 的 recall 工具搜索相关记忆。
- 当用户表达新的偏好或习惯时，使用 remember 工具保存。
- 不要等用户提示才去搜索记忆。
```

**beforeSubmitPrompt 智能注入**：

改进上下文注入策略，在返回的 `additional_context` 中增加引导语：

```
[Memory Context]
以下是与当前问题可能相关的历史记忆，请参考使用：
...（检索到的记忆）...
如需更多历史信息，可使用 agent-memory MCP 的 recall 工具搜索。
```

影响模块：

- 修改 `src/servers/mcp-server.ts`：增强工具描述，新增 `recall` / `remember` 语义化工具。
- 新增 `.cursor/rules/memory-agent.mdc`：Agent 行为引导规则。
- 修改 `src/hooks-cli.ts`：`handleBeforeSubmitPrompt` 增加引导语。

---

## Phase 2：检索升级

### 五、向量嵌入与语义检索

#### 5.1 嵌入方案选型

| 方案 | 优点 | 缺点 | 推荐 |
|------|------|------|------|
| A. SQLite + sqlite-vss 扩展 | 保持单一 SQLite 部署 | 扩展编译复杂，社区维护不够活跃 | 暂不推荐 |
| B. SQLite + 内存向量索引 | 轻量，无外部依赖 | 重启后需重建索引 | Phase 2 首选 |
| C. ChromaDB（本地） | 成熟的向量数据库 | 多一个依赖进程 | 作为 Phase 2 备选 |

#### 5.2 推荐方案：轻量级本地嵌入 + 内存向量索引

嵌入模型：

使用本地推理的轻量模型（如 `all-MiniLM-L6-v2` 通过 `@xenova/transformers` 在 Node.js 本地运行），避免依赖外部 API：

```typescript
import { pipeline } from '@xenova/transformers';

class EmbeddingService {
  private embedder: any;

  async init() {
    this.embedder = await pipeline(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2'
    );
  }

  async embed(text: string): Promise<Float32Array> {
    const result = await this.embedder(text, {
      pooling: 'mean',
      normalize: true
    });
    return result.data;
  }
}
```

向量存储：

在 SQLite 中新增 `observation_embeddings` 表存储向量（BLOB），应用层内存中维护 HNSW 索引用于快速近似搜索：

```sql
CREATE TABLE IF NOT EXISTS observation_embeddings (
  observation_id TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,
  model_version TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

#### 5.3 混合检索策略

```
用户查询
  ├── FTS5 全文搜索 → 候选集 A（关键词匹配）
  ├── 向量语义搜索 → 候选集 B（语义相似）
  └── 合并 + RRF 排序 → 最终结果
```

使用 Reciprocal Rank Fusion (RRF) 合并两路结果：

```typescript
function rrfScore(ftsRank: number, vecRank: number, k: number = 60): number {
  return 1 / (k + ftsRank) + 1 / (k + vecRank);
}
```

影响模块：

- 新增 `src/services/embedding/EmbeddingService.ts`：嵌入生成与管理。
- 新增 `src/services/embedding/VectorIndex.ts`：内存 HNSW 索引。
- 修改 `src/services/sqlite/Database.ts`：新增 `observation_embeddings` 表。
- 修改 `src/services/sqlite/observations.ts`：`searchObservations` 增加混合检索路径。
- 修改 `src/services/worker/WorkerService.ts`：observation 写入时同步生成嵌入。

### 六、智能上下文注入

#### 6.1 改进 ContextBuilder

从"最近 N 条"改为"最相关 N 条"：

```typescript
class ContextBuilder {
  async buildContext(query: string, options: ContextOptions): Promise<ContextResult> {
    // 1. 语义检索最相关的 observations
    const relevantObs = await this.hybridSearch(query, options.maxObservations);

    // 2. 补充当前项目最近的 summaries
    const recentSummaries = await this.getProjectSummaries(
      options.project,
      options.maxSummaries
    );

    // 3. 始终注入的高优先级记忆（用户偏好等）
    const pinnedMemories = await this.getPinnedMemories();

    // 4. Token 预算分配
    const budget = new TokenBudget(options.maxTokens);
    budget.allocate('pinned', pinnedMemories, 0.2);    // 20% 给固定记忆
    budget.allocate('relevant', relevantObs, 0.5);       // 50% 给相关记忆
    budget.allocate('summaries', recentSummaries, 0.3);  // 30% 给摘要

    return budget.build();
  }
}
```

#### 6.2 记忆分层注入

引入记忆优先级层：

| 优先级 | 内容 | 注入策略 |
|--------|------|----------|
| P0 | 用户偏好（language、style、tools） | 始终注入 |
| P1 | 与当前 query 语义相关的记忆 | 按相关性排序注入 |
| P2 | 当前项目最近摘要 | 补充注入 |
| P3 | 历史记忆 | 仅在 Token 预算充足时注入 |

影响模块：

- 重构 `src/services/context/builder.ts`：实现分层预算分配。
- 修改 `src/services/worker/WorkerService.ts`：`/api/context/inject` 路由使用新 ContextBuilder。

### 七、记忆置信度与来源追溯

#### 7.1 数据模型扩展

为 observations 增加来源和置信度字段：

```sql
ALTER TABLE observations ADD COLUMN source_type TEXT DEFAULT 'ai_extract';
-- 'ai_extract' | 'direct_input' | 'rule_detect' | 'user_explicit'

ALTER TABLE observations ADD COLUMN confidence REAL DEFAULT 0.5;
-- 0.0 ~ 1.0，AI 提取默认 0.5，用户明确声明为 1.0，规则检测为 0.8

ALTER TABLE observations ADD COLUMN source_session_id TEXT;
-- 关联到原始会话，便于溯源

ALTER TABLE observations ADD COLUMN last_referenced_at TEXT;
-- 最后一次被检索/注入的时间，用于后续衰减
```

影响模块：

- 修改 `src/types/database.ts`：`Observation` 类型增加新字段。
- 修改 `src/services/sqlite/Database.ts`：迁移脚本添加列。
- 修改 `src/services/sqlite/observations.ts`：写入和查询适配。

---

## Phase 3：记忆智能化

### 八、记忆冲突检测与消解

#### 8.1 冲突检测策略

写入新 observation 时，异步检测与已有记忆的冲突：

```typescript
async function detectConflicts(newObs: Observation): Promise<Conflict[]> {
  // 1. 向量搜索找到语义相似的已有记忆
  const similar = await vectorSearch(newObs.facts, { threshold: 0.85 });

  // 2. 对相似记忆调用 LLM 判断关系
  const prompt = buildConflictDetectionPrompt(newObs, similar);
  const result = await callAI(prompt);
  // 返回: CONSISTENT（一致）| CONTRADICTS（矛盾）| SUPERSEDES（取代）| DUPLICATE（重复）
  return parseConflictResult(result);
}
```

#### 8.2 消解策略

| 关系类型 | 处理方式 |
|----------|----------|
| CONSISTENT | 保留两条，关联标记 |
| CONTRADICTS | 新记忆标记为 active，旧记忆标记为 `superseded_by = new_id` |
| SUPERSEDES | 同 CONTRADICTS |
| DUPLICATE | 保留较完整的一条，另一条标记为 `merged_into = kept_id` |

数据模型扩展：

```sql
ALTER TABLE observations ADD COLUMN status TEXT DEFAULT 'active';
-- 'active' | 'superseded' | 'merged' | 'expired'

ALTER TABLE observations ADD COLUMN superseded_by TEXT;
ALTER TABLE observations ADD COLUMN merged_into TEXT;
```

### 九、时间衰减机制

#### 9.1 衰减公式

记忆的有效权重随时间衰减，但被引用时刷新：

```typescript
function calculateWeight(obs: Observation): number {
  const daysSinceCreated = daysBetween(obs.created_at, now());
  const daysSinceReferenced = daysBetween(
    obs.last_referenced_at || obs.created_at,
    now()
  );

  // 基础衰减：指数衰减，半衰期 90 天
  const decayFactor = Math.pow(0.5, daysSinceReferenced / 90);

  // 置信度加权
  const confidenceBoost = obs.confidence;

  // 用户偏好不衰减
  if (obs.concepts?.includes('user-preference')) {
    return confidenceBoost;
  }

  return decayFactor * confidenceBoost;
}
```

#### 9.2 定期清理任务

Worker 启动时注册定时任务：

- 每天扫描一次，将权重低于阈值的记忆标记为 `expired`。
- 已 `expired` 超过 30 天的记忆移入归档表 `observations_archive`。
- 清理操作记录日志，可恢复。

### 十、跨会话知识提炼

#### 10.1 渐进式知识合并

定期对同一 `concepts` 标签下的多条 observation 做知识提炼：

```typescript
async function distillKnowledge(concept: string): Promise<void> {
  const observations = await getActiveObservationsByConcept(concept);
  if (observations.length < 3) return;

  const prompt = buildDistillPrompt(observations);
  const distilled = await callAI(prompt);
  // 生成一条高置信度的"提炼记忆"
  await insertObservation({
    type: 'knowledge',
    source_type: 'distilled',
    confidence: 0.9,
    facts: distilled.facts,
    narrative: distilled.narrative,
    concepts: concept,
    // 关联原始记忆 ID
    meta_intent: `提炼自 ${observations.map(o => o.id).join(', ')}`
  });

  // 原始记忆标记为已提炼
  for (const obs of observations) {
    await updateObservationStatus(obs.id, 'distilled');
  }
}
```

---

## Phase 4：知识图谱

### 十一、轻量级知识图谱

#### 11.1 存储方案

在 SQLite 中用关系表模拟图结构，避免引入 Neo4j：

```sql
CREATE TABLE IF NOT EXISTS kg_entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  -- 'project' | 'module' | 'file' | 'concept' | 'person' | 'tool'
  properties TEXT, -- JSON
  embedding BLOB,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kg_relations (
  id TEXT PRIMARY KEY,
  source_entity_id TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  -- 'uses' | 'depends_on' | 'modified_by' | 'related_to' | 'part_of'
  weight REAL DEFAULT 1.0,
  valid_at TEXT,
  invalid_at TEXT,
  source_observation_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (source_entity_id) REFERENCES kg_entities(id),
  FOREIGN KEY (target_entity_id) REFERENCES kg_entities(id)
);

CREATE INDEX idx_kg_relations_source ON kg_relations(source_entity_id);
CREATE INDEX idx_kg_relations_target ON kg_relations(target_entity_id);
CREATE INDEX idx_kg_relations_type ON kg_relations(relation_type);
```

#### 11.2 实体与关系自动提取

在 observation 写入后，异步提取实体和关系：

```typescript
async function extractEntitiesAndRelations(obs: Observation): Promise<void> {
  const prompt = buildEntityExtractionPrompt(obs);
  const result = await callAI(prompt);
  const { entities, relations } = parseEntityResult(result);

  for (const entity of entities) {
    await upsertEntity(entity);
  }
  for (const relation of relations) {
    await insertRelation({
      ...relation,
      source_observation_id: obs.id
    });
  }
}
```

#### 11.3 图遍历查询

提供 BFS 广度优先遍历 API：

```typescript
async function graphTraversal(
  startEntityId: string,
  depth: number = 2,
  relationTypes?: string[]
): Promise<GraphResult> {
  const visited = new Set<string>();
  const queue: Array<{ entityId: string; depth: number }> = [
    { entityId: startEntityId, depth: 0 }
  ];
  const result: GraphResult = { entities: [], relations: [] };

  while (queue.length > 0) {
    const { entityId, depth: currentDepth } = queue.shift()!;
    if (visited.has(entityId) || currentDepth > depth) continue;
    visited.add(entityId);

    const entity = await getEntity(entityId);
    result.entities.push(entity);

    const relations = await getRelationsFrom(entityId, relationTypes);
    result.relations.push(...relations);

    for (const rel of relations) {
      queue.push({ entityId: rel.target_entity_id, depth: currentDepth + 1 });
    }
  }
  return result;
}
```

---

## 整体架构演进图

```
Phase 1 (当前)                    Phase 2                         Phase 3-4
┌─────────────┐              ┌─────────────┐              ┌─────────────────────┐
│  IDE Hooks   │              │  IDE Hooks   │              │  IDE Hooks           │
│  + MCP       │              │  + MCP       │              │  + MCP + Skills      │
└──────┬───────┘              │  + Rules     │              │  + Rules             │
       │                      └──────┬───────┘              └──────┬───────────────┘
       ▼                             ▼                             ▼
┌─────────────┐              ┌─────────────┐              ┌─────────────────────┐
│   Worker     │              │   Worker     │              │   Worker (服务化)     │
│   HTTP API   │              │   HTTP API   │              │   HTTP API           │
└──────┬───────┘              └──────┬───────┘              └──────┬───────────────┘
       │                             │                             │
       ▼                             ▼                             ▼
┌─────────────┐              ┌──────────────────┐         ┌──────────────────────┐
│  SQLite      │              │  SQLite           │         │  SQLite               │
│  + FTS5      │              │  + FTS5           │         │  + FTS5               │
│              │              │  + Embeddings     │         │  + Embeddings         │
│              │              │  + 置信度/来源     │         │  + 置信度/来源/状态    │
│              │              │                    │         │  + 知识图谱表          │
└─────────────┘              │  本地嵌入模型      │         │  + 衰减/冲突消解       │
                              │  + 向量索引        │         │                       │
                              └──────────────────┘         │  本地嵌入模型          │
                                                            │  + 向量索引            │
                                                            │  + 知识提炼引擎        │
                                                            └──────────────────────┘
```

## 工期估算

| Phase | 内容 | 预估工期 | 前置依赖 |
|-------|------|----------|----------|
| Phase 1 | 一键安装 + 自启动 + 数据采集 + IDE 主动调用 | 2-3 周 | 无 |
| Phase 2 | 向量嵌入 + 混合检索 + 智能注入 + 置信度 | 3-4 周 | Phase 1 |
| Phase 3 | 冲突消解 + 时间衰减 + 知识提炼 | 2-3 周 | Phase 2 |
| Phase 4 | 知识图谱 + 图遍历 + 跨项目复用 | 3-4 周 | Phase 2 |

Phase 3 和 Phase 4 可并行开发。

## 风险与取舍

### 风险 1：本地嵌入模型体积大

取舍：`all-MiniLM-L6-v2` 约 80MB，首次下载需时间。可在安装向导中预下载，或提供跳过选项（退化为纯 FTS 检索）。

### 风险 2：SQLite 模拟知识图谱性能

取舍：SQLite 的关系表图遍历在万级节点下性能可接受。若未来规模超出，可迁移到 DuckDB 或引入 Kuzu 嵌入式图数据库。

### 风险 3：系统服务注册需要权限

取舍：优先使用用户级服务（Windows 启动目录、macOS launchd user agent），不需要管理员权限。若注册失败，降级为 WorkerClient 自动 spawn。

### 风险 4：冲突消解依赖 LLM 准确性

取舍：冲突消解标记为 `superseded` 而非直接删除，保留可恢复性。误判时用户可通过 viewer 手动恢复。

### 风险 5：向量索引内存占用

取舍：384 维向量，1 万条记忆约占 15MB 内存，可接受。超过 10 万条时考虑分区加载或切换到磁盘索引。
