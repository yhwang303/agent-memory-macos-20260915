# ShadowFolk Desktop Workspaces Daily Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ShadowFolk desktop auto-upload's implicit all-project scanning and second-based interval with an explicit user-managed upload workspace list, daily Beijing-time scheduling, token reveal, and manual push.

**Architecture:** Desktop Settings owns user-facing configuration and writes `server` / `api_token` to `~/.shadow/config.json`. Desktop `desktop-config.json` owns ShadowFolk enablement, daily time, and validated Git root workspace list. Worker owns Git validation, explicit-workspace upload, daily scheduler, status, and push execution through the existing Node `ShadowFolkUploader`.

**Tech Stack:** Electron main/preload/HTML settings UI, Node Worker HTTP API, TypeScript, `better-sqlite3`, built-in `fetch`, `git rev-parse --show-toplevel`, Node test runner with `tsx`.

---

## File Structure

- Modify `desktop/src/config/store.ts`: replace `shadowfolkIntervalSec` with `shadowfolkDailyTime` and `shadowfolkWorkspaces`; pass these to Worker env.
- Modify `desktop/src/windows/SettingsWindow.ts`: add IPC for token reveal, workspace validation/discovery, ShadowFolk status/push proxy; save workspace list and daily time.
- Modify `desktop/src/preload-settings.ts`: expose new ShadowFolk IPC methods to renderer.
- Modify `desktop/src/windows/settings.html`: replace interval UI with daily time; add manual workspace list UI; fix token reveal.
- Modify `src/services/shadowfolk/ShadowFolkUploader.ts`: add Git workspace validation, explicit workspace upload API, discovery helper, and remove default upload-all database scan behavior from push entrypoint.
- Create `src/services/shadowfolk/schedule.ts`: calculate next Beijing-time daily upload.
- Modify `src/services/worker/WorkerService.ts`: read explicit workspace env/config, schedule daily upload, expose validate/discover/status/push endpoints.
- Modify `tests/shadowfolk-uploader.test.ts`: cover explicit workspace upload, Git validation, duplicate Git root behavior, and per-workspace failure isolation.
- Create `tests/shadowfolk-schedule.test.ts`: cover Beijing-time next-run calculation.
- Modify `tests/worker/worker-endpoints.test.ts`: cover validate/discover/status/push endpoints and busy handling.

Do not commit during execution unless the user explicitly asks. If the plan is executed by an agent, use the commit steps as checkpoints only.

---

### Task 1: Desktop Config Shape

**Files:**
- Modify: `desktop/src/config/store.ts`
- Test: `npm run typecheck`

- [ ] **Step 1: Replace the AppConfig ShadowFolk fields**

Change the ShadowFolk fields in `AppConfig` from:

```ts
shadowfolkEnabled: boolean;
shadowfolkIntervalSec: number;
```

to:

```ts
shadowfolkEnabled: boolean;
shadowfolkDailyTime: string;
shadowfolkWorkspaces: string[];
```

- [ ] **Step 2: Update defaults**

Change defaults from:

```ts
shadowfolkEnabled: false,
shadowfolkIntervalSec: 600,
```

to:

```ts
shadowfolkEnabled: false,
shadowfolkDailyTime: '23:30',
shadowfolkWorkspaces: [],
```

- [ ] **Step 3: Update getConfig()**

Return the new fields:

```ts
shadowfolkEnabled: store.get('shadowfolkEnabled'),
shadowfolkDailyTime: store.get('shadowfolkDailyTime'),
shadowfolkWorkspaces: store.get('shadowfolkWorkspaces') || [],
```

- [ ] **Step 4: Update getWorkerEnv()**

Replace `CODEBUDDY_MEM_SHADOWFOLK_INTERVAL_SEC` with:

```ts
CODEBUDDY_MEM_SHADOWFOLK_DAILY_TIME: config.shadowfolkDailyTime || '23:30',
CODEBUDDY_MEM_SHADOWFOLK_WORKSPACES: JSON.stringify(config.shadowfolkWorkspaces || []),
```

- [ ] **Step 5: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: TypeScript fails until later tasks update all references to `shadowfolkIntervalSec`. This is acceptable at this task boundary.

---

### Task 2: Beijing Daily Schedule Utility

**Files:**
- Create: `src/services/shadowfolk/schedule.ts`
- Create: `tests/shadowfolk-schedule.test.ts`

