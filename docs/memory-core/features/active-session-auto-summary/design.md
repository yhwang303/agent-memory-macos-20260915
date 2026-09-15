# 设计文档：active 会话闲置自动总结

> 日期：2026-04-28
> 关联需求：`2026-04-28-active会话闲置自动总结-需求文档.md`

## 现状

### 现有 summary 触发路径

| 入口 | 触发条件 | 内部调用链 |
|---|---|---|
| `POST /api/session/end` | hooks-cli 显式调用（IDE 路径） | `handleSessionEnd` → `pendingSummaries.set` → `SDKAgent.generateSummary` → `updateSessionStatus(completed)` |
| `POST /api/session/complete` | OpenClaw plugin `agent_end` hook 触发 | `handleSessionComplete` → `updateSessionStatus(completed, now)` （**不**调 `generateSummary`） |
| `POST /api/summary` | OpenClaw plugin `agent_end` hook 同步调用 | `handleSummary`（要求 body 里 `summary` 字段，**当前 plugin 没传**，所以这条调用一直 400 静默） |

### 关键观察

- 已有 `getActiveSessions()` 能拿到所有 `status='active'` 的 session（`src/services/sqlite/sessions.ts:116`）。
- 已有 `getObservationsBySession(memorySessionId)` 按时间排序返回所有 observation，可以取最后一条的 `created_at_epoch` 作为 session 的"最后活跃时间"。
- `WorkerService.pendingSummaries: Map<string, Promise<...>>` 已经在做并发去重，新增路径需复用此 Map。
- `SDKAgent.generateSummary(memorySessionId, project)` 是现成的、可复用的 LLM 总结调用（在 `handleSessionEnd:432` 已用过）。
- `WorkerService` 里已有 `setInterval`（`SyncQueue` 等用的），引入新的定时器没问题。

### 当前问题

1. OpenClaw main agent 路径不发 `agent_end`，session 永久 `active`（详见需求文档背景）。
2. `handleSessionComplete` 只翻状态、不生成 summary（这是设计如此，避免重复触发）。
3. 没有任何"被动兜底"机制，外部不调就什么都不发生。

## 方案

### 总体思路

在 `WorkerService` 内嵌一个 `IdleSummaryScheduler`：

```
每 60 秒一次:
  1. 调 getActiveSessions() 拿到全部 active session
  2. 对每个 session:
     - 算"最后活跃时间" = max(observations.created_at_epoch)
       如果没有 observation，用 sessions.started_at_epoch
     - 如果 (now - 最后活跃时间) < threshold(默认 5 分钟): 跳过
     - 如果在 pendingSummaries 里: 跳过（外部已经在跑了）
     - 如果在最近一次失败后的退避窗口里: 跳过
     - 否则: 收入"待处理"列表
  3. 对待处理列表前 N=5 个:
     - 复用 handleSessionEnd 内部的 summary 流程（不通过 HTTP，直接调内部方法）
     - 成功: status='completed', completed_at=now（已有逻辑）
     - 失败: 记录失败时间到 lastFailureMs Map，下一轮按退避窗口跳过
```

### 改动 1：抽 `handleSessionEnd` 主体为可复用内部方法

把当前 `handleSessionEnd` 中"找到 session → 排重 → 生成 summary → 翻状态 → 入 syncQueue"那段提取为：

```typescript
private async runSummaryFlow(sessionId: string, reason: string): Promise<void>
```

然后：
- `handleSessionEnd` 收到 HTTP 请求后调它。
- `IdleSummaryScheduler` 也调它。

这样两条路径**完全共用**：`pendingSummaries` 去重、`generateSummary` 调用、`updateSessionStatus`、`syncQueue.enqueue` 全部一致。

### 改动 2：新增 `IdleSummaryScheduler`

新文件 `src/services/worker/IdleSummaryScheduler.ts`：

