// Simple test hook that just reads stdin and outputs JSON
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  const fs = require('fs');
  fs.writeFileSync('D:\\GitHub\\agent-memory\\logs\\simple-hook-probe.log', 
    'TIME: ' + new Date().toISOString() + '\nSTDIN: ' + data + '\nARGS: ' + JSON.stringify(process.argv) + '\n');
  process.stdout.write(JSON.stringify({permission: 'allow', additional_context: ''}));
  process.exitCode = 0;
});
setTimeout(() => {
  const fs = require('fs');
  fs.appendFileSync('D:\\GitHub\\agent-memory\\logs\\simple-hook-probe.log',
    'TIMEOUT reached\n');
  process.stdout.write(JSON.stringify({permission: 'allow', additional_context: ''}));
  process.exitCode = 0;
}, 5000);
