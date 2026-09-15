/**
 * Path utilities for AgentMemory System
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Get the default data directory path
 */
export function getDataDir(): string {
  const homeDir = os.homedir();
  return path.join(homeDir, '.agent-memory');
}

/**
 * Ensure data directory exists
 */
export function ensureDataDir(dataDir?: string): string {
  const dir = dataDir || getDataDir();
  
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  return dir;
}

/**
 * Get SQLite database file path
 */
export function getDatabasePath(dataDir?: string): string {
  const dir = dataDir || getDataDir();
  return path.join(dir, 'memory.db');
}

/**
 * Get ChromaDB storage path
 */
export function getChromaPath(dataDir?: string): string {
  const dir = dataDir || getDataDir();
  return path.join(dir, 'chroma');
}

/**
 * Get logs directory path
 */
export function getLogsDir(dataDir?: string): string {
  const dir = dataDir || getDataDir();
  const logsDir = path.join(dir, 'logs');
  
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  
  return logsDir;
}

/**
 * PID file path used by the headless worker daemon.
 *
 * Lives next to the database so a single data-dir owns one worker at a time.
 */
export function getPidFilePath(dataDir?: string): string {
  const dir = dataDir || getDataDir();
  return path.join(dir, 'worker.pid');
}

/**
 * Get session-specific directory
 */
export function getSessionDir(sessionId: string, dataDir?: string): string {
  const dir = dataDir || getDataDir();
  const sessionDir = path.join(dir, 'sessions', sessionId);
  
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }
  
  return sessionDir;
}

/**
 * Resolve project path to absolute path
 */
export function resolveProjectPath(projectPath: string): string {
  if (path.isAbsolute(projectPath)) {
    return projectPath;
  }
  return path.resolve(process.cwd(), projectPath);
}

/**
 * Get project identifier from path
 */
export function getProjectId(projectPath: string): string {
  const resolved = resolveProjectPath(projectPath);
  // Use the last two directory components as project ID
  const parts = resolved.split(path.sep).filter(Boolean);
  return parts.slice(-2).join('/');
}
