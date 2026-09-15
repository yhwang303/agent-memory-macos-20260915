# 设计文档：Self-Evolve 内置插件

> 日期：2026-05-23
> 关联需求：[prd.md](./prd.md)

## 现状

### Agent-Mem 现有数据流

```
IDE Hook → hooks-cli → POST /api/observation → Worker (port 3847)
                                                  ↓
                                          SDKAgent (AI 压缩)
                                                  ↓
                                      observations + session_summaries
                                                  ↓
                     beforeSubmitPrompt ← ContextBuilder (注入上下文)
```

### Self-Evolve 现有数据流

```
IDE Hook → POST /api/event → Worker (port 3849)
                                  ↓
                          events 表 (raw: prompt/response/file_edit/shell)
                                  ↓ (stop 后 60s debounce)
                          EvolveEngine (AI 分析)
                                  ↓
                     evolved_rules / evolved_skills
                                  ↓
                          PlatformWriter → CLAUDE.md / .cursor/rules/
```

### 核心观察

两套流程的触发点相同（会话结束），数据来源高度重叠（同一个 IDE 会话的操作记录）。差异在于 Agent-Mem 存储**经 AI 压缩的 observations**，Self-Evolve 存储**原始 events**。

整合的核心判断：**observations 的信噪比高于原始 events**，更适合作为 EvolveEngine 的输入。EvolveEngine 的 prompt 可以适配接受 observations 格式，而不是原始的 prompt/response/file_edit 流水账。

---

## 方案总览

```
IDE Hook (不变)
    ↓
hooks-cli (不变)
    ↓
WorkerService (port 3847)
    ├─ [现有] SDKAgent → observations → ContextBuilder → 注入上下文
    └─ [新增] SelfEvolvePlugin.onSessionEnd()
                  ↓
           EvolveEngine (从 observations + summary 读数据)
                  ↓
           CriticEngine (可选即时审计)
                  ↓
           evolved_rules / evolved_skills (同一 SQLite)
                  ↓
           PlatformWriter → CLAUDE.md / .cursor/rules/ 等
```

**关键设计决策**：
1. Self-Evolve 不再需要独立 HTTP 服务，全部嵌入 WorkerService
2. 不新增任何 IDE Hooks，复用 Agent-Mem 的 `stop` 事件触发链
3. EvolveEngine 输入从"原始 events"改为"observations + session summary"
4. 数据库合并：Self-Evolve 的表加入 Agent-Mem 的 SQLite（同一文件，新增迁移）

---

## 目录结构

```
src/plugins/self-evolve/
├── index.ts                  # SelfEvolvePlugin 入口，export 给 WorkerService
├── EvolveEngine.ts           # 核心进化引擎（适配后）
├── CriticEngine.ts           # 质量审计引擎
├── PlatformWriter.ts         # 多平台文件写入
├── ContextBuilder.ts         # 构建规则注入上下文
├── config.ts                 # 配置类型 SelfEvolvePluginConfig
├── db/
│   ├── rules.ts              # evolved_rules 表 CRUD
│   ├── skills.ts             # evolved_skills 表 CRUD
│   ├── evoLog.ts             # evolution_log 表 CRUD
│   └── naturalSelection.ts   # natural_selection 表 CRUD
└── prompts/
    ├── evolve.ts             # 进化分析 prompt（适配 observations 格式）
    └── critic.ts             # 审计分析 prompt（与原版一致）
```

---

## 数据库变更

### 迁移版本：新增 migration step（在 `src/services/sqlite/Database.ts` 的迁移数组中追加）

#### `evolved_rules`

```sql
CREATE TABLE IF NOT EXISTS evolved_rules (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace        TEXT    NOT NULL,
  title            TEXT    NOT NULL,
  content          TEXT    NOT NULL,
  category         TEXT    NOT NULL DEFAULT 'general',
  slug             TEXT,
  paths_glob       TEXT,
  source_session_id TEXT,        -- 来源 memory_session_id
  evidence         TEXT,
  status           TEXT    NOT NULL DEFAULT 'active',   -- active | archived
  rule_type        TEXT    NOT NULL DEFAULT 'user_evolved', -- user_evolved | system
  quality_score    INTEGER,
  feedback         TEXT,         -- useful | useless | NULL
  audit_status     TEXT    NOT NULL DEFAULT 'pending',  -- pending | clean | flagged | archived
  review_status    TEXT    NOT NULL DEFAULT 'auto',     -- auto | pending_review | approved | rejected
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(workspace, title)
);
CREATE INDEX IF NOT EXISTS idx_evolved_rules_workspace ON evolved_rules(workspace);
CREATE INDEX IF NOT EXISTS idx_evolved_rules_status    ON evolved_rules(status);
```

