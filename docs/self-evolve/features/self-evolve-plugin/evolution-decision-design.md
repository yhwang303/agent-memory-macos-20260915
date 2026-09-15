# Self-Evolve 进化判断方案文档

**主题**：Self-Evolve 插件如何判断是否要对一次会话进行"进化"
**作者**：cloudboyguo
**日期**：2026-05-26
**状态**：现状梳理 + 优化建议

---

## 1. 总览

Self-Evolve 插件在每次会话结束后尝试从记忆中提炼可复用的 Rules（规范）和 Skills（技能），写入 IDE 配置文件（CLAUDE.md / .cursor/rules）。

**核心判断链**：

```
会话结束
  │
  ▼
[Gate 1] 插件是否 enabled？             → 否：不执行
  │
  ▼
[Gate 2] 当前是否已有进化在跑？          → 是：跳过
  │
  ▼
[Gate 3] 该会话是否已被进化过？          → 是：跳过（除非 force=true）
  │
  ▼
[Gate 4] 该会话有没有 observations？     → 无：跳过（空会话无法学习）
  │
  ▼
[Gate 5] AI 判断：是不是"工具链维护会话"？ → 是：跳过
  │
  ▼
  ├─ 生成 Rules → [质量打分] → [去重/防腐败] → 入库
  │
  └─ 生成 Skills → [质量打分(多轮)] → [去重/防腐败] → 入库
        │
        ▼
  [Critic 引擎] 冗余/冲突/语义价值复查
        │
        ▼
  [审核模式] auto/quality_gate/manual → 决定是否直接写入文件
```

---

## 2. 现状：各判断门详解

### Gate 1-4：硬编码前置条件

| 门 | 位置 | 条件 | 结果 |
|---|---|---|---|
| enabled | index.ts:59 | `config.enabled !== true` | 不执行 |
| 重入锁 | EvolveEngine.ts:46 | `inProgress.has(sessionId)` | 跳过 |
| 已进化 | EvolveEngine.ts:50 | `evolution_log` 中有完成/跳过记录 | 跳过 |
| 无观察 | EvolveEngine.ts:76 | `observations.length === 0` | 跳过 |

### Gate 5：AI 驱动的"工具链维护"过滤

**目的**：防止 self-evolve 从"修改自己代码"的会话中学到无用规则。

**判断标准**（prompts/evolve.ts 定义，满足 ≥2 条即 skip）：
1. 修改的文件集中在工具链代码（agent-memory/src/、.cursor/hooks/）
2. 会话中出现工具链专有名词（Worker、EvolveEngine、hooks-cli、mcp-server）
3. 会话核心目的是改善/修复 AI 工具链本身，而非在用工具链做业务项目

**AI 返回 `skip_reason` 字段** → 有值则跳过整个会话。

### Rule 质量打分（60 分及格）

```
+ 40  内容 ≥ 80 字符
+ 20  内容 ≥ 30 字符（仅当 < 80 时）
+ 20  包含行动词（必须/应该/不要/禁止/always/never/must/should）
+ 20  有 paths_glob（明确指定了作用范围）
+ 20  内容 ≥ 40 字符
─────
总分满分 100，及格线 60
```

**不及格 → `rejectedRules++`，不入库。**

### Skill 质量打分（多轮补救，60 分及格）

```
第 1 轮：直接打分
  └─ 不及格 →
第 2 轮：自动增强（补 YAML frontmatter + 协作协议段）再打分
  └─ 不及格 →
第 3 轮：调用 AI 重写 (buildRefineSkillPrompt) 再打分
  └─ 仍不及格 → rejectedSkills++
```

**打分项**：
- YAML Frontmatter 存在且完整（+25 满分）
- 内容长度 ≥ 400 字符（+15）/ ≥ 200（+10）/ < 200（FAIL）
- 二级标题数量（每个 +5，最高 +20）
- 包含 "Collaboration Protocol" 段（+10）
- 代码块数量 ≥ 2（+10）
- 编号步骤 ≥ 3（+20）/ ≥ 1（+10）

### Critic 引擎（后置复查）

当 `criticOnGenerate = true`（默认开启）时，新增的 artifact 会被 Critic 额外审查：

| 检查项 | 方法 | 结果 |
|--------|------|------|
| 冗余检测 | 关键词重叠 > 0.15 → AI 判断是否完全重复 | overlap ≥ 0.8 → 标记/拒绝 |
| 冲突检测 | 同一 paths_glob 下查找 → AI 判断是否矛盾 | 矛盾 → 标记 |
| 语义价值 | AI 判断是否有实际价值 | verdict='archive' → 标记/拒绝 |

`autoApplyFixes = false`（默认）→ 只标记不自动拒绝，需人工最终裁定。

### 审核模式（决定是否写入文件）

| 模式 | 行为 |
|------|------|
| `manual`（默认） | 所有 artifact → 状态 `pending`，用户批准后才写入 |
| `auto` | 直接 `approved`，立即写入 IDE 文件 |
| `quality_gate` | 质量分 ≥ threshold → `approved` 写入；否则 → `pending` 等人审 |

---

## 3. 现状问题分析

### 问题 1：无"会话价值"预判

**现状**：只要有 observations（哪怕只有 1 条 "用户问了个好"），就会完整走一遍 AI 调用 → 生成 → 打分。

