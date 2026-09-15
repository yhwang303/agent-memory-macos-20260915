import { app, Notification, globalShortcut, ipcMain } from 'electron';
import { execFile } from 'child_process';
import * as path from 'path';
import { WorkerManager } from './worker/WorkerManager';
import { VectorProgressPoller, type VectorStatusSnapshot } from './worker/VectorProgressPoller';
import { ImportProgressPoller, type ImportProgressSnapshot } from './worker/ImportProgressPoller';
import { TrayManager } from './tray/TrayManager';
import { QuickPanel } from './windows/QuickPanel';
import { SettingsWindow } from './windows/SettingsWindow';
import { SetupWizard } from './windows/SetupWizard';
import { ViewerWindow } from './windows/ViewerWindow';
import type { ViewerOpenOptions } from './windows/ViewerWindow';
import { VectorProgressPanel } from './windows/VectorProgressPanel';
import { ImportProgressPanel } from './windows/ImportProgressPanel';
import { getConfig } from './config/store';
import { HooksRegistrar, getPaths as getHooksPaths } from './services/HooksRegistrar';
import { UpdateChecker } from './services/UpdateChecker';
import { CodexTranscriptWatcher } from './services/CodexTranscriptWatcher';

const hooksRegistrar = HooksRegistrar;

let workerManager: WorkerManager;
let vectorPoller: VectorProgressPoller;
let vectorProgressPanel: VectorProgressPanel;
let importPoller: ImportProgressPoller;
let importProgressPanel: ImportProgressPanel;
let trayManager: TrayManager;
let quickPanel: QuickPanel;
let settingsWindow: SettingsWindow;
let viewerWindow: ViewerWindow;
let setupWizard: SetupWizard | null = null;
let updateChecker: UpdateChecker;
let codexTranscriptWatcher: CodexTranscriptWatcher | null = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

const IDE_DISPLAY_NAME: Record<string, string> = {
  codebuddy: 'CodeBuddy',
  cursor: 'Cursor',
  'codebuddy-ide': 'CodeBuddy IDE',
  'claude-code': 'Claude Code',
  'claude-internal': 'Claude Internal',
  codex: 'Codex App / CLI',
  openclaw: 'OpenClaw Gateway',
};

/* ----------------------- cmem:// protocol ----------------------- */

function registerCmemProtocol(): void {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('cmem', process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient('cmem');
  }
}

function findInviteUrl(argv: string[]): string | null {
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.startsWith('cmem://')) return arg;
  }
  return null;
}

function handleInviteUrl(url: string): void {
  if (!settingsWindow) return;
  settingsWindow.showWithInvite(url);
  new Notification({
    title: 'AgentMemory',
    body: '收到服务器邀请链接，请在「服务器同步」里确认连接',
  }).show();
}

registerCmemProtocol();

app.on('second-instance', (_event, argv) => {
  const invite = findInviteUrl(argv);
  if (invite) {
    handleInviteUrl(invite);
  } else {
    quickPanel?.show();
  }
});

// macOS does not emit "second-instance" when the user re-opens an already
// running app from Finder. Keep the menu-bar app discoverable by opening the
// main viewer on that native activation path as well.
app.on('activate', () => {
  viewerWindow?.show();
});