#### `evolved_skills`

```sql
CREATE TABLE IF NOT EXISTS evolved_skills (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace        TEXT    NOT NULL,
  slug             TEXT    NOT NULL,
  name             TEXT    NOT NULL,
  trigger_scene    TEXT,
  description      TEXT,
  skill_kind       TEXT    NOT NULL DEFAULT 'markdown',
  skill_md         TEXT,
  manifest_json    TEXT,
  source_session_id TEXT,
  evidence         TEXT,
  status           TEXT    NOT NULL DEFAULT 'active',
  quality_score    INTEGER,
  audit_status     TEXT    NOT NULL DEFAULT 'pending',
  review_status    TEXT    NOT NULL DEFAULT 'auto',
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(workspace, slug)
);
CREATE INDEX IF NOT EXISTS idx_evolved_skills_workspace ON evolved_skills(workspace);
```

#### `evolution_log`

```sql
CREATE TABLE IF NOT EXISTS evolution_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_session_id TEXT   NOT NULL,
  workspace        TEXT    NOT NULL,
  rules_added      INTEGER NOT NULL DEFAULT 0,
  rules_updated    INTEGER NOT NULL DEFAULT 0,
  skills_added     INTEGER NOT NULL DEFAULT 0,
  rejected_rules   INTEGER NOT NULL DEFAULT 0,
  rejected_skills  INTEGER NOT NULL DEFAULT 0,
  status           TEXT    NOT NULL,  -- success | parse_failed | review_pending | skipped
  error_message    TEXT,
  raw_output       TEXT,
  duration_ms      INTEGER,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_evo_log_session ON evolution_log(memory_session_id);
```

#### `natural_selection`

```sql
CREATE TABLE IF NOT EXISTS natural_selection (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  title            TEXT    NOT NULL,
  content          TEXT    NOT NULL,
  scope            TEXT    NOT NULL DEFAULT 'all',   -- all | evolve | critic
  type             TEXT    NOT NULL DEFAULT 'append', -- append | override
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
```

---

## 核心模块设计

### SelfEvolvePlugin（插件入口）

```typescript
// src/plugins/self-evolve/index.ts

export interface SelfEvolvePlugin {
  // WorkerService 在 start() 里调用，若 enabled=false 直接返回
  initialize(db: Database, config: SelfEvolvePluginConfig): void;

  // WorkerService 在 runSummaryFlow 完成后异步调用（不 await）
  onSessionEnd(memorySessionId: string, project: string): Promise<void>;

  // GET /api/self-evolve/status
  getStatus(): SelfEvolveStatus;

  // POST /api/self-evolve/trigger
  triggerEvolve(memorySessionId: string, force?: boolean): Promise<void>;

  // 审核相关（WorkerService 路由到这里）
  getPendingReview(workspace: string): PendingItem[];
  approveArtifact(id: number, type: 'rule' | 'skill'): Promise<void>;
  rejectArtifact(id: number, type: 'rule' | 'skill', reason: string): Promise<void>;

  // MCP 工具调用
  getRules(workspace: string, category?: string): EvolvedRule[];
  getSkills(workspace: string): EvolvedSkill[];
}
```

### EvolveEngine 适配

原版 Self-Evolve 的 EvolveEngine 从 `events` 表读取 `prompt`/`response`/`file_edit`/`shell` 原始记录，构建一段"对话流水账"交给 AI 分析。

整合后，输入源改为 Agent-Mem 的 `observations` + `session_summaries`：

```typescript
// src/plugins/self-evolve/EvolveEngine.ts

interface EvolveInput {
  memorySessionId: string;
  project: string;
  sessionSummary: SessionSummaryRow | null;     // 已有的会话总结
  observations: ObservationRow[];               // 已有的 observations（最多取 20 条最近的）
  existingRules: EvolvedRule[];                 // 当前 workspace 的 active rules
  existingSkills: EvolvedSkill[];               // 当前 workspace 的 active skills
  naturalSelections: NaturalSelection[];        // 用户自定义约束
}
```

