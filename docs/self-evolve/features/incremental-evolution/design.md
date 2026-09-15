# incremental-evolution — 设计

## 1. 背景 / 问题

当前 Self-Evolve 的进化粒度绑定在 **session 生命周期**上：

```
会话开始 → 用户工作（产生 observations）→ 会话结束 → 一次性进化
```

但现实中的用户行为是：

```
会话开始 → [写代码 30min] → [聊架构 15min] → [调试部署 20min] → [改文档 5min] → (可能从不"结束")
```

**三个致命问题**：

| 问题 | 原因 | 后果 |
|------|------|------|
| 长会话永不触发 | `onSessionEnd` 只在会话明确结束时调用 | 用户用 Claude Code 挂一整天 → 0 次进化 |
| 主题混杂 | 一锅端喂给 AI 80 分钟的混合上下文 | 产出模糊泛化规则，精度低 |
| 低时效性 | 必须等会话完整结束 | 有价值的规则延迟产出，无法在当前会话后半段受益 |

---

## 2. 现状数据流

```
hooks-cli (IDE事件)
   │
   ▼  POST /api/observations
WorkerService.handleObservation()
   │
   ├─ insertObservation() → SQLite
   ├─ generateSummary() [异步,有去重]
   │      └─ updateSessionStatus('completed')
   │             └─ selfEvolve.onSessionEnd()  ← 唯一触发点
   │
   └─ syncQueue.enqueue() [远程同步]
```

**`onSessionEnd` 触发条件**（WorkerService.ts:558-570）：
- 只在 `generateSummary` 完成后才调用
- `generateSummary` 只在 session status 从 pending→completed 时触发
- session 需要被显式 "complete"（通过 hooks 的 stop 事件或 API 调用）

**结论**：如果 IDE hooks 没有发出 stop 事件，进化永远不会触发。

---

## 3. 方案：增量进化引擎

### 3.1 核心架构变更

从 **"会话结束时一次性处理"** 改为 **"观察累积到阈值时分段处理"**：

```
                    ┌─────────────────────────────────┐
                    │     Incremental Evolve Scheduler │
                    │                                 │
  observation ──►   │  [accumulator]                  │
  observation ──►   │      │                          │
  observation ──►   │      ▼ 触发条件满足?            │
                    │  ┌──────────────┐               │
                    │  │ Topic Slicer │ ← 切分主题段   │
                    │  └──────┬───────┘               │
                    │         ▼                        │
                    │  ┌──────────────┐               │
                    │  │ EvolveEngine │ ← 只处理一段   │
                    │  └──────────────┘               │
                    └─────────────────────────────────┘
```

### 3.2 触发策略（三路并行，任一满足即触发）

```typescript
interface IncrementalEvolveConfig {
  /** 按数量触发：累积 N 条新 observation 后进化 */
  observationThreshold: number;    // 默认 8

  /** 按时间触发：距上次进化超过 N 分钟且有新 observation */
  idleMinutes: number;             // 默认 30

  /** 按主题切换触发：检测到明显主题变化时进化前一段 */
  topicSwitchEnabled: boolean;     // 默认 true

  /** 冷却：两次增量进化间最少间隔 */
  cooldownMinutes: number;         // 默认 10

  /** 每日上限 */
  maxDailyRuns: number;            // 默认 30
}
```

**触发流程伪代码**：

```typescript
class IncrementalEvolveScheduler {
  private pendingObservations: ObservationRef[] = [];
  private lastEvolveAt: number = 0;
  private dailyRunCount: number = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  /** 每次新 observation 写入时被调用 */
  onObservationAdded(obs: ObservationRef): void {
    this.pendingObservations.push(obs);
    this.resetIdleTimer();

    // 路径1：数量触发
    if (this.pendingObservations.length >= this.config.observationThreshold) {
      this.tryEvolve('count_threshold');
    }

    // 路径2：主题切换检测
    if (this.config.topicSwitchEnabled && this.detectTopicSwitch(obs)) {
      this.tryEvolve('topic_switch');
    }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // 路径3：空闲触发
    this.idleTimer = setTimeout(() => {
      if (this.pendingObservations.length > 0) {
        this.tryEvolve('idle_timeout');
      }
    }, this.config.idleMinutes * 60_000);
  }

  private tryEvolve(reason: TriggerReason): void {
    const now = Date.now();
    if (now - this.lastEvolveAt < this.config.cooldownMinutes * 60_000) return;
    if (this.dailyRunCount >= this.config.maxDailyRuns) return;
    if (this.pendingObservations.length < 3) return; // 最少3条才有意义

    const segment = this.sliceTopicSegment();
    this.lastEvolveAt = now;
    this.dailyRunCount++;

    // 异步触发进化，只处理这一段
    this.evolveSegment(segment, reason);
  }
}
```

