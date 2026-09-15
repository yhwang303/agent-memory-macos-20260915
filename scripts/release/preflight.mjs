#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..', '..');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
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

function fail(message) {
  console.error(`[release:preflight] ERROR: ${message}`);
  process.exitCode = 1;
}

function warn(message) {
  console.warn(`[release:preflight] WARN: ${message}`);
}

const rootPkg = readJson(resolve(rootDir, 'package.json'));
const desktopPkg = readJson(resolve(rootDir, 'desktop', 'package.json'));
const expectedTag = `v${rootPkg.version}`;

console.log(`[release:preflight] version=${rootPkg.version}`);

if (rootPkg.version !== desktopPkg.version) {
  fail(`package versions differ: root=${rootPkg.version}, desktop=${desktopPkg.version}`);
}

const changelogPath = resolve(rootDir, 'CHANGELOG.md');
if (!existsSync(changelogPath)) {
  fail('CHANGELOG.md is missing');
} else {
  const changelog = readFileSync(changelogPath, 'utf8');
  if (!changelog.includes(`## [${rootPkg.version}]`)) {
    fail(`CHANGELOG.md has no entry for ${rootPkg.version}`);
  }
}

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], 'unknown');
const commit = git(['rev-parse', '--short=12', 'HEAD'], 'unknown');
const status = git(['status', '--short'], '');
console.log(`[release:preflight] branch=${branch} commit=${commit}`);

if (status) {
  const message = `working tree is not clean:\n${status}`;
  if (process.env.CI && process.env.RELEASE_ALLOW_DIRTY !== '1') {
    fail(message);
  } else {
    warn(message);
  }
}

const githubRefType = process.env.GITHUB_REF_TYPE;
const githubRefName = process.env.GITHUB_REF_NAME;
if (githubRefType === 'tag' && githubRefName !== expectedTag) {
  fail(`tag ${githubRefName} does not match package version ${expectedTag}`);
}

const exactTag = git(['describe', '--tags', '--exact-match'], '');
if (exactTag && exactTag !== expectedTag) {
  fail(`current git tag ${exactTag} does not match package version ${expectedTag}`);
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log('[release:preflight] OK');