**Prompt 适配要点**（`src/plugins/self-evolve/prompts/evolve.ts`）：

原版将原始 events 格式化为：
```
[prompt] 用户说了什么
[response] AI 回答了什么
[file_edit] 修改了哪个文件
```

适配后改为将 observations 格式化为：
```
## 会话总结
{session_summary.request} / {session_summary.completed} / {session_summary.learned}

## 关键观察（AI 提炼）
{observations[].narrative}
{observations[].facts}
{observations[].files_modified}
```

observations 已经过 AI 压缩提炼，比原始 events 信噪比更高，进化质量应持平或更好。

**输出格式不变**（维持原版 JSON 结构）：

```json
{
  "new_rules": [...],
  "rule_actions": [...],
  "new_skills": [...],
  "system_rule_updates": [...],
  "skipped": [...]
}
```

### CriticEngine

直接移植，无需适配。读取 `evolved_rules` / `evolved_skills` 表，调用 AI 检测冗余/冲突/质量，更新 `audit_status`。

本期只支持 `criticOnGenerate=true` 的即时审计，不实现定期扫描调度器（定期调度放下一期）。

### PlatformWriter

直接移植。负责将 `evolved_rules` / `evolved_skills` 的内容写入各平台配置文件。

**托管区/手动区分段机制**（继承原版，防止覆盖用户手工内容）：

```
<!-- SELF-EVOLVE MANAGED START -->
（这里是自动生成的规则，每次进化时整段替换）
<!-- SELF-EVOLVE MANAGED END -->

（这里是用户手工编辑内容，PlatformWriter 永远不动这里）
```

**支持的平台**（`targetPlatforms` 配置项）：

| platform id | 写入位置 |
|---|---|
| `claudecode` | `{workspace}/CLAUDE.md`（托管区） |
| `cursor` | `{workspace}/.cursor/rules/self-evolved.mdc` |
| `codebuddy` | `{workspace}/.codebuddy/rules/self-evolved.md` |
| `windsurf` | `{workspace}/.windsurf/rules/self-evolved.md` |

---

## WorkerService 改动

### 装配（`WorkerService.start()`）

```typescript
// src/services/worker/WorkerService.ts

import { createSelfEvolvePlugin } from '../../plugins/self-evolve/index.js';

private selfEvolve: SelfEvolvePlugin | null = null;

async start(): Promise<void> {
  // ... existing ...
  const cfg = this.config.plugins?.selfEvolve;
  if (cfg?.enabled) {
    this.selfEvolve = createSelfEvolvePlugin();
    this.selfEvolve.initialize(this.db, cfg);
    logger.info('WORKER', 'SelfEvolve plugin initialized');
  }
}
```

### 桥接（`runSummaryFlow` 末尾）

```typescript
private async runSummaryFlow(contentSessionId: string, reason: string): Promise<void> {
  // ... existing summary logic ...

  // 异步触发进化，不阻塞 summary 返回
  if (this.selfEvolve && session.memory_session_id) {
    const msid = session.memory_session_id;
    const project = session.project;
    setImmediate(() => {
      this.selfEvolve!.onSessionEnd(msid, project).catch(err => {
        logger.error('SELF_EVOLVE', 'Evolution failed', { msid }, err as Error);
      });
    });
  }
}
```

### 新增路由

在 `WorkerService.setupRoutes()` 中增加：

```
POST /api/self-evolve/trigger          → selfEvolve.triggerEvolve()
GET  /api/self-evolve/status           → selfEvolve.getStatus()
GET  /api/self-evolve/review/pending   → selfEvolve.getPendingReview()
POST /api/self-evolve/review/approve   → selfEvolve.approveArtifact()
POST /api/self-evolve/review/reject    → selfEvolve.rejectArtifact()
GET  /api/viewer/rules                 → selfEvolve.getRules()   （供 Viewer 用）
GET  /api/viewer/skills                → selfEvolve.getSkills()  （供 Viewer 用）
GET  /api/viewer/evo-log               → db 直接查 evolution_log
```

若插件未启用，所有 `/api/self-evolve/*` 路由返回 `{ error: 'SelfEvolve plugin is disabled' }`（HTTP 503）。

