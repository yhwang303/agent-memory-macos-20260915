/**
 * Stages the worker runtime dependencies for packaged builds and rebuilds
 * better-sqlite3 against the target Electron runtime ABI.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const desktopRoot = path.join(__dirname, '..');
const repoRoot = path.join(desktopRoot, '..');
const sourceNodeModules = path.join(repoRoot, 'node_modules');
const buildResourcesDir = path.join(desktopRoot, 'build-resources');
const stageRoot = path.join(buildResourcesDir, 'worker-node-modules-stage');
const stageNodeModules = path.join(stageRoot, 'node_modules');
const outputNodeModules = path.join(buildResourcesDir, 'worker-node-modules');
const rebuildCliPath = path.join(desktopRoot, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js');
const electronPackageJsonPath = path.join(desktopRoot, 'node_modules', 'electron', 'package.json');
const targetArch = process.env.TARGET_ARCH || process.arch;
const modulesToCopy = [
  // Worker 主库 (AgentMemory 现有依赖)
  'better-sqlite3',
  'bindings',
  'file-uri-to-path',
  'iconv-lite',
  'safer-buffer',
  // Hybrid 检索栈 (M4 新增 — sqlite-vec 向量库 + ONNX 嵌入模型推理)
  'sqlite-vec',
  // sqlite-vec 平台 native 二进制(macOS)
  'sqlite-vec-darwin-x64',
  'sqlite-vec-darwin-arm64',
  // ONNX 推理 + transformers
  '@xenova',
  '@huggingface',
  'onnxruntime-common',
  'onnxruntime-web',
  'onnxruntime-node',
  'protobufjs',
  '@protobufjs',
  'long',
  'guid-typescript',
  'flatbuffers',
  // sharp 是 @xenova/transformers v2 的 image.js 静态 import,虽然我们做 text embedding
  // 不真正调用它,但 ESM 静态 import 阶段会触发模块加载,因此必须随包打入
  'sharp',
  '@img',
  'detect-libc',
  'semver',
  'color',
  'color-convert',
  'color-name',
  'color-string',
  'simple-swizzle',
  'is-arrayish',
];

const dependencyClosureRoots = [
  '@modelcontextprotocol/sdk',
];

const copiedModules = new Set();

function ensureExists(filePath, description) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${description}: ${filePath}`);
  }
}

function resetDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyModule(moduleName) {
  if (copiedModules.has(moduleName)) return;
  const sourcePath = path.join(sourceNodeModules, moduleName);
  const destPath = path.join(stageNodeModules, moduleName);
  if (!fs.existsSync(sourcePath)) {
    // 平台特定的可选依赖在不匹配的平台上不存在(e.g. sqlite-vec-darwin-arm64 on x64),
    // 这些缺失是预期的,跳过即可。
    if (isPlatformSpecificOptional(moduleName)) {
      console.log(`Skipped optional platform-specific dependency (not installed on this host): ${moduleName}`);
      return;
    }
    throw new Error(`Missing worker runtime dependency "${moduleName}": ${sourcePath}`);
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.cpSync(sourcePath, destPath, { recursive: true, force: true });
  copiedModules.add(moduleName);
  console.log(`Staged dependency: ${moduleName}`);
}

function copyDependencyClosure(rootNames) {
  const queue = [...rootNames];
  const visited = new Set();

  while (queue.length > 0) {
    const moduleName = queue.shift();
    if (!moduleName || visited.has(moduleName)) continue;
    visited.add(moduleName);

    copyModule(moduleName);
    const packageJsonPath = path.join(sourceNodeModules, moduleName, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    queue.push(...Object.keys(packageJson.dependencies || {}));
  }
}

function isPlatformSpecificOptional(name) {
  // sqlite-vec 的 platform 包 + sharp 的 @img/sharp-* 平台包
  return /^sqlite-vec-(darwin|linux|win32)-/.test(name) ||
         /^@img\/sharp-(darwin|linux|win32|wasm32)-/.test(name) ||
         /^@img\/sharp-libvips-/.test(name);
}

function writeStagePackageJson() {
  const stagePackageJson = {
    name: 'agent-memoryory-worker-runtime',
    private: true,
    description: 'Staged worker runtime dependencies for desktop packaging',
  };

  fs.writeFileSync(
    path.join(stageRoot, 'package.json'),
    `${JSON.stringify(stagePackageJson, null, 2)}\n`,
    'utf8'
  );
}

function rebuildBetterSqlite3() {
  ensureExists(rebuildCliPath, 'electron-rebuild CLI');
  ensureExists(electronPackageJsonPath, 'Electron package metadata');

  const electronVersion = JSON.parse(fs.readFileSync(electronPackageJsonPath, 'utf8')).version;
  const rebuildArgs = [
    rebuildCliPath,
    '--version',
    electronVersion,
    '--module-dir',
    stageRoot,
    '--which-module',
    'better-sqlite3',
    '--arch',
    targetArch,
    '--force',
    '--build-from-source',
  ];

  console.log(`Rebuilding better-sqlite3 for Electron ${electronVersion} (${targetArch})...`);
  const result = spawnSync(process.execPath, rebuildArgs, {
    cwd: desktopRoot,
    env: process.env,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(`electron-rebuild failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function finalizeOutput() {
  fs.rmSync(outputNodeModules, { recursive: true, force: true });
  fs.renameSync(stageNodeModules, outputNodeModules);
  fs.rmSync(stageRoot, { recursive: true, force: true });
}

function main() {
  // Windows 打包不需要这一步：build.win.extraResources 直接拷 ../node_modules/better-sqlite3，
  // 由 ensure-worker-sqlite-binary.js 负责保证其 ABI 与 bundled node.exe 匹配。
  // 而本脚本依赖 electron-rebuild + node-gyp（需要 Python），仅 macOS 路径会用到 worker-node-modules。
  if (process.platform === 'win32') {
    console.log('[prepare-worker-modules] Skipping on Windows (handled by ensure-worker-sqlite-binary.js).');
    return;
  }

  ensureExists(sourceNodeModules, 'root node_modules');
  fs.mkdirSync(buildResourcesDir, { recursive: true });
  resetDir(stageNodeModules);
  writeStagePackageJson();

  for (const moduleName of modulesToCopy) {
    copyModule(moduleName);
  }
  copyDependencyClosure(dependencyClosureRoots);

  rebuildBetterSqlite3();
  finalizeOutput();

  console.log(`Prepared packaged worker dependencies at: ${outputNodeModules}`);
}

main();