**浪费**：大量低质量、闲聊型、或极短会话会触发昂贵的 AI 调用，最后只是产出空结果或全被 reject。

### 问题 2："工具链维护"过滤依赖 AI，无本地快筛

**现状**：必须先发 AI 请求才能知道"该不该跳过"。

**浪费**：一次 AI 调用（通常 1-5 秒、0.01-0.05 USD）只为了得到 `skip_reason`。

### 问题 3：质量打分维度单一

- Rule 打分完全基于"长度 + 行动词 + paths_glob"，**不考虑语义质量**
- 一条 80 字的废话可以拿 60 分通过
- 一条 25 字的精炼规则（如 "所有 API 响应必须包含 request_id"）只能拿 40 分被 reject

### 问题 4：无频率/冷却控制

**现状**：用户一天完成 50 个会话 → 触发 50 次进化 → 50 次 AI 调用。

**没有**："每小时最多 N 次" / "积攒 N 个会话后批量进化" 等节流机制。

---

## 4. 优化方案

### 方案 A：本地快速预筛（推荐优先实施）

在 Gate 4 之后、Gate 5 之前，加一层**本地判断**，不用调 AI：

```typescript
// Gate 4.5: 本地价值预判
const worthEvolving = preScreenSession(observations, sessionSummary);
if (!worthEvolving) {
  updateEvoLog(logId, { status: 'skipped', skip_reason: 'low_value_session' });
  return;
}
```

**预判规则**（全部可配置）：

| 条件 | 默认阈值 | 说明 |
|------|----------|------|
| observations 数量 | ≥ 3 | 少于 3 条说明会话太短/太浅 |
| 至少 1 条 observation 类型为 learning/refactor/bugfix | 必须 | 纯 investigation 不产生可复用规则 |
| session summary 中 `learned` 字段非空 | 必须 | 没有 learned 说明没可学内容 |
| 会话时长（或 observation 时间跨度） | ≥ 5 分钟 | 极短会话不值得进化 |

### 方案 B：工具链维护本地快筛

在 Gate 5 的 AI 调用前，先用正则做本地快筛：

```typescript
const TOOLCHAIN_PATTERNS = [
  /agent-memory\/src\/(plugins|services|hooks)/,
  /\.cursor\/(hooks|rules)\//,
  /EvolveEngine|CriticEngine|WorkerService|mcp-server/,
];

function isToolchainMaintenance(observations): boolean {
  const allText = observations.map(o => 
    `${o.title} ${o.narrative} ${o.files_modified || ''}`
  ).join(' ');
  const matchCount = TOOLCHAIN_PATTERNS.filter(p => p.test(allText)).length;
  return matchCount >= 2;
}
```

**命中 → 直接 skip，省掉一次 AI 调用。**

### 方案 C：批量进化 + 频率控制

不在每次会话结束时立即触发，而是积攒后批量处理：

```typescript
interface EvolveScheduleConfig {
  mode: 'immediate' | 'batch';
  batchSize: number;       // 积攒 N 个会话后统一进化（默认 5）
  cooldownMinutes: number; // 两次进化之间的最小间隔（默认 30）
  maxDailyRuns: number;    // 每日最多进化次数（默认 20）
}
```

**好处**：
- 减少 AI 调用次数（5 个会话合成 1 次请求）
- AI 能看到更大的上下文窗口，产出更有价值的泛化规则
- 避免碎片化规则（每次只从 1 个会话提炼，容易太具体）

### 方案 D：Rule 质量打分增加语义维度

```
现有维度（保留）:
+ 长度
+ 行动词
+ 作用范围

新增维度:
+ 具体性（是否引用了具体技术/文件/模式？）   +15
+ 可操作性（是否描述了 DO/DON'T？）          +10
+ 非显而易见（不是所有人都知道的常识？）      +10（需 AI 辅助）
```

---

## 5. 实施优先级

| 优先级 | 方案 | 工作量 | 收益 |
|--------|------|--------|------|
| P0 | A - 本地快速预筛 | 2h | 减少 60%+ 无效 AI 调用 |
| P1 | B - 工具链本地快筛 | 1h | 减少特定场景 AI 调用 |
| P2 | C - 频率控制 | 4h | 控制成本、提高产出质量 |
| P3 | D - 质量打分增强 | 3h | 减少低质量 rule 入库 |

---

## 6. 配置项汇总

```typescript
interface SelfEvolvePluginConfig {
  // 现有
  enabled: boolean;
  reviewMode: 'auto' | 'manual' | 'quality_gate';
  qualityGateThreshold: number;       // 默认 70
  targetPlatforms: string[];          // ['claudecode']
  maxContextRules: number;            // 默认 20
  criticOnGenerate: boolean;          // 默认 true

  // 新增（方案 A）
  minObservations: number;            // 默认 3
  requireLearningObservation: boolean;// 默认 true
  requireSessionLearned: boolean;     // 默认 true
  minSessionDurationMinutes: number;  // 默认 5

  // 新增（方案 C）
  evolveSchedule: {
    mode: 'immediate' | 'batch';      // 默认 'immediate'
    batchSize: number;                // 默认 5
    cooldownMinutes: number;          // 默认 30
    maxDailyRuns: number;             // 默认 20
  };
}
```
