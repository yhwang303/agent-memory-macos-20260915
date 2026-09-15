import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logFile = join(__dirname, 'logs', 'execution-probe.log');
const hookType = process.argv[2] || 'unknown';

let stdinData = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => stdinData += chunk);
process.stdin.on('end', () => {
  const info = {
    time: new Date().toISOString(),
    hookType,
    args: process.argv,
    cwd: process.cwd(),
    stdinPreview: stdinData.substring(0, 300),
    env_COMSPEC: process.env.COMSPEC,
    env_SHELL: process.env.SHELL,
    ppid: process.ppid
  };
  
  try { mkdirSync(join(__dirname, 'logs'), { recursive: true }); } catch(e) {}
  appendFileSync(logFile, JSON.stringify(info) + '\n');
  
  // Output valid response
  if (hookType === 'beforeSubmitPrompt') {
    process.stdout.write(JSON.stringify({ permission: 'allow', additional_context: 'probe working!' }));
  } else {
    process.stdout.write(JSON.stringify({ success: true }));
  }
  process.exitCode = 0;
});

// Safety timeout
setTimeout(() => {
  const info = { time: new Date().toISOString(), hookType, event: 'TIMEOUT', stdinLen: stdinData.length };
  try { appendFileSync(logFile, JSON.stringify(info) + '\n'); } catch(e) {}
  if (hookType === 'beforeSubmitPrompt') {
    process.stdout.write(JSON.stringify({ permission: 'allow', additional_context: 'timeout' }));
  } else {
    process.stdout.write(JSON.stringify({ success: true }));
  }
  process.exitCode = 0;
}, 5000);