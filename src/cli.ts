import { getDatabase, getDatabaseStats } from './services/sqlite/Database.js';
import { loadSettings } from './config/settings.js';
import { detectInstalledIDEs } from './services/integrations/ide-detection.js';
import { getAllIntegrations } from './services/integrations/index.js';
import { OpenClawInstaller } from './services/integrations/OpenClawInstaller.js';
import type { InstallOptions } from './services/integrations/types.js';
import { getDeviceIdentity, getSyncConfig } from './shared/identity.js';
import { ensureDataDir, getDataDir, getDatabasePath, getPidFilePath } from './shared/paths.js';
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { cmdImportHistory } from './cli/import-history.js';

/**
 * Resolve sibling dist/ scripts relative to this CLI module, not to the
 * caller's `node` binary. Critical for `npm i -g` installs where
 * `process.execPath` points to /usr/bin/node, not into the package.
 */
function resolveCliPaths() {
  const distDir = dirname(fileURLToPath(import.meta.url));
  const hooksCliPath = join(distDir, 'hooks-cli.js').replace(/\\/g, '/');
  const mcpServerPath = join(distDir, 'servers', 'mcp-server.js').replace(/\\/g, '/');
  const workerScript = join(distDir, 'bin', 'worker.js').replace(/\\/g, '/');
  return { hooksCliPath, mcpServerPath, workerScript };
}

function rowOk(label: string, msg: string): void   { console.log(`  ✓  ${label.padEnd(22)} ${msg}`); }
function rowWarn(label: string, msg: string): void { console.log(`  !  ${label.padEnd(22)} ${msg}`); }
function rowFail(label: string, msg: string): void { console.log(`  ✗  ${label.padEnd(22)} ${msg}`); }

