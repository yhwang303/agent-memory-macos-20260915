import { getAllIntegrations, detectInstalledIDEs, McpIntegrations, MCP_PLATFORMS } from '../services/integrations/index.js';
import type { InstallOptions } from '../services/integrations/types.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');

function resolveCliPaths() {
  const hooksCliPath = join(projectRoot, 'dist', 'hooks-cli.js').replace(/\\/g, '/');
  const mcpServerPath = join(projectRoot, 'dist', 'servers', 'mcp-server.js').replace(/\\/g, '/');
  return { hooksCliPath, mcpServerPath };
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

async function main(): Promise<void> {
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
    default:
      console.log('Usage:');
      console.log('  npx tsx src/cli/install.ts install [--all | <id>...]');
      console.log('  npx tsx src/cli/install.ts status');
      console.log('  npx tsx src/cli/install.ts uninstall <id>...');
      console.log('');
      console.log('Available integrations: cursor, windsurf, gemini-cli, opencode, codex-cli');
      console.log('MCP-only platforms: copilot-cli, antigravity, goose, crush, roo-code, warp');
      break;
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exitCode = 1;
});
