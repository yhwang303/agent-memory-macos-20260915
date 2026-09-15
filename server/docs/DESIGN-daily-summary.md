# 设计文档：今日总结（Daily Brief）

> 版本: 1.0.0
> 最后更新: 2026-04-19
> 对应 PRD: PRD-daily-summary.md
> 关联设计: DESIGN-cross-device-memory-sync.md

---

## 一、架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│  设备 A (Mac)                                                    │
│                                                                 │
│   ┌─────────────────────┐       每日 22:00 / 启动时             │
│   │ DailyBriefScheduler │──────── 触发 ────────┐               │
│   └─────────────────────┘                      │               │
│                                                ▼               │
│   ┌─────────────────────┐    读取本日数据   ┌─────────────┐    │
│   │ sessions/observa-   │───────────────────│ DailyBrief- │    │
│   │ tions/summaries     │                   │ Generator   │    │
│   └─────────────────────┘                   │ (用 SDKAgent)│    │
│                                             └──────┬──────┘    │
│                                                    │           │
│                                                    ▼           │
│                                        ┌──────────────────┐    │
│                                        │ daily_briefs 表  │    │
│                                        └────────┬─────────┘    │
│                                                 │              │
│                                                 ▼              │
│                                        ┌──────────────────┐    │
│                                        │ SyncQueue        │    │
│                                        │ (kind='daily_-   │    │
│                                        │  brief')         │    │
│                                        └────────┬─────────┘    │
│                                                 │ HTTP POST    │
└─────────────────────────────────────────────────┼──────────────┘
                                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  agent-mem-server                                                │
│                                                                 │
│   POST /api/v1/sync/daily-briefs ──▶ daily_briefs 表（多设备）  │
│                                                                 │
│   GET  /api/v1/daily-brief?date= ──▶ 内存合并多设备 ──▶ JSON   │
│                                                                 │
│   GET  /web/  (今日总结 Tab) ────────────────────────▶ HTML     │
└─────────────────────────────────────────────────────────────────┘

       ▲ Desktop QuickPanel ─── GET /api/daily-brief?date=
                              ─── POST /api/daily-brief/generate
                            （直连本机 Worker）
```

---

## 二、客户端改造点

### 2.1 新增/修改文件清单

| 文件 | 类型 | 职责 |
|:---|:---|:---|
| `src/services/daily-brief/DailyBriefGenerator.ts` | 新增 | 读取本日数据、构造 prompt、调用 SDKAgent、写库 |
| `src/services/daily-brief/DailyBriefScheduler.ts` | 新增 | 每日 22:00 + 启动时补昨日 + 手动触发限流 |
| `src/services/daily-brief/index.ts` | 新增 | 模块导出 |
| `src/services/sqlite/dailyBriefs.ts` | 新增 | `daily_briefs` 表 CRUD |
| `src/sdk/prompts.ts` | 修改 | 新增 `buildDailyBriefPrompt()` |
| `src/sdk/parser.ts` | 修改 | 新增 `parseDailyBrief()` |
| `src/services/sqlite/Database.ts` | 修改 | 新增 `daily_briefs` 表的 schema |
| `src/services/worker/WorkerService.ts` | 修改 | 注册 3 个新路由 + 启动时初始化 Scheduler |
| `src/services/sync/SyncQueue.ts` | 修改 | 支持 `kind='daily_brief'` |
| `src/services/sync/RemoteClient.ts` | 修改 | 新增 `syncDailyBriefs()` 方法 |

### 2.2 数据库 Schema：daily_briefs 表

```sql
CREATE TABLE IF NOT EXISTS daily_briefs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  date_local          TEXT NOT NULL,         -- 'YYYY-MM-DD'，本地时区
  device_id           TEXT,                  -- 复用 identity.ts
  device_name         TEXT,
  source_ide_summary  TEXT,                  -- 当日涉及的 IDE 列表 JSON 数组
  projects_summary    TEXT,                  -- 当日涉及的 project 列表 JSON 数组
  brief_json          TEXT NOT NULL,         -- 结构化总结，见 §2.3
  brief_markdown      TEXT NOT NULL,         -- 渲染好的 Markdown，便于直接展示
  input_stats         TEXT,                  -- 输入统计 JSON: {sessions, observations, summaries}
  llm_model           TEXT,                  -- 生成时使用的模型
  llm_provider        TEXT,                  -- 'api' | 'claude-code'
  generation_ms       INTEGER,               -- 本次生成耗时
  status              TEXT NOT NULL,         -- 'success' | 'failed' | 'skipped_empty'
  error_message       TEXT,
  client_uuid         TEXT NOT NULL,         -- 同步幂等 key: 'daily_brief-{date}-{device_id}-v{n}'
  synced_at           INTEGER,
  created_at          TEXT NOT NULL,
  created_at_epoch    INTEGER NOT NULL,
  UNIQUE(date_local, device_id)
);
CREATE INDEX IF NOT EXISTS idx_daily_briefs_date ON daily_briefs(date_local);
CREATE INDEX IF NOT EXISTS idx_daily_briefs_status ON daily_briefs(status);
```

> 注：`UNIQUE(date_local, device_id)` 约束 + `INSERT OR REPLACE` 实现"同一日期同一设备只保留最新版"。`client_uuid` 末尾的 `v{n}` 自增（n=`(SELECT COUNT(*) FROM daily_briefs WHERE date_local=? AND device_id=?) + 1`），保证服务端能感知"同一日期被覆盖更新"，触发 `ON CONFLICT DO UPDATE`。

### 2.3 brief_json 结构

```typescript
interface DailyBrief {
  date: string;                      // 'YYYY-MM-DD'
  generated_at: string;              // ISO 时间
  per_project: Array<{
    project: string;
    headline: string;                // 一句话提要
    completed: string[];             // 完成的事项要点
    thinking: string[];              // 主要思考 / 决策 / 想法
    issues: string[];                // 遇到的问题 / 卡点
    next_suggestions: string[];      // 明日建议
  }>;
  overall: {
    theme: string;                   // 今日总主题
    narrative: string;               // 一段叙事性回顾（200~400 字）
    state_observation: string;       // 对使用者状态/情绪的观察（如"下午效率明显下降"）
    feedback_to_user: string;        // 反馈给使用者的"观察录"（鼓励、提醒、建议）
  };
}
```

### 2.4 DailyBriefGenerator 设计

```typescript
class DailyBriefGenerator {
  constructor(private sdkAgent: SDKAgent) {}