```typescript
import { getActiveSessions } from '../sqlite/sessions.js';
import { getObservationsBySession } from '../sqlite/observations.js';
import { logger } from '../../utils/logger.js';

export interface IdleSummaryConfig {
  enabled: boolean;
  thresholdMs: number;       // 距最后 observation 多久算 idle
  scanIntervalMs: number;    // 多久扫一次
  maxPerScan: number;        // 单次最多处理几个
  retryBackoffMs: number;    // 失败后多久才重试
}

export const DEFAULT_IDLE_SUMMARY_CONFIG: IdleSummaryConfig = {
  enabled: true,
  thresholdMs: 5 * 60 * 1000,
  scanIntervalMs: 60 * 1000,
  maxPerScan: 5,
  retryBackoffMs: 5 * 60 * 1000,
};

export type RunSummaryFn = (sessionId: string, reason: string) => Promise<void>;

export class IdleSummaryScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFailureMs = new Map<string, number>();
  private running = false;

  constructor(
    private readonly cfg: IdleSummaryConfig,
    private readonly runSummary: RunSummaryFn,
    private readonly isPending: (memorySessionId: string) => boolean
  ) {}

  start(): void {
    if (!this.cfg.enabled) {
      logger.info('IDLE_SUMMARY', 'Disabled by config; scheduler not started');
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => this.tickSafe(), this.cfg.scanIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    logger.info('IDLE_SUMMARY', 'Scheduler started', {
      thresholdMs: this.cfg.thresholdMs,
      scanIntervalMs: this.cfg.scanIntervalMs,
      maxPerScan: this.cfg.maxPerScan,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tickSafe(): Promise<void> {
    if (this.running) return; // 上一轮还没跑完
    this.running = true;
    try {
      await this.tick();
    } catch (err) {
      logger.error('IDLE_SUMMARY', 'Tick failed', {}, err as Error);
    } finally {
      this.running = false;
    }
  }

  /** Visible for tests */
  async tick(now = Date.now()): Promise<{ scanned: number; processed: number; skipped: number }> {
    const active = getActiveSessions();
    let processed = 0;
    let skipped = 0;
    const candidates: Array<{ contentSessionId: string; lastActivity: number }> = [];

    for (const s of active) {
      if (!s.memory_session_id) { skipped++; continue; }

      const obs = getObservationsBySession(s.memory_session_id);
      const lastActivity = obs.length > 0
        ? obs[obs.length - 1].created_at_epoch
        : s.started_at_epoch;

      if (now - lastActivity < this.cfg.thresholdMs) { skipped++; continue; }
      if (this.isPending(s.memory_session_id)) { skipped++; continue; }

      const lastFail = this.lastFailureMs.get(s.content_session_id);
      if (lastFail && now - lastFail < this.cfg.retryBackoffMs) { skipped++; continue; }

      candidates.push({ contentSessionId: s.content_session_id, lastActivity });
    }

    // 优先处理最久没动的
    candidates.sort((a, b) => a.lastActivity - b.lastActivity);

    for (const c of candidates.slice(0, this.cfg.maxPerScan)) {
      try {
        await this.runSummary(c.contentSessionId, 'idle-timeout');
        this.lastFailureMs.delete(c.contentSessionId);
        processed++;
        logger.info('IDLE_SUMMARY', 'Auto-completed idle session', {
          contentSessionId: c.contentSessionId,
          idleMs: now - c.lastActivity,
        });
      } catch (err) {
        this.lastFailureMs.set(c.contentSessionId, now);
        logger.warn('IDLE_SUMMARY', 'Failed to auto-summarize', {
          contentSessionId: c.contentSessionId,
          err: String(err),
        });
      }
    }

    if (processed > 0 || candidates.length > 0) {
      logger.info('IDLE_SUMMARY', 'Tick complete', {
        active: active.length,
        candidates: candidates.length,
        processed,
        skipped,
      });
    }
    return { scanned: active.length, processed, skipped };
  }
}
```

### 改动 3：`WorkerService` 装配

```typescript
// src/services/worker/WorkerService.ts

private idleScheduler: IdleSummaryScheduler | null = null;

async start(): Promise<void> {
  // ... existing ...
  const cfg = resolveIdleSummaryConfig();   // 读 env / config
  this.idleScheduler = new IdleSummaryScheduler(
    cfg,
    (sid, reason) => this.runSummaryFlow(sid, reason),
    (msid) => this.pendingSummaries.has(msid),
  );
  this.idleScheduler.start();
}

async shutdown(): Promise<void> {
  this.idleScheduler?.stop();
  // ... existing ...
}

private async runSummaryFlow(sessionId: string, reason: string): Promise<void> {
  // 提取自原 handleSessionEnd 的核心逻辑，HTTP 端和 scheduler 共用
}
```

