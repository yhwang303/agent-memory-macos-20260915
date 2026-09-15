# IDE Hooks 自动关联 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让安装包用户首次启动 Electron 托盘应用时，通过向导自动将 agent-memory hooks 注册到 CodeBuddy/Cursor 的配置文件中。

**Architecture:** 共享的 `hooks-config.ts`（纯 IO，无 Electron 依赖）提供 hooks.json 读写能力，`HooksRegistrar`（Electron 层）封装路径解析和 IDE 检测，`SetupWizard` 提供首次启动向导 UI，`SettingsWindow` 扩展 IDE 关联管理。卸载脚本复用 `hooks-config` 的清理逻辑。

**Tech Stack:** TypeScript, Electron (BrowserWindow, ipcMain, contextBridge), Node.js fs/path/os

**Spec:** `docs/superpowers/specs/2025-03-24-ide-hooks-integration-design.md`

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `desktop/src/shared/hooks-config.ts` | 创建 | 纯 IO 的 hooks.json 读写（无 Electron 依赖） |
| `desktop/src/services/HooksRegistrar.ts` | 创建 | Electron 层封装：路径解析、IDE 检测、代理 hooks-config |
| `desktop/src/windows/SetupWizard.ts` | 创建 | 首次启动向导窗口管理 + IPC |
| `desktop/src/windows/setup-wizard.html` | 创建 | 向导 UI |
| `desktop/src/windows/SettingsWindow.ts` | 修改 | 新增 IDE 关联管理 IPC |
| `desktop/src/windows/settings.html` | 修改 | 新增 IDE 关联管理 UI 区域 |
| `desktop/src/preload-settings.ts` | 修改 | 新增 hooks IPC bridge |
| `desktop/src/main.ts` | 修改 | 集成 SetupWizard 和 HooksRegistrar |
| `desktop/src/scripts/uninstall-hooks.ts` | 创建 | 卸载清理脚本（复用 hooks-config） |

---

### Task 1: 共享 hooks-config 模块

**Files:**
- Create: `desktop/src/shared/hooks-config.ts`

- [ ] **Step 1: 创建 hooks-config.ts**