  async generate(date: string, opts?: { force?: boolean }): Promise<GenerateResult> {
    // 1. 拉取当日数据（本设备本日 [00:00, 23:59:59]）
    const sessions = listSessionsByDate(date);
    const observations = listObservationsByDate(date);
    const summaries = listSummariesByDate(date);

    if (sessions.length + observations.length + summaries.length === 0) {
      return { status: 'skipped_empty' };
    }

    // 2. 截断到 MAX_INPUT_OBSERVATIONS 防爆炸
    const truncated = truncateForPrompt({ sessions, observations, summaries });

    // 3. 按 project 预分组（让 LLM 视角更清晰）
    const byProject = groupByProject(truncated);

    // 4. 构造 prompt + 调用 LLM
    const prompt = buildDailyBriefPrompt({ date, byProject, ... });
    const response = await this.sdkAgent.callLLM(prompt, { timeoutMs: 90000 });

    // 5. 解析为结构化 brief
    const brief = parseDailyBrief(response);

    // 6. 渲染 Markdown
    const markdown = renderDailyBriefMarkdown(brief);

    // 7. 写入 daily_briefs 表（INSERT OR REPLACE） + 入队同步
    upsertDailyBrief({ date, brief, markdown, ... });
    syncQueue.enqueue('daily_brief', { date, brief, markdown, ... });

    return { status: 'success', durationMs };
  }
}
```

### 2.5 DailyBriefScheduler 设计

```typescript
class DailyBriefScheduler {
  constructor(private generator: DailyBriefGenerator)

  start(): void {
    // 启动时 ① 检查昨日是否需要补生成
    this.checkBackfill();

    // 启动时 ② 算出下一个 22:00 的 ms 距离，setTimeout 触发
    this.scheduleNextRun();
  }

  stop(): void

  // 手动触发（带 60 秒限流）
  async triggerManual(date: string): Promise<GenerateResult>

  private scheduleNextRun(): void {
    const hour = parseInt(process.env.CODEBUDDY_MEM_DAILY_BRIEF_HOUR || '22', 10);
    const next = computeNext(hour);  // 下一次 hour:00 的 epoch
    setTimeout(() => {
      this.generator.generate(today()).finally(() => this.scheduleNextRun());
    }, next - Date.now());
  }

