# ShadowFolk Workspace Memory Alias Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a real ShadowFolk Git upload workspace include memories recorded under old project paths after a local project directory migration.

**Architecture:** Keep the upload identity anchored on the current Git root, and add a separate `memoryRoots` alias list for memory filtering. Desktop config stores aliases next to the existing workspace list, Worker normalizes and passes them through, and `ShadowFolkUploader` uses the expanded roots for observations/summaries while keeping Git payload and push-record keyed by the current Git root.

**Tech Stack:** TypeScript, Electron main/preload/renderer HTML, Node `node:test`, `better-sqlite3`, existing ShadowFolk Worker HTTP endpoints.

---

## File Structure

- Modify `desktop/src/config/store.ts`
  - Add persisted `shadowfolkWorkspaceAliases`.
  - Pass aliases into Worker env as JSON.

- Modify `desktop/src/windows/SettingsWindow.ts`
  - Load/save aliases through settings IPC.
  - Pass aliases through `/api/shadowfolk/config`.
  - Add alias suggestion IPC if implemented in Worker.

- Modify `desktop/src/preload-settings.ts`
  - Expose `suggestShadowfolkWorkspaceAliases` if the optional suggestion endpoint is implemented.

- Modify `desktop/src/windows/settings.html`
  - Track aliases in renderer state.
  - Render old memory roots per workspace.
  - Add “bind selected memory project as alias” and manual alias input.
  - Prevent non-Git memory projects from being added as upload workspaces while offering alias binding.

- Modify `src/services/shadowfolk/PushHistoryStore.ts`
  - Add optional `memoryRoots` to history entries.

- Modify `src/services/shadowfolk/ShadowFolkUploader.ts`
  - Add `ShadowFolkWorkspaceConfig`.
  - Normalize workspace inputs.
  - Use `memoryRoots` for memory export in normal push, full repush, and history replay.
  - Keep Git identity and push-record based on `gitRoot`.

- Modify `src/services/worker/WorkerService.ts`
  - Accept aliases in runtime config.
  - Pass aliases to uploader methods.
  - Return alias metadata in status.
  - Optionally provide alias suggestions from recorded memory project paths.

- Modify tests:
  - `tests/shadowfolk-uploader.test.ts`
  - `tests/worker/worker-endpoints.test.ts`
  - `tests/settings-renderer-contract.test.ts`

---

### Task 1: Desktop Config Shape

**Files:**
- Modify: `desktop/src/config/store.ts`
- Test: no direct unit test exists; verified through Task 3 Worker tests and Task 5 renderer contract tests.

- [ ] **Step 1: Add alias types to config**

In `desktop/src/config/store.ts`, add:

```ts
export interface ShadowFolkWorkspaceAlias {
  workspace: string;
  memoryRoots: string[];
}
```

Update `AppConfig`:

```ts
  shadowfolkEnabled: boolean;
  shadowfolkDailyTime: string;
  shadowfolkWorkspaces: string[];
  shadowfolkWorkspaceAliases: ShadowFolkWorkspaceAlias[];
```

- [ ] **Step 2: Add default value**

Update `defaults`:

```ts
  shadowfolkEnabled: false,
  shadowfolkDailyTime: '23:30',
  shadowfolkWorkspaces: [],
  shadowfolkWorkspaceAliases: [],
```

- [ ] **Step 3: Normalize config reads**

Add helper:

```ts
function normalizeShadowFolkWorkspaceAliases(value: unknown): ShadowFolkWorkspaceAlias[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      const workspace = typeof record.workspace === 'string' ? record.workspace.trim() : '';
      const memoryRoots = Array.isArray(record.memoryRoots)
        ? Array.from(new Set(record.memoryRoots
          .filter((root): root is string => typeof root === 'string')
          .map(root => root.trim())
          .filter(Boolean)))
        : [];
      if (!workspace || memoryRoots.length === 0) return null;
      return { workspace, memoryRoots };
    })
    .filter((entry): entry is ShadowFolkWorkspaceAlias => !!entry);
}
```

Update `getConfig()`:

```ts
    shadowfolkWorkspaces: store.get('shadowfolkWorkspaces') || [],
    shadowfolkWorkspaceAliases: normalizeShadowFolkWorkspaceAliases(store.get('shadowfolkWorkspaceAliases')),
```

- [ ] **Step 4: Pass aliases to Worker env**

Update `getWorkerEnv()`:

```ts
    CODEBUDDY_MEM_SHADOWFOLK_WORKSPACES: JSON.stringify(config.shadowfolkWorkspaces || []),
    CODEBUDDY_MEM_SHADOWFOLK_WORKSPACE_ALIASES: JSON.stringify(config.shadowfolkWorkspaceAliases || []),
```