`handleSessionEnd` 改成：

```typescript
private async handleSessionEnd(req, res): Promise<void> {
  const { sessionId, reason } = await this.parseBody(req);
  if (!sessionId) { res.statusCode = 400; res.end(...); return; }
  res.statusCode = 200;
  res.end(JSON.stringify({ success: true, queued: true, reason }));
  this.runSummaryFlow(sessionId, reason || 'http').catch(err => {
    logger.error('WORKER', 'Background summary failed', { sessionId }, err as Error);
  });
}
```

### 改动 4：配置解析

新增 `src/services/worker/idleSummaryConfig.ts`：

```typescript
import { DEFAULT_IDLE_SUMMARY_CONFIG, type IdleSummaryConfig } from './IdleSummaryScheduler.js';

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw == null) return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase());
}

export function resolveIdleSummaryConfig(): IdleSummaryConfig {
  return {
    enabled:        envBool('IDLE_SUMMARY_ENABLED',        DEFAULT_IDLE_SUMMARY_CONFIG.enabled),
    thresholdMs:    envInt('IDLE_SUMMARY_THRESHOLD_MS',    DEFAULT_IDLE_SUMMARY_CONFIG.thresholdMs),
    scanIntervalMs: envInt('IDLE_SUMMARY_SCAN_INTERVAL_MS', DEFAULT_IDLE_SUMMARY_CONFIG.scanIntervalMs),
    maxPerScan:     envInt('IDLE_SUMMARY_MAX_PER_SCAN',    DEFAULT_IDLE_SUMMARY_CONFIG.maxPerScan),
    retryBackoffMs: envInt('IDLE_SUMMARY_RETRY_BACKOFF_MS', DEFAULT_IDLE_SUMMARY_CONFIG.retryBackoffMs),
  };
}
```

## 数据模型

**不动 schema**。完全基于现有表：

| 用到的表/字段 | 用途 |
|---|---|
| `sdk_sessions.status='active'` | 找候选 session |
| `sdk_sessions.memory_session_id` | 关联 observations |
| `sdk_sessions.started_at_epoch` | session 还没观察时的活跃时间 fallback |
| `observations.created_at_epoch` | 推导"最后活跃时间" |

不新增字段、不引入新表。

## 测试计划

### 单元测试 `tests/worker/IdleSummaryScheduler.test.ts`

1. **threshold 边界**：mock `getActiveSessions` + `getObservationsBySession`，构造 `now - lastActivity = thresholdMs - 1`，断言 `runSummary` 不被调。
2. **越界即处理**：`now - lastActivity = thresholdMs + 1`，断言 `runSummary` 被调一次，参数为对应 sessionId、reason='idle-timeout'。
3. **pendingSummaries 命中即跳过**：`isPending` 返回 true，断言 `runSummary` 不被调。
4. **失败退避**：mock `runSummary` 抛错；下一次 tick 在 `retryBackoffMs` 内时 `runSummary` 再次**不**被调；超过窗口后被调。
5. **maxPerScan 限流**：构造 10 个均超阈值的 session，单次 tick 只调 5 次 `runSummary`，剩下 5 个下次再处理。
6. **优先级**：构造时间错乱的 session，断言 `runSummary` 调用顺序按 `lastActivity ASC`（最久不动的先处理）。
7. **空 observation 兜底**：session 有 `started_at_epoch` 但没 observation，按 `started_at_epoch` 算 idle。
8. **enabled=false 不启动**：`new IdleSummaryScheduler({enabled:false,...})` 后 `start()` 不创建 timer。

### Worker 集成测试 `tests/worker/idle-summary-integration.test.ts`

跑真实 `WorkerService`，但用极小的间隔（`scanIntervalMs=200`、`thresholdMs=300`）：