---

## MCP Server 扩展

在 `src/servers/mcp-server.ts` 的工具列表末尾追加：

| 工具名 | 描述 | 参数 |
|---|---|---|
| `get_rules` | 获取当前工作区已进化的规则 | `workspace?: string`, `category?: string` |
| `get_skills` | 获取已进化的可复用技能列表 | `workspace?: string` |
| `get_skill_detail` | 获取某个技能的完整内容 | `slug: string` |
| `get_evo_history` | 查看最近的进化日志 | `workspace?: string`, `limit?: number` |
| `approve_artifact` | 批准待审核的 Rule 或 Skill | `id: number`, `type: 'rule' \| 'skill'` |
| `reject_artifact` | 拒绝并给出反馈 | `id: number`, `type: 'rule' \| 'skill'`, `reason: string` |

上述工具在插件未启用时返回 `{ error: 'SelfEvolve plugin is disabled' }`。

---

## Web Viewer 扩展

在 `web/viewer.html` 现有标签页（Sessions、Observations、Summaries、Stats）之后追加三个标签页：

### Rules 标签页
- 列表展示 `evolved_rules`（按 workspace 筛选、按 category 分组、按 quality_score 排序）
- 每行显示：title、category、quality_score、audit_status、review_status、created_at
- 点击展开：content 全文、evidence、来源 session 链接（跳到 Sessions 标签）
- 操作按钮：Approve / Reject（仅 `review_status=pending_review` 时显示）

### Skills 标签页
- 列表展示 `evolved_skills`
- 点击展开：skill_md 全文、trigger_scene、来源 session 链接
- 同上的 Approve / Reject 操作

### Evo Log 标签页
- 列表展示 `evolution_log`（按时间倒序）
- 每行显示：时间、会话 ID、rules_added、skills_added、status、duration_ms
- 点击展开：raw_output（折叠，仅调试用）

---

## 配置类型

```typescript
// src/plugins/self-evolve/config.ts

export interface SelfEvolvePluginConfig {
  enabled: boolean;
  reviewMode: 'auto' | 'manual' | 'quality_gate';
  qualityGateThreshold: number;     // 0-100，仅 quality_gate 模式有效
  targetPlatforms: string[];        // ['claudecode', 'cursor', ...]
  maxContextRules: number;
  criticOnGenerate: boolean;
  aiModel?: string;                 // 若不填，继承 Worker 全局 AI 配置
}

export const DEFAULT_SELF_EVOLVE_CONFIG: SelfEvolvePluginConfig = {
  enabled: false,
  reviewMode: 'manual',
  qualityGateThreshold: 70,
  targetPlatforms: ['claudecode'],
  maxContextRules: 20,
  criticOnGenerate: true,
};
```

在 `src/config/settings.ts` 的 `AgentMemConfig` 接口中增加：

```typescript
plugins?: {
  selfEvolve?: Partial<SelfEvolvePluginConfig>;
};
```

---

## 进化流程时序

```
[IDE stop hook]
    │
    ▼
WorkerService.handleSessionEnd()
    │
    ▼
runSummaryFlow(sessionId)
    ├─ updateSessionStatus('completed')
    ├─ SDKAgent.generateSummary()          ← 已有逻辑
    └─ syncQueue.enqueue()                 ← 已有逻辑
    │
    └─ [setImmediate, 不阻塞]
        ▼
       SelfEvolvePlugin.onSessionEnd(msid, project)
           │
           ├─ 检查 session 是否已进化（evolution_log 有记录且 force=false）→ 跳过
           ├─ 读取 observations + session_summary（Agent-Mem DB）
           ├─ 读取 existingRules + existingSkills（evolved_rules/skills）
           ├─ 读取 naturalSelections
           │
           ▼
          EvolveEngine.run(input)
           ├─ buildEvolvePrompt(input)
           ├─ callAI()                      ← claude-internal 或 API
           ├─ parseAnalysisResult()
           │
           ├─ [reviewMode=auto]     → 直接 insertRules/upsertSkills
           ├─ [reviewMode=manual]   → 插入 review_status='pending_review'
           └─ [reviewMode=quality_gate] → quality_score >= threshold 才插入
           │
           ▼
          CriticEngine.run()（若 criticOnGenerate=true）
           ├─ 检测冗余 / 冲突 / 质量
           └─ 更新 audit_status
           │
           ▼
          PlatformWriter.writeAll(workspace, targetPlatforms)
           ├─ 读取所有 active + approved 的 rules
           ├─ 按 category 分组渲染
           └─ 写入各平台文件（保留手动区不动）
           │
           ▼
          evolution_log 写入结果记录
```

