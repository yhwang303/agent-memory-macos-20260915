const fs = require('fs');
const path = require('path');

// ============================================================================
// Configuration
// ============================================================================

const hooksDir = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.gongfeng-copilot',
  'hooks'
);
const hooksJsonPath = path.join(hooksDir, 'hooks.json');
const nodeScript = path.join(__dirname, 'dist', 'hooks-cli.js');

console.log('=== AgentMemory Hooks Fixer ===');
console.log(`Hooks dir: ${hooksDir}`);
console.log(`Node script: ${nodeScript}`);
console.log('');

// ============================================================================
// Step 1: Read and fix hooks.json (change .sh -> .cmd on Windows)
// ============================================================================

if (!fs.existsSync(hooksJsonPath)) {
  console.error(`ERROR: hooks.json not found at ${hooksJsonPath}`);
  console.error('Please configure hooks on the CodeBuddy web interface first.');
  process.exit(1);
}

let hooksJsonRaw = fs.readFileSync(hooksJsonPath, 'utf8');
if (hooksJsonRaw.charCodeAt(0) === 0xFEFF) {
  hooksJsonRaw = hooksJsonRaw.slice(1);
  console.log('  [INFO] Stripped UTF-8 BOM from hooks.json');
}
let hooksConfig;
try {
  hooksConfig = JSON.parse(hooksJsonRaw);
} catch (e) {
  console.error(`ERROR: Failed to parse hooks.json: ${e.message}`);
  process.exit(1);
}

console.log('[Step 1] Fixing hooks.json - replacing .sh -> .cmd in command paths...');

let fixedCount = 0;
const hookEntries = []; // Collect all hook entries for Step 2

if (hooksConfig.hooks) {
  for (const [eventName, hookList] of Object.entries(hooksConfig.hooks)) {
    if (!Array.isArray(hookList)) continue;
    for (const hook of hookList) {
      if (hook.command && (hook.command.endsWith('.sh') || hook.command.endsWith('.ps1'))) {
        const oldCmd = hook.command;
        hook.command = hook.command.replace(/\.(sh|ps1)$/, '.cmd');
        console.log(`  Fixed: ${path.basename(oldCmd)} -> ${path.basename(hook.command)}`);
        fixedCount++;
      }
      // Collect entry info
      if (hook.command) {
        const baseName = path.basename(hook.command).replace(/\.(sh|ps1|cmd|bat)$/, '');
        hookEntries.push({
          baseName,
          hookName: hook.trigger_event || eventName,
          commandPath: hook.command
        });
      }
    }
  }
}

// Write back fixed hooks.json
fs.writeFileSync(hooksJsonPath, JSON.stringify(hooksConfig, null, 2), 'utf8');
console.log(`  -> Fixed ${fixedCount} command paths in hooks.json`);
console.log('');

// ============================================================================
// Step 2: Generate .cmd files for each hook (CMD batch scripts)
// ============================================================================

console.log('[Step 2] Generating hook script files...');

for (const entry of hookEntries) {
  const { baseName, hookName } = entry;

  // Generate .cmd file (for Windows CMD executor)
  // No @echo off — the executor's :run_agentmemory branch reads script content.
  // No chcp — not always available in the executor environment.
  // First line starts with # so the executor skips it as a comment.
  const cmdPath = path.join(hooksDir, `${baseName}.cmd`);
  const cmdContent = `# AgentMemory hook script\r\nnode "${nodeScript}" ${hookName}\r\n`;
  fs.writeFileSync(cmdPath, cmdContent, 'utf8');
  console.log(`  Generated: ${baseName}.cmd -> ${hookName}`);

  // Also update .sh file (for bash/Unix environments or fallback)
  const shPath = path.join(hooksDir, `${baseName}.sh`);
  const shContent = [
    `node "${nodeScript}" ${hookName}`,
    ''
  ].join('\n');
  fs.writeFileSync(shPath, shContent, 'utf8');
  console.log(`  Updated:   ${baseName}.sh -> ${hookName}`);
}

console.log('');
console.log(`[Done] ${hookEntries.length} hooks processed.`);
console.log('');
console.log('Summary:');
console.log('  1. hooks.json: All .sh/.ps1 paths changed to .cmd');
console.log('  2. .cmd files: Generated with @echo off + node command (for cmd.exe executor)');
console.log('  3. .sh files: Updated with direct node calls (for Unix fallback)');
console.log('');
console.log('IMPORTANT: Make sure "Custom Hooks Executor Path" in CodeBuddy web is set to:');
console.log('  C:\\Windows\\System32\\cmd.exe');
console.log('');
console.log('If hooks stop working after web sync, just run: node update-hooks.cjs');
