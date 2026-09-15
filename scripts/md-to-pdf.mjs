/**
 * md-to-pdf.mjs
 * Convert a Markdown file to PDF using puppeteer-core + system Edge/Chrome
 * Usage: node scripts/md-to-pdf.mjs <input.md> [output.pdf]
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname, basename, join } from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function findBrowser() {
  if (readFileSync && require) {} // unused - just for type check
  try { readFileSync(EDGE_PATH); return EDGE_PATH; } catch {}
  for (const p of CHROME_PATHS) { try { readFileSync(p); return p; } catch {} }
  throw new Error('找不到 Chrome 或 Edge，请确认已安装');
}

function mdToHtml(mdContent) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  body {
    font-family: -apple-system, "Microsoft YaHei", "PingFang SC", sans-serif;
    font-size: 14px;
    line-height: 1.8;
    color: #333;
    max-width: 860px;
    margin: 40px auto;
    padding: 0 40px;
  }
  h1 { font-size: 24px; border-bottom: 2px solid #333; padding-bottom: 8px; }
  h2 { font-size: 18px; border-bottom: 1px solid #ddd; padding-bottom: 4px; margin-top: 28px; }
  h3 { font-size: 15px; margin-top: 20px; }
  code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-family: "Consolas", monospace; font-size: 13px; }
  pre { background: #f4f4f4; padding: 12px 16px; border-radius: 5px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 4px solid #ddd; margin: 0; padding: 4px 16px; color: #666; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
  th { background: #f0f0f0; }
  ul, ol { padding-left: 24px; }
  li { margin: 4px 0; }
  a { color: #0066cc; }
  hr { border: none; border-top: 1px solid #ddd; margin: 24px 0; }
</style>
</head>
<body>
${marked.parse(mdContent)}
</body>
</html>`;
}

async function convert(inputPath, outputPath) {
  const mdContent = readFileSync(inputPath, 'utf8');
  const html = mdToHtml(mdContent);

  // Find browser
  let executablePath;
  try {
    // Try Edge first
    readFileSync(EDGE_PATH);
    executablePath = EDGE_PATH;
  } catch {
    for (const p of CHROME_PATHS) {
      try { readFileSync(p); executablePath = p; break; } catch {}
    }
  }
  if (!executablePath) throw new Error('找不到 Chrome 或 Edge');

  console.log(`使用浏览器: ${executablePath}`);
  console.log(`转换: ${inputPath} → ${outputPath}`);

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.pdf({
      path: outputPath,
      format: 'A4',
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
      printBackground: true,
    });
    console.log(`✅ 已生成: ${outputPath}`);
  } finally {
    await browser.close();
  }
}

// Main
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('用法: node scripts/md-to-pdf.mjs <input.md> [output.pdf]');
  process.exit(1);
}

const inputPath = resolve(args[0]);
const outputPath = args[1]
  ? resolve(args[1])
  : join(dirname(inputPath), basename(inputPath, '.md') + '.pdf');

convert(inputPath, outputPath).catch(err => {
  console.error('转换失败:', err.message);
  process.exit(1);
});
