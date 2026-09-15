/**
 * Device identity management for cross-device memory sync.
 * Generates and persists a unique device_id, and reads device_name config.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { getDataDir } from './paths.js';

interface DeviceIdentity {
  deviceId: string;
  deviceName: string;
  createdAt: string;
}

const IDENTITY_FILE = 'device.json';

let cachedIdentity: DeviceIdentity | null = null;

function getIdentityPath(): string {
  return path.join(getDataDir(), IDENTITY_FILE);
}

function generateDeviceId(): string {
  return crypto.randomUUID();
}

function getDefaultDeviceName(): string {
  return os.hostname();
}

/**
 * Load or create device identity.
 * Priority: env vars > persisted file > auto-generate.
 */
export function getDeviceIdentity(): DeviceIdentity {
  if (cachedIdentity) return cachedIdentity;

  const identityPath = getIdentityPath();
  let persisted: Partial<DeviceIdentity> = {};

  if (fs.existsSync(identityPath)) {
    try {
      persisted = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
    } catch {
      // corrupted file, regenerate
    }
  }

  const identity: DeviceIdentity = {
    deviceId: process.env.CODEBUDDY_MEM_DEVICE_ID || persisted.deviceId || generateDeviceId(),
    deviceName: process.env.CODEBUDDY_MEM_DEVICE_NAME || persisted.deviceName || getDefaultDeviceName(),
    createdAt: persisted.createdAt || new Date().toISOString(),
  };

  // Persist if file doesn't exist or deviceId was newly generated
  if (!persisted.deviceId || persisted.deviceId !== identity.deviceId) {
    const dir = getDataDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(identityPath, JSON.stringify(identity, null, 2), 'utf-8');
  }

  cachedIdentity = identity;
  return identity;
}

export function getDeviceId(): string {
  return getDeviceIdentity().deviceId;
}

export function getDeviceName(): string {
  return getDeviceIdentity().deviceName;
}

/**
 * Remote sync configuration.
 */
export interface SyncConfig {
  enabled: boolean;
  remoteUrl: string;
  remoteToken: string;
  redactRaw: boolean;
}

export function getSyncConfig(): SyncConfig {
  const remoteUrl = process.env.CODEBUDDY_MEM_REMOTE_URL || '';
  const remoteToken = process.env.CODEBUDDY_MEM_REMOTE_TOKEN || '';
  const explicitEnabled = process.env.CODEBUDDY_MEM_SYNC_ENABLED;

  return {
    enabled: explicitEnabled !== undefined
      ? explicitEnabled === 'true'
      : !!(remoteUrl && remoteToken),
    remoteUrl: remoteUrl.replace(/\/+$/, ''),
    remoteToken,
    redactRaw: process.env.CODEBUDDY_MEM_SYNC_REDACT_RAW === 'true',
  };
}
