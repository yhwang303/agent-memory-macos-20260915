/**
 * prepare-hybrid-mcp.js — 把 hybrid-mcp(agentmem-hybrid-mcp 的 vendored 副本)的产物
 * stage 到 desktop/build-resources/hybrid-mcp/。
 *
 * 思路:
 *   1. 源 = <repoRoot>/hybrid-mcp/(主仓内 vendor 的子目录),可被环境变量
 *      AGENTMEM_HYBRID_MCP_DIR 显式覆盖,主要给 CI 或单独检验场景用
 *   2. 先在源目录跑一次 `npm install --omit=dev` + `npm run build`,确保
 *      node_modules/undici 与 dist/ 都是最新的
 *   3. 复制 dist/ + package.json 到 build-resources/hybrid-mcp/
 *   4. 复制私有依赖 undici 到 hybrid-mcp/node_modules/
 *      其余依赖 (@modelcontextprotocol/sdk, @xenova/transformers, better-sqlite3,
 *      sqlite-vec, zod, zod-to-json-schema) 共享 AgentMemory 主 resources/node_modules/,
 *      Node 目录向上解析自动找到,不重复打包
 *   5. 在 hybrid-mcp/ 下额外写一份 agentmem-hybrid-mcp.cmd 模板,NSIS 安装时拷到 bin/
 *
 * 失败行为: 如果 hybrid-mcp/ 源不可达(理论上不会,因为已 vendor 进主仓),
 * prepare:bundle 不会因此失败,而是输出警告并跳过 — 这条退路保留给手动改了
 * sourceRoot 又写错路径的场景。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const desktopRoot = path.join(__dirname, '..');
const repoRoot = path.join(desktopRoot, '..');
const stageRoot = path.join(desktopRoot, 'build-resources', 'hybrid-mcp');
// 默认从 vendored 子目录拿源码;AGENTMEM_HYBRID_MCP_DIR env 可显式覆盖(开发期调试用)。
const sourceRoot = process.env.AGENTMEM_HYBRID_MCP_DIR || path.join(repoRoot, 'hybrid-mcp');

// undici 是 agentmem-hybrid-mcp 私有依赖,不在 AgentMemory 主 node_modules 里
// 其他依赖共享 AgentMemory 主 resources/node_modules,无需复制
const PRIVATE_DEPS = ['undici'];

function logInfo(msg) { console.log(`[prepare-hybrid-mcp] ${msg}`); }
function logWarn(msg) { console.warn(`[prepare-hybrid-mcp] WARN: ${msg}`); }

function buildSource() {
  const isWin = process.platform === 'win32';
  const npmCmd = isWin ? 'npm.cmd' : 'npm';

  // hybrid-mcp/ 是 vendored 进主仓的源码,不带 node_modules。先按需 install,
  // 只装 prod deps + tsc(它在 devDeps,但 build 需要它)。如果已经有 node_modules
  // 就跳过,加快重复构建。
  const nmDir = path.join(sourceRoot, 'node_modules');
  const tscBin = path.join(nmDir, 'typescript', 'bin', 'tsc');
  const undiciDir = path.join(nmDir, 'undici');
  if (!fs.existsSync(tscBin) || !fs.existsSync(undiciDir)) {
    logInfo(`installing hybrid-mcp deps at ${sourceRoot} (first time / cache miss) ...`);
    const inst = spawnSync(npmCmd, ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: sourceRoot,
      stdio: 'inherit',
      env: process.env,
      shell: isWin,
    });
    if (inst.status !== 0) {
      throw new Error(`hybrid-mcp npm install failed (exit ${inst.status})`);
    }
  } else {
    logInfo('hybrid-mcp node_modules already present — skipping npm install');
  }

  logInfo(`building source at ${sourceRoot} ...`);
  fs.rmSync(path.join(sourceRoot, 'dist'), { recursive: true, force: true });
  const result = spawnSync(npmCmd, ['run', 'build'], {
    cwd: sourceRoot,
    stdio: 'inherit',
    env: process.env,
    shell: isWin, // npm.cmd 需要走 shell, 否则 spawnSync 在某些环境下会 exit null
  });
  if (result.status !== 0) {
    throw new Error(`hybrid-mcp build failed (exit ${result.status})`);
  }
}

function copyTree(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true, force: true });
}

function stageDistAndPackage() {
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.mkdirSync(stageRoot, { recursive: true });

  const distSrc = path.join(sourceRoot, 'dist');
  const distDst = path.join(stageRoot, 'dist');
  if (!fs.existsSync(distSrc)) {
    throw new Error(`dist/ missing after build: ${distSrc}`);
  }
  copyTree(distSrc, distDst);
  logInfo(`staged dist/ → ${path.relative(desktopRoot, distDst)}`);

  // package.json 是必需的 — Node ESM 需要它来识别 "type": "module"
  const pkgSrc = path.join(sourceRoot, 'package.json');
  fs.copyFileSync(pkgSrc, path.join(stageRoot, 'package.json'));
  logInfo('staged package.json');

  // README + LICENSE (best-effort,不存在也不报错)
  for (const f of ['README.md', 'LICENSE']) {
    const s = path.join(sourceRoot, f);
    if (fs.existsSync(s)) {
      fs.copyFileSync(s, path.join(stageRoot, f));
    }
  }
}

function stagePrivateDeps() {
  const stageNm = path.join(stageRoot, 'node_modules');
  fs.mkdirSync(stageNm, { recursive: true });

  const sourceNm = path.join(sourceRoot, 'node_modules');
  for (const dep of PRIVATE_DEPS) {
    const src = path.join(sourceNm, dep);
    const dst = path.join(stageNm, dep);
    if (!fs.existsSync(src)) {
      throw new Error(
        `Private dep "${dep}" missing in agentmem-hybrid-mcp node_modules: ${src}\n` +
        `Run \`npm install --omit=dev\` inside ${sourceRoot} first.`
      );
    }
    copyTree(src, dst);
    logInfo(`staged private dep: ${dep}`);
  }
}

function writeWrapperTemplate() {
  // NSIS installer 安装时把这个文件拷到 ${INSTDIR}\bin\agentmem-hybrid-mcp.cmd 并加 PATH。
  // %~dp0 = 当前 .cmd 所在目录(末尾带反斜杠), .. = ${INSTDIR},
  // resources\node.exe + resources\hybrid-mcp\dist\server.js 都是 electron-builder 标准布局。
  const wrapper = [
    '@echo off',
    'rem agentmem-hybrid-mcp launcher — generated by AgentMemory installer',
    'rem do not edit; will be overwritten on upgrade',
    '"%~dp0..\\resources\\node.exe" "%~dp0..\\resources\\hybrid-mcp\\dist\\server.js" %*',
    '',
  ].join('\r\n');
  const wrapperPath = path.join(stageRoot, 'agentmem-hybrid-mcp.cmd');
  fs.writeFileSync(wrapperPath, wrapper, 'utf8');
  logInfo('wrote wrapper template: agentmem-hybrid-mcp.cmd');
}

function main() {
  if (!fs.existsSync(sourceRoot)) {
    logWarn(`source not found: ${sourceRoot}`);
    logWarn('skipping agentmem-hybrid-mcp staging — installer will NOT include the MCP bundle.');
    logWarn('Set AGENTMEM_HYBRID_MCP_DIR=<path> to override.');
    // create empty stage root with a marker file so extraResources doesn't fail
    fs.mkdirSync(stageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(stageRoot, '.MISSING'),
      'agentmem-hybrid-mcp source was not found at build time; MCP bundle absent.\n',
      'utf8'
    );
    return;
  }

  buildSource();
  stageDistAndPackage();
  stagePrivateDeps();
  writeWrapperTemplate();
  logInfo(`done — staged at ${stageRoot}`);
}

try {
  main();
} catch (err) {
  console.error(`[prepare-hybrid-mcp] FATAL: ${err.message}`);
  process.exit(1);
}