### 3.3 主题切割算法（Topic Slicer）

**目标**：把 `pendingObservations` 切成主题连贯的段落，每段单独进化。

**实现**：轻量级本地判断，不调 AI：

```typescript
function detectTopicSwitch(newObs: ObservationRef): boolean {
  if (this.pendingObservations.length < 3) return false;

  const recent3 = this.pendingObservations.slice(-3);
  const signals = [
    // 信号1：文件路径前缀变化（从 src/plugins/ 跳到 desktop/）
    hasPathPrefixShift(recent3, newObs),

    // 信号2：observation type 突变（连续 refactor → 突然 investigation）
    hasTypeShift(recent3, newObs),

    // 信号3：时间间隔超过 15 分钟
    (newObs.timestamp - recent3[recent3.length - 1].timestamp) > 15 * 60_000,

    // 信号4：project 字段变化
    newObs.project !== recent3[recent3.length - 1].project,
  ];

  return signals.filter(Boolean).length >= 2;
}

function hasPathPrefixShift(recent: ObservationRef[], newObs: ObservationRef): boolean {
  const recentPrefixes = new Set(
    recent.flatMap(o => (o.files_modified || '').split(','))
      .map(f => f.trim().split('/').slice(0, 2).join('/'))
      .filter(Boolean)
  );
  const newPrefixes = (newObs.files_modified || '').split(',')
    .map(f => f.trim().split('/').slice(0, 2).join('/'))
    .filter(Boolean);

  if (recentPrefixes.size === 0 || newPrefixes.length === 0) return false;
  return newPrefixes.every(p => !recentPrefixes.has(p));
}
```

### 3.4 进化段（Segment）的上下文构建

不再把整个 session 的所有 observations 喂给 AI，而是只处理一段：

```typescript
interface EvolveSegment {
  observations: ObservationRef[];   // 只有这一段的 3~15 条
  segmentSummary: string | null;    // 这一段的简短描述（由前几条 obs 拼接）
  triggerReason: TriggerReason;     // 触发原因（日志用）
  workspace: string;
  sessionId: string;                // 仍关联原始 session
}

async function evolveSegment(segment: EvolveSegment): Promise<void> {
  // 复用现有 EvolveEngine.run() 的核心逻辑
  // 但输入从 "整个session的observations" 改为 "segment.observations"
  const evolveInput = {
    memorySessionId: `${segment.sessionId}:seg-${Date.now()}`,
    workspace: segment.workspace,
    observations: segment.observations,
    sessionSummary: null,  // 段没有完整 summary，用 null
    existingRules: getRulesByWorkspace(segment.workspace, { status: 'active' }),
    naturalSelections: getAllNaturalSelections(true),
  };

  await this.engine.runFromInput(evolveInput, config);
}
```

### 3.5 与现有 `onSessionEnd` 的兼容

**不删除现有逻辑**，而是叠加：

```typescript
// index.ts
async onSessionEnd(memorySessionId: string, workspace: string): Promise<void> {
  if (!this.config?.enabled) return;

  // 增量调度器可能已经处理了部分 observations
  // onSessionEnd 只进化「剩余未处理的」
  const remaining = this.scheduler.flushRemaining();
  if (remaining.length >= 3) {
    await this.evolveSegment({ observations: remaining, ... });
  }
}
```

---

## 4. 状态管理

### 4.1 追踪"哪些 observations 已被进化过"

```sql
-- 在 evolved_rules / evolution_log 中已有 source_session_id
-- 新增：记录每条 observation 是否已参与进化
ALTER TABLE observations ADD COLUMN evolved_at TEXT DEFAULT NULL;
```

或者更轻量的方式 — 用内存 watermark：