  private async checkBackfill(): Promise<void> {
    const yesterday = isoDate(Date.now() - 86400_000);
    if (!hasBriefFor(yesterday) && hasDataFor(yesterday)) {
      await this.generator.generate(yesterday);
    }
  }
}
```

环境变量：

- `CODEBUDDY_MEM_DAILY_BRIEF_ENABLED`：默认 `true`，设为 `false` 完全关闭
- `CODEBUDDY_MEM_DAILY_BRIEF_HOUR`：定时小时，默认 `22`
- `CODEBUDDY_MEM_DAILY_BRIEF_MAX_INPUT`：单次输入观察记录上限，默认 `100`

### 2.6 WorkerService 路由

```typescript
// 现有 WorkerService 注册新增三个路由：

router.get('/api/daily-brief', async (req, res) => {
  const date = parseDateParam(req) ?? today();
  const brief = getDailyBriefByDate(date);
  res.json(brief);  // 不存在时返回 { exists: false, date }
});

router.post('/api/daily-brief/generate', async (req, res) => {
  const date = req.body?.date ?? today();
  const result = await scheduler.triggerManual(date);
  res.json(result);
});

router.get('/api/daily-brief/list', async (req, res) => {
  const { from, to } = req.query;
  res.json(listDailyBriefs({ from, to }));
});
```

### 2.7 与 SyncQueue 集成

`SyncQueue.ts` 扩展点：

- `kind` 类型增加 `'daily_brief'`
- `dispatchByKind()` 中新增分支调用 `RemoteClient.syncDailyBriefs(items)`

`RemoteClient.ts`：

```typescript
async syncDailyBriefs(items: SyncDailyBriefItem[]): Promise<SyncResult> {
  return this.post('/api/v1/sync/daily-briefs', { items });
}
```

### 2.8 与现有 hooks-cli 无关

本功能完全在 Worker 进程内闭环，不需要修改 hooks-cli 或各 IDE 适配器。

---

## 三、服务端改造点（agent-mem-server）

### 3.1 数据库 Schema

```sql
CREATE TABLE IF NOT EXISTS daily_briefs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id           TEXT NOT NULL,
  source_ide_summary  TEXT,
  projects_summary    TEXT,
  date_local          TEXT NOT NULL,
  client_uuid         TEXT NOT NULL,
  brief_json          TEXT NOT NULL,
  brief_markdown      TEXT NOT NULL,
  input_stats         TEXT,
  llm_model           TEXT,
  llm_provider        TEXT,
  generation_ms       INTEGER,
  status              TEXT NOT NULL,
  error_message       TEXT,
  created_at          TEXT,
  created_at_epoch    INTEGER,
  received_at         TEXT NOT NULL,
  UNIQUE(device_id, date_local)
);
CREATE INDEX IF NOT EXISTS idx_brief_date ON daily_briefs(date_local);
CREATE INDEX IF NOT EXISTS idx_brief_device ON daily_briefs(device_id);
```

> 注：服务端唯一约束按 `(device_id, date_local)` 而非 `(device_id, client_uuid)`，因为客户端会用同一对 device+date 多次覆盖。冲突时走 `ON CONFLICT DO UPDATE`。

### 3.2 新增路由

#### 3.2.1 同步接收

**POST /api/v1/sync/daily-briefs**

```typescript
// Request
{
  items: Array<{
    client_uuid: string;
    device_id: string;
    date_local: string;             // 'YYYY-MM-DD'
    source_ide_summary?: string;    // JSON 数组字符串
    projects_summary?: string;      // JSON 数组字符串
    brief_json: string;             // 已序列化
    brief_markdown: string;
    input_stats?: string;
    llm_model?: string;
    llm_provider?: string;
    generation_ms?: number;
    status: 'success' | 'failed' | 'skipped_empty';
    error_message?: string;
    created_at?: string;
    created_at_epoch?: number;
  }>
}

