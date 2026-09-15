/**
 * Sessions store - CRUD operations for SDK sessions
 */
import type DatabaseT from 'better-sqlite3';
import { getDatabase } from './Database.js';
import { SDKSessionRow, normalizeTimestamp, normalizeProjectPath } from '../../types/database.js';
import { isLowConfidenceProjectPath } from '../../utils/projectPath.js';

/**
 * Create a new session
 */
export function createSession(session: Omit<SDKSessionRow, 'id'>): number {
  const db = getDatabase();
  const { isoString: startedAt, epoch: startedAtEpoch } = normalizeTimestamp(session.started_at);
  
  const stmt = db.prepare(`
    INSERT INTO sdk_sessions (
      content_session_id, memory_session_id, project, user_prompt,
      started_at, started_at_epoch, status, worker_port, prompt_counter, source_ide
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  const result = stmt.run(
    session.content_session_id,
    session.memory_session_id,
    normalizeProjectPath(session.project),
    session.user_prompt,
    startedAt,
    startedAtEpoch,
    session.status || 'active',
    session.worker_port || null,
    session.prompt_counter || 0,
    session.source_ide || null
  );
  
  return result.lastInsertRowid as number;
}

/**
 * Get session by content session ID
 */
export function getSessionByContentId(contentSessionId: string): SDKSessionRow | undefined {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM sdk_sessions WHERE content_session_id = ?');
  return stmt.get(contentSessionId) as SDKSessionRow | undefined;
}

/**
 * Get session by memory session ID
 */
export function getSessionByMemoryId(memorySessionId: string): SDKSessionRow | undefined {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM sdk_sessions WHERE memory_session_id = ?');
  return stmt.get(memorySessionId) as SDKSessionRow | undefined;
}

/**
 * Update session status
 */
export function updateSessionStatus(
  contentSessionId: string, 
  status: SDKSessionRow['status'],
  completedAt?: string
): void {
  const db = getDatabase();
  
  if (completedAt) {
    const { isoString, epoch } = normalizeTimestamp(completedAt);
    const stmt = db.prepare(`
      UPDATE sdk_sessions 
      SET status = ?, completed_at = ?, completed_at_epoch = ?
      WHERE content_session_id = ?
    `);
    stmt.run(status, isoString, epoch, contentSessionId);
  } else {
    const stmt = db.prepare('UPDATE sdk_sessions SET status = ? WHERE content_session_id = ?');
    stmt.run(status, contentSessionId);
  }
}

/**
 * Update session memory ID
 */
export function updateSessionMemoryId(contentSessionId: string, memorySessionId: string): void {
  const db = getDatabase();
  const stmt = db.prepare('UPDATE sdk_sessions SET memory_session_id = ? WHERE content_session_id = ?');
  stmt.run(memorySessionId, contentSessionId);
}

/**
 * Update session user prompt (called on each new user message in the session)
 */
export function updateSessionUserPrompt(contentSessionId: string, userPrompt: string): void {
  const db = getDatabase();
  const stmt = db.prepare('UPDATE sdk_sessions SET user_prompt = ? WHERE content_session_id = ?');
  stmt.run(userPrompt, contentSessionId);
}

/**
 * Repair a low-confidence hook-process fallback once a later hook provides a
 * real workspace. Never rewrites an already meaningful project assignment.
 */
export function repairFallbackSessionProject(
  contentSessionId: string,
  project: string,
  dbArg?: DatabaseT.Database,
): boolean {
  const normalized = normalizeProjectPath(project);
  if (isLowConfidenceProjectPath(normalized)) return false;
  const db = dbArg ?? getDatabase();
  const existing = db.prepare(
    'SELECT project FROM sdk_sessions WHERE content_session_id = ?'
  ).get(contentSessionId) as { project: string } | undefined;
  if (!existing || !isLowConfidenceProjectPath(existing.project)) return false;
  const result = db.prepare(
    'UPDATE sdk_sessions SET project = ? WHERE content_session_id = ?'
  ).run(normalized, contentSessionId);
  return result.changes > 0;
}

/**
 * Increment prompt counter
 */
export function incrementPromptCounter(contentSessionId: string): number {
  const db = getDatabase();
  const stmt = db.prepare(`
    UPDATE sdk_sessions 
    SET prompt_counter = prompt_counter + 1 
    WHERE content_session_id = ?
  `);
  stmt.run(contentSessionId);
  
  const session = getSessionByContentId(contentSessionId);
  return session?.prompt_counter || 0;
}

/**
 * Get active sessions
 */
export function getActiveSessions(): SDKSessionRow[] {
  const db = getDatabase();
  const stmt = db.prepare("SELECT * FROM sdk_sessions WHERE status = 'active'");
  return stmt.all() as SDKSessionRow[];
}

/**
 * Get sessions by project
 */
export function getSessionsByProject(project: string, limit = 20): SDKSessionRow[] {
  const db = getDatabase();
  const normalizedProject = normalizeProjectPath(project);
  const stmt = db.prepare(`
    SELECT * FROM sdk_sessions 
    WHERE project = ? 
    ORDER BY started_at_epoch DESC 
    LIMIT ?
  `);
  return stmt.all(normalizedProject, limit) as SDKSessionRow[];
}

/**
 * Check if session exists
 */
export function sessionExists(contentSessionId: string): boolean {
  const session = getSessionByContentId(contentSessionId);
  return session !== undefined;
}

/**
 * Get all sessions with optional limit
 */
export function getAllSessions(limit = 100): SDKSessionRow[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM sdk_sessions 
    ORDER BY started_at_epoch DESC 
    LIMIT ?
  `);
  return stmt.all(limit) as SDKSessionRow[];
}

/**
 * Get distinct projects from sessions and observations
 */
export function getDistinctProjects(): string[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT DISTINCT project FROM sdk_sessions 
    UNION 
    SELECT DISTINCT project FROM observations
    ORDER BY project
  `);
  const rows = stmt.all() as { project: string }[];
  return rows.map(r => r.project);
}

const ALLOWED_UPDATE_FIELDS = new Set([
  'last_assistant_message',
  'transcript_path',
  // Stop 钩子从 transcript 回填当轮用户请求：UserPromptSubmit 在 Cursor 等 IDE
  // 可能漏触发，导致 user_prompt 冻结、摘要 request 字段长期重复，故允许此处刷新。
  'user_prompt',
]);

/**
 * Update a single whitelisted field on sdk_sessions.
 * Session is matched by content_session_id OR memory_session_id.
 * Accepts an optional db arg for testing; otherwise uses the singleton.
 */
export function updateSessionField(
  sessionId: string,
  field: string,
  value: string | null,
  dbArg?: DatabaseT.Database
): void {
  if (!ALLOWED_UPDATE_FIELDS.has(field)) {
    throw new Error(`updateSessionField: disallowed field "${field}"`);
  }
  const db = dbArg ?? getDatabase();
  const stmt = db.prepare(
    `UPDATE sdk_sessions SET ${field} = ?
     WHERE content_session_id = ? OR memory_session_id = ?`
  );
  stmt.run(value, sessionId, sessionId);
}
