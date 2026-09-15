const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const desktopRoot = path.join(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'));
const productName = packageJson.build?.productName || 'AgentMemory';
const targetArch = process.env.TARGET_ARCH || process.arch;
const appPath = process.env.MCP_APP_PATH || path.join(
  desktopRoot,
  'release5',
  `mac-${targetArch}`,
  `${productName}.app`,
);
const resourcesPath = path.join(appPath, 'Contents', 'Resources');
const nodePath = path.join(resourcesPath, 'node');

const servers = [
  ['hybrid', path.join(resourcesPath, 'hybrid-mcp', 'dist', 'server.js')],
  ['core', path.join(resourcesPath, 'worker', 'servers', 'mcp-server.js')],
];

for (const requiredPath of [appPath, nodePath, ...servers.map(([, serverPath]) => serverPath)]) {
  if (!fs.existsSync(requiredPath)) {
    throw new Error(`Missing packaged MCP runtime path: ${requiredPath}`);
  }
}

for (const [name, serverPath] of servers) {
  const result = spawnSync(nodePath, [serverPath], {
    input: '',
    encoding: 'utf8',
    timeout: 15_000,
    env: process.env,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.error || result.status !== 0 || /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(output)) {
    throw new Error(
      `${name} MCP packaged smoke test failed (status=${result.status}):\n${output.trim()}`,
      { cause: result.error },
    );
  }
  console.log(`[mcp-smoke] ${name} MCP started successfully`);
}
