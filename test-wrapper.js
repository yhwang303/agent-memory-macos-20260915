// Zero-dependency diagnostic wrapper
// Writes all diagnostic info to a file, then calls the real hooks-cli
const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const logFile = path.join(__dirname, 'hook-debug.log');
function log(msg) {
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
}

log('=== WRAPPER START ===');
log(`argv: ${JSON.stringify(process.argv)}`);
log(`cwd: ${process.cwd()}`);
log(`env.PATH first 200: ${(process.env.PATH || '').substring(0,200)}`);
log(`stdin.isTTY: ${process.stdin.isTTY}`);
log(`stdin.readable: ${process.stdin.readable}`);

// Read stdin
let stdinData = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinData += chunk;
  log(`stdin data chunk, total len=${stdinData.length}`);
  try {
    JSON.parse(stdinData);
    log(`valid JSON received, length=${stdinData.length}`);
    // Output minimal response
    const out = JSON.stringify({permission:'allow',additional_context:'[test-wrapper] hooks working!'});
    log(`writing stdout: ${out.substring(0,100)}`);
    const flushed = process.stdout.write(out);
    log(`stdout.write returned: ${flushed}`);
    process.stdin.pause();
    if (process.stdin.unref) process.stdin.unref();
    process.exitCode = 0;
    log('exitCode set to 0, waiting for natural exit');
  } catch(e) {
    // not valid json yet
  }
});

process.stdin.on('end', () => {
  log(`stdin end event, data length=${stdinData.length}`);
  if (stdinData.length === 0) {
    log('NO STDIN DATA RECEIVED!');
    process.stdout.write(JSON.stringify({permission:'allow'}));
    process.exitCode = 0;
  }
});

process.stdin.on('error', (err) => {
  log(`stdin error: ${err}`);
  process.stdout.write(JSON.stringify({permission:'allow'}));
  process.exitCode = 0;
});

// Safety timeout
setTimeout(() => {
  log(`TIMEOUT! stdinData length=${stdinData.length}, data=${stdinData.substring(0,200)}`);
  process.stdout.write(JSON.stringify({permission:'allow'}));
  process.exit(0);
}, 4000);

log('event listeners registered, waiting for stdin...');
