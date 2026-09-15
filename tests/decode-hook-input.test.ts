import { test } from 'node:test';
import assert from 'node:assert/strict';
import iconv from 'iconv-lite';
import { decodeBufferWithFallback, containsInvalidChars } from '../src/utils/decodeHookInput.js';

test('decodeBufferWithFallback: clean UTF-8 JSON passes through unchanged', () => {
  const json = JSON.stringify({ prompt: '哎呀 这是中文', n: 1 });
  const out = decodeBufferWithFallback(Buffer.from(json, 'utf8'));
  assert.deepEqual(JSON.parse(out), { prompt: '哎呀 这是中文', n: 1 });
});

test('decodeBufferWithFallback: pure UTF-8 ASCII JSON passes through', () => {
  const json = '{"status":"completed","loop_count":0}';
  const out = decodeBufferWithFallback(Buffer.from(json, 'utf8'));
  assert.deepEqual(JSON.parse(out), { status: 'completed', loop_count: 0 });
});

test('decodeBufferWithFallback: raw GBK-encoded JSON is recovered', () => {
  const json = JSON.stringify({ prompt: '中文内容' });
  const gbkBytes = iconv.encode(json, 'gbk');
  const out = decodeBufferWithFallback(gbkBytes);
  assert.deepEqual(JSON.parse(out), { prompt: '中文内容' });
});

test('decodeBufferWithFallback: strips a leading UTF-8 BOM (PowerShell cp65001)', () => {
  const json = JSON.stringify({ prompt: '对，核心就是这个', text: 'async generator' });
  const withBom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(json, 'utf8')]);
  const out = decodeBufferWithFallback(withBom);
  // Result must be parseable (no leading BOM byte or U+FEFF char)
  assert.deepEqual(JSON.parse(out), { prompt: '对，核心就是这个', text: 'async generator' });
  assert.notEqual(out.charCodeAt(0), 0xFEFF);
});

test('decodeBufferWithFallback: never throws and always returns a string', () => {
  // Even for garbage bytes, the decoder must return a string (the caller logs it).
  const garbage = Buffer.from([0xff, 0xfe, 0x00, 0x81, 0x22, 0x7b]);
  const out = decodeBufferWithFallback(garbage);
  assert.equal(typeof out, 'string');
});

test('containsInvalidChars: flags consecutive ? after a quoted value', () => {
  assert.equal(containsInvalidChars('{"prompt":"??"}'), true);
  assert.equal(containsInvalidChars('{"prompt":"ok?"}'), false);
});