// macOS: cmem:// arrives via 'open-url'
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (url && url.startsWith('cmem://')) {
    handleInviteUrl(url);
  }
});

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    app.dock.hide();
  }

  workerManager = new WorkerManager();
  quickPanel = new QuickPanel();
  viewerWindow = new ViewerWindow();
  settingsWindow = new SettingsWindow(
    async () => {
      await workerManager.restart();
      const config = getConfig();
      app.setLoginItemSettings({
        openAtLogin: config.openAtLogin,
        openAsHidden: true,
      });
      globalShortcut.unregisterAll();
      trayManager.registerShortcut();
    },
    hooksRegistrar,
  );

  ipcMain.handle('viewer:open', (_e, opts: ViewerOpenOptions | undefined) => {
    viewerWindow.show(opts);
  });

  // beta.8: 向量索引重建的暂停 / 恢复 / 切档 — 转发到 Worker 的 HTTP 端点
  const vectorHttpPost = (apiPath: string, body?: object): Promise<void> => new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const port = require('./config/store').getConfig().port;
    const req = require('http').request({
      host: '127.0.0.1',
      port,
      path: apiPath,
      method: 'POST',
      headers: data
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        : {},
      timeout: 3000,
    }, (res: any) => { res.on('data', () => {}); res.on('end', () => resolve()); });
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    if (data) req.write(data);
    req.end();
  });
  ipcMain.on('vector:pause', () => { void vectorHttpPost('/api/vector/pause'); });
  ipcMain.on('vector:resume', () => { void vectorHttpPost('/api/vector/resume'); });

  /**
   * Tray 菜单的"导入历史对话…"入口。
   *
   * 工作分两步:
   *   1. 激活 ImportProgressPoller — 此后它会 2s 轮询 /api/import/status
   *      并 emit 'snapshot' 给 Tray + Panel
   *   2. POST /api/import/run, Worker 进程内启动 runImport (NOT 子进程,
   *      保证 SDKAgent 拿到 Desktop 注入的 API key)
   *
   * 重复触发安全: Worker 端 /api/import/run 自带 409 re-entrancy guard;
   * 这里再加一层"已在跑就只激活 poller 不再 POST"的本地短路, 避免无谓 HTTP。
   */
  const triggerImportHistory = (): void => {
    importPoller.activate();
    void vectorHttpPost('/api/import/run', {});
    new Notification({
      title: 'AgentMemory',
      body: '已开始导入历史对话，进度将显示在右下角浮窗。',
    }).show();
  };

  /**
   * 拿一次 /api/import/discover 的结果给 SetupWizard 用。
   *
   * Wizard 的 IPC handler `setup:discover-import` 调用这里 → 返回精简的
   * { totalFiles, perAdapter[] }。Wizard 据此决定是否显示"☑ 同时导入
   * X 条历史对话"那个 checkbox(totalFiles=0 时直接隐藏,避免打扰从未用过
   * 这些 IDE 的用户)。
   *
   * 容错: Worker 还没起来 / 端点 503 时返回空,wizard 静默隐藏勾选项。
   */
  const discoverImportSummaryForWizard = async (): Promise<{
    totalFiles: number;
    perAdapter: Array<{ id: string; files: number }>;
  }> => {
    try {
      const port = require('./config/store').getConfig().port;
      const data = await new Promise<string>((resolve) => {
        const req = require('http').get(
          `http://127.0.0.1:${port}/api/import/discover`,
          { timeout: 5000 },
          (res: any) => {
            let buf = '';
            res.on('data', (c: any) => (buf += c));
            res.on('end', () => resolve(buf));
          },
        );
        req.on('error', () => resolve(''));
        req.on('timeout', () => { req.destroy(); resolve(''); });
      });
      if (!data) return { totalFiles: 0, perAdapter: [] };
      const parsed = JSON.parse(data) as {
        success: boolean;
        report?: {
          totalFiles: number;
          adapters: Array<{ adapterId: string; files: unknown[] }>;
        };
      };
      if (!parsed.success || !parsed.report) {
        return { totalFiles: 0, perAdapter: [] };
      }
      return {
        totalFiles: parsed.report.totalFiles,
        perAdapter: parsed.report.adapters.map((a) => ({
          id: a.adapterId,
          files: a.files.length,
        })),
      };
    } catch {
      return { totalFiles: 0, perAdapter: [] };
    }
  };

  trayManager = new TrayManager(
    workerManager,
    (anchorBounds) => quickPanel.toggle(anchorBounds),
    () => settingsWindow.show(),
    (opts) => viewerWindow.show(opts),
    (ms) => vectorProgressPanel.suppressCloseFor(ms),
    () => triggerImportHistory(),
  );
  trayManager.init();

  // Initialize update checker
  updateChecker = new UpdateChecker();
  updateChecker.on('update-available', (info) => {
    trayManager.setUpdateInfo(info);
  });
  trayManager.setCheckUpdateHandler(async () => {
    const info = await updateChecker.checkNow();
    if (!info) {
      new Notification({
        title: 'AgentMemory',
        body: `当前已是最新版本 v${app.getVersion()}`,
      }).show();
    }
  });
  updateChecker.start();

  // Worker → Tray 索引进度桥接(2s 轮询 /api/vector/status)
  vectorPoller = new VectorProgressPoller(workerManager);
  vectorProgressPanel = new VectorProgressPanel();
  // 当 import:done 触发了自动 reindex 时,我们把"刚刚导入了多少条"记下来。
  // 等 vectorPoller 看到 running -> done 的状态翻转就 fire 一条"向量库已就绪"的
  // 通知,把"导入 → 重建 → 可搜索"这条链给用户看完整。
  let autoReindexExpected = false;
  let autoReindexImportedCount = 0;
  let lastVectorRunning = false;
  vectorPoller.on('snapshot', (snap: VectorStatusSnapshot) => {
    trayManager.setVectorStatus(snap);
    vectorProgressPanel.feed(snap);
    const running = snap?.indexer?.status === 'running';
    if (autoReindexExpected && lastVectorRunning && !running) {
      // 自动 reindex 跑完了,通知用户搜索已就绪,清旗。
      autoReindexExpected = false;
      const obs = snap?.vectorIndex?.summaries ?? snap?.indexer?.summaries?.embedded ?? 0;
      new Notification({
        title: 'AgentMemory',
        body: `向量库已自动重建完成（已嵌入 ${obs} 条 summary，含本次新导入的 ${autoReindexImportedCount} 条）。现在用 search 就能命中新记忆。`,
      }).show();
      autoReindexImportedCount = 0;
    }
    lastVectorRunning = running;
  });
  vectorPoller.start();

  // Worker → Tray 历史导入进度桥接(opt-in 轮询 /api/import/status)
  importPoller = new ImportProgressPoller(workerManager);
  importProgressPanel = new ImportProgressPanel();
  importPoller.on('snapshot', (snap: ImportProgressSnapshot | null) => {
    importProgressPanel.feed(snap);
    const running =
      snap?.phase === 'discovering' || snap?.phase === 'running';
    trayManager.setImportInProgress(!!running);
    if (snap?.phase === 'done') {
      const imported = snap.importedSummaries;
      // Worker 端如果导入了 >0 条,会直接调 hybridIndexer.reindexAll();
      // 我们这里把 expected 旗子立起来,vectorPoller 看到 running→done 就发收尾通知。
      if (imported > 0) {
        autoReindexExpected = true;
        autoReindexImportedCount = imported;
      }
      new Notification({
        title: 'AgentMemory',
        body:
          imported > 0
            ? `历史对话导入完成：成功 ${imported} · 跳过 ${snap.skippedSessions} · 失败 ${snap.failedSessions}。\n向量库正在自动重建,完成后会再提示。`
            : `历史对话导入完成：无新增（跳过 ${snap.skippedSessions} · 失败 ${snap.failedSessions}）。`,
      }).show();
    } else if (snap?.phase === 'failed') {
      new Notification({
        title: 'AgentMemory',
        body: `历史对话导入失败：${snap.errorMessage ?? '未知错误'}`,
      }).show();
    }
  });
  importPoller.start();

  const config = getConfig();
  app.setLoginItemSettings({
    openAtLogin: config.openAtLogin,
    openAsHidden: true,
  });

  await workerManager.start();
  codexTranscriptWatcher = new CodexTranscriptWatcher(getHooksPaths());
  codexTranscriptWatcher.start();

  new Notification({
    title: 'AgentMemory',
    body: `服务已启动，运行在 localhost:${config.port}`,
  }).show();

  // Handle cmem:// URL from initial launch (Windows/Linux startup args)
  const initialInvite = findInviteUrl(process.argv);
  if (initialInvite) {
    handleInviteUrl(initialInvite);
  }

  if (hooksRegistrar.isFirstRun()) {
    setupWizard = new SetupWizard(
      hooksRegistrar,
      () => {
        setupWizard?.destroy();
        setupWizard = null;
      },
      // Wizard "完成时勾选导入" 入口 — 直接复用托盘那条调用链。
      () => triggerImportHistory(),
      // 用于在 wizard 中显示"X 条历史对话可导入"的扫盘探针 (cheap, no AI)。
      () => discoverImportSummaryForWizard(),
    );
    setupWizard.show();
  } else if (hooksRegistrar.hasNewUnregisteredIDEs()) {
    const unregistered = hooksRegistrar
      .detectIDEs()
      .filter((d) => d.type !== 'openclaw' && !d.isRegistered);
    const succeeded: string[] = [];
    const failed: string[] = [];
    for (const ide of unregistered) {
      const result = hooksRegistrar.register(ide.type);
      if (result.success) {
        succeeded.push(IDE_DISPLAY_NAME[ide.type] ?? ide.type);
      } else {
        failed.push(IDE_DISPLAY_NAME[ide.type] ?? ide.type);
      }
    }
    if (succeeded.length > 0) {
      new Notification({
        title: 'AgentMemory',
        body: `已自动关联 ${succeeded.join('、')}。`,
      }).show();
    }
    if (failed.length > 0) {
      new Notification({
        title: 'AgentMemory',
        body: `${failed.join('、')} 自动关联失败，请在设置中手动关联。`,
      }).show();
    }
  }

  try {
    if (hooksRegistrar.ensureOpenClawUpToDate()) {
      console.log('[OpenClaw] plugin auto-upgraded to latest template');
    }
  } catch { /* upgrade path must not block startup */ }

  // 2.1.0-beta.7+:升级兜底 — 为已关联但还没收到 MCP 自动配置的 IDE 补一遍。
  // 幂等;新装机 / 已是 beta.7+ 注册的 IDE 都是 noop。失败仅 log,不阻塞启动。
  try {
    const mcpResults = hooksRegistrar.ensureMcpConfiguredForRegisteredIdes();
    const updated = mcpResults.filter((r) => r.success && r.action !== 'noop');
    const failed = mcpResults.filter((r) => !r.success);
    if (updated.length > 0) {
      const labels = updated.map((r) => IDE_DISPLAY_NAME[r.ide] ?? r.ide).join('、');
      new Notification({
        title: 'AgentMemory',
        body: `已为 ${labels} 自动写入 agentmem MCP 配置,IDE 重启后生效。`,
      }).show();
    }
    for (const r of failed) {
      console.warn(`[MCP auto-config] ${r.ide} skipped: ${r.error}`);
    }
  } catch (err) {
    console.warn('[MCP auto-config] backfill threw:', err);
  }

  // 启动时**静默**清理跨 scope 残留(perMachine vs perUser 双装) — 用户无感
  // 完成卸载后再 startHooksGuard,refreshAllWrappers 会基于已清理状态重写 wrapper
  // 实现真正的"覆盖安装",不再依赖用户点通知。
  await autoCleanupCrossScopeResidue();

  startHooksGuard();

  // 启动后自动检测 / 静默补导入历史会话。
  // 设计意图（per-session 范式）:
  //   - 真实场景: 用户装了 AgentMemory 后中间退出过、或者刚装 AgentMemory 还没用过, 期间在
  //     IDE 里发生的会话 hook 都没抓到 → 启动后自动扫一遍, 补 hook 没记录的;
  //   - 重复保护: 服务端 fingerprint 表 (adapterId+sessionId) 防自跑重复;
  //     hook-overlap 时段 + project 双重判定防跟在线 hook 重复;
  //   - 静默: 不弹大窗, 不打断用户; 只在右下角浮窗里悄悄走完, done 后 toast。
  //   - 容错: Worker 还没就绪 / API key 没配 / 其它错都 swallow, 不阻塞启动。
  //   - 时机: Worker.start() 已 await 完, 但留 5s 让向量重建之类的早期工作
  //     先吃带宽; 5s 后才发 /api/import/run。
  const scheduleAutoImportProbe = (): void => {
    const POST_START_DELAY_MS = 5_000;
    setTimeout(() => {
      void (async () => {
        try {
          const port = require('./config/store').getConfig().port;
          // 先 cheap discover 看有没有候选。零候选直接退出, 完全不打扰。
          const summary = await discoverImportSummaryForWizard();
          if (!summary || summary.totalFiles === 0) return;
          // 激活 progress poller 然后请 Worker 跑一次。Worker 端的指纹和
          // hook-overlap 过滤会决定哪些真的会被导入, 不会重复 hook 已抓的。
          importPoller.activate();
          await new Promise<void>((resolve) => {
            const data = JSON.stringify({});
            const req = require('http').request(
              {
                host: '127.0.0.1',
                port,
                path: '/api/import/run',
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(data),
                },
                timeout: 5000,
              },
              (res: any) => { res.on('data', () => {}); res.on('end', () => resolve()); },
            );
            req.on('error', () => resolve());
            req.on('timeout', () => { req.destroy(); resolve(); });
            req.write(data);
            req.end();
          });
        } catch (err) {
          console.warn('[auto-import] probe failed (silently swallowed):', err);
        }
      })();
    }, POST_START_DELAY_MS);
  };
  scheduleAutoImportProbe();
});