// Response
{ success: true, received: number, updated: number }
```

实现要点：参考 `routes/sync.ts` 现有 `handleSyncSessions()` 模式，使用 `ON CONFLICT(device_id, date_local) DO UPDATE` 覆盖式写入。

#### 3.2.2 聚合查询

**GET /api/v1/daily-brief?date=YYYY-MM-DD**

```typescript
// Response
{
  date: "2026-04-19",
  devices: [
    { device_id: "uuid...", device_name: "mac-work", status: "success", generated_at: "..." },
    { device_id: "uuid...", device_name: "win-home", status: "success", generated_at: "..." }
  ],
  per_project: [
    {
      project: "agent-memory",
      contributions: [
        { device_name: "mac-work", headline: "...", completed: [...], thinking: [...], issues: [...], next_suggestions: [...] },
        { device_name: "win-home", headline: "...", completed: [...], ... }
      ]
    },
    { project: "agent-mem-server", contributions: [...] }
  ],
  overall: [
    { device_name: "mac-work", theme: "...", narrative: "...", state_observation: "...", feedback_to_user: "..." },
    { device_name: "win-home", theme: "...", narrative: "...", ... }
  ],
  merged_markdown: "# 今日总结 ..."   // 拼接好的 Markdown，便于前端直接渲染
}
```

合并逻辑（纯内存拼接，无 LLM）：

1. `SELECT ... FROM daily_briefs WHERE date_local = ?` 按 device 维度全量取出
2. `JOIN devices` 拿到 `device_name`
3. 解析每条 `brief_json`：按 project 索引，重新组装 `per_project`
4. `overall` 段直接平铺各设备的"叙事 + 状态 + 反馈"
5. 渲染成 `merged_markdown`，§3.4 给出格式

**GET /api/v1/daily-brief/list?from=&to=&device=**

返回区间内可用日期清单：

```typescript
{
  dates: [
    { date: "2026-04-19", device_count: 2, status_summary: { success: 2 } },
    { date: "2026-04-18", device_count: 1, status_summary: { success: 1 } }
  ]
}
```

### 3.3 鉴权

- `POST /api/v1/sync/daily-briefs` 需 `Authorization: Bearer ${SHARED_TOKEN}`，复用现有 `auth/token.ts`
- `GET /api/v1/daily-brief*` 与现有 aggregate 接口同等：MVP 不鉴权

### 3.4 Markdown 渲染规范

```markdown
# 今日总结 - 2026-04-19

> 跨设备汇总 | 设备: mac-work, win-home | 共 12 个会话、87 条观察

---

## 按项目

### agent-memory

**[mac-work]** 今天主要在调试同步链路，修了 4 个根本问题。

- **完成**
  - 修复 client_uuid 拼接异常导致的 415 报错
  - 启动时补扫历史数据
- **思考**
  - 幂等键应在最早入口处生成，而不是临入队前
- **问题**
  - 服务端 8848 端口残留进程，重启偶发失败
- **明日建议**
  - 给 Worker 启动加端口占用预检

**[win-home]** ...

### agent-mem-server

**[mac-work]** ...

---

## 整体回顾

**[mac-work]**
- **主题**：跨设备同步链路打磨
- **叙事**：上午定位到 4 个根因，下午集中修复并联调，晚上回归测试通过……
- **状态观察**：下午 3 点后状态明显下降，几次小修反复
- **反馈**：你今天处理了 4 个根因问题，节奏紧凑；建议明天先做单元测试再动业务代码

**[win-home]** ...
```

### 3.5 Web 页面改动

`web/index.html` 在现有 Tab 区新增「今日总结」Tab：

```html
<div class="tabs">
  <button data-tab="timeline">时间线</button>
  <button data-tab="daily-brief">今日总结</button>
  <button data-tab="export">导出</button>
</div>

<div data-tab-content="daily-brief" hidden>
  <div class="toolbar">
    <input type="date" id="brief-date" />
    <button id="brief-prev">‹</button>
    <button id="brief-next">›</button>
    <span class="spacer"></span>
    <span class="hint">如需重新生成，请到 Desktop 客户端点击「立即生成」</span>
  </div>
  <div id="brief-content">
    <!-- 渲染 merged_markdown -->
  </div>
</div>
```

JS 侧：

```javascript
async function loadDailyBrief(date) {
  const r = await fetch(`/api/v1/daily-brief?date=${date}`);
  const data = await r.json();
  document.getElementById('brief-content').innerHTML = renderMarkdown(data.merged_markdown);
}
```

> Markdown 渲染：MVP 用最简手写渲染（标题、列表、加粗、引用），不引入额外依赖；复杂场景后续可换 marked.js。

---

## 四、Desktop 客户端改造点

### 4.1 QuickPanel 新增「今日总结」入口

`desktop/src/windows/quick-panel.html` 增加 Tab：

```html
<nav class="tabs">
  <a data-tab="recent">最近</a>
  <a data-tab="brief">今日总结</a>
  <a data-tab="status">状态</a>