- [ ] **Step 5: Run a type check or targeted test**

Run:

```bash
npx tsc --noEmit
```

Expected: no new type errors from `desktop/src/config/store.ts`.

---

### Task 2: Uploader Alias-Aware Memory Export

**Files:**
- Modify: `src/services/shadowfolk/ShadowFolkUploader.ts`
- Modify: `src/services/shadowfolk/PushHistoryStore.ts`
- Test: `tests/shadowfolk-uploader.test.ts`

- [ ] **Step 1: Write failing uploader test for normal push aliases**

Append to `tests/shadowfolk-uploader.test.ts`:

```ts
test('pushWorkspaces exports memories from configured old memory roots while keeping new git root identity', async () => {
  const workspace = initRepo();
  const oldMemoryRoot = path.join(path.dirname(workspace), 'old-repo-path');
  const requests: Array<{ method: string; path: string; body?: any }> = [];
  const db = makeMemoryDb(workspace, oldMemoryRoot);

  const uploader = new ShadowFolkUploader({
    db,
    server: 'http://shadowfolk.local',
    apiToken: 'sf_test',
    historyStore: noopHistoryStore,
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
      if (parsed.pathname.startsWith('/api/push/push-records/') && init?.method === 'PUT') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 });
    },
  });

  try {
    const result = await uploader.pushWorkspaces([{ workspace, memoryRoots: [oldMemoryRoot] }]);

    assert.equal(result.pushed, true);
    assert.equal(result.observations, 2);
    assert.equal(result.summaries, 2);

    const raw = requests.find(r => r.path === '/api/push/raw');
    assert.ok(raw, 'expected raw push request');
    assert.equal(raw!.body.git.root.replace(/\\/g, '/').toLowerCase(), workspace.replace(/\\/g, '/').toLowerCase());
    assert.equal(raw!.body.memory.scope.replace(/\\/g, '/').toLowerCase(), workspace.replace(/\\/g, '/').toLowerCase());
    assert.deepEqual(
      raw!.body.memory.observations.map((row: any) => row.project).sort(),
      [workspace, oldMemoryRoot].map(p => p.replace(/\\/g, '/').toLowerCase()).sort(),
    );

    const putRecord = requests.find(r => r.method === 'PUT' && r.path.startsWith('/api/push/push-records/'));
    assert.ok(putRecord, 'expected push-record update');
    assert.equal(decodeURIComponent(putRecord!.path.replace('/api/push/push-records/', '')).replace(/\\/g, '/').toLowerCase(), workspace.replace(/\\/g, '/').toLowerCase());
  } finally {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test and confirm failure**

Run:

```bash
node --import tsx --test --test-name-pattern "old memory roots" tests/shadowfolk-uploader.test.ts
```

Expected: FAIL because `pushWorkspaces()` only accepts strings or ignores `memoryRoots`.

- [ ] **Step 3: Add workspace config types**

In `src/services/shadowfolk/ShadowFolkUploader.ts`, add near existing interfaces:

```ts
export interface ShadowFolkWorkspaceConfig {
  workspace: string;
  memoryRoots?: string[];
}

