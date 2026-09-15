/**
 * prepare-models.js — 把 BGE-zh ONNX 模型文件搬到 desktop/build-resources/models/,
 * 让 electron-builder 通过 extraResources 打进 installer。
 *
 * 模型来源优先级:
 *   1. 已在 build-resources/models/ 下 → 直接跳过(idempotent,加速重复打包)
 *   2. ~/.agentMemory-hybrid-mcp/models/ → 复制(大多数开发机的本地缓存路径)
 *   3. ~/.agent-memory/models/ → 复制(AgentMemory 升级版本下的缓存路径)
 *   4. 从 hf-mirror 下载(CI / 全新机器兜底,需要网络)
 *
 * 必备文件清单 (with @xenova/transformers v2.17.2 + Xenova/bge-base-zh-v1.5):
 *   - config.json
 *   - tokenizer.json
 *   - tokenizer_config.json
 *   - onnx/model_quantized.onnx
 *
 * 总大小约 99 MB。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { URL } = require('url');

const MODEL_ID = 'Xenova/bge-base-zh-v1.5';
const REQUIRED_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_quantized.onnx',
];

const desktopRoot = path.join(__dirname, '..');
const targetRoot = path.join(desktopRoot, 'build-resources', 'models', MODEL_ID);
const homeDir = os.homedir();

const SOURCE_CANDIDATES = [
  path.join(homeDir, '.agentMemory-hybrid-mcp', 'models', MODEL_ID),
  path.join(homeDir, '.agent-memory', 'models', MODEL_ID),
];

const HF_MIRROR = process.env.HF_ENDPOINT || 'https://hf-mirror.com';

function logInfo(msg) {
  console.log(`[prepare-models] ${msg}`);
}
function logWarn(msg) {
  console.warn(`[prepare-models] WARN: ${msg}`);
}

function hasAllRequiredFiles(dir) {
  if (!fs.existsSync(dir)) return false;
  for (const rel of REQUIRED_FILES) {
    const full = path.join(dir, rel);
    if (!fs.existsSync(full)) return false;
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size === 0) return false;
  }
  return true;
}

function copyTreeSelective(srcRoot, dstRoot) {
  for (const rel of REQUIRED_FILES) {
    const srcPath = path.join(srcRoot, rel);
    const dstPath = path.join(dstRoot, rel);
    if (!fs.existsSync(srcPath)) {
      throw new Error(`Source missing required file: ${srcPath}`);
    }
    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    fs.copyFileSync(srcPath, dstPath);
    const sizeMB = (fs.statSync(dstPath).size / 1024 / 1024).toFixed(2);
    logInfo(`copied ${rel} (${sizeMB} MB)`);
  }
}

function downloadFile(url, dst, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      method: 'GET',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: { 'User-Agent': 'agentMemory-prepare-models/1.0' },
    };
    const req = https.request(opts, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) return reject(new Error(`Too many redirects: ${url}`));
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        return resolve(downloadFile(next, dst, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      const tmp = dst + '.tmp';
      const out = fs.createWriteStream(tmp);
      let bytes = 0;
      res.on('data', (chunk) => { bytes += chunk.length; });
      res.pipe(out);
      out.on('finish', () => {
        out.close((err) => {
          if (err) return reject(err);
          fs.renameSync(tmp, dst);
          const sizeMB = (bytes / 1024 / 1024).toFixed(2);
          logInfo(`downloaded ${path.relative(targetRoot, dst)} (${sizeMB} MB)`);
          resolve();
        });
      });
      out.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

async function downloadFromMirror() {
  logInfo(`falling back to ${HF_MIRROR}/${MODEL_ID}/resolve/main/...`);
  for (const rel of REQUIRED_FILES) {
    const url = `${HF_MIRROR}/${MODEL_ID}/resolve/main/${rel}`;
    const dst = path.join(targetRoot, rel);
    try {
      await downloadFile(url, dst);
    } catch (err) {
      throw new Error(`Failed to download ${rel}: ${err.message}`);
    }
  }
}

async function main() {
  if (hasAllRequiredFiles(targetRoot)) {
    logInfo(`models already staged at ${targetRoot} — skipping`);
    return;
  }

  fs.mkdirSync(targetRoot, { recursive: true });

  for (const candidate of SOURCE_CANDIDATES) {
    if (hasAllRequiredFiles(candidate)) {
      logInfo(`copying from local cache: ${candidate}`);
      copyTreeSelective(candidate, targetRoot);
      logInfo(`done — staged at ${targetRoot}`);
      return;
    }
  }

  logWarn(`no local cache found; will download from ${HF_MIRROR}`);
  if (process.env.CBM_NO_DOWNLOAD === '1') {
    throw new Error('CBM_NO_DOWNLOAD=1 set and no local cache; aborting.');
  }
  await downloadFromMirror();

  if (!hasAllRequiredFiles(targetRoot)) {
    throw new Error(`Post-download verification failed at ${targetRoot}`);
  }
  logInfo(`done — staged at ${targetRoot}`);
}

main().catch((err) => {
  console.error(`[prepare-models] FATAL: ${err.message}`);
  process.exit(1);
});