---

## 文件变更清单

| 文件 | 变更类型 | 说明 |
|---|---|---|
| `src/plugins/self-evolve/` | 新增目录 | 插件全部代码 |
| `src/services/sqlite/Database.ts` | 修改 | 新增 4 张表的迁移步骤 |
| `src/services/worker/WorkerService.ts` | 修改 | 装配插件、桥接 runSummaryFlow、注册新路由 |
| `src/servers/mcp-server.ts` | 修改 | 注册 6 个新 MCP 工具 |
| `src/config/settings.ts` | 修改 | 扩展 AgentMemConfig 类型 |
| `web/viewer.html` | 修改 | 新增 Rules / Skills / Evo Log 三个标签页 |
| `package.json` | 可能修改 | 若 Self-Evolve 有独有依赖需补充（预计无，依赖已覆盖） |

---

## 测试计划

### 单元测试

1. **EvolveEngine**：mock AI 调用，验证 observations 格式输入能正确解析为 rules/skills
2. **CriticEngine**：mock AI 调用，验证冗余/冲突判断逻辑
3. **PlatformWriter**：验证托管区替换时手动区内容保持不变；验证 CLAUDE.md 不存在时正确创建
4. **SelfEvolvePlugin.onSessionEnd**：验证重复进化被跳过；验证 `enabled=false` 时不初始化任何资源

### 集成测试

1. **全流程**：启动 WorkerService（启用插件）→ 模拟 session 结束 → 断言 `evolved_rules` 表有新记录 → 断言 CLAUDE.md 托管区已更新（`review_mode=auto`）
2. **手动审核**：`review_mode=manual` → 进化后 rules 在 `pending_review` 状态 → 调 approve API → 断言文件写入
3. **零影响**：`enabled=false` 时，原有 summary 生成流程时序不变，不抛异常

### 手工 E2E

```bash
# 0. 开启插件
# config.json: plugins.selfEvolve.enabled=true, reviewMode='auto'

# 1. 模拟一次会话
curl -X POST http://127.0.0.1:3847/api/session/start \
  -d '{"sessionId":"se-e2e-001","project":"/test","userPrompt":"fix the memory leak"}'

curl -X POST http://127.0.0.1:3847/api/observation \
  -d '{"sessionId":"se-e2e-001","toolName":"Bash","toolOutput":"fixed in utils.ts",...}'

curl -X POST http://127.0.0.1:3847/api/session/end \
  -d '{"sessionId":"se-e2e-001"}'

# 2. 等待进化完成（约 10-30s）
sleep 30

# 3. 验证
curl http://127.0.0.1:3847/api/viewer/rules
# 期望：至少 1 条 rule

cat /test/CLAUDE.md
# 期望：托管区有新规则
```

---

## 兼容性 / 回滚

- `plugins.selfEvolve.enabled=false`（默认值）时，新增代码路径完全不执行，现有功能零影响
- 新增的 4 张数据库表均使用 `CREATE TABLE IF NOT EXISTS`，升级安全，不影响旧表
- PlatformWriter 只修改托管区（HTML 注释标记），手动编辑的内容永远保留
- 回滚方案：将 `enabled` 改为 `false` 重启 worker 即可；数据库表可留着不影响任何逻辑

---

## 遗留问题 / 下一期

| 问题 | 优先级 | 说明 |
|---|---|---|
| CriticEngine 定期扫描调度器 | 中 | 本期只做即时审计，定期后台扫描推到 P1 |
| Natural Selection 管理 UI | 低 | 本期 API-only，Viewer 里的增删改 UI 下期 |
| 旧 `~/.self-evolve/` 数据迁移工具 | 低 | 给已有 Self-Evolve 用户提供一键迁移脚本 |
| 进化 token 用量统计展示 | 低 | evolution_log 可加 input_tokens / output_tokens 字段，Viewer 展示 |
| observations 置信度加权 | 低 | 高质量 observation（quality_score 高）在 evolve prompt 中优先展示 |