</nav>

<section data-tab-panel="brief">
  <header>
    <h3 id="brief-title">2026-04-19 今日总结</h3>
    <div class="actions">
      <button id="brief-refresh">刷新</button>
      <button id="brief-generate" class="primary">立即生成</button>
    </div>
    <small id="brief-meta">上次生成: 2026-04-19 22:00:12 · 用时 32s · 模型 gpt-5.4</small>
  </header>
  <article id="brief-body"></article>
</section>
```

### 4.2 QuickPanel.ts 数据加载

```typescript
// desktop/src/windows/QuickPanel.ts

private async loadDailyBrief(date: string) {
  const res = await fetch(`http://127.0.0.1:${WORKER_PORT}/api/daily-brief?date=${date}`);
  const data = await res.json();
  if (!data.exists) {
    this.renderEmpty(date);
    return;
  }
  this.renderBriefMarkdown(data.brief_markdown, data);
}

private async triggerGenerate() {
  this.setBriefStatus('生成中...');
  const res = await fetch(`http://127.0.0.1:${WORKER_PORT}/api/daily-brief/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: this.currentBriefDate }),
  });
  const result = await res.json();
  if (result.status === 'success') {
    await this.loadDailyBrief(this.currentBriefDate);
  } else {
    this.setBriefStatus(`生成失败: ${result.error_message ?? result.status}`);
  }
}
```

### 4.3 状态指示

- 生成中：按钮禁用 + 转圈 + "生成中..." 文案
- 60 秒限流：返回 `{ status: 'rate_limited', retry_after_seconds: N }` 时按钮显示倒计时
- 生成失败：红色提示文案 + 显示错误，按钮可立即重试

---

## 五、Prompt 设计

### 5.1 buildDailyBriefPrompt() 模板

```typescript
function buildDailyBriefPrompt(input: {
  date: string;
  device_name: string;
  byProject: Record<string, {
    sessions: SessionLite[];
    observations: ObservationLite[];
    summaries: SummaryLite[];
  }>;
  totalCounts: { sessions: number; observations: number; summaries: number };
}): string {
  return `
你是用户的工作日志编辑。基于下面 ${input.date}（${input.device_name}）一整天的实际操作记录，
为用户生成一份"今日总结 + 观察录"。要求：

【目标】
- 让用户看完一眼就明白：今天我做了什么、想了什么、遇到了什么、明天该做什么
- 同时输出一段对用户状态的观察（叙事性、温和、有同理心，不奉承不批评）

【按项目分组的输入】
${formatByProjectForPrompt(input.byProject)}

【输出 JSON 结构】（严格按此格式，不要多余内容）
{
  "per_project": [
    {
      "project": "string",
      "headline": "一句话提要（≤30 字）",
      "completed": ["完成事项 1", "完成事项 2", ...],   // 3~6 条
      "thinking": ["主要想法/决策 1", ...],            // 1~4 条
      "issues": ["遇到的问题 1", ...],                 // 0~3 条
      "next_suggestions": ["明日建议 1", ...]          // 1~3 条
    }
  ],
  "overall": {
    "theme": "今日总主题（≤20 字）",
    "narrative": "一段 200~400 字的叙事回顾",
    "state_observation": "对用户状态/节奏的观察（80~150 字）",
    "feedback_to_user": "给用户的反馈，鼓励或提醒（80~150 字）"
  }
}

【硬约束】
- 输出严格合法 JSON，不要 \`\`\` 包裹，不要前后说明文字
- 只基于提供的事实，不要凭空编造项目名、文件名、命令
- 中文输出
`;
}
```

### 5.2 parseDailyBrief() 容错

- 优先 `JSON.parse` 整段
- 失败时尝试用 `/{[\s\S]*}/` 截取首尾大括号
- 仍失败则将原文作为 `overall.narrative`，其余字段置空，`status` 仍记 `success`（保留可读内容）

---

## 六、跨设备时区处理

- 日期统一用客户端本地时区的 `YYYY-MM-DD` 字符串作为对齐键
- 客户端 `today()` 返回本机本地日期
- 服务端不做时区转换，直接以 `date_local` 字段去重和聚合
- 副作用：跨时区的两台设备，对应的"同一天"在时间线上其实是错位的；MVP 接受这一近似，未来若需精准跨时区合并，再引入 `tz_offset_minutes` 字段

---

## 七、错误处理与重试

| 场景 | 处理 |
|:---|:---|
| LLM 调用超时 | 写入 `status='failed', error_message`；下一次定时/手动可重试覆盖 |
| LLM 返回格式无法解析 | 走 §5.2 容错路径；解析失败的原文兜底入 `overall.narrative`，`status='success'` |
| SyncQueue 上行失败 | 复用现有重试机制，不影响本地展示 |
| 服务端不支持 `daily_brief` kind（旧版本） | 客户端首次同步收到 404 时缓存"远端不支持"标记 24h，期间不重复上行；告警 1 次到日志 |
| 数据库写冲突 | `INSERT OR REPLACE` 保证最后一次生成胜出 |
| 生成耗时过长 (> 90s) | 主动 abort + 标 failed；不在 Worker 主循环里阻塞 |

---

## 八、兼容性与迁移

### 8.1 客户端

- 新增 `daily_briefs` 表通过 `IF NOT EXISTS` 创建
- 未启用功能（`CODEBUDDY_MEM_DAILY_BRIEF_ENABLED=false`）时 Scheduler 不启动，相关路由仍可读历史数据
- 旧版本 Desktop 不感知本功能，QuickPanel 新 Tab 在配置开关关闭时隐藏

### 8.2 服务端

- 新增 `daily_briefs` 表通过 `IF NOT EXISTS` 创建
- 未升级的服务端：客户端探测到 404 自动跳过同步，本机仍正常展示
- 新版服务端遇到旧客户端：旧客户端不上行此类数据，服务端表为空时 Web Tab 显示"暂无总结"

---

## 九、配置与环境变量汇总

### 9.1 客户端

```env
# 总开关
CODEBUDDY_MEM_DAILY_BRIEF_ENABLED=true

# 定时小时（本地时区，0~23）
CODEBUDDY_MEM_DAILY_BRIEF_HOUR=22

# 单次生成最多输入观察记录数
CODEBUDDY_MEM_DAILY_BRIEF_MAX_INPUT=100

# 手动触发限流（秒）
CODEBUDDY_MEM_DAILY_BRIEF_MANUAL_COOLDOWN=60

# 单次 LLM 调用超时
CODEBUDDY_MEM_DAILY_BRIEF_TIMEOUT=90000
```

### 9.2 服务端

无新增配置（复用现有）。

---

## 十、实施计划与里程碑

| 阶段 | 内容 | 预计工作量 |
|:---|:---|:---|
| P1 | 客户端表 + Generator + Prompt + 单元测试 | 1 天 |
| P2 | Scheduler + 启动补昨日 + 手动触发限流 | 0.5 天 |
| P3 | SyncQueue 扩展 + RemoteClient 方法 + 客户端 Worker 路由 | 0.5 天 |
| P4 | 服务端表 + 同步接收 + 聚合查询 + 列表接口 | 0.5 天 |
| P5 | Web 页面 Tab + Markdown 极简渲染 | 0.5 天 |
| P6 | Desktop QuickPanel Tab + 立即生成按钮 + 状态指示 | 0.5 天 |
| P7 | 端到端联调（无远端 / 单设备 / 多设备 / 失败回退）+ 文档补全 | 1 天 |

合计约 4.5 个工作日。

---

## 十一、待确认 / 风险

1. **Markdown 渲染**：服务端 Web 与 Desktop QuickPanel 是否各自手写极简渲染，还是统一用 marked.js？倾向手写以避免依赖膨胀。
2. **跨设备 overall 段**：MVP 直接平铺各设备 overall，未做"二次聚合摘要"。如果用户反馈太啰嗦，Phase 2 可考虑：① 服务端引入轻量 LLM 调用做合并；② 客户端在最后一次同步时附带"我是当日数据最多的设备"标记，作为聚合时的主叙事。
3. **同设备同日多次生成**：当前直接覆盖。如果用户希望保留中间版本（如 18:00 一份 + 22:00 一份），需把 UNIQUE 约束放宽并增加 `version` 字段，前端展示加版本切换。
4. **多用户/多账号**：目前数据库无 user 维度，与现有同步设计一致。未来引入多用户时，`daily_briefs` 表需补 `user_id`。