```typescript
// desktop/src/shared/hooks-config.ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type IDEType = 'codebuddy' | 'cursor';

export interface HooksConfigPaths {
  nodeExePath: string;
  hooksCliPath: string;
}

export interface DetectedIDE {
  type: IDEType;
  name: string;
  configDir: string;
  hooksFilePath: string;
  registered: boolean;
}

export interface RegisterResult {
  success: boolean;
  eventsRegistered: string[];
  eventsSkipped: string[];
  error?: string;
}

export interface UnregisterResult {
  success: boolean;
  eventsRemoved: number;
  error?: string;
}

interface HookEvent {
  name: string;
  timeout: number;
}

const COMMON_EVENTS: HookEvent[] = [
  { name: 'beforeSubmitPrompt', timeout: 10 },
  { name: 'afterAgentResponse', timeout: 30 },
  { name: 'afterAgentThought', timeout: 30 },
  { name: 'afterShellExecution', timeout: 30 },
  { name: 'afterMCPExecution', timeout: 30 },
  { name: 'afterFileEdit', timeout: 30 },
  { name: 'afterSearchReplaceFileEdit', timeout: 30 },
  { name: 'stop', timeout: 30 },
];

const CURSOR_ONLY_EVENTS: HookEvent[] = [
  { name: 'sessionStart', timeout: 10 },
  { name: 'sessionEnd', timeout: 30 },
];

const CODEBUDDY_TRIGGER_DISPLAY: Record<string, string> = {
  beforeSubmitPrompt: '提交提示词前',
  afterAgentResponse: 'Agent响应后',
  afterAgentThought: 'Agent思考后',
  afterShellExecution: 'Shell执行后',
  afterMCPExecution: 'MCP执行后',
  afterFileEdit: '文件编辑后',
  afterSearchReplaceFileEdit: '搜索替换文件编辑后',
  stop: '停止',
};

function getIDEConfigPaths(ide: IDEType): { configDir: string; hooksFilePath: string } | null {
  const home = os.homedir();
  if (ide === 'codebuddy') {
    const configDir = path.join(home, '.gongfeng-copilot');
    if (!fs.existsSync(configDir)) return null;
    return {
      configDir,
      hooksFilePath: path.join(configDir, 'hooks', 'hooks.json'),
    };
  }
  if (ide === 'cursor') {
    const configDir = path.join(home, '.cursor');
    if (!fs.existsSync(configDir)) return null;
    return {
      configDir,
      hooksFilePath: path.join(configDir, 'hooks.json'),
    };
  }
  return null;
}

function buildCommand(paths: HooksConfigPaths, eventName: string): string {
  if (process.platform === 'win32') {
    return `cmd.exe /c chcp 65001 >nul & "${paths.nodeExePath}" "${paths.hooksCliPath}" ${eventName}`;
  }
  return `"${paths.nodeExePath}" "${paths.hooksCliPath}" ${eventName}`;
}

function isCodebuddyMemHook(hook: any): boolean {
  if (hook.hook_id && typeof hook.hook_id === 'string' && hook.hook_id.startsWith('agent-memory:')) {
    return true;
  }
  if (hook.command && typeof hook.command === 'string' && hook.command.includes('hooks-cli')) {
    return true;
  }
  return false;
}

export function detectIDEs(): DetectedIDE[] {
  const ides: DetectedIDE[] = [];
  for (const type of ['codebuddy', 'cursor'] as IDEType[]) {
    const paths = getIDEConfigPaths(type);
    if (!paths) continue;
    const registered = checkRegistered(type, paths.hooksFilePath);
    ides.push({
      type,
      name: type === 'codebuddy' ? 'CodeBuddy' : 'Cursor',
      configDir: paths.configDir,
      hooksFilePath: paths.hooksFilePath,
      registered,
    });
  }
  return ides;
}

function checkRegistered(ide: IDEType, hooksFilePath: string): boolean {
  if (!fs.existsSync(hooksFilePath)) return false;
  try {
    const content = JSON.parse(fs.readFileSync(hooksFilePath, 'utf8'));
    const hooks = content.hooks || {};
    for (const eventHooks of Object.values(hooks) as any[][]) {
      if (Array.isArray(eventHooks) && eventHooks.some(isCodebuddyMemHook)) {
        return true;
      }
    }
  } catch {}
  return false;
}

export function register(ide: IDEType, configPaths: HooksConfigPaths): RegisterResult {
  const idePaths = getIDEConfigPaths(ide);
  if (!idePaths) {
    return { success: false, eventsRegistered: [], eventsSkipped: [], error: `${ide} 未安装` };
  }

  const hooksFilePath = idePaths.hooksFilePath;
  const hooksDir = path.dirname(hooksFilePath);
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  let config: any;
  try {
    if (fs.existsSync(hooksFilePath)) {
      config = JSON.parse(fs.readFileSync(hooksFilePath, 'utf8'));
    }
  } catch {}

  const events = ide === 'cursor'
    ? [...COMMON_EVENTS, ...CURSOR_ONLY_EVENTS]
    : [...COMMON_EVENTS];

  const registered: string[] = [];
  const skipped: string[] = [];

  if (ide === 'cursor') {
    if (!config) config = { version: 1, hooks: {} };
    if (!config.hooks) config.hooks = {};

    for (const ev of events) {
      if (!config.hooks[ev.name]) config.hooks[ev.name] = [];
      const existing = config.hooks[ev.name].find((h: any) => isCodebuddyMemHook(h));
      if (existing) {
        skipped.push(ev.name);
        continue;
      }
      config.hooks[ev.name].push({
        command: buildCommand(configPaths, ev.name),
        timeout: ev.timeout,
      });
      registered.push(ev.name);
    }
  } else {
    if (!config) config = { enabled: true, hooks: {} };
    if (!config.hooks) config.hooks = {};

    for (const ev of events) {
      if (!config.hooks[ev.name]) config.hooks[ev.name] = [];
      const existing = config.hooks[ev.name].find((h: any) => isCodebuddyMemHook(h));
      if (existing) {
        skipped.push(ev.name);
        continue;
      }
      config.hooks[ev.name].push({
        command: buildCommand(configPaths, ev.name),
        display_name: `[AgentMemory] ${ev.name}`,
        hook_id: `agent-memory:${ev.name}`,
        trigger_event: ev.name,
        trigger_event_display: CODEBUDDY_TRIGGER_DISPLAY[ev.name] || ev.name,
      });
      registered.push(ev.name);
    }
  }

  try {
    fs.writeFileSync(hooksFilePath, JSON.stringify(config, null, 2), 'utf8');
  } catch (err: any) {
    return { success: false, eventsRegistered: [], eventsSkipped: [], error: `写入失败: ${err.message}` };
  }

  return { success: true, eventsRegistered: registered, eventsSkipped: skipped };
}

export function unregister(ide: IDEType): UnregisterResult {
  const idePaths = getIDEConfigPaths(ide);
  if (!idePaths || !fs.existsSync(idePaths.hooksFilePath)) {
    return { success: true, eventsRemoved: 0 };
  }

  let config: any;
  try {
    config = JSON.parse(fs.readFileSync(idePaths.hooksFilePath, 'utf8'));
  } catch {
    return { success: false, eventsRemoved: 0, error: '无法解析 hooks.json' };
  }

  let removed = 0;
  const hooks = config.hooks || {};
  for (const eventName of Object.keys(hooks)) {
    if (!Array.isArray(hooks[eventName])) continue;
    const before = hooks[eventName].length;
    hooks[eventName] = hooks[eventName].filter((h: any) => !isCodebuddyMemHook(h));
    removed += before - hooks[eventName].length;
    if (hooks[eventName].length === 0) {
      delete hooks[eventName];
    }
  }

  try {
    fs.writeFileSync(idePaths.hooksFilePath, JSON.stringify(config, null, 2), 'utf8');
  } catch (err: any) {
    return { success: false, eventsRemoved: 0, error: `写入失败: ${err.message}` };
  }

  return { success: true, eventsRemoved: removed };
}
```

