const fs = require('fs');
const logFile = 'D:\\GitHub\\agent-memory\\logs\\executor-probe.log';
const info = {
  args: process.argv,
  cwd: process.cwd(),
  env_keys: Object.keys(process.env).filter(k => k.match(/hook|script|command/i)),
  time: new Date().toISOString()
};
fs.writeFileSync(logFile, JSON.stringify(info, null, 2) + '\n');

// Read stdin
let stdinData = '';
process.stdin.on('data', (chunk) => { stdinData += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(logFile, 'STDIN: ' + stdinData + '\n');
  process.stdout.write(JSON.stringify({permission:'allow'}));
  process.exit(0);
});
setTimeout(() => {
  fs.appendFileSync(logFile, 'STDIN_TIMEOUT: ' + stdinData + '\n');
  process.stdout.write(JSON.stringify({permission:'allow'}));
  process.exit(0);
}, 3000);
