import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

const SAFE_PREFIX = 'safe:v1:';
const LOCAL_PREFIX = 'local:v1:';

function defaultKeyPath(): string {
  return path.join(os.homedir(), '.agent-memory', '.config-encryption-key');
}

function loadOrCreateLocalKey(keyPath: string): Buffer {
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });

  try {
    const existing = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'base64');
    if (existing.length !== 32) throw new Error('invalid local encryption key');
    fs.chmodSync(keyPath, 0o600);
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const key = randomBytes(32);
  try {
    const fd = fs.openSync(keyPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, key.toString('base64'), 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'base64');
    if (existing.length !== 32) throw new Error('invalid local encryption key');
    fs.chmodSync(keyPath, 0o600);
    return existing;
  }
}

function encryptLocally(value: string, keyPath: string): string {
  const key = loadOrCreateLocalKey(keyPath);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${LOCAL_PREFIX}${Buffer.concat([iv, tag, encrypted]).toString('base64')}`;
}

function decryptLocally(value: string, keyPath: string): string {
  const payload = Buffer.from(value.slice(LOCAL_PREFIX.length), 'base64');
  if (payload.length < 29) throw new Error('invalid local encrypted value');
  const key = loadOrCreateLocalKey(keyPath);
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const encrypted = payload.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function encryptSecureValue(
  value: string,
  safeStorage: SafeStorageLike,
  keyPath = defaultKeyPath(),
): string {
  if (!value) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return `${SAFE_PREFIX}${safeStorage.encryptString(value).toString('base64')}`;
    }
  } catch {
    // Ad-hoc signed macOS builds can report safeStorage as unavailable.
  }
  return encryptLocally(value, keyPath);
}

export function decryptSecureValue(
  value: string,
  safeStorage: SafeStorageLike,
  keyPath = defaultKeyPath(),
): string {
  if (!value) return '';
  try {
    if (value.startsWith(LOCAL_PREFIX)) return decryptLocally(value, keyPath);
    const encoded = value.startsWith(SAFE_PREFIX) ? value.slice(SAFE_PREFIX.length) : value;
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch {
    return '';
  }
}
