const path = require('path');
const Module = require('module');

const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'better-sqlite3') {
    const exeDir = path.dirname(process.execPath);
    const localPath = path.join(exeDir, 'node_modules', 'better-sqlite3', 'lib', 'index.js');
    try {
      require('fs').accessSync(localPath);
      return localPath;
    } catch {}
  }
  return origResolveFilename.call(this, request, parent, isMain, options);
};

require('./cli.cjs');