- [ ] **Step 2: 编译验证**

Run: `cd desktop && npx tsc`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add desktop/src/shared/hooks-config.ts
git commit -m "feat(desktop): add shared hooks-config module for IDE hooks registration"
```

---

### Task 2: HooksRegistrar（Electron 封装）

**Files:**
- Create: `desktop/src/services/HooksRegistrar.ts`

- [ ] **Step 1: 创建 HooksRegistrar.ts**

```typescript
// desktop/src/services/HooksRegistrar.ts
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  detectIDEs as detectIDEsShared,
  register as registerShared,
  unregister as unregisterShared,
  type IDEType,
  type DetectedIDE,
  type RegisterResult,
  type UnregisterResult,
  type HooksConfigPaths,
} from '../shared/hooks-config';

const SETUP_STATE_PATH = path.join(os.homedir(), '.agent-memory', 'setup-state.json');

interface SetupState {
  version: string;
  registeredIDEs: IDEType[];
  registeredAt: string;
}

export class HooksRegistrar {
  private getPaths(): HooksConfigPaths {
    if (app.isPackaged) {
      const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
      return {
        nodeExePath: path.join(process.resourcesPath, nodeName),
        hooksCliPath: path.join(process.resourcesPath, 'worker', 'hooks-cli.js'),
      };
    }
    const repoRoot = path.join(__dirname, '..', '..', '..');
    return {
      nodeExePath: 'node',
      hooksCliPath: path.join(repoRoot, 'dist', 'hooks-cli.js'),
    };
  }

  detectIDEs(): DetectedIDE[] {
    return detectIDEsShared();
  }

  register(ide: IDEType): RegisterResult {
    const result = registerShared(ide, this.getPaths());
    if (result.success) this.updateSetupState(ide, 'add');
    return result;
  }