async function probeRemote(url: string, token: string): Promise<{ ok: boolean; status: number; user?: string; message: string }> {
  try {
    const healthRes = await fetch(`${url.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(5000) });
    if (!healthRes.ok) {
      return { ok: false, status: healthRes.status, message: `/health 返回 ${healthRes.status}` };
    }
  } catch (err) {
    return { ok: false, status: 0, message: `连不上 /health：${String(err).slice(0, 120)}` };
  }
  if (!token) {
    return { ok: false, status: 0, message: 'REMOTE_TOKEN 未配置，跳过鉴权探测' };
  }
  try {
    const whoamiRes = await fetch(`${url.replace(/\/+$/, '')}/api/v1/whoami`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (whoamiRes.status === 401 || whoamiRes.status === 403) {
      return { ok: false, status: whoamiRes.status, message: 'token 被拒绝（401/403）' };
    }
    if (!whoamiRes.ok) {
      return { ok: false, status: whoamiRes.status, message: `whoami 返回 ${whoamiRes.status}` };
    }
    const data = await whoamiRes.json().catch(() => ({})) as { user?: { name?: string } };
    return { ok: true, status: 200, user: data?.user?.name, message: `已连上，user=${data?.user?.name ?? 'unknown'}` };
  } catch (err) {
    return { ok: false, status: 0, message: `whoami 探测异常：${String(err).slice(0, 120)}` };
  }
}

async function cmdDoctor(): Promise<void> {
  console.log('agent-memory doctor');
  console.log('===================');

  const nodeOk = parseInt(process.versions.node.split('.')[0], 10) >= 18;
  (nodeOk ? rowOk : rowFail)('Node.js', `${process.version} (要求 >= 18.0.0)`);
  rowOk('Platform', `${process.platform} ${process.arch}`);

  rowOk('Data dir', getDataDir());

  try {
    getDatabase();
    const stats = getDatabaseStats();
    rowOk('SQLite', `${getDatabasePath()} (${stats.observations} obs / ${stats.summaries} sum)`);
  } catch (e) {
    rowFail('SQLite', String(e).slice(0, 200));
  }

  try {
    const ident = getDeviceIdentity();
    rowOk('Device ID', `${ident.deviceId.slice(0, 8)}…  name=${ident.deviceName}`);
  } catch (e) {
    rowFail('Device ID', String(e));
  }

  try {
    const settings = loadSettings();
    if (settings.rag.enabled) {
      rowOk('RAG (Chroma)', `enabled · model=${settings.rag.embedding_model}`);
    } else {
      rowOk('RAG (Chroma)', 'disabled (SQLite-only — 服务端场景的默认选择)');
    }
  } catch {
    rowWarn('RAG (Chroma)', 'settings 读取失败，使用默认禁用');
  }

  const sync = getSyncConfig();
  if (!sync.remoteUrl) {
    rowWarn('Remote sync', 'CODEBUDDY_MEM_REMOTE_URL 未配置 — 数据只会留在本地');
  } else {
    const result = await probeRemote(sync.remoteUrl, sync.remoteToken || '');
    (result.ok ? rowOk : rowFail)('Remote sync', `${sync.remoteUrl} · ${result.message}`);
  }

  try {
    const detected = await detectInstalledIDEs();
    const found = detected.filter(d => d.detected);
    rowOk('IDE detected', `${found.length} (${found.map(d => d.displayName).join(', ') || 'none'})`);
  } catch {
    rowWarn('IDE detected', '检测失败（在纯服务端这是正常的）');
  }

  const pidPath = getPidFilePath();
  if (existsSync(pidPath)) {
    rowOk('Worker pid', `${pidPath} (run \`agent-memory worker status\` for details)`);
  } else {
    rowWarn('Worker pid', `${pidPath} 不存在 — worker 当前未由本 CLI 管理`);
  }
}

async function cmdInit(args: string[]): Promise<void> {
  const force = args.includes('--force');
  const inviteIdx = args.indexOf('--invite');
  const invite = inviteIdx >= 0 ? args[inviteIdx + 1] : undefined;

  const dataDir = ensureDataDir();
  console.log(`数据目录：${dataDir}`);

  // 触发 device.json 落盘
  const ident = getDeviceIdentity();
  console.log(`设备身份：${ident.deviceId.slice(0, 8)}… (${ident.deviceName})`);

  const settingsPath = join(dataDir, 'settings.json');
  if (existsSync(settingsPath) && !force) {
    console.log(`settings.json 已存在（${settingsPath}），跳过；如需覆盖请加 --force`);
  } else {
    const defaultSettings = {
      rag: {
        enabled: false,
        embedding_model: 'bge-m3',
        fallback_mode: 'sqlite-only',
        hybrid_weights: { sqlite: 0.4, chroma: 0.6 },
        rrf_k: 60,
      },
    };
    writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2), 'utf-8');
    console.log(`已写入默认配置：${settingsPath}`);
  }

  if (invite) {
    // cmem://host:port?token=xxx 形式的邀请链接
    try {
      const u = new URL(invite.replace(/^cmem:\/\//, 'http://'));
      const remoteUrl = `${u.protocol}//${u.host}`;
      const token = u.searchParams.get('token') || '';
      const envPath = join(dataDir, 'agent-memory.env');
      const lines = [
        `CODEBUDDY_MEM_REMOTE_URL=${remoteUrl}`,
        token ? `CODEBUDDY_MEM_REMOTE_TOKEN=${token}` : '# CODEBUDDY_MEM_REMOTE_TOKEN=（邀请链接里没有 token，请手工补上）',
        'CODEBUDDY_MEM_SYNC_ENABLED=true',
      ];
      writeFileSync(envPath, lines.join('\n') + '\n', { mode: 0o600 });
      console.log(`已从邀请链接生成：${envPath}（权限 600）`);
      console.log(`下一步：source ${envPath}  然后  agent-memory worker start`);
    } catch (e) {
      console.error(`邀请链接解析失败：${e}`);
      process.exitCode = 1;
      return;
    }
  } else {
    console.log('');
    console.log('下一步配置远端服务端（写入到环境变量或当前 shell）：');
    console.log('  export CODEBUDDY_MEM_REMOTE_URL=http://your-backend:8848');
    console.log('  export CODEBUDDY_MEM_REMOTE_TOKEN=<在 backend admin 控制台生成>');
    console.log('  agent-memory doctor          # 验证连通性');
    console.log('  agent-memory worker start    # 启动 worker (后台)');
  }
}

/**
 * 已部署 OpenClaw 插件版本与最新模板不一致时，静默重写。
 * 仅在 `worker start` / `worker restart` 入口触发，让老 npm 用户升级包后无需重跑 install
 * 即可自动拿到最新 hooks。任何失败都吞掉，不阻塞 worker 启动。
 */
function maybeUpgradeOpenClawPlugin(): void {
  try {
    const installer = new OpenClawInstaller();
    if (installer.ensureUpToDate()) {
      console.log('[OpenClaw] plugin auto-upgraded to latest template');
    }
  } catch {
    // best-effort
  }
}

async function cmdWorker(args: string[]): Promise<number> {
  const { workerScript } = resolveCliPaths();
  const sub = args[0];
  if (sub === 'start' || sub === 'restart') {
    maybeUpgradeOpenClawPlugin();
  }
  return new Promise<number>((resolveExit) => {
    const child = spawn(process.execPath, [workerScript, ...args], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => resolveExit(code ?? 0));
    child.on('error', (err) => {
      console.error('Failed to launch worker:', err);
      resolveExit(1);
    });
  });
}

async function cmdInstall(targets: string[]): Promise<void> {
  const { hooksCliPath, mcpServerPath } = resolveCliPaths();
  const opts: InstallOptions = { hooksCliPath, mcpServerPath };
  const integrations = getAllIntegrations();
  const all = targets.includes('--all');

  let toInstall = integrations;
  if (!all && targets.length > 0) {
    toInstall = integrations.filter(i => targets.includes(i.id));
    if (toInstall.length === 0) {
      console.log(`No matching integrations found for: ${targets.join(', ')}`);
      console.log(`Available: ${integrations.map(i => i.id).join(', ')}`);
      process.exitCode = 1;
      return;
    }
  }

  if (all) {
    const detected = await detectInstalledIDEs();
    const detectedIds = new Set(detected.filter(d => d.detected).map(d => d.id));
    toInstall = integrations.filter(i => detectedIds.has(i.id));
    console.log(`Auto-detected: ${toInstall.map(i => i.displayName).join(', ') || 'none'}`);
  }

  for (const integration of toInstall) {
    console.log(`\nInstalling ${integration.displayName}...`);
    try {
      const result = await integration.install(opts);
      if (result.success) {
        console.log(`  OK ${integration.displayName} installed`);
        for (const f of result.filesWritten) console.log(`    Written: ${f}`);
        for (const b of result.filesBackedUp) console.log(`    Backed up: ${b}`);
      } else {
        console.log(`  FAIL ${integration.displayName} failed`);
      }
      for (const w of result.warnings) console.log(`    WARNING: ${w}`);
    } catch (err) {
      console.log(`  FAIL ${integration.displayName} error: ${err}`);
    }
  }
}

async function cmdStatus(): Promise<void> {
  const integrations = getAllIntegrations();
  const detected = await detectInstalledIDEs();

  console.log('\nIDE Integration Status:\n');
  console.log('  ID                  Detected  Installed  Mechanism');
  console.log('  ------------------- --------  ---------  ---------');

  for (const d of detected) {
    const integration = integrations.find(i => i.id === d.id);
    let installed = false;
    let mechanism = 'mcp';
    if (integration) {
      const s = await integration.status();
      installed = s.installed;
      mechanism = integration.mechanism;
    }
    const det = d.detected ? 'yes' : 'no';
    const ins = installed ? 'yes' : 'no';
    console.log(`  ${d.id.padEnd(20)} ${det.padEnd(10)}${ins.padEnd(11)}${mechanism}`);
  }
}

async function cmdUninstall(targets: string[]): Promise<void> {
  const integrations = getAllIntegrations();
  const toUninstall = integrations.filter(i => targets.includes(i.id));

  if (toUninstall.length === 0) {
    console.log(`No matching integrations found for: ${targets.join(', ')}`);
    return;
  }

  for (const integration of toUninstall) {
    console.log(`Uninstalling ${integration.displayName}...`);
    const result = await integration.uninstall();
    for (const w of result.warnings) console.log(`  WARNING: ${w}`);
    console.log(`  Done.`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const targets = args.slice(1);

  switch (command) {
    case 'install':
      await cmdInstall(targets);
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'uninstall':
      await cmdUninstall(targets);
      break;
    case 'doctor':
      await cmdDoctor();
      break;
    case 'init':
      await cmdInit(targets);
      break;
    case 'worker': {
      const code = await cmdWorker(targets);
      if (code !== 0) process.exit(code);
      break;
    }
    case 'import-history': {
      const code = await cmdImportHistory(targets);
      if (code !== 0) process.exit(code);
      break;
    }
    case 'version':
    case '--version':
    case '-v': {
      // 版本号从 package.json 读，避免硬编码漂移
      try {
        const distDir = dirname(fileURLToPath(import.meta.url));
        const pkgPath = resolve(distDir, '..', 'package.json');
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
        console.log(pkg.version);
      } catch {
        console.log('2.0.2');
      }
      break;
    }
    default:
      console.log('agent-memory CLI · headless memory client for AgentMem backend');
      console.log('');
      console.log('Commands:');
      console.log('  init [--invite cmem://...]    Create ~/.agent-memory/ + default settings');
      console.log('  doctor                        Check system / sqlite / remote sync health');
      console.log('  worker start [--foreground]   Start worker (detached or foreground)');
      console.log('  worker stop|restart|status    Manage worker process');
      console.log('  install [--all | <id>...]     Install IDE / OpenClaw integrations');
      console.log('  status                        Show integration status');
      console.log('  uninstall <id>...             Remove integrations');
      console.log('  import-history [--dry-run]    Backfill historical IDE transcripts as summaries');
      console.log('  version                       Show version');
      console.log('');
      console.log('Typical Linux server flow:');
      console.log('  npm i -g agent-memory');
      console.log('  agent-memory init --invite cmem://my-backend:8848?token=xxx');
      console.log('  agent-memory doctor');
      console.log('  agent-memory worker start');
      console.log('  agent-memory install openclaw');
      break;
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exitCode = 1;
});
