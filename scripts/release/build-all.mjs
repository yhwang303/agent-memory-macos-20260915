#!/usr/bin/env node
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..', '..');
const desktopDir = resolve(rootDir, 'desktop');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function npmBin() {
  return 'npm';
}

function run(command, args, options = {}) {
  const useCmd = options.cmdShell && process.platform === 'win32';
  const actualCommand = useCmd ? 'cmd.exe' : command;
  const actualArgs = useCmd
    ? ['/d', '/s', '/c', [command, ...args].map(quoteCmdArg).join(' ')]
    : args;
  const result = spawnSync(actualCommand, actualArgs, {
    cwd: options.cwd || rootDir,
    env: { ...process.env, ...(options.env || {}) },
    stdio: 'inherit',
    shell: false,
  });
  if (result.status !== 0) {
    const reason = result.error ? ` (${result.error.message})` : '';
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}${reason}`);
  }
}

function quoteCmdArg(arg) {
  if (/^[A-Za-z0-9_./:=,\\-]+$/.test(arg)) return arg;
  return `"${String(arg).replaceAll('"', '\\"')}"`;
}

function git(args, fallback = '') {
  try {
    return execFileSync('git', args, {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return fallback;
  }
}

function parseTargets() {
  const arg = process.argv.find(a => a.startsWith('--targets='));
  const envTargets = process.env.RELEASE_TARGETS;
  const raw = arg ? arg.slice('--targets='.length) : envTargets;
  if (!raw) return ['npm', 'win', 'mac'];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function listFilesRecursive(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(path));
    } else {
      out.push(path);
    }
  }
  return out;
}

function sha256(path) {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

function copyMatching(srcDir, destDir, predicate) {
  ensureDir(destDir);
  const copied = [];
  for (const file of listFilesRecursive(srcDir)) {
    const name = file.replaceAll('\\', '/');
    if (!predicate(name)) continue;
    const target = join(destDir, file.split(/[\\/]/).pop());
    copyFileSync(file, target);
    copied.push(target);
  }
  return copied;
}

function writeManifest(versionDir, version, targets, skipped) {
  const files = listFilesRecursive(versionDir)
    .filter(file => !file.endsWith('manifest.json') && !file.endsWith('checksums.txt'))
    .sort()
    .map(file => {
      const rel = relative(versionDir, file).replaceAll('\\', '/');
      return {
        path: rel,
        size: statSync(file).size,
        sha256: sha256(file),
      };
    });

  const manifest = {
    name: 'agent-memory',
    version,
    builtAt: new Date().toISOString(),
    git: {
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], 'unknown'),
      commit: git(['rev-parse', 'HEAD'], 'unknown'),
    },
    platform: {
      os: process.platform,
      arch: process.arch,
      node: process.version,
    },
    targets,
    skipped,
    files,
  };

  writeFileSync(join(versionDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  writeFileSync(
    join(versionDir, 'checksums.txt'),
    files.map(file => `${file.sha256}  ${file.path}`).join('\n') + '\n',
    'utf8',
  );
  return manifest;
}

function buildNpm(versionDir) {
  const npmDir = join(versionDir, 'npm');
  ensureDir(npmDir);
  run(npmBin(), ['pack', '--pack-destination', npmDir], { cwd: rootDir, cmdShell: true });
}

function buildWindows(version, versionDir) {
  if (process.platform !== 'win32') {
    return `windows build skipped on ${process.platform}`;
  }

  run(npmBin(), ['--prefix', 'desktop', 'run', 'build:win'], { cwd: rootDir, cmdShell: true });
  const outDir = join(desktopDir, 'release5');
  const copied = copyMatching(outDir, join(versionDir, 'windows'), name =>
    name.endsWith(`AgentMemory-Setup-${version}.exe`) || name.endsWith(`AgentMemory-Setup-${version}.exe.blockmap`)
  );
  if (!copied.some(file => file.endsWith('.exe'))) {
    throw new Error(`Windows installer not found in ${outDir}`);
  }
  return null;
}

function buildMac(version, versionDir) {
  if (process.platform !== 'darwin') {
    return `macOS build skipped on ${process.platform}; use macOS or GitHub Actions`;
  }

  run(npmBin(), ['--prefix', 'desktop', 'run', 'build:mac:x64'], { cwd: rootDir, cmdShell: true });
  run(npmBin(), ['--prefix', 'desktop', 'run', 'build:mac:arm64'], { cwd: rootDir, cmdShell: true });
  const outDir = join(desktopDir, 'release5');
  const copied = copyMatching(outDir, join(versionDir, 'macos'), name =>
    name.endsWith(`AgentMemory-${version}-mac-x64.dmg`) ||
    name.endsWith(`AgentMemory-${version}-mac-x64.dmg.blockmap`) ||
    name.endsWith(`AgentMemory-${version}-mac-arm64.dmg`) ||
    name.endsWith(`AgentMemory-${version}-mac-arm64.dmg.blockmap`)
  );
  if (!copied.some(file => file.endsWith('.dmg'))) {
    throw new Error(`macOS dmg not found in ${outDir}`);
  }
  return null;
}

const rootPkg = readJson(join(rootDir, 'package.json'));
const desktopPkg = readJson(join(desktopDir, 'package.json'));
if (rootPkg.version !== desktopPkg.version) {
  throw new Error(`package versions differ: root=${rootPkg.version}, desktop=${desktopPkg.version}`);
}

const version = rootPkg.version;
const versionDir = join(rootDir, 'release-artifacts', `v${version}`);
const targets = parseTargets();
const skipped = [];

console.log(`[release] version=${version} targets=${targets.join(',')}`);
rmSync(versionDir, { recursive: true, force: true });
ensureDir(versionDir);

run(process.execPath, [join(rootDir, 'scripts', 'release', 'preflight.mjs')], { cwd: rootDir });

if (process.env.RELEASE_SKIP_TESTS !== '1') {
  run(npmBin(), ['run', 'typecheck'], { cwd: rootDir, cmdShell: true });
  run(npmBin(), ['test'], { cwd: rootDir, cmdShell: true });
  run(npmBin(), ['run', 'check:bun'], { cwd: rootDir, cmdShell: true });
}

if (targets.includes('npm')) {
  buildNpm(versionDir);
}

if (targets.includes('win') || targets.includes('windows')) {
  const reason = buildWindows(version, versionDir);
  if (reason) skipped.push({ target: 'windows', reason });
}

if (targets.includes('mac') || targets.includes('macos')) {
  const reason = buildMac(version, versionDir);
  if (reason) skipped.push({ target: 'macos', reason });
}

const manifest = writeManifest(versionDir, version, targets, skipped);

console.log('\n[release] artifacts');
for (const file of manifest.files) {
  console.log(`- ${file.path} (${file.size} bytes) sha256=${file.sha256}`);
}
if (skipped.length) {
  console.log('\n[release] skipped');
  for (const item of skipped) console.log(`- ${item.target}: ${item.reason}`);
}
console.log(`\n[release] output=${versionDir}`);
