import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decryptSecureValue,
  encryptSecureValue,
  type SafeStorageLike,
} from '../desktop/src/config/secure-value';

test('secure values use an encrypted local fallback when safeStorage is unavailable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-secure-'));
  const keyPath = path.join(dir, 'key');
  const unavailable: SafeStorageLike = {
    isEncryptionAvailable: () => false,
    encryptString: () => { throw new Error('unavailable'); },
    decryptString: () => { throw new Error('unavailable'); },
  };

  const encrypted = encryptSecureValue('deepseek-test-key', unavailable, keyPath);
  assert.match(encrypted, /^local:v1:/);
  assert.equal(encrypted.includes('deepseek-test-key'), false);
  assert.equal(decryptSecureValue(encrypted, unavailable, keyPath), 'deepseek-test-key');
  assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
});

test('secure values keep Electron safeStorage compatibility, including legacy values', () => {
  const safe: SafeStorageLike = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`wrapped:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^wrapped:/, ''),
  };

  const encrypted = encryptSecureValue('api-test-key', safe);
  assert.match(encrypted, /^safe:v1:/);
  assert.equal(decryptSecureValue(encrypted, safe), 'api-test-key');
  const legacy = Buffer.from('wrapped:legacy-key', 'utf8').toString('base64');
  assert.equal(decryptSecureValue(legacy, safe), 'legacy-key');
});