type ShadowFolkWorkspaceInput = string | ShadowFolkWorkspaceConfig;
```

Add helper:

```ts
function normalizeMemoryRoots(roots: unknown): string[] {
  if (!Array.isArray(roots)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const root of roots) {
    if (typeof root !== 'string') continue;
    const trimmed = root.trim();
    if (!trimmed) continue;
    const key = normalizeRootPrefix(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizeWorkspaceInput(input: ShadowFolkWorkspaceInput): ShadowFolkWorkspaceConfig {
  if (typeof input === 'string') {
    return { workspace: input.trim(), memoryRoots: [] };
  }
  return {
    workspace: String(input.workspace || '').trim(),
    memoryRoots: normalizeMemoryRoots(input.memoryRoots),
  };
}
```

- [ ] **Step 4: Update public method signatures**

Change:

```ts
async pushWorkspaces(workspaces: string[]): Promise<PushAllResult>
```

to:

```ts
async pushWorkspaces(workspaces: ShadowFolkWorkspaceInput[]): Promise<PushAllResult>
```

Change internal `normalized` shape:

```ts
const normalized: Array<{ input: string; gitRoot: string; memoryRoots: string[] }> = [];
```

Inside the loop:

```ts
const config = normalizeWorkspaceInput(workspace);
const validation = await this.validateWorkspace(config.workspace);
if (!validation.valid) {
  failures.push({ workspace: config.workspace, error: validation.error || '工作区无效' });
  continue;
}
const key = normalizeRootPrefix(validation.gitRoot);
if (seen.has(key)) continue;
seen.add(key);
normalized.push({ input: validation.input, gitRoot: validation.gitRoot, memoryRoots: config.memoryRoots });
```

Call `pushWorkspace`:

```ts
results.push(await this.pushWorkspace(workspace.gitRoot, [workspace.gitRoot, workspace.input, ...workspace.memoryRoots], workspace.memoryRoots));
```

- [ ] **Step 5: Persist memory roots in push history**

In `src/services/shadowfolk/PushHistoryStore.ts`, extend `PushHistoryEntry`:

```ts
  memoryRoots?: string[];
```

In `ShadowFolkUploader.pushWorkspace()`, change signature:

```ts
async pushWorkspace(workspace: string, projectRoots?: string[], memoryRoots: string[] = []): Promise<PushWorkspaceResult>
```

When appending history:

```ts
      memoryRoots,
```

- [ ] **Step 6: Ensure full repush and history replay can receive aliases**

Change signatures:

```ts
async repushWorkspaceFull(workspace: string | ShadowFolkWorkspaceConfig): Promise<PushWorkspaceResult>
async listPushHistory(workspace: string | ShadowFolkWorkspaceConfig): Promise<PushHistoryEntry[]>
async replayHistoryEntry(workspace: string | ShadowFolkWorkspaceConfig, historyId: string): Promise<PushWorkspaceResult>
```

At the start of each method:

```ts
const config = normalizeWorkspaceInput(workspace);
const gitRoot = await this.getGitRoot(config.workspace);
```

Use roots:

```ts
const roots = [gitRoot, config.workspace, ...config.memoryRoots];
```

When calling `pushWorkspaceRange()`, pass aliases through a new option:

```ts
memoryRoots: config.memoryRoots,
```

Extend `PushWorkspaceRangeOptions`:

```ts
  memoryRoots?: string[];
```

In `pushWorkspaceRange()`:

```ts
const roots = [gitRoot, workspace, ...normalizeMemoryRoots(options.memoryRoots)];
```

Add `memoryRoots: normalizeMemoryRoots(options.memoryRoots)` to replay/full history entries.

- [ ] **Step 7: Run uploader alias tests**

Run:

```bash
node --import tsx --test --test-name-pattern "old memory roots|pushWorkspaceRange|repushWorkspaceFull|records start" tests/shadowfolk-uploader.test.ts
```

Expected: selected tests PASS.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/services/shadowfolk/ShadowFolkUploader.ts src/services/shadowfolk/PushHistoryStore.ts tests/shadowfolk-uploader.test.ts
git commit -m "feat(shadowfolk): support workspace memory aliases in uploader"
```

---

### Task 3: Worker Runtime Config and API Pass-Through

**Files:**
- Modify: `src/services/worker/WorkerService.ts`
- Test: `tests/worker/worker-endpoints.test.ts`

- [ ] **Step 1: Write failing Worker push pass-through test**

Append to `tests/worker/worker-endpoints.test.ts`:

```ts
test('POST /api/shadowfolk/push passes workspace aliases to uploader', async () => {
  let receivedWorkspaces: any[] = [];
  const worker = new WorkerService({
    port: 0,
    host: '127.0.0.1',
    loadSettings: disabledSettings,
    shadowfolk: {
      enabled: true,
      dailyTime: '23:30',
      workspaces: ['D:/GitHub/foo'],
      workspaceAliases: [{ workspace: 'D:/GitHub/foo', memoryRoots: ['E:/GitHub/foo'] }],
      createUploader: () => ({
        pushWorkspaces: async (workspaces: any[]) => {
          receivedWorkspaces = workspaces;
          return { pushed: true, workspaces: 1, observations: 2, summaries: 2, commits: 1, results: [], failures: [] };
        },
      }),
    },
  } as any);
  const req = makeReq({ method: 'POST', url: '/api/shadowfolk/push' });
  const { res, captured } = makeRes();

  await (worker as any).handleRequest(req, res);

  assert.equal(captured.status, 200);
  assert.deepEqual(receivedWorkspaces, [{
    workspace: 'D:/GitHub/foo',
    memoryRoots: ['E:/GitHub/foo'],
  }]);
});
```

- [ ] **Step 2: Run Worker test and confirm failure**

Run:

```bash
node --import tsx --test --test-name-pattern "passes workspace aliases" tests/worker/worker-endpoints.test.ts
```

Expected: FAIL because Worker only passes `string[]`.

- [ ] **Step 3: Extend Worker ShadowFolk config shape**

In `src/services/worker/WorkerService.ts`, add type near ShadowFolk config definitions:

```ts
interface ShadowFolkWorkspaceAlias {
  workspace: string;
  memoryRoots: string[];
}

interface ShadowFolkWorkspaceConfig {
  workspace: string;
  memoryRoots: string[];
}
```

Update `shadowfolkOverride` type:

```ts
private shadowfolkOverride: { enabled: boolean; dailyTime: string; workspaces: string[]; workspaceAliases: ShadowFolkWorkspaceAlias[] } | null = null;
```

Update `ShadowFolkUploaderLike` so relevant methods accept `string | ShadowFolkWorkspaceConfig` where needed:

```ts
pushWorkspaces(workspaces: Array<string | ShadowFolkWorkspaceConfig>): Promise<PushAllResult>;
repushWorkspaceFull?(workspace: string | ShadowFolkWorkspaceConfig): Promise<PushWorkspaceResult>;
listPushHistory?(workspace: string | ShadowFolkWorkspaceConfig): Promise<PushHistoryEntry[]>;
replayHistoryEntry?(workspace: string | ShadowFolkWorkspaceConfig, historyId: string): Promise<PushWorkspaceResult>;
```

- [ ] **Step 4: Normalize aliases in Worker**

Add helpers:

```ts
private normalizeShadowFolkWorkspaceAliases(value: unknown): ShadowFolkWorkspaceAlias[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      const workspace = typeof record.workspace === 'string' ? record.workspace.trim() : '';
      const memoryRoots = Array.isArray(record.memoryRoots)
        ? Array.from(new Set(record.memoryRoots
          .filter((root): root is string => typeof root === 'string')
          .map(root => root.trim())
          .filter(Boolean)))
        : [];
      if (!workspace || memoryRoots.length === 0) return null;
      return { workspace, memoryRoots };
    })
    .filter((entry): entry is ShadowFolkWorkspaceAlias => !!entry);
}

private buildShadowFolkWorkspaceConfigs(workspaces: string[], aliases: ShadowFolkWorkspaceAlias[]): ShadowFolkWorkspaceConfig[] {
  return workspaces.map(workspace => {
    const matched = aliases.find(alias => alias.workspace.toLowerCase() === workspace.toLowerCase());
    return {
      workspace,
      memoryRoots: matched?.memoryRoots || [],
    };
  });
}
```

- [ ] **Step 5: Read aliases from config and env**

Update `getShadowFolkRuntimeConfig()` return type:

```ts
private getShadowFolkRuntimeConfig(): {
  enabled: boolean;
  dailyTime: string;
  workspaces: string[];
  workspaceAliases: ShadowFolkWorkspaceAlias[];
  workspaceConfigs: ShadowFolkWorkspaceConfig[];
}
```

When reading `this.config.shadowfolk`:

```ts
const workspaces = this.normalizeShadowFolkWorkspaces(this.config.shadowfolk.workspaces);
const workspaceAliases = this.normalizeShadowFolkWorkspaceAliases((this.config.shadowfolk as any).workspaceAliases);
return {
  enabled: this.config.shadowfolk.enabled,
  dailyTime: this.config.shadowfolk.dailyTime || '23:30',
  workspaces,
  workspaceAliases,
  workspaceConfigs: this.buildShadowFolkWorkspaceConfigs(workspaces, workspaceAliases),
};
```

When reading env:

```ts
let aliases: unknown = [];
try {
  aliases = JSON.parse(process.env.CODEBUDDY_MEM_SHADOWFOLK_WORKSPACE_ALIASES || '[]');
} catch {
  aliases = [];
}
const normalizedWorkspaces = this.normalizeShadowFolkWorkspaces(workspaces);
const workspaceAliases = this.normalizeShadowFolkWorkspaceAliases(aliases);
return {
  enabled: String(process.env.CODEBUDDY_MEM_SHADOWFOLK_ENABLED || '').toLowerCase() === 'true',
  dailyTime: process.env.CODEBUDDY_MEM_SHADOWFOLK_DAILY_TIME || '23:30',
  workspaces: normalizedWorkspaces,
  workspaceAliases,
  workspaceConfigs: this.buildShadowFolkWorkspaceConfigs(normalizedWorkspaces, workspaceAliases),
};
```

- [ ] **Step 6: Pass workspace configs to uploader**

In `runShadowFolkPush()`:

```ts
const result = await uploader.pushWorkspaces(runtime.workspaceConfigs);
```

In `handleShadowFolkStatus()` add:

```ts
      workspaceAliases: runtime.workspaceAliases,
      workspaceConfigs: runtime.workspaceConfigs,
```

In `handleShadowFolkHistory()` and `handleShadowFolkReplay()`, resolve the selected workspace to a config:

```ts
const runtime = this.getShadowFolkRuntimeConfig();
const workspaceConfig = runtime.workspaceConfigs.find(item => item.workspace.toLowerCase() === workspace.toLowerCase()) || { workspace, memoryRoots: [] };
```

Use `workspaceConfig` for `listPushHistory`, `repushWorkspaceFull`, and `replayHistoryEntry`.

- [ ] **Step 7: Save aliases through config endpoint**

In `handleShadowFolkConfigUpdate()`, parse incoming `workspaceAliases`:

```ts
const workspaceAliases = this.normalizeShadowFolkWorkspaceAliases((body as any).workspaceAliases);
```

When setting override:

```ts
this.shadowfolkOverride = {
  enabled,
  dailyTime,
  workspaces,
  workspaceAliases,
};
```

- [ ] **Step 8: Run Worker tests**

Run:

```bash
node --import tsx --test --test-name-pattern "shadowfolk/push|shadowfolk/history|shadowfolk/replay|workspace aliases" tests/worker/worker-endpoints.test.ts
```

Expected: selected tests PASS.

- [ ] **Step 9: Commit Task 3**

```bash
git add src/services/worker/WorkerService.ts tests/worker/worker-endpoints.test.ts
git commit -m "feat(shadowfolk): pass workspace memory aliases through worker"
```

---

### Task 4: Settings IPC and Renderer State

**Files:**
- Modify: `desktop/src/windows/SettingsWindow.ts`
- Modify: `desktop/src/preload-settings.ts`
- Modify: `desktop/src/windows/settings.html`
- Test: `tests/settings-renderer-contract.test.ts`

- [ ] **Step 1: Write failing renderer contract tests**

Append to `tests/settings-renderer-contract.test.ts`:

```ts
test('settings page persists ShadowFolk workspace aliases with plugin settings', () => {
  assert.match(
    settingsHtml,
    /shadowfolkWorkspaceAliases:\s*\[\.\.\.shadowfolkWorkspaceAliases\]/,
    'ShadowFolk plugin save should include workspace aliases',
  );
});

test('settings page offers non-git memory projects as aliases instead of upload workspaces', () => {
  assert.match(
    settingsHtml,
    /addShadowfolkWorkspaceAlias/,
    'settings page should define an alias binding helper',
  );
  assert.match(
    settingsHtml,
    /可作为.*旧记忆路径/,
    'settings page should explain non-git memory projects can be bound as old memory paths',
  );
});
```

- [ ] **Step 2: Run renderer contract tests and confirm failure**

Run:

```bash
node --import tsx --test --test-name-pattern "workspace aliases|non-git memory projects" tests/settings-renderer-contract.test.ts
```

Expected: FAIL because renderer has no alias state or helper.

- [ ] **Step 3: Save aliases in SettingsWindow**

In `desktop/src/windows/SettingsWindow.ts`, import or define a local normalizer:

```ts
function normalizeShadowfolkWorkspaceAliases(value: unknown): Array<{ workspace: string; memoryRoots: string[] }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      const workspace = typeof record.workspace === 'string' ? record.workspace.trim() : '';
      const memoryRoots = Array.isArray(record.memoryRoots)
        ? Array.from(new Set(record.memoryRoots
          .filter((root): root is string => typeof root === 'string')
          .map(root => root.trim())
          .filter(Boolean)))
        : [];
      if (!workspace || memoryRoots.length === 0) return null;
      return { workspace, memoryRoots };
    })
    .filter((entry): entry is { workspace: string; memoryRoots: string[] } => !!entry);
}
```

In `settings:save`, when `data.shadowfolkWorkspaceAliases !== undefined`:

```ts
updates.shadowfolkWorkspaceAliases = normalizeShadowfolkWorkspaceAliases(data.shadowfolkWorkspaceAliases) as any;
```

When proxying `/api/shadowfolk/config`, include:

```ts
workspaceAliases: cfg.shadowfolkWorkspaceAliases,
```

- [ ] **Step 4: Add renderer alias state**

In `desktop/src/windows/settings.html`, near existing globals:

```js
let shadowfolkWorkspaceAliases = [];
```

Add helpers:

```js
function normalizeShadowfolkWorkspaceAliases(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const workspace = entry && typeof entry.workspace === 'string' ? entry.workspace.trim() : '';
      const memoryRoots = entry && Array.isArray(entry.memoryRoots)
        ? Array.from(new Set(entry.memoryRoots.map(root => String(root || '').trim()).filter(Boolean)))
        : [];
      return workspace && memoryRoots.length ? { workspace, memoryRoots } : null;
    })
    .filter(Boolean);
}

function getShadowfolkAliasesForWorkspace(workspace) {
  const entry = shadowfolkWorkspaceAliases.find(alias => alias.workspace.toLowerCase() === workspace.toLowerCase());
  return entry ? [...entry.memoryRoots] : [];
}

function setShadowfolkAliasesForWorkspace(workspace, memoryRoots) {
  const roots = Array.from(new Set((memoryRoots || []).map(root => String(root || '').trim()).filter(Boolean)));
  shadowfolkWorkspaceAliases = shadowfolkWorkspaceAliases.filter(alias => alias.workspace.toLowerCase() !== workspace.toLowerCase());
  if (roots.length) shadowfolkWorkspaceAliases.push({ workspace, memoryRoots: roots });
}

function removeShadowfolkWorkspaceAlias(workspace, memoryRoot) {
  const remaining = getShadowfolkAliasesForWorkspace(workspace).filter(root => root.toLowerCase() !== memoryRoot.toLowerCase());
  setShadowfolkAliasesForWorkspace(workspace, remaining);
  renderShadowfolkWorkspaces();
}

function addShadowfolkWorkspaceAlias(workspace, memoryRoot) {
  const root = String(memoryRoot || '').trim();
  if (!workspace || !root) return;
  const lowerRoot = root.toLowerCase();
  if (workspace.toLowerCase() === lowerRoot) {
    setShadowfolkStatus('该路径已经是当前上传工作区，不需要作为旧记忆路径添加');
    return;
  }
  const usedBy = shadowfolkWorkspaceAliases.find(alias => (
    alias.workspace.toLowerCase() !== workspace.toLowerCase()
    && alias.memoryRoots.some(existing => existing.toLowerCase() === lowerRoot)
  ));
  if (usedBy) {
    setShadowfolkStatus('该旧记忆路径已经绑定到其他上传工作区，请先移除后再添加', 'err');
    return;
  }
  const roots = getShadowfolkAliasesForWorkspace(workspace);
  if (!roots.some(existing => existing.toLowerCase() === lowerRoot)) roots.push(root);
  setShadowfolkAliasesForWorkspace(workspace, roots);
  renderShadowfolkWorkspaces();
  setShadowfolkStatus('已添加旧记忆路径：' + root, 'ok');
}
```

- [ ] **Step 5: Hydrate and persist aliases**

When loading config:

```js
shadowfolkWorkspaceAliases = normalizeShadowfolkWorkspaceAliases(config.shadowfolkWorkspaceAliases);
```

In `saveShadowfolkPluginSettings()` and full `saveSettings()` payload:

```js
shadowfolkWorkspaceAliases: [...shadowfolkWorkspaceAliases],
```

When removing a workspace:

```js
shadowfolkWorkspaceAliases = shadowfolkWorkspaceAliases.filter(alias => alias.workspace.toLowerCase() !== workspace.toLowerCase());
```

- [ ] **Step 6: Render aliases under each workspace**

In `renderShadowfolkWorkspaces()`, after main row and before replay row, add:

```js
const aliases = getShadowfolkAliasesForWorkspace(workspace);
const aliasBox = document.createElement('div');
aliasBox.className = 'field-hint shadowfolk-alias-box';
aliasBox.textContent = aliases.length ? `旧记忆路径：${aliases.join('，')}` : '旧记忆路径：无';

aliases.forEach((memoryRoot) => {
  const removeAliasBtn = document.createElement('button');
  removeAliasBtn.type = 'button';
  removeAliasBtn.className = 'btn btn-secondary';
  removeAliasBtn.textContent = '移除旧路径';
  removeAliasBtn.style.fontSize = '11px';
  removeAliasBtn.style.marginLeft = '6px';
  removeAliasBtn.addEventListener('click', () => removeShadowfolkWorkspaceAlias(workspace, memoryRoot));
  aliasBox.appendChild(removeAliasBtn);
});

const aliasInputRow = document.createElement('div');
aliasInputRow.className = 'shadowfolk-replay-row';

const aliasInput = document.createElement('input');
aliasInput.type = 'text';
aliasInput.placeholder = '输入旧记忆路径，例如 E:/Github/foo';

const aliasBtn = document.createElement('button');
aliasBtn.type = 'button';
aliasBtn.className = 'btn btn-secondary';
aliasBtn.textContent = '添加旧记忆路径';
aliasBtn.style.fontSize = '12px';
aliasBtn.addEventListener('click', () => addShadowfolkWorkspaceAlias(workspace, aliasInput.value));

aliasInputRow.appendChild(aliasInput);
aliasInputRow.appendChild(aliasBtn);
card.appendChild(aliasBox);
card.appendChild(aliasInputRow);
```

- [ ] **Step 7: Offer alias binding when adding non-Git memory project**

In `addShadowfolkWorkspace(rawPath)`, when validation fails and there are existing workspaces:

```js
if (result && result.error && /不是 Git 工作区|路径不存在/.test(result.error) && shadowfolkWorkspaces.length) {
  setShadowfolkStatus('该路径不是 Git 工作区，可作为某个工作区的旧记忆路径绑定。请在对应工作区下点击“添加旧记忆路径”。', 'err');
  return;
}
```

This is intentionally explicit for MVP; it avoids silently guessing which workspace should receive the alias.

- [ ] **Step 8: Run renderer contract tests**

Run:

```bash
node --import tsx --test tests/settings-renderer-contract.test.ts
```

Expected: all tests PASS.

- [ ] **Step 9: Commit Task 4**

```bash
git add desktop/src/windows/SettingsWindow.ts desktop/src/preload-settings.ts desktop/src/windows/settings.html tests/settings-renderer-contract.test.ts
git commit -m "feat(desktop): configure ShadowFolk memory aliases"
```

---

### Task 5: Alias Suggestions and End-to-End Verification

**Files:**
- Modify: `src/services/worker/WorkerService.ts`
- Modify: `desktop/src/windows/SettingsWindow.ts`
- Modify: `desktop/src/preload-settings.ts`
- Modify: `desktop/src/windows/settings.html`
- Test: `tests/worker/worker-endpoints.test.ts`

- [ ] **Step 1: Write failing suggestion endpoint test**

Append to `tests/worker/worker-endpoints.test.ts`:

```ts
test('POST /api/shadowfolk/workspaces/suggest-aliases suggests recorded projects with same basename', async () => {
  const worker = makeWorker();
  const req = makeReq({ method: 'POST', url: '/api/shadowfolk/workspaces/suggest-aliases' });
  const { res, captured } = makeRes();

  (worker as any).listShadowFolkMemoryProjectsForAliasSuggestions = () => [
    'E:/Github/foo',
    'D:/Github/foo',
    'E:/Github/bar',
  ];

  const promise = (worker as any).handleRequest(req, res);
  req.emit('data', Buffer.from(JSON.stringify({ workspace: 'D:/Github/foo' })));
  req.emit('end');
  await promise;

  assert.equal(captured.status, 200);
  const body = JSON.parse(captured.body!);
  assert.equal(body.success, true);
  assert.deepEqual(body.suggestions, ['E:/Github/foo']);
});
```

- [ ] **Step 2: Add Worker route and suggestion helper**

In `handleRequest()`:

```ts
} else if (path === '/api/shadowfolk/workspaces/suggest-aliases' && req.method === 'POST') {
  await this.handleShadowFolkWorkspaceAliasSuggestions(req, res);
```

Add methods:

```ts
private listShadowFolkMemoryProjectsForAliasSuggestions(): string[] {
  const rows = getDatabase().prepare(`
    SELECT DISTINCT project FROM observations WHERE project IS NOT NULL AND project != ''
    UNION
    SELECT DISTINCT project FROM session_summaries WHERE project IS NOT NULL AND project != ''
    ORDER BY project ASC
  `).all() as Array<{ project: string }>;
  return rows.map(row => row.project).filter(Boolean);
}

private async handleShadowFolkWorkspaceAliasSuggestions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await this.parseBody(req);
  const workspace = String(body.workspace || '').trim();
  if (!workspace) {
    res.statusCode = 400;
    res.end(JSON.stringify({ success: false, error: 'workspace is required', suggestions: [] }));
    return;
  }

  const normalizedWorkspace = workspace.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  const basename = normalizedWorkspace.split('/').filter(Boolean).at(-1) || '';
  const projects = this.listShadowFolkMemoryProjectsForAliasSuggestions();
  const suggestions = projects
    .map(project => project.trim())
    .filter(Boolean)
    .filter(project => {
      const normalized = project.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
      if (normalized === normalizedWorkspace) return false;
      return normalized.split('/').filter(Boolean).at(-1) === basename;
    });

  res.statusCode = 200;
  res.end(JSON.stringify({ success: true, workspace, suggestions: Array.from(new Set(suggestions)) }));
}
```

- [ ] **Step 3: Expose suggestion IPC**

In `desktop/src/preload-settings.ts`:

```ts
  suggestShadowfolkWorkspaceAliases: (workspace: string) => ipcRenderer.invoke('shadowfolk:suggest-aliases', workspace),
```

In `desktop/src/windows/SettingsWindow.ts`:

```ts
ipcMain.handle('shadowfolk:suggest-aliases', async (_event, workspace: string) => {
  const value = String(workspace || '').trim();
  if (!value) return { success: false, error: 'workspace is required', suggestions: [] };
  const r = await workerRequestWithRetry('POST', '/api/shadowfolk/workspaces/suggest-aliases', 15000, 6000, { workspace: value });
  if (r.status === 0) return { success: false, error: 'worker 没响应', suggestions: [] };
  return r.body || { success: false, suggestions: [] };
});
```

Remember to remove the IPC handler in cleanup:

```ts
ipcMain.removeHandler('shadowfolk:suggest-aliases');
```

- [ ] **Step 4: Use suggestions in renderer after workspace add**

After adding a workspace in `addShadowfolkWorkspace()`:

```js
if (window.settingsAPI.suggestShadowfolkWorkspaceAliases) {
  const suggestions = await window.settingsAPI.suggestShadowfolkWorkspaceAliases(gitRoot);
  if (suggestions && suggestions.success && Array.isArray(suggestions.suggestions) && suggestions.suggestions.length) {
    setShadowfolkStatus(`已添加上传工作区：${gitRoot}。发现可能的旧记忆路径：${suggestions.suggestions.join('，')}，可在工作区卡片下绑定。`, 'ok');
  } else {
    setShadowfolkStatus('已添加上传工作区：' + gitRoot, 'ok');
  }
} else {
  setShadowfolkStatus('已添加上传工作区：' + gitRoot, 'ok');
}
```

- [ ] **Step 5: Run targeted verification**

Run:

```bash
node --import tsx --test --test-name-pattern "suggest-aliases|workspace aliases|shadowfolk/push|shadowfolk/history|shadowfolk/replay" tests/worker/worker-endpoints.test.ts
node --import tsx --test tests/settings-renderer-contract.test.ts
node --import tsx --test --test-name-pattern "old memory roots|pushWorkspaceRange|repushWorkspaceFull|records start" tests/shadowfolk-uploader.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 6: Check lints for edited files**

Use Cursor `ReadLints` for:

```text
desktop/src/config/store.ts
desktop/src/windows/SettingsWindow.ts
desktop/src/preload-settings.ts
desktop/src/windows/settings.html
src/services/shadowfolk/PushHistoryStore.ts
src/services/shadowfolk/ShadowFolkUploader.ts
src/services/worker/WorkerService.ts
tests/settings-renderer-contract.test.ts
tests/shadowfolk-uploader.test.ts
tests/worker/worker-endpoints.test.ts
```

Expected: no introduced diagnostics.

- [ ] **Step 7: Commit Task 5**

```bash
git add src/services/worker/WorkerService.ts desktop/src/windows/SettingsWindow.ts desktop/src/preload-settings.ts desktop/src/windows/settings.html tests/worker/worker-endpoints.test.ts
git commit -m "feat(shadowfolk): suggest migrated memory aliases"
```

---

### Task 6: Final Regression and Manual Scenario

**Files:**
- Verify only; no planned edits unless a regression is found.

- [ ] **Step 1: Run all ShadowFolk-related tests**

Run:

```bash
node --import tsx --test tests/shadowfolk-uploader.test.ts tests/shadowfolk-history-store.test.ts tests/shadowfolk-schedule.test.ts tests/worker/worker-endpoints.test.ts tests/settings-renderer-contract.test.ts
```

Expected: all tests PASS.

- [ ] **Step 2: Manual desktop scenario**

Use a local setup with:

- Real Git workspace: `D:/Github/foo`
- Memory DB rows whose `project` is `E:/Github/foo`

Manual steps:

1. Open Settings → Plugins → ShadowFolk Upload Plugin.
2. Add `D:/Github/foo` as upload workspace.
3. Add `E:/Github/foo` under that workspace as old memory path.
4. Save.
5. Click “上传一次”.

Expected result:

- UI reports upload success.
- Raw ShadowFolk payload uses `git.root = D:/Github/foo`.
- Memory rows include `project = e:/github/foo`.
- Push record key is `D:/Github/foo`.

- [ ] **Step 3: Verify full repush includes aliases**

Manual or test-backed check:

1. Select “全量重推” under `D:/Github/foo`.
2. Start replay.

Expected result:

- Full repush exports memory rows from both `D:/Github/foo` and `E:/Github/foo`.
- Git commits still come from `D:/Github/foo`.

- [ ] **Step 4: Final status check**

Run:

```bash
git status --short --branch
```

Expected:

- Branch contains only intended committed changes.
- Existing unrelated `project-comparison.md` remains untracked unless the user explicitly asks to handle it.

---

## Self-Review

- Spec coverage: The plan covers config compatibility, alias persistence, Worker propagation, uploader export behavior, settings UI repair flow, suggestion support, full/history replay behavior, and tests.
- Placeholder scan: No unresolved markers or vague implementation instructions remain.
- Type consistency: The plan uses `ShadowFolkWorkspaceAlias`, `ShadowFolkWorkspaceConfig`, `workspaceAliases`, and `memoryRoots` consistently across config, Worker, uploader, and renderer.
- Scope check: The plan stays within local project migration support. It does not add memory-only upload identity, database project rewriting, or automatic full-disk discovery.