/**
 * 启动时检测跨 scope 残留:同一机器上是否同时存在两份 AgentMemory 安装。
 *
 * 背景:NSIS 在 perMachine(HKLM,Program Files)和 perUser(HKCU,
 *   AppData\Local\Programs)是两套独立的 Uninstall 注册条目,装/卸互不
 *   感知。早期版本(或用户当年手动选过 Program Files 路径)留下的另一份
 *   AgentMemory 安装,新版升级时不会自动清掉,会出现:
 *     - 两份 AgentMemory 同时存在
 *     - IDE 的 wrapper(尤其 cursor 的 .cjs)硬编码到其中一份的绝对路径
 *     - 哪份 AgentMemory 先启动,wrapper 就指向谁,导致来源标签 / source_ide 不稳定
 *
 * 本函数: 静默自动卸载残留版本,真正实现"覆盖安装",用户无感。
 * 1. 扫 HKLM + HKCU 注册表找所有 InstallLocation != 当前 .exe 目录的 AgentMemory 安装
 * 2. 杀掉这些残留安装目录下正在跑的 AgentMemory 进程(以 .exe path prefix 匹配,只杀
 *    那一份,不会误伤当前 AgentMemory 自己)
 * 3. 调 UninstallString /S 静默卸载
 * 4. 等卸载目录消失或超时 30s
 *
 * 数据安全:UninstallString 是该旧版自带的卸载器,行为遵循 installer.nsh
 * 的 customUnInstall — 只删 ${INSTDIR}\bin\ 里的几个 .cmd 启动器,不动
 * ~/.agent-memory/ 用户数据。SQLite 主库与向量库都安全。
 *
 * 失败兜底:任何一步失败都 swallow,不阻塞启动。失败时退化为"双装并存"
 * 状态,refreshAllWrappers 仍能把 wrapper 抢回当前 AgentMemory,功能不受损。
 */