  unregister(ide: IDEType): UnregisterResult {
    const result = unregisterShared(ide);
    if (result.success) this.updateSetupState(ide, 'remove');
    return result;
  }

  isFirstRun(): boolean {
    return !fs.existsSync(SETUP_STATE_PATH);
  }

  hasNewUnregisteredIDEs(): DetectedIDE[] {
    const state = this.readSetupState();
    if (!state) return [];
    const ides = this.detectIDEs();
    return ides.filter(ide => !ide.registered && !state.registeredIDEs.includes(ide.type));
  }

  private readSetupState(): SetupState | null {
    try {
      if (!fs.existsSync(SETUP_STATE_PATH)) return null;
      return JSON.parse(fs.readFileSync(SETUP_STATE_PATH, 'utf8'));
    } catch {
      return null;
    }
  }

  private updateSetupState(ide: IDEType, action: 'add' | 'remove'): void {
    let state = this.readSetupState() || {
      version: '1.0.0',
      registeredIDEs: [],
      registeredAt: new Date().toISOString(),
    };

    if (action === 'add' && !state.registeredIDEs.includes(ide)) {
      state.registeredIDEs.push(ide);
    } else if (action === 'remove') {
      state.registeredIDEs = state.registeredIDEs.filter(i => i !== ide);
    }
    state.registeredAt = new Date().toISOString();

    const dir = path.dirname(SETUP_STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SETUP_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
  }
}
```

- [ ] **Step 2: 编译验证**

Run: `cd desktop && npx tsc`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add desktop/src/services/HooksRegistrar.ts
git commit -m "feat(desktop): add HooksRegistrar with path resolution and setup state"
```

---

### Task 3: SetupWizard 窗口

**Files:**
- Create: `desktop/src/windows/SetupWizard.ts`
- Create: `desktop/src/windows/setup-wizard.html`

- [ ] **Step 1: 创建 SetupWizard.ts**

```typescript
// desktop/src/windows/SetupWizard.ts
import { BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { HooksRegistrar } from '../services/HooksRegistrar';
import type { IDEType } from '../shared/hooks-config';

export class SetupWizard {
  private window: BrowserWindow | null = null;
  private registrar: HooksRegistrar;
  private onComplete: () => void;

  constructor(registrar: HooksRegistrar, onComplete: () => void) {
    this.registrar = registrar;
    this.onComplete = onComplete;
    this.setupIPC();
  }

  private setupIPC(): void {
    ipcMain.handle('setup:detect-ides', () => {
      return this.registrar.detectIDEs();
    });

    ipcMain.handle('setup:register', (_event, ides: IDEType[]) => {
      const results: Record<string, any> = {};
      for (const ide of ides) {
        results[ide] = this.registrar.register(ide);
      }
      return results;
    });

    ipcMain.handle('setup:skip', () => {
      this.onComplete();
      this.window?.close();
    });
  }

  show(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.focus();
      return;
    }

    this.window = new BrowserWindow({
      width: 480,
      height: 420,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'AgentMemory — 初始化设置',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '..', 'preload-setup.js'),
      },
    });

    const htmlPath = path.join(__dirname, 'setup-wizard.html');
    this.window.loadFile(htmlPath);

    this.window.on('closed', () => {
      this.window = null;
      this.onComplete();
    });
  }

  destroy(): void {
    ipcMain.removeHandler('setup:detect-ides');
    ipcMain.removeHandler('setup:register');
    ipcMain.removeHandler('setup:skip');
    this.window?.destroy();
    this.window = null;
  }
}
```

- [ ] **Step 2: 创建 preload-setup.ts**

```typescript
// desktop/src/preload-setup.ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('setupAPI', {
  detectIDEs: () => ipcRenderer.invoke('setup:detect-ides'),
  register: (ides: string[]) => ipcRenderer.invoke('setup:register', ides),
  skip: () => ipcRenderer.invoke('setup:skip'),
});
```

- [ ] **Step 3: 创建 setup-wizard.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>AgentMemory — 初始化设置</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif;
    background: #f7f8fa;
    color: #1a1a2e;
    padding: 24px;
    font-size: 13px;
    line-height: 1.6;
    user-select: none;
  }
  h1 {
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 6px;
    color: #2d2d4e;
  }
  .subtitle {
    font-size: 13px;
    color: #6b6b8d;
    margin-bottom: 20px;
  }
  .ide-list {
    background: #fff;
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 16px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    min-height: 80px;
  }
  .ide-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 0;
    border-bottom: 1px solid #f0f0f4;
  }
  .ide-item:last-child { border-bottom: none; }
  .ide-item input[type="checkbox"] {
    width: 18px; height: 18px;
    accent-color: #6c5ce7;
    cursor: pointer;
  }
  .ide-name {
    font-size: 14px;
    font-weight: 500;
    flex: 1;
  }
  .ide-path {
    font-size: 11px;
    color: #9b9bb5;
    font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  }
  .ide-status {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    background: #f0f0f4;
    color: #6b6b8d;
  }
  .ide-status.registered {
    background: #e8f5e9;
    color: #27ae60;
  }
  .no-ide {
    text-align: center;
    color: #9b9bb5;
    padding: 20px 0;
  }
  .result-section {
    background: #fff;
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 16px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    display: none;
  }
  .result-item {
    padding: 4px 0;
    font-size: 12px;
  }
  .result-item.success { color: #27ae60; }
  .result-item.error { color: #e74c3c; }
  .button-bar {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 20px;
  }
  .btn {
    padding: 9px 24px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border: none;
    font-family: inherit;
    transition: all 0.2s;
  }
  .btn-primary {
    background: linear-gradient(135deg, #6c5ce7, #a78bfa);
    color: #fff;
    box-shadow: 0 2px 8px rgba(108,92,231,0.25);
  }
  .btn-primary:hover {
    box-shadow: 0 4px 12px rgba(108,92,231,0.35);
    transform: translateY(-1px);
  }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
  .btn-secondary {
    background: transparent;
    color: #6b6b8d;
    border: 1px solid #dcdfe6;
  }
  .btn-secondary:hover {
    border-color: #b0b0c8;
    color: #4a4a6a;
  }
  .loading { text-align: center; color: #9b9bb5; padding: 20px 0; }
</style>
</head>
<body>

<h1>欢迎使用 AgentMemory</h1>
<p class="subtitle">检测到以下 IDE，勾选要关联的 IDE 来启用记忆采集。</p>

<div class="ide-list" id="ideList">
  <div class="loading">正在检测已安装的 IDE...</div>
</div>

<div class="result-section" id="resultSection">
  <div id="resultContent"></div>
</div>

<div class="button-bar">
  <button class="btn btn-secondary" id="skipBtn">跳过</button>
  <button class="btn btn-primary" id="registerBtn" disabled>开始关联</button>
</div>

<script>
  let detectedIDEs = [];

  window.addEventListener('DOMContentLoaded', async () => {
    detectedIDEs = await window.setupAPI.detectIDEs();
    renderIDEs();

    document.getElementById('registerBtn').addEventListener('click', doRegister);
    document.getElementById('skipBtn').addEventListener('click', () => window.setupAPI.skip());
  });

  function renderIDEs() {
    const list = document.getElementById('ideList');
    if (detectedIDEs.length === 0) {
      list.innerHTML = '<div class="no-ide">未检测到已安装的 IDE（CodeBuddy / Cursor）</div>';
      return;
    }

    list.innerHTML = detectedIDEs.map(ide => `
      <label class="ide-item">
        <input type="checkbox" value="${ide.type}" ${ide.registered ? '' : 'checked'}>
        <div>
          <div class="ide-name">${ide.name}</div>
          <div class="ide-path">${ide.configDir}</div>
        </div>
        ${ide.registered ? '<span class="ide-status registered">已关联</span>' : '<span class="ide-status">未关联</span>'}
      </label>
    `).join('');

    updateRegisterBtn();
    list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', updateRegisterBtn);
    });
  }

  function updateRegisterBtn() {
    const checked = document.querySelectorAll('.ide-item input:checked');
    document.getElementById('registerBtn').disabled = checked.length === 0;
  }

  async function doRegister() {
    const btn = document.getElementById('registerBtn');
    btn.disabled = true;
    btn.textContent = '正在关联...';

    const checked = Array.from(document.querySelectorAll('.ide-item input:checked'))
      .map(cb => cb.value);

    const results = await window.setupAPI.register(checked);

    const section = document.getElementById('resultSection');
    const content = document.getElementById('resultContent');
    section.style.display = 'block';

    let html = '';
    for (const [ide, result] of Object.entries(results)) {
      const r = result;
      const name = ide === 'codebuddy' ? 'CodeBuddy' : 'Cursor';
      if (r.success) {
        html += `<div class="result-item success">✓ ${name}：注册了 ${r.eventsRegistered.length} 个事件`;
        if (r.eventsSkipped.length > 0) html += `，跳过 ${r.eventsSkipped.length} 个已有事件`;
        html += `</div>`;
      } else {
        html += `<div class="result-item error">✗ ${name}：${r.error}</div>`;
      }
    }
    content.innerHTML = html;

    btn.textContent = '完成';
    btn.disabled = false;
    btn.onclick = () => window.close();
    document.getElementById('skipBtn').style.display = 'none';
  }
</script>
</body>
</html>
```

- [ ] **Step 4: 编译验证**

Run: `cd desktop && npx tsc && npm run copy-assets`
Expected: 无错误，`dist/windows/setup-wizard.html` 存在

- [ ] **Step 5: Commit**

```bash
git add desktop/src/windows/SetupWizard.ts desktop/src/windows/setup-wizard.html desktop/src/preload-setup.ts
git commit -m "feat(desktop): add SetupWizard with IDE detection and registration UI"
```

---

### Task 4: SettingsWindow 扩展 — IDE 关联管理

**Files:**
- Modify: `desktop/src/windows/SettingsWindow.ts`
- Modify: `desktop/src/windows/settings.html`
- Modify: `desktop/src/preload-settings.ts`

- [ ] **Step 1: 在 preload-settings.ts 新增 hooks IPC bridge**

在 `contextBridge.exposeInMainWorld` 中追加：

```typescript
// desktop/src/preload-settings.ts
contextBridge.exposeInMainWorld('settingsAPI', {
  getConfig: () => ipcRenderer.invoke('settings:get'),
  saveConfig: (data: Record<string, unknown>) => ipcRenderer.invoke('settings:save', data),
  detectIDEs: () => ipcRenderer.invoke('hooks:detect-ides'),
  registerIDE: (ide: string) => ipcRenderer.invoke('hooks:register', ide),
  unregisterIDE: (ide: string) => ipcRenderer.invoke('hooks:unregister', ide),
});
```

- [ ] **Step 2: 在 SettingsWindow.ts 的 setupIPC 中添加 hooks IPC handler**

在 `setupIPC()` 方法的末尾（`settings:save` handler 之后）追加：

```typescript
ipcMain.handle('hooks:detect-ides', () => {
  return this.registrar.detectIDEs();
});

ipcMain.handle('hooks:register', (_event, ide: string) => {
  return this.registrar.register(ide as IDEType);
});

ipcMain.handle('hooks:unregister', (_event, ide: string) => {
  return this.registrar.unregister(ide as IDEType);
});
```

同时修改构造函数接受 `HooksRegistrar`：

```typescript
private registrar: HooksRegistrar;

constructor(onConfigChanged: () => void, registrar: HooksRegistrar) {
  this.onConfigChanged = onConfigChanged;
  this.registrar = registrar;
  this.setupIPC();
}
```

添加 import：

```typescript
import { HooksRegistrar } from '../services/HooksRegistrar';
import type { IDEType } from '../shared/hooks-config';
```

在 `destroy()` 中清理新 handler：

```typescript
ipcMain.removeHandler('hooks:detect-ides');
ipcMain.removeHandler('hooks:register');
ipcMain.removeHandler('hooks:unregister');
```

- [ ] **Step 3: 在 settings.html 添加 IDE 关联管理 UI**

在"通用设置"的 `</div>` 之后、`<div class="button-bar">` 之前插入：

```html
<div class="section">
  <h2>IDE 关联</h2>
  <div id="ideSection">
    <div style="color:#9b9bb5;font-size:12px;">检测中...</div>
  </div>
  <div style="margin-top:10px;">
    <button type="button" class="btn btn-secondary" id="refreshIDEBtn" style="font-size:12px;padding:4px 12px;">刷新检测</button>
  </div>
</div>
```

在 `<script>` 的 `DOMContentLoaded` 回调中追加：

```javascript
loadIDEStatus();
document.getElementById('refreshIDEBtn').addEventListener('click', loadIDEStatus);
```

在 `</script>` 之前追加函数：

```javascript
async function loadIDEStatus() {
  const section = document.getElementById('ideSection');
  section.innerHTML = '<div style="color:#9b9bb5;font-size:12px;">检测中...</div>';

  const ides = await window.settingsAPI.detectIDEs();
  if (ides.length === 0) {
    section.innerHTML = '<div style="color:#9b9bb5;font-size:12px;">未检测到已安装的 IDE</div>';
    return;
  }

  section.innerHTML = ides.map(ide => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f0f0f4;">
      <span style="font-size:13px;flex:1;">${ide.name}</span>
      <span style="font-size:11px;color:${ide.registered ? '#27ae60' : '#9b9bb5'};">
        ${ide.registered ? '已关联' : '未关联'}
      </span>
      <button onclick="toggleIDE('${ide.type}', ${ide.registered})" 
              style="font-size:11px;padding:2px 10px;border:1px solid ${ide.registered ? '#e74c3c' : '#6c5ce7'};
                     border-radius:4px;background:transparent;color:${ide.registered ? '#e74c3c' : '#6c5ce7'};cursor:pointer;">
        ${ide.registered ? '断开' : '关联'}
      </button>
    </div>
  `).join('');
}

async function toggleIDE(ideType, isRegistered) {
  if (isRegistered) {
    await window.settingsAPI.unregisterIDE(ideType);
  } else {
    await window.settingsAPI.registerIDE(ideType);
  }
  loadIDEStatus();
}
```

- [ ] **Step 4: 调整 SettingsWindow 高度**

窗口高度从 520 调为 620，容纳新增区域：

```typescript
height: 620,
```

- [ ] **Step 5: 编译验证**

Run: `cd desktop && npx tsc && npm run copy-assets`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add desktop/src/windows/SettingsWindow.ts desktop/src/windows/settings.html desktop/src/preload-settings.ts
git commit -m "feat(desktop): add IDE hooks management to SettingsWindow"
```

---

### Task 5: 集成到 main.ts

**Files:**
- Modify: `desktop/src/main.ts`

- [ ] **Step 1: 导入新模块并集成到启动流程**

修改 `desktop/src/main.ts`：

```typescript
import { app, Notification, globalShortcut } from 'electron';
import { WorkerManager } from './worker/WorkerManager';
import { TrayManager } from './tray/TrayManager';
import { QuickPanel } from './windows/QuickPanel';
import { SettingsWindow } from './windows/SettingsWindow';
import { SetupWizard } from './windows/SetupWizard';
import { HooksRegistrar } from './services/HooksRegistrar';
import { getConfig } from './config/store';

let workerManager: WorkerManager;
let trayManager: TrayManager;
let quickPanel: QuickPanel;
let settingsWindow: SettingsWindow;
let setupWizard: SetupWizard;

const hooksRegistrar = new HooksRegistrar();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on('second-instance', () => {
  quickPanel?.show();
});

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    app.dock.hide();
  }

  workerManager = new WorkerManager();
  quickPanel = new QuickPanel();
  settingsWindow = new SettingsWindow(() => {
    workerManager.restart();
    const config = getConfig();
    app.setLoginItemSettings({
      openAtLogin: config.openAtLogin,
      openAsHidden: true,
    });
    globalShortcut.unregisterAll();
    trayManager.registerShortcut();
  }, hooksRegistrar);

  trayManager = new TrayManager(
    workerManager,
    () => quickPanel.toggle(),
    () => settingsWindow.show(),
  );
  trayManager.init();

  const config = getConfig();
  app.setLoginItemSettings({
    openAtLogin: config.openAtLogin,
    openAsHidden: true,
  });

  await workerManager.start();

  new Notification({
    title: 'AgentMemory',
    body: `服务已启动，运行在 localhost:${config.port}`,
  }).show();

  // 首次启动向导
  if (hooksRegistrar.isFirstRun()) {
    setupWizard = new SetupWizard(hooksRegistrar, () => {
      setupWizard?.destroy();
    });
    setupWizard.show();
  } else {
    // 非首次启动：检测新 IDE
    const newIDEs = hooksRegistrar.hasNewUnregisteredIDEs();
    if (newIDEs.length > 0) {
      const names = newIDEs.map(i => i.name).join('、');
      new Notification({
        title: 'AgentMemory',
        body: `检测到新安装的 ${names}，可在设置中关联。`,
      }).show();
    }
  }
});

app.on('before-quit', async () => {
  trayManager?.destroy();
  quickPanel?.destroy();
  settingsWindow?.destroy();
  setupWizard?.destroy();
  await workerManager?.destroy();
});

app.on('window-all-closed', () => {
  // Keep running as tray app
});
```

- [ ] **Step 2: 编译验证**

Run: `cd desktop && npx tsc && npm run copy-assets`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add desktop/src/main.ts
git commit -m "feat(desktop): integrate SetupWizard and HooksRegistrar into app lifecycle"
```

---

### Task 6: 卸载清理脚本

**Files:**
- Create: `desktop/src/scripts/uninstall-hooks.ts`

- [ ] **Step 1: 创建 uninstall-hooks.ts**

```typescript
// desktop/src/scripts/uninstall-hooks.ts
import { detectIDEs, unregister } from '../shared/hooks-config';

const ides = detectIDEs();
for (const ide of ides) {
  if (ide.registered) {
    const result = unregister(ide.type);
    if (result.success) {
      process.stderr.write(`Removed ${result.eventsRemoved} hooks from ${ide.name}\n`);
    }
  }
}
process.exit(0);
```

- [ ] **Step 2: 编译验证**

Run: `cd desktop && npx tsc`
Expected: 无错误，`dist/scripts/uninstall-hooks.js` 存在

- [ ] **Step 3: Commit**

```bash
git add desktop/src/scripts/uninstall-hooks.ts
git commit -m "feat(desktop): add uninstall-hooks script for NSIS cleanup"
```

---

### Task 7: 端到端验证

- [ ] **Step 1: 编译整个 desktop 项目**

Run: `cd desktop && npx tsc && npm run copy-assets`
Expected: 无错误

- [ ] **Step 2: 启动 Electron 验证首次启动向导**

Run: `cd desktop && npm run dev`

验证：
1. 首次启动弹出向导窗口
2. 检测到已安装的 IDE（CodeBuddy 和/或 Cursor）
3. 勾选后点"开始关联"，显示注册结果
4. 关闭向导后再次启动不再弹出

- [ ] **Step 3: 验证 hooks.json 被正确写入**

检查 `~/.cursor/hooks.json` 或 `~/.gongfeng-copilot/hooks/hooks.json`：
- 新增的条目 command 包含 `hooks-cli.js`
- Cursor 条目有 `timeout` 字段
- CodeBuddy 条目有 `hook_id`、`display_name`、`trigger_event`
- 原有的其他 hooks 未被删除

- [ ] **Step 4: 验证设置界面的 IDE 关联管理**

打开设置 → IDE 关联区域：
- 显示已检测的 IDE 及关联状态
- 点"断开"后状态变为"未关联"，hooks.json 中对应条目被移除
- 点"关联"后重新注册

- [ ] **Step 5: Commit 最终状态**

```bash
git add -A
git commit -m "feat(desktop): IDE hooks auto-registration with setup wizard"
```
