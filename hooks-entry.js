#!/usr/bin/env node

import { existsSync } from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.dirname(__filename);

const distEntry = path.join(projectRoot, 'dist', 'hooks-cli.js');
const srcEntry = path.join(projectRoot, 'src', 'hooks-cli.ts');
const tsxPackage = path.join(projectRoot, 'node_modules', 'tsx', 'package.json');

const hookArgs = process.argv.slice(2);

function spawnAndPipe(command, args) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env
  });

  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  child.on('error', (error) => {
    console.error('[Agent Memory] Failed to start hook entry:', error.message);
    process.exit(1);
  });

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}

if (existsSync(distEntry)) {
  spawnAndPipe(process.execPath, [distEntry, ...hookArgs]);
} else if (existsSync(tsxPackage)) {
  spawnAndPipe(process.execPath, ['--import', 'tsx', srcEntry, ...hookArgs]);
} else {
  console.error('[Agent Memory] Hook runtime not ready.');
  console.error('[Agent Memory] Run `npm install` first, or `npm run build` if you prefer using dist.');
  process.exit(1);
}