async function autoCleanupCrossScopeResidue(): Promise<void> {
  try {
    const currentExeDir = path.dirname(app.getPath('exe'));
    const residues = await scanLegacyInstallEntries();
    const stale = residues.filter(
      (r) =>
        r.installLocation &&
        path.normalize(r.installLocation).toLowerCase() !==
          path.normalize(currentExeDir).toLowerCase(),
    );
    if (stale.length === 0) return;

    for (const r of stale) {
      console.log(
        `[CrossScopeCleanup] auto-uninstalling stale AgentMemory: scope=${r.scope} ` +
          `at "${r.installLocation}"`,
      );
      try {
        await killProcessesUnderPath(r.installLocation);
        await runSilentUninstall(r.uninstallString);
        await waitForPathGone(r.installLocation, 30_000);
        console.log(`[CrossScopeCleanup] cleaned: ${r.installLocation}`);
      } catch (e) {
        console.warn(`[CrossScopeCleanup] cleanup failed for ${r.installLocation}:`, e);
      }
    }

    if (stale.length > 0) {
      try {
        new Notification({
          title: 'AgentMemory',
          body: '已自动清理旧版残留,当前安装是唯一在用的版本。',
        }).show();
      } catch { /* notifications disabled — silent ok */ }
    }
  } catch (e) {
    console.warn('[CrossScopeCleanup] non-fatal error:', e);
  }
}

