const fs = require('fs');
const { spawn } = require('child_process');
const logFile = 'D:\\GitHub\\agent-memory\\logs\\executor-probe.log';

// Log all args
const info = {
  args: process.argv.slice(2),
  time: new Date().toISOString(),
  pid: process.pid
};
fs.writeFileSync(logFile, JSON.stringify(info, null, 2) + '\n');

// Find the script file from args
// Expected: node executor-probe.js /c "path/to/script.sh"  OR  node executor-probe.js "path/to/script.sh"
let scriptPath = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '/c' || args[i] === '-c') {
    scriptPath = args[i + 1];
    break;
  }
  if (args[i].endsWith('.sh') || args[i].endsWith('.bat') || args[i].endsWith('.cmd')) {
    scriptPath = args[i];
    break;
  }
}

if (!scriptPath) {
  fs.appendFileSync(logFile, 'ERROR: No script path found in args\n');
  process.stdout.write(JSON.stringify({permission:'allow'}));
  process.exit(0);
}

// Read script content and execute it
const scriptContent = fs.readFileSync(scriptPath, 'utf-8').trim();
fs.appendFileSync(logFile, 'Script: ' + scriptContent + '\n');

// Execute the script content via cmd.exe, piping stdin/stdout
const child = spawn('cmd.exe', ['/c', scriptContent], {
  stdio: ['pipe', 'pipe', 'pipe']
});

// Pipe stdin from parent to child
process.stdin.pipe(child.stdin);
// Pipe child stdout to parent stdout
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

child.on('exit', (code) => {
  fs.appendFileSync(logFile, 'Child exit code: ' + code + '\n');
  process.exit(code || 0);
});