```typescript
class IncrementalEvolveScheduler {
  /** 上次进化处理到的 observation id（watermark） */
  private lastEvolvedObsId: number = 0;

  onObservationAdded(obs: ObservationRef): void {
    if (obs.id <= this.lastEvolvedObsId) return; // 已处理过
    this.pendingObservations.push(obs);
    ...
  }

  private afterEvolve(segment: EvolveSegment): void {
    const maxId = Math.max(...segment.observations.map(o => o.id));
    this.lastEvolvedObsId = maxId;
    this.pendingObservations = this.pendingObservations.filter(o => o.id > maxId);
  }
}
```

### 4.2 持久化（重启恢复）

```json
// ~/.agent-memory/plugins/self-evolve/scheduler-state.json
{
  "lastEvolvedObsId": 19542,
  "lastEvolveAt": "2026-05-26T05:10:00Z",
  "dailyRunCount": 7,
  "dailyResetDate": "2026-05-26"
}
```

---

## 5. 对 Prompt 的调整

现有 evolve prompt 假设输入是"完整会话"。增量模式下需要调整提示词：

```diff
- 以下是一次完整的工作会话记录。请从中提炼可复用的规则和技能。
+ 以下是最近一段连续工作片段（约 ${segment.observations.length} 条记录，
+ 时间跨度 ${durationMinutes} 分钟）。
+ 触发原因：${triggerReason}。
+ 请从中提炼可复用的规则和技能。
+ 注意：这不是完整会话，只是一个工作片段，请聚焦于这段内容本身的规律。
```

---

## 6. 配置项

```typescript
interface SelfEvolvePluginConfig {
  // 现有（保留）
  enabled: boolean;
  reviewMode: 'auto' | 'manual' | 'quality_gate';
  qualityGateThreshold: number;
  targetPlatforms: string[];
  maxContextRules: number;
  criticOnGenerate: boolean;

  // 新增：增量进化配置
  incremental: {
    enabled: boolean;              // 默认 true（开启增量模式）
    observationThreshold: number;  // 默认 8（累积 N 条触发）
    idleMinutes: number;           // 默认 30（空闲 N 分钟触发）
    topicSwitchEnabled: boolean;   // 默认 true（主题切换触发）
    cooldownMinutes: number;       // 默认 10（冷却期）
    maxDailyRuns: number;          // 默认 30（日上限）
    minSegmentSize: number;        // 默认 3（最少 N 条才进化）
  };
}
```

---

## 7. 生命周期集成点

```
WorkerService.handleObservation()
    │
    ├─ insertObservation()                        ← 现有
    │
    └─ scheduler.onObservationAdded(obsRef)       ← 新增
           │
           ├─ [count >= threshold?] → tryEvolve()
           ├─ [topic switch?]       → tryEvolve()
           └─ [idle timer fires]    → tryEvolve()

WorkerService.start()
    └─ scheduler.restore()                        ← 从 JSON 恢复 watermark

WorkerService.stop()
    └─ scheduler.persist()                        ← 持久化状态
```

---

## 8. 验证方式

| 场景 | 预期 | 如何验证 |
|------|------|----------|
| 连续写入 8 条 observation | 自动触发 1 次增量进化 | 检查 evolution_log 新增记录 |
| 空闲 30 分钟后有积累 | 空闲定时器触发进化 | 模拟 setTimeout 回调 |
| 文件前缀从 src/ 突变到 desktop/ | 检测到主题切换，进化前一段 | 单测 detectTopicSwitch |
| 10 分钟内连续满足阈值 | 只执行 1 次（冷却期） | 验证 cooldownMinutes 生效 |
| Worker 重启后 | 从 JSON 恢复 watermark | 重启后不重复进化已处理 obs |
| 会话正常结束 | flush 剩余未处理 obs | onSessionEnd 正确处理余量 |

---

## 9. 实施步骤

| 步骤 | 工作量 | 内容 |
|------|--------|------|
| 1 | 2h | 创建 `IncrementalEvolveScheduler` 类 + 数量触发 |
| 2 | 1h | 集成到 `WorkerService.handleObservation` 调用链 |
| 3 | 2h | 实现 `detectTopicSwitch` + 单测 |
| 4 | 1h | 添加空闲定时器 |
| 5 | 1h | 持久化 watermark（重启恢复） |
| 6 | 1h | 修改 evolve prompt 适配片段输入 |
| 7 | 1h | 配置项 + settings UI 暴露 |
| 8 | 1h | 与现有 onSessionEnd 兼容（flush 余量） |

**总计约 10h，可拆为 3 天迭代。**