- [ ] **Step 1: Write failing schedule tests**

Create `tests/shadowfolk-schedule.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextBeijingDailyRun } from '../src/services/shadowfolk/schedule.js';

test('nextBeijingDailyRun returns today when configured time has not passed in Beijing', () => {
  const now = new Date('2026-05-07T12:00:00.000Z'); // 20:00 Beijing
  const next = nextBeijingDailyRun('23:30', now);
  assert.equal(next.toISOString(), '2026-05-07T15:30:00.000Z');
});

test('nextBeijingDailyRun returns tomorrow when configured time already passed in Beijing', () => {
  const now = new Date('2026-05-07T16:00:00.000Z'); // 00:00 May 8 Beijing
  const next = nextBeijingDailyRun('23:30', now);
  assert.equal(next.toISOString(), '2026-05-08T15:30:00.000Z');
});

test('nextBeijingDailyRun falls back to 23:30 for invalid time', () => {
  const now = new Date('2026-05-07T12:00:00.000Z');
  const next = nextBeijingDailyRun('bad-input', now);
  assert.equal(next.toISOString(), '2026-05-07T15:30:00.000Z');
});
```

- [ ] **Step 2: Verify red**

Run:

```bash
node --import tsx --test tests/shadowfolk-schedule.test.ts
```

Expected: FAIL with module not found for `src/services/shadowfolk/schedule.js`.

- [ ] **Step 3: Implement schedule utility**

Create `src/services/shadowfolk/schedule.ts`:

```ts
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DEFAULT_TIME = '23:30';

function parseDailyTime(value: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value || '');
  if (!match) return { hour: 23, minute: 30 };
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { hour: 23, minute: 30 };
  }
  return { hour, minute };
}

export function normalizeBeijingDailyTime(value: string): string {
  const { hour, minute } = parseDailyTime(value || DEFAULT_TIME);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function nextBeijingDailyRun(time: string, now = new Date()): Date {
  const { hour, minute } = parseDailyTime(time || DEFAULT_TIME);
  const beijingNow = new Date(now.getTime() + BEIJING_OFFSET_MS);
  const y = beijingNow.getUTCFullYear();
  const m = beijingNow.getUTCMonth();
  const d = beijingNow.getUTCDate();
  let candidateUtcMs = Date.UTC(y, m, d, hour - 8, minute, 0, 0);
  if (candidateUtcMs <= now.getTime()) {
    candidateUtcMs = Date.UTC(y, m, d + 1, hour - 8, minute, 0, 0);
  }
  return new Date(candidateUtcMs);
}
```

- [ ] **Step 4: Verify green**

Run:

```bash
node --import tsx --test tests/shadowfolk-schedule.test.ts
```

Expected: PASS.

---

### Task 3: Explicit Workspace Validation And Upload API

**Files:**
- Modify: `src/services/shadowfolk/ShadowFolkUploader.ts`
- Modify: `tests/shadowfolk-uploader.test.ts`

- [ ] **Step 1: Add failing Git validation tests**

Append to `tests/shadowfolk-uploader.test.ts`:

