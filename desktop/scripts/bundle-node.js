/**
 * Prepares the packaged runtime used to execute worker/hooks scripts.
 *
 * - Windows keeps bundling the standalone node.exe binary.
 * - macOS bundles a tiny wrapper that re-invokes the app binary with
 *   ELECTRON_RUN_AS_NODE=1, avoiding Homebrew's dynamic lib dependencies.
 */
const fs = require('fs');
const path = require('path');

const desktopRoot = path.join(__dirname, '..');
const buildResourcesDir = path.join(desktopRoot, 'build-resources');
const packageJson = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'));
const productName = packageJson.build?.productName || 'AgentMemory';
const nodeBin = process.platform === 'win32' ? 'node.exe' : 'node';
const staleBins = ['node.exe', 'node'];
const destPath = path.join(buildResourcesDir, nodeBin);

function clearOldBinaries() {
  fs.mkdirSync(buildResourcesDir, { recursive: true });

  for (const bin of staleBins) {
    const binPath = path.join(buildResourcesDir, bin);
    if (fs.existsSync(binPath)) {
      fs.rmSync(binPath, { force: true });
    }
  }
}

function escapeForDoubleQuotedShell(value) {
  return value.replace(/(["\\$`])/g, '\\$1');
}

function writeDarwinWrapper() {
  const escapedProductName = escapeForDoubleQuotedShell(productName);
  const wrapper = `#!/bin/sh
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
APP_BIN="$SCRIPT_DIR/../MacOS/${escapedProductName}"
export ELECTRON_RUN_AS_NODE=1
exec "$APP_BIN" "$@"
`;

  console.log(`Bundling Electron Node wrapper: ${destPath}`);
  fs.writeFileSync(destPath, wrapper, { encoding: 'utf8', mode: 0o755 });
  fs.chmodSync(destPath, 0o755);
}

function copyStandaloneNode() {
  console.log(`Bundling Node.js runtime: ${process.execPath} -> ${destPath}`);
  fs.copyFileSync(process.execPath, destPath);
  if (process.platform !== 'win32') {
    fs.chmodSync(destPath, 0o755);
  }
}

clearOldBinaries();

if (process.platform === 'darwin') {
  writeDarwinWrapper();
} else {
  copyStandaloneNode();
}

const sizeKB = (fs.statSync(destPath).size / 1024).toFixed(1);
console.log(`Done. Size: ${sizeKB} KB`);
