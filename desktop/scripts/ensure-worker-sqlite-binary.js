/**
 * 确保打包进安装包的 better-sqlite3 native 二进制与 bundled node.exe 的 ABI 匹配。
 *
 * 背景：
 * - Windows 打包时 desktop/package.json 的 build.win.extraResources 直接把
 *   ../node_modules/better-sqlite3 整个拷到安装包里。
 * - 如果开发机 `npm install` 时用的系统 Node 版本和我们 bundle 进去的 node.exe
 *   版本不一致（例如系统 Node v24 ABI 137 vs bundled Node v22 ABI 127），
 *   worker 启动加载 .node 文件就会抛 NODE_MODULE_VERSION 不匹配。
 *
 * 这个脚本会：
 *   1. 读取 build-resources/node.exe 的版本号（必须先跑过 bundle-node.js）。
 *   2. 调 prebuild-install 下载对应版本的预编译二进制，覆盖
 *      ../node_modules/better-sqlite3/build/Release/better_sqlite3.node。
 *   3. 用 bundled node.exe 真实加载一次，验证不再 ABI 报错。
 *
 * 仅 Windows 需要。Mac 走 prepare-worker-modules.js 的 electron-rebuild 路径。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const desktopRoot = path.join(__dirname, '..');
const repoRoot = path.join(desktopRoot, '..');
const buildResourcesDir = path.join(desktopRoot, 'build-resources');
const bundledNodePath = path.join(buildResourcesDir, 'node.exe');
const sqliteModuleDir = path.join(repoRoot, 'node_modules', 'better-sqlite3');
const sqliteBinaryPath = path.join(sqliteModuleDir, 'build', 'Release', 'better_sqlite3.node');

function ensureExists(p, desc) {
  if (!fs.existsSync(p)) {
    throw new Error(`Missing ${desc}: ${p}`);
  }
}

function getBundledNodeVersion() {
  const out = execFileSync(bundledNodePath, ['-p', 'process.versions.node'], {
    encoding: 'utf8',
  }).trim();
  return out;
}

function getBundledNodeAbi() {
  return execFileSync(bundledNodePath, ['-p', 'process.versions.modules'], {
    encoding: 'utf8',
  }).trim();
}

function tryLoadWithBundledNode() {
  // Use forward slashes for the JS string literal to avoid Windows backslash escaping issues.
  const moduleSpec = sqliteModuleDir.replace(/\\/g, '/');
  const probe = `try { const D = require('${moduleSpec}'); const db = new D(':memory:'); db.close(); console.log('OK'); } catch (e) { console.error('FAIL: ' + e.message); process.exit(2); }`;
  const result = spawnSync(bundledNodePath, ['-e', probe], { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
  };
}

function runPrebuildInstall(nodeVersion) {
  const prebuildCli = path.join(repoRoot, 'node_modules', 'prebuild-install', 'bin.js');
  ensureExists(prebuildCli, 'prebuild-install CLI (npm install in repo root first)');

  const args = [
    prebuildCli,
    '--runtime=node',
    `--target=${nodeVersion}`,
    '--arch=x64',
    '--platform=win32',
    '--force',
  ];

  console.log(`[ensure-sqlite] Running prebuild-install for Node ${nodeVersion} ...`);
  const result = spawnSync(process.execPath, args, {
    cwd: sqliteModuleDir,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(`prebuild-install failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function main() {
  if (process.platform !== 'win32') {
    console.log('[ensure-sqlite] Skipping (non-Windows platform).');
    return;
  }

  ensureExists(bundledNodePath, 'bundled node.exe (run bundle-node.js first)');
  ensureExists(sqliteModuleDir, 'better-sqlite3 in repo node_modules (run npm install first)');

  const nodeVersion = getBundledNodeVersion();
  const nodeAbi = getBundledNodeAbi();
  console.log(`[ensure-sqlite] Bundled node: v${nodeVersion} (ABI ${nodeAbi})`);

  const beforeProbe = tryLoadWithBundledNode();
  if (beforeProbe.ok) {
    console.log('[ensure-sqlite] better-sqlite3 already matches bundled node ABI. Nothing to do.');
    return;
  }

  console.log(`[ensure-sqlite] ABI mismatch detected: ${beforeProbe.stderr || '(no stderr)'}`);
  runPrebuildInstall(nodeVersion);

  const afterProbe = tryLoadWithBundledNode();
  if (!afterProbe.ok) {
    throw new Error(
      `[ensure-sqlite] Verification still failing after prebuild-install:\n${afterProbe.stderr}`
    );
  }

  const stats = fs.statSync(sqliteBinaryPath);
  console.log(
    `[ensure-sqlite] OK. Replaced ${path.relative(repoRoot, sqliteBinaryPath)} (${stats.size} bytes).`
  );
}

main();