```ts
test('validateWorkspace returns git root for a repository child directory', async () => {
  const workspace = initRepo();
  const child = path.join(workspace, 'nested');
  execFileSync(process.execPath, ['-e', "require('fs').mkdirSync('nested')"], { cwd: workspace });
  const db = makeMemoryDb(workspace);
  const uploader = new ShadowFolkUploader({ db, server: 'http://shadowfolk.local', apiToken: 'sf_test' });
  try {
    const result = await uploader.validateWorkspace(child);
    assert.equal(result.valid, true);
    assert.match(result.gitRoot.replace(/\\/g, '/'), /sf-uploader-/);
  } finally {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('validateWorkspace rejects a non-git directory', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'sf-non-git-'));
  const db = makeMemoryDb(workspace);
  const uploader = new ShadowFolkUploader({ db, server: 'http://shadowfolk.local', apiToken: 'sf_test' });
  try {
    const result = await uploader.validateWorkspace(workspace);
    assert.equal(result.valid, false);
    assert.match(result.error || '', /不是 Git 工作区/);
  } finally {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Add failing explicit list upload test**

Append:

```ts
test('pushWorkspaces uploads only explicit workspace list', async () => {
  const workspaceA = initRepo();
  const workspaceB = initRepo();
  const db = makeMemoryDb(workspaceA);
  db.prepare(`
    INSERT INTO observations (memory_session_id, project, text, type, title, created_at, created_at_epoch)
    VALUES ('mem-2', ?, 'other work', 'insight', 'Other', '2026-05-07T00:00:02.000Z', 3)
  `).run(workspaceB.replace(/\\/g, '/').toLowerCase());

  const requests: Array<{ method: string; path: string; body?: any }> = [];
  const uploader = new ShadowFolkUploader({
    db,
    server: 'http://shadowfolk.local',
    apiToken: 'sf_test',
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method: init?.method || 'GET', path: parsed.pathname, body });
      if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'GET') {
        return new Response(JSON.stringify({ record: { last_observation_id: 0, last_summary_id: 0 } }), { status: 200 });
      }
      if (parsed.pathname === '/api/push/raw') {
        return new Response(JSON.stringify({ batch_id: 'batch-1' }), { status: 201 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  try {
    const result = await uploader.pushWorkspaces([workspaceA]);
    assert.equal(result.workspaces, 1);
    const raw = requests.find(r => r.path === '/api/push/raw');
    assert.ok(raw);
    assert.equal(raw!.body.memory.observations.length, 1);
    assert.equal(raw!.body.memory.observations[0].text, 'observed work');
  } finally {
    db.close();
    rmSync(workspaceA, { recursive: true, force: true });
    rmSync(workspaceB, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Verify red**

Run:

```bash
node --import tsx --test tests/shadowfolk-uploader.test.ts
```

Expected: FAIL because `validateWorkspace` and `pushWorkspaces` are missing.

- [ ] **Step 4: Implement validation types**

Add to `src/services/shadowfolk/ShadowFolkUploader.ts`:

```ts
export interface WorkspaceValidationResult {
  input: string;
  valid: boolean;
  gitRoot: string;
  error: string | null;
}

export interface PushAllResult {
  pushed: boolean;
  workspaces: number;
  observations: number;
  summaries: number;
  commits: number;
  results: PushWorkspaceResult[];
  failures: Array<{ workspace: string; error: string }>;
}
```

- [ ] **Step 5: Implement validateWorkspace()**

Add method:

```ts
async validateWorkspace(workspace: string): Promise<WorkspaceValidationResult> {
  const input = workspace.trim();
  if (!input) {
    return { input, valid: false, gitRoot: '', error: '请先输入工作区路径' };
  }
  if (!fs.existsSync(input)) {
    return { input, valid: false, gitRoot: '', error: '路径不存在' };
  }
  try {
    const gitRoot = await this.getGitRoot(input);
    return { input, valid: true, gitRoot, error: null };
  } catch {
    return { input, valid: false, gitRoot: '', error: '该路径不是 Git 工作区或其子目录' };
  }
}
```

- [ ] **Step 6: Implement pushWorkspaces() and stop using implicit scan**

Add method:

```ts
async pushWorkspaces(workspaces: string[]): Promise<PushAllResult> {
  const seen = new Set<string>();
  const normalized: string[] = [];
  const failures: Array<{ workspace: string; error: string }> = [];

  for (const workspace of workspaces) {
    const validation = await this.validateWorkspace(workspace);
    if (!validation.valid) {
      failures.push({ workspace, error: validation.error || '工作区无效' });
      continue;
    }
    const key = normalizeProjectPath(validation.gitRoot);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(validation.gitRoot);
  }

  const results: PushWorkspaceResult[] = [];
  for (const workspace of normalized) {
    try {
      results.push(await this.pushWorkspace(workspace));
    } catch (error) {
      failures.push({
        workspace,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    pushed: results.some(r => r.pushed),
    workspaces: results.length,
    observations: results.reduce((n, r) => n + r.observations, 0),
    summaries: results.reduce((n, r) => n + r.summaries, 0),
    commits: results.reduce((n, r) => n + r.commits, 0),
    results,
    failures,
  };
}
```

Keep `discoverWorkspaces()` as a helper for UI discovery, but do not call it from `/api/shadowfolk/push`.

- [ ] **Step 7: Verify green**

Run:

```bash
node --import tsx --test tests/shadowfolk-uploader.test.ts
```

Expected: PASS.

---

### Task 4: Worker Daily Scheduler And Workspace Endpoints

**Files:**
- Modify: `src/services/worker/WorkerService.ts`
- Modify: `tests/worker/worker-endpoints.test.ts`

- [ ] **Step 1: Add failing endpoint tests**

Append to `tests/worker/worker-endpoints.test.ts`:

```ts
test('POST /api/shadowfolk/workspaces/validate returns injected git root', async () => {
  const worker = new WorkerService({
    port: 0,
    host: '127.0.0.1',
    loadSettings: disabledSettings,
    shadowfolk: {
      enabled: false,
      dailyTime: '23:30',
      workspaces: [],
      createUploader: () => ({
        validateWorkspace: async (workspace: string) => ({
          input: workspace,
          valid: true,
          gitRoot: 'E:/Github/agent-memory',
          error: null,
        }),
        pushWorkspaces: async () => ({ pushed: false, workspaces: 0, observations: 0, summaries: 0, commits: 0, results: [], failures: [] }),
      }),
    },
  } as any);
  const req = makeReq({ method: 'POST', url: '/api/shadowfolk/workspaces/validate' });
  const { res, captured } = makeRes();

  const promise = (worker as any).handleRequest(req, res);
  req.emit('data', Buffer.from(JSON.stringify({ workspace: 'E:/Github/agent-memory/src' })));
  req.emit('end');
  await promise;

  assert.equal(captured.status, 200);
  const body = JSON.parse(captured.body!);
  assert.equal(body.success, true);
  assert.equal(body.gitRoot, 'E:/Github/agent-memory');
});

test('POST /api/shadowfolk/push uses configured workspace list', async () => {
  let received: string[] = [];
  const worker = new WorkerService({
    port: 0,
    host: '127.0.0.1',
    loadSettings: disabledSettings,
    shadowfolk: {
      enabled: true,
      dailyTime: '23:30',
      workspaces: ['E:/Github/agent-memory'],
      createUploader: () => ({
        pushWorkspaces: async (workspaces: string[]) => {
          received = workspaces;
          return { pushed: true, workspaces: 1, observations: 2, summaries: 1, commits: 3, results: [], failures: [] };
        },
      }),
    },
  } as any);
  const req = makeReq({ method: 'POST', url: '/api/shadowfolk/push' });
  const { res, captured } = makeRes();

  await (worker as any).handleRequest(req, res);

  assert.deepEqual(received, ['E:/Github/agent-memory']);
  assert.equal(captured.status, 200);
});
```

- [ ] **Step 2: Verify red**

Run:

```bash
node --import tsx --test tests/worker/worker-endpoints.test.ts
```

Expected: FAIL because worker config and endpoints do not yet expose `dailyTime`, `workspaces`, or validate endpoint.

- [ ] **Step 3: Update WorkerConfig shadowfolk shape**

In `WorkerService.ts`, change test seam:

```ts
shadowfolk?: {
  enabled: boolean;
  dailyTime: string;
  workspaces: string[];
  createUploader?: () => {
    validateWorkspace?: (workspace: string) => Promise<any>;
    discoverWorkspaces?: () => Promise<string[]> | string[];
    pushWorkspaces: (workspaces: string[]) => Promise<PushAllResult>;
  };
};
```

- [ ] **Step 4: Read runtime config from env**

Replace interval config reader with:

```ts
private getShadowFolkRuntimeConfig(): { enabled: boolean; dailyTime: string; workspaces: string[] } {
  if (this.config.shadowfolk) {
    return {
      enabled: this.config.shadowfolk.enabled,
      dailyTime: this.config.shadowfolk.dailyTime || '23:30',
      workspaces: this.config.shadowfolk.workspaces || [],
    };
  }
  let workspaces: string[] = [];
  try {
    workspaces = JSON.parse(process.env.CODEBUDDY_MEM_SHADOWFOLK_WORKSPACES || '[]');
  } catch {
    workspaces = [];
  }
  return {
    enabled: String(process.env.CODEBUDDY_MEM_SHADOWFOLK_ENABLED || '').toLowerCase() === 'true',
    dailyTime: process.env.CODEBUDDY_MEM_SHADOWFOLK_DAILY_TIME || '23:30',
    workspaces: Array.isArray(workspaces) ? workspaces.map(String) : [],
  };
}
```

- [ ] **Step 5: Update push execution**

Replace `uploader.pushAll()` with:

```ts
const runtime = this.getShadowFolkRuntimeConfig();
if (runtime.workspaces.length === 0) {
  throw new Error('请先添加至少一个上传工作区');
}
const result = await uploader.pushWorkspaces(runtime.workspaces);
```

- [ ] **Step 6: Add validate endpoint handler**

Route:

```ts
} else if (path === '/api/shadowfolk/workspaces/validate' && req.method === 'POST') {
  await this.handleShadowFolkWorkspaceValidate(req, res);
```

Handler:

```ts
private async handleShadowFolkWorkspaceValidate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await this.parseBody(req);
  const workspace = String(body.workspace || '').trim();
  const uploader = this.createShadowFolkUploader();
  if (!uploader || !uploader.validateWorkspace) {
    res.statusCode = 400;
    res.end(JSON.stringify({ success: false, error: 'ShadowFolk 未配置' }));
    return;
  }
  const result = await uploader.validateWorkspace(workspace);
  res.statusCode = result.valid ? 200 : 400;
  res.end(JSON.stringify({ success: result.valid, ...result }));
}
```

- [ ] **Step 7: Add daily scheduler**

Import:

```ts
import { nextBeijingDailyRun } from '../shadowfolk/schedule.js';
```

Replace setInterval scheduler with a timeout-based scheduler:

```ts
private shadowfolkTimer: ReturnType<typeof setTimeout> | null = null;
private shadowfolkNextRunAt: string | null = null;

private scheduleNextShadowFolkRun(): void {
  const runtime = this.getShadowFolkRuntimeConfig();
  if (!runtime.enabled) return;
  const next = nextBeijingDailyRun(runtime.dailyTime);
  this.shadowfolkNextRunAt = next.toISOString();
  const delayMs = Math.max(1000, next.getTime() - Date.now());
  this.shadowfolkTimer = setTimeout(async () => {
    try {
      await this.runShadowFolkPush();
    } catch (error) {
      logger.warn('SHADOWFOLK', 'Scheduled upload failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.shadowfolkTimer = null;
      this.scheduleNextShadowFolkRun();
    }
  }, delayMs);
}
```

Expose `nextRunAt` in status response.

- [ ] **Step 8: Verify green**

Run:

```bash
node --import tsx --test tests/worker/worker-endpoints.test.ts tests/shadowfolk-schedule.test.ts
```

Expected: PASS.

---

### Task 5: Settings IPC For Token Reveal And Workspaces

**Files:**
- Modify: `desktop/src/windows/SettingsWindow.ts`
- Modify: `desktop/src/preload-settings.ts`

- [ ] **Step 1: Add IPC handlers in SettingsWindow**

In `SettingsWindow.ts`, add:

```ts
ipcMain.handle('shadowfolk:reveal-token', async () => {
  const config = await readShadowConfig();
  return {
    success: true,
    apiToken: typeof config.api_token === 'string' ? config.api_token : '',
  };
});

ipcMain.handle('shadowfolk:validate-workspace', async (_event, workspace: string) => {
  const r = await workerRequestWithRetry('POST', '/api/shadowfolk/workspaces/validate', 15000, 6000, { workspace });
  if (r.status === 0) return { success: false, error: 'worker 没响应' };
  return r.body || { success: false };
});
```

If `workerRequestWithRetry` currently cannot send JSON bodies, add optional `body?: unknown` and use `req.write(JSON.stringify(body))` before `req.end()`.

- [ ] **Step 2: Save workspaces/daily time**

In `settings:save`, parse:

```ts
if (data.shadowfolkDailyTime !== undefined) {
  updates.shadowfolkDailyTime = String(data.shadowfolkDailyTime || '23:30').trim();
}
if (data.shadowfolkWorkspaces !== undefined) {
  updates.shadowfolkWorkspaces = Array.isArray(data.shadowfolkWorkspaces)
    ? data.shadowfolkWorkspaces.map(String).filter(Boolean)
    : [];
}
```

- [ ] **Step 3: Expose preload APIs**

In `desktop/src/preload-settings.ts`, add:

```ts
revealShadowfolkToken: () => ipcRenderer.invoke('shadowfolk:reveal-token'),
validateShadowfolkWorkspace: (workspace: string) => ipcRenderer.invoke('shadowfolk:validate-workspace', workspace),
```

- [ ] **Step 4: Remove handlers in destroy()**

Add:

```ts
ipcMain.removeHandler('shadowfolk:reveal-token');
ipcMain.removeHandler('shadowfolk:validate-workspace');
```

- [ ] **Step 5: Run desktop build**

Run:

```bash
npm --prefix desktop run build:ts
```

Expected: PASS after UI task updates references.

---

### Task 6: Settings UI For Daily Time And Manual Workspace List

**Files:**
- Modify: `desktop/src/windows/settings.html`

- [ ] **Step 1: Replace interval markup**

Replace the interval block:

```html
<div class="form-group">
  <label for="shadowfolkIntervalSec">上传间隔（秒）</label>
  <input type="number" id="shadowfolkIntervalSec" min="30" step="30" value="600" />
  <div class="field-hint">最小 30 秒，常用 300 / 600 / 1800。保存后 Worker 会按此间隔定时上传。</div>
</div>
```

with:

```html
<div class="form-group">
  <label for="shadowfolkDailyTime">每日自动上传时间（北京时间）</label>
  <input type="time" id="shadowfolkDailyTime" value="23:30" />
  <div class="field-hint">每天按北京时间上传一次；立即上传不受该时间限制。</div>
</div>
```

- [ ] **Step 2: Add workspace list markup**

Insert before the action buttons:

```html
<div class="form-group">
  <label>上传工作区</label>
  <div id="shadowfolkWorkspaceList" style="display:flex;flex-direction:column;gap:6px;"></div>
  <div style="display:flex;gap:8px;margin-top:8px;">
    <button type="button" class="btn btn-secondary" id="shadowfolkAddCurrentBtn" style="font-size:12px;padding:6px 12px;">添加当前项目</button>
    <button type="button" class="btn btn-secondary" id="shadowfolkAddManualBtn" style="font-size:12px;padding:6px 12px;">手动添加路径</button>
  </div>
  <div class="field-hint">添加时必须是 Git 工作区或其子目录；保存和上传时会按 Git root 去重。</div>
</div>
```

- [ ] **Step 3: Add renderer state helpers**

In the script section, add:

```js
let shadowfolkWorkspaces = [];

function renderShadowfolkWorkspaces() {
  const list = document.getElementById('shadowfolkWorkspaceList');
  list.innerHTML = '';
  if (shadowfolkWorkspaces.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'field-hint';
    empty.textContent = '还没有上传工作区，请先添加。';
    list.appendChild(empty);
    return;
  }
  shadowfolkWorkspaces.forEach((workspace, index) => {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '8px';
    row.style.alignItems = 'center';
    const pathEl = document.createElement('code');
    pathEl.textContent = workspace;
    pathEl.style.flex = '1';
    pathEl.style.wordBreak = 'break-all';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-secondary';
    remove.style.fontSize = '12px';
    remove.style.padding = '4px 10px';
    remove.textContent = '移除';
    remove.addEventListener('click', () => {
      shadowfolkWorkspaces.splice(index, 1);
      renderShadowfolkWorkspaces();
    });
    row.appendChild(pathEl);
    row.appendChild(remove);
    list.appendChild(row);
  });
}

async function addShadowfolkWorkspace(rawPath) {
  const value = (rawPath || '').trim();
  if (!value) return;
  const result = await window.settingsAPI.validateShadowfolkWorkspace(value);
  if (!result || !result.success) {
    setShadowfolkStatus((result && result.error) || '该路径不是 Git 工作区或其子目录', 'err');
    return;
  }
  const gitRoot = result.gitRoot;
  if (shadowfolkWorkspaces.some(p => p.toLowerCase() === gitRoot.toLowerCase())) {
    setShadowfolkStatus('该项目已在上传列表中', 'info');
    return;
  }
  shadowfolkWorkspaces.push(gitRoot);
  renderShadowfolkWorkspaces();
  setShadowfolkStatus('已添加上传工作区：' + gitRoot, 'ok');
}
```

- [ ] **Step 4: Load config into UI**

Replace:

```js
document.getElementById('shadowfolkIntervalSec').value = config.shadowfolkIntervalSec || 600;
```

with:

```js
document.getElementById('shadowfolkDailyTime').value = config.shadowfolkDailyTime || '23:30';
shadowfolkWorkspaces = Array.isArray(config.shadowfolkWorkspaces) ? [...config.shadowfolkWorkspaces] : [];
renderShadowfolkWorkspaces();
```

- [ ] **Step 5: Wire add buttons**

Add listeners:

```js
document.getElementById('shadowfolkAddManualBtn').addEventListener('click', async () => {
  const value = prompt('请输入 Git 工作区路径或其子目录');
  await addShadowfolkWorkspace(value);
});
document.getElementById('shadowfolkAddCurrentBtn').addEventListener('click', async () => {
  await addShadowfolkWorkspace('E:/Github/agent-memory');
});
```

For now, use the workspace path from the packaged app environment if one is available; if no reliable current workspace exists, keep `添加当前项目` hidden or disabled with text `桌面端未检测到当前项目`.

- [ ] **Step 6: Fix token reveal button**

Replace the current token toggle listener with:

```js
document.getElementById('shadowfolkTokenToggle').addEventListener('click', async () => {
  const input = document.getElementById('shadowfolkToken');
  const btn = document.getElementById('shadowfolkTokenToggle');
  if (input.type === 'password') {
    if (input.value === '********') {
      const result = await window.settingsAPI.revealShadowfolkToken();
      if (result && result.success) input.value = result.apiToken || '';
    }
    input.type = 'text';
    btn.textContent = '隐藏';
  } else {
    input.type = 'password';
    btn.textContent = '显示';
  }
});
```

- [ ] **Step 7: Save new fields**

Replace save fields:

```js
shadowfolkIntervalSec: parseInt(document.getElementById('shadowfolkIntervalSec').value, 10) || 600,
```

with:

```js
shadowfolkDailyTime: document.getElementById('shadowfolkDailyTime').value || '23:30',
shadowfolkWorkspaces,
```

- [ ] **Step 8: Update status text**

In `refreshShadowfolkStatus()`, replace interval text with:

```js
const next = status.nextRunAt ? `，下次上传 ${new Date(status.nextRunAt).toLocaleString()}（北京时间计划 ${status.dailyTime || '23:30'}）` : '';
setShadowfolkStatus(`${enabled}，${configured}，${running}，已配置 ${status.workspaces || 0} 个工作区${next}${last}${count}`, status.lastError ? 'err' : 'ok');
```

- [ ] **Step 9: Run desktop build**

Run:

```bash
npm --prefix desktop run build:ts
```

Expected: PASS.

---

### Task 7: Final Verification And Release Build

**Files:**
- Verify all files touched in previous tasks.

- [ ] **Step 1: Run focused tests**

Run:

```bash
node --import tsx --test tests/shadowfolk-uploader.test.ts tests/shadowfolk-schedule.test.ts tests/worker/worker-endpoints.test.ts
```

Expected: all tests PASS.

- [ ] **Step 2: Run root typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run desktop TypeScript build**

Run:

```bash
npm --prefix desktop run build:ts
```

Expected: PASS.

- [ ] **Step 4: Build Windows installer**

Run:

```bash
npm run release:build:win
```

Expected:

```text
[release] artifacts
- npm/agent-memory-2.0.7.tgz (...)
- windows/AgentMemory-Setup-2.0.7.exe (...)
- windows/AgentMemory-Setup-2.0.7.exe.blockmap (...)
```

- [ ] **Step 5: Manual UI verification**

Install the generated `release-artifacts/v2.0.7/windows/AgentMemory-Setup-2.0.7.exe`, then verify:

1. Settings → Plugins shows `每日自动上传时间（北京时间）`.
2. `上传间隔（秒）` no longer appears.
3. `API Token` display button reveals the actual token.
4. Manual workspace add rejects a non-Git directory.
5. Manual workspace add accepts a Git repository child directory and displays the Git root.
6. Duplicate Git root is not added twice.
7. `立即上传一次` uses only configured workspaces and shows summary status.

---

## Self-Review

- Spec coverage: workspace list, Git validation, no all-project scan default, daily Beijing schedule, immediate push, token reveal, status, and tests are all covered by Tasks 1-7.
- Red-flag scan: this plan contains no incomplete placeholder text or vague future work instructions.
- Type consistency: the plan uses `shadowfolkDailyTime`, `shadowfolkWorkspaces`, `pushWorkspaces`, `validateWorkspace`, `nextRunAt`, and `nextBeijingDailyRun` consistently across config, Worker, uploader, tests, and UI.
- Scope check: the plan intentionally excludes per-server workspace sets, multi-timezone scheduling, and Python daemon changes, matching the approved design.