1. 启动 worker → POST `/api/session/start` → POST 一条 `/api/observation` → 等 700ms → 查 `/api/viewer/sessions`：status 应为 `completed`。
2. 启动 worker → POST `/api/session/start` → 持续每 100ms POST observation → 等 1s → status 应仍为 `active`。

（`SDKAgent.generateSummary` 用 stub 替换避免真调 LLM。）

### 手工 E2E

```bash
# 1. 把 main agent session 的最近活跃时间往前推到 6 分钟前（直接动 SQLite 太脏，更稳的做法是新建一条测试 session）
curl -X POST http://127.0.0.1:3847/api/session/start \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"idle-e2e-XXX","project":"openclaw-gateway","userPrompt":"idle test"}'

curl -X POST http://127.0.0.1:3847/api/observation \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"idle-e2e-XXX","toolName":"x","toolOutput":"y","observationType":"tool_output"}'

# 2. 等 6 分钟
sleep 360

# 3. 查 status
curl -s 'http://127.0.0.1:3847/api/viewer/sessions?limit=5' | python3 -c "
import json,sys
for s in json.load(sys.stdin)['data']:
  if s['content_session_id']=='idle-e2e-XXX':
    print(s['status'], s['completed_at'])"
# 期望: completed <非空时间>

# 4. 查 summary
curl -s 'http://127.0.0.1:3847/api/viewer/summaries?limit=5' | python3 -c "
import json,sys
ds=json.load(sys.stdin)['data']
print('hit:', any(s.get('memory_session_id','').startswith('mem-') for s in ds))"
```

## 部署

仅 worker 端改动：

1. `npm run build` 重新编译 `dist/`。
2. 把新 `dist/services/worker/{WorkerService,IdleSummaryScheduler,idleSummaryConfig}.js` 同步到 `/Applications/AgentMemory.app/Contents/Resources/worker/services/worker/`（跟之前 `cp` 同样操作，备份原文件）。
3. 退出 + 重启 `AgentMemory.app`，新 worker 加载后自动启动 scheduler，5 分钟后开始扫到第一批历史 active session（包括 `agent:main:main`）。

## 兼容性 / 回滚

- 默认开启，但所有 SQL 操作都是只读 + 既有写路径，**不会破坏现有数据**。
- 想回滚：环境变量 `IDLE_SUMMARY_ENABLED=false` 后重启 worker，scheduler 不启动；或 `cp` 回备份文件。
- 不影响 hooks-cli / OpenClaw plugin / channel hooks 任何一条现有路径。

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 启动瞬间一次性扫到大量历史 active session（你这台已经有 8+ 条），一次性调 LLM | LLM 配额秒爆 | `maxPerScan=5` + 失败退避 5 分钟 + scan 间隔 1 分钟，每分钟最多 5 个 |
| LLM 配额耗尽时 summary 为空标题继续累积 | 仍然失败但被反复扫到 | 失败后 `lastFailureMs` 记录，5 分钟内不重试；多次失败累积，最终至少把 status 翻好 |
| `getObservationsBySession` 全表扫描慢 | 性能问题 | 该方法已有 `WHERE memory_session_id = ?` 索引，单 session 数据量小（<100 条）；扫描间隔 1 分钟可接受 |
| 真有用户跑 5+ 分钟手工任务（中间不调工具） | 误判为 idle | 阈值 5 分钟保守；用户可调大 `IDLE_SUMMARY_THRESHOLD_MS` |
| Scheduler 与外部 `/api/session/end` 同时触发 | 重复总结 | 共享 `pendingSummaries` Map，第二次会拿到第一次的 promise 等结果 |

## 验收清单（与需求文档一一对应）

- [ ] 单测全部通过（IdleSummaryScheduler 8 条）
- [ ] 集成测试两条用例通过
- [ ] typecheck / 现有 worker + plugin 单测全绿
- [ ] 手工 E2E：构造一个 idle session，6 分钟后自动 completed + summary 出现
- [ ] `IDLE_SUMMARY_ENABLED=false` 重启后不再自动总结
- [ ] LLM 失败时 status 不被错误翻成 completed
- [ ] worker 日志能看到 `[IDLE_SUMMARY] Tick complete` / `Auto-completed idle session`