/**
 * 杀掉指定目录(含子目录)下任何 AgentMemory 进程。
 * 不会误伤当前 AgentMemory 自己 — 通过 ExecutablePath 前缀匹配,只杀那一份残留的进程。
 */
async function killProcessesUnderPath(installDir: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const target = path.normalize(installDir).toLowerCase();
  const myPid = process.pid;

  // PowerShell 列举 AgentMemory 进程,过滤 ExecutablePath 在残留目录下的
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('AgentMemory.exe','CodeBuddy Memory.exe') } | ` +
    `Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress`;
  let stdout: string;
  try {
    stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
        { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
        (err, out) => (err ? reject(err) : resolve(out)),
      );
    });
  } catch {
    return;
  }

  let entries: Array<{ ProcessId: number; ExecutablePath?: string }> = [];
  try {
    const parsed = JSON.parse(stdout || '[]');
    entries = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return;
  }

  for (const e of entries) {
    if (!e?.ExecutablePath || !e.ProcessId) continue;
    if (e.ProcessId === myPid) continue;
    const exe = path.normalize(e.ExecutablePath).toLowerCase();
    if (!exe.startsWith(target)) continue;
    await new Promise<void>((resolve) => {
      execFile('taskkill.exe', ['/PID', String(e.ProcessId), '/F', '/T'], () => resolve());
    });
  }
}

/**
 * 静默调用 UninstallString /S。UninstallString 通常长这样:
 *   "C:\Program Files\AgentMemory\Uninstall AgentMemory.exe" /currentuser
 * 我们解析出 .exe 路径,追加 /S 让它走 NSIS 的 silent 模式。
 */
async function runSilentUninstall(uninstallString: string): Promise<void> {
  if (process.platform !== 'win32') return;
  if (!uninstallString) return;
  const m = uninstallString.match(/^"?([^"]+\.exe)"?\s*(.*)$/i);
  if (!m) return;
  const exe = m[1];
  const restArgs = (m[2] || '').trim();
  const args: string[] = [];
  if (restArgs) {
    // 简单切分,UninstallString 里通常只有 /currentuser 这种纯参数,不带空格路径
    args.push(...restArgs.split(/\s+/).filter(Boolean));
  }
  if (!args.includes('/S')) args.push('/S');

  await new Promise<void>((resolve) => {
    const child = execFile(exe, args, { windowsHide: true }, () => resolve());
    // 双保险:30s 还没退出就放弃
    const t = setTimeout(() => {
      try { child.kill(); } catch { /* */ }
      resolve();
    }, 30_000);
    child.on('exit', () => clearTimeout(t));
  });
}

async function waitForPathGone(p: string, timeoutMs: number): Promise<void> {
  const fs = await import('fs');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!fs.existsSync(p)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

let hooksGuardTimer: ReturnType<typeof setInterval> | null = null;

interface UninstallEntry {
  scope: 'HKLM' | 'HKCU';
  displayName: string;
  installLocation: string;
  uninstallString: string;
}

/**
 * 扫 HKLM 和 HKCU 的 Uninstall 注册表,返回 DisplayName 含 "AgentMemory"
 * 的所有条目。Windows-only;非 Windows 平台直接返回空数组。
 */
async function scanLegacyInstallEntries(): Promise<UninstallEntry[]> {
  if (process.platform !== 'win32') return [];
  const out: UninstallEntry[] = [];
  const roots: Array<{ scope: 'HKLM' | 'HKCU'; key: string }> = [
    { scope: 'HKLM', key: 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' },
    { scope: 'HKLM', key: 'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall' },
    { scope: 'HKCU', key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' },
  ];
  for (const root of roots) {
    try {
      // /s = 递归;/f "AgentMemory" /d 在 DisplayName 值里找;/t REG_SZ
      const stdout = await regQuery(root.key);
      const blocks = stdout.split(/\r?\n\r?\n/);
      for (const block of blocks) {
        const dn = /DisplayName\s+REG_SZ\s+(.+)/.exec(block);
        if (!dn || !/(?:AgentMemory|CodeBuddy Memory)/i.test(dn[1])) continue;
        const il = /InstallLocation\s+REG_SZ\s+(.+)/.exec(block);
        const us = /UninstallString\s+REG_SZ\s+(.+)/.exec(block);
        out.push({
          scope: root.scope,
          displayName: dn[1].trim(),
          installLocation: (il?.[1] ?? '').trim(),
          uninstallString: (us?.[1] ?? '').trim(),
        });
      }
    } catch {
      /* 没那个 key 是正常的(尤其 WOW6432Node),跳过 */
    }
  }
  return out;
}

function regQuery(key: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'reg.exe',
      ['query', key, '/s'],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });
}

/**
 * 启动时强制刷新所有已注册 IDE 的 wrapper 文件。
 *
 * 解决跨版本升级时 wrapper 没被刷新的产品 bug:
 *   - HooksGuard 只对 !isRegistered 的 IDE 调 register(),已注册的从不重刷
 *   - 但 wrapper 文件(~/.agent-memory/hooks/agentmemory-*.cmd 和
 *     ~/.cursor/hooks/agent-memory.cjs)可能停在旧版本(硬编码上一次
 *     安装位置 / 缺少 AGENTMEM_IDE 注入),IDE 调到时跑的是错的二进制
 *
 * 修复思路: 每次 AgentMemory 启动,对所有"检测到 + 已注册"的 IDE 跑一次 register(),
 * register() 内部会调 ensureXxxProxyCmd/Script 把 wrapper 重写成当前 AgentMemory
 * 版本。整个过程幂等,hooks.json 同内容会被无害覆盖,只是文件 mtime 更新。
 *
 * 不动 !isRegistered 的 IDE: 那些走"自动关联"的 setup 流程,本函数不抢路。
 */
function refreshAllWrappers(): void {
  try {
    const ides = hooksRegistrar.detectIDEs();
    for (const ide of ides) {
      if (ide.type === 'openclaw') continue;
      if (!ide.isRegistered) continue; // 留给"自动关联"分支处理
      try {
        const result = hooksRegistrar.register(ide.type);
        if (result.success) {
          console.log(`[HooksGuard] Refreshed wrapper for ${ide.type} on AgentMemory start`);
        }
      } catch (e) {
        console.warn(`[HooksGuard] Refresh failed for ${ide.type}:`, e);
      }
    }
  } catch (e) {
    console.warn('[HooksGuard] refreshAllWrappers detectIDEs failed:', e);
  }
}

function startHooksGuard(): void {
  const INTERVAL_MS = 60_000;
  // 启动时立即跑一次,把 wrapper 文件刷新到当前 AgentMemory 版本(覆盖跨版本残留:
  // 比如 cursor 的 .cjs 还在硬编码上一次安装的路径,或者 wrapper 还没有
  // AGENTMEM_IDE 注入)。已注册的 IDE 也强制刷一次,使本次安装的 hooksCliPath
  // / nodePath 真正写入磁盘。register() 是幂等的:hooks.json 同内容会被无害
  // 覆盖,只刷新 wrapper 部分。
  refreshAllWrappers();
  hooksGuardTimer = setInterval(() => {
    try {
      const ides = hooksRegistrar.detectIDEs();
      for (const ide of ides) {
        if (ide.type === 'openclaw') continue;
        if (!ide.isRegistered) {
          const result = hooksRegistrar.register(ide.type);
          if (result.success) {
            console.log(`[HooksGuard] Re-registered hooks for ${ide.type} (hooks.json was modified externally)`);
          }
        }
      }
    } catch { /* swallow to keep timer alive */ }
  }, INTERVAL_MS);
}

app.on('before-quit', async () => {
  if (hooksGuardTimer) {
    clearInterval(hooksGuardTimer);
    hooksGuardTimer = null;
  }
  updateChecker?.destroy();
  setupWizard?.destroy();
  setupWizard = null;
  vectorPoller?.stop();
  vectorProgressPanel?.destroy();
  importPoller?.stop();
  importProgressPanel?.destroy();
  codexTranscriptWatcher?.stop();
  codexTranscriptWatcher = null;
  trayManager?.destroy();
  quickPanel?.destroy();
  settingsWindow?.destroy();
  viewerWindow?.destroy();
  ipcMain.removeHandler('viewer:open');
  await workerManager?.destroy();
});

app.on('window-all-closed', () => {
  // Keep running as tray app
});
