/**
 * Observations store - CRUD operations for observation records
 */
import { getDatabase } from './Database.js';
import { ObservationRow, ObservationSearchResult, SearchOptions, normalizeTimestamp, normalizeProjectPath } from '../../types/database.js';

/**
 * Insert a new observation.
 *
 * 使用 INSERT OR IGNORE 配合 idx_observations_unique_sig(memory_session_id,
 * signature) 唯一索引:如果 SDKAgent 层 inflight 锁失守、worker 跨进程并发
 * 写入,或者 hook 路径上某条事件在毫秒级被重复 POST,DB 层在这里静默吞掉
 * 第二次写入,返回 0(此时 lastInsertRowid 仍指向上次成功插入,所以我们直接
 * 通过 changes 判断是否真正写入)。返回 -1 表示被去重忽略。
 */
export function insertObservation(observation: Omit<ObservationRow, 'id'>): number {
  try {
    const db = getDatabase();
    const { isoString, epoch } = normalizeTimestamp(observation.created_at);

    const stmt = db.prepare(`
      INSERT OR IGNORE INTO observations (
        memory_session_id, project, text, type, title, subtitle, meta_intent,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, tier, signature, evidence, source_ide, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      observation.memory_session_id,
      normalizeProjectPath(observation.project),
      observation.text,
      observation.type,
      observation.title,
      observation.subtitle,
      observation.meta_intent,
      observation.facts,
      observation.narrative,
      observation.concepts,
      observation.files_read,
      observation.files_modified,
      observation.prompt_number,
      observation.discovery_tokens || 0,
      observation.tier ?? 2,
      observation.signature ?? null,
      observation.evidence ?? null,
      observation.source_ide ?? null,
      isoString,
      epoch
    );

    if (result.changes === 0) {
      // UNIQUE INDEX 命中,本次插入被忽略。caller 应当把这个当作 dedup 成功处理。
      console.warn('[DB:observations] INSERT OR IGNORE matched UNIQUE constraint (duplicate signature) for session', observation.memory_session_id);
      return -1;
    }
    return result.lastInsertRowid as number;
  } catch (error) {
    console.error('[DB:observations] !!! INSERT FAILED !!!', {
      sessionId: observation.memory_session_id,
      error: String(error),
      stack: (error as Error).stack
    });
    throw error;
  }
}

/**
 * Get observations by project
 */
export function getObservationsByProject(project: string, limit = 50): ObservationRow[] {
  const db = getDatabase();
  const normalizedProject = normalizeProjectPath(project);
  const stmt = db.prepare(`
    SELECT * FROM observations 
    WHERE project = ? 
    ORDER BY created_at_epoch DESC 
    LIMIT ?
  `);
  return stmt.all(normalizedProject, limit) as ObservationRow[];
}

/**
 * 分档召回：默认只取 Tier ≥2（模型精写）的有价值记录；当 Tier 2 不足 limit 时，
 * 按时间倒序用 Tier 1 trace 兜底补足到 limit。历史数据全部 tier=2，召回零影响。
 */
export function getTieredObservationsByProject(project: string, limit = 50, minTier = 2): ObservationRow[] {
  const db = getDatabase();
  const normalizedProject = normalizeProjectPath(project);

  const primaryStmt = db.prepare(`
    SELECT * FROM observations
    WHERE project = ? AND tier >= ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `);
  const primary = primaryStmt.all(normalizedProject, minTier, limit) as ObservationRow[];

  if (primary.length >= limit) {
    return primary;
  }

  // Tier 2 不足，用 Tier 1 trace 按时间倒序兜底补足
  const remaining = limit - primary.length;
  const fallbackStmt = db.prepare(`
    SELECT * FROM observations
    WHERE project = ? AND tier < ?
    ORDER BY created_at_epoch DESC
    LIMIT ?
  `);
  const fallback = fallbackStmt.all(normalizedProject, minTier, remaining) as ObservationRow[];

  return [...primary, ...fallback];
}

/**
 * Get observations by session
 */
export function getObservationsBySession(memorySessionId: string): ObservationRow[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM observations
    WHERE memory_session_id = ?
    ORDER BY created_at_epoch ASC
  `);
  return stmt.all(memorySessionId) as ObservationRow[];
}

/**
 * 取该 sid 在 observations 表中的最新一条 created_at_epoch。供 summary 生成前的
 * "无新观测则跳过" guard 使用。空 session 返回 null。
 */
export function getLatestObservationEpochForSession(memorySessionId: string): number | null {
  if (!memorySessionId) return null;
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT MAX(created_at_epoch) AS ep FROM observations WHERE memory_session_id = ?`
    )
    .get(memorySessionId) as { ep: number | null } | undefined;
  if (!row || row.ep == null) return null;
  return row.ep;
}

/**
 * 跨 session 去重兜底:同一 project 内,如果在最近 windowMs 毫秒里已经存在
 * 同一 signature 的观测,则视为重复。
 *
 * 触发场景:多个 IDE(claude-internal / cursor / codebuddy-ide / ...)的 hook
 * 同时被注册时,同一条用户行为可能由不同 hook 进程并发写入,各自生成不同
 * memory_session_id,绕过 classify() 的会话内 signature 去重。这里在插入前
 * 加一道项目级的窗口式 guard。
 *
 * @param project 已经走过 normalizeProjectPath 的标准化 project 字符串
 * @param signature classifier 计算出的 content fingerprint
 * @param windowMs 时间窗,默认 60_000 ms = 60s
 */
export function hasRecentSignature(
  project: string,
  signature: string,
  windowMs = 60_000,
): boolean {
  if (!project || !signature) return false;
  const db = getDatabase();
  const since = Date.now() - windowMs;
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM observations
       WHERE project = ? AND signature = ? AND created_at_epoch >= ?
       LIMIT 1`,
    )
    .get(normalizeProjectPath(project), signature, since) as { hit: number } | undefined;
  return !!row;
}

/**
 * 同会话 source_ide 强一致性查询：返回该 memory_session_id 下最早一条
 * 非空 source_ide 的值。任何后续写入(observation 或 summary)如果传入的
 * source_ide 与之不同,都应该被强制覆盖为这个值,杜绝同一会话被两个
 * adapter 并发记成两个来源(典型表现:claude-internal 会话里混入 cursor 标签)。
 *
 * 触发 hooks-cli 时 IDE 身份理论上由 AGENTMEM_IDE 环境变量唯一锁定,但 desktop 端
 * 历史上有部分 wrapper(尤其 cursor 的 .cjs)未注入该 env;此函数作为最后一道
 * 数据完整性保险,确保即使 wrapper 漏掉了 env、第三方 hook 又被触发,数据库
 * 里同一 sid 也只会留下一种 source_ide。
 */
export function getSessionSourceIde(memorySessionId: string): string | null {
  if (!memorySessionId) return null;
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT source_ide FROM observations
       WHERE memory_session_id = ? AND source_ide IS NOT NULL AND source_ide != ''
       ORDER BY created_at_epoch ASC, id ASC
       LIMIT 1`,
    )
    .get(memorySessionId) as { source_ide: string } | undefined;
  if (row?.source_ide) return row.source_ide;
  // observation 还没写入时,可能 summary 已经写过了(极少见,但 import 路径下会发生)
  const sumRow = db
    .prepare(
      `SELECT source_ide FROM session_summaries
       WHERE memory_session_id = ? AND source_ide IS NOT NULL AND source_ide != ''
       ORDER BY created_at_epoch ASC, id ASC
       LIMIT 1`,
    )
    .get(memorySessionId) as { source_ide: string } | undefined;
  return sumRow?.source_ide ?? null;
}

/**
 * Search observations with full-text search
 */
export function searchObservations(query: string, options: SearchOptions = {}): ObservationSearchResult[] {
  const db = getDatabase();
  const { project, type, limit = 20, orderBy = 'relevance' } = options;
  
  let sql = `
    SELECT o.*, fts.rank as score
    FROM observations o
    JOIN observations_fts fts ON o.id = fts.rowid
    WHERE observations_fts MATCH ?
  `;
  
  const params: (string | number)[] = [query];
  
  if (project) {
    sql += ' AND o.project = ?';
    params.push(normalizeProjectPath(project));
  }
  
  if (type) {
    if (Array.isArray(type)) {
      sql += ` AND o.type IN (${type.map(() => '?').join(',')})`;
      params.push(...type);
    } else {
      sql += ' AND o.type = ?';
      params.push(type);
    }
  }
  
  switch (orderBy) {
    case 'date_desc':
      sql += ' ORDER BY o.created_at_epoch DESC';
      break;
    case 'date_asc':
      sql += ' ORDER BY o.created_at_epoch ASC';
      break;
    default:
      sql += ' ORDER BY fts.rank';
  }
  
  sql += ' LIMIT ?';
  params.push(limit);
  
  const stmt = db.prepare(sql);
  return stmt.all(...params) as ObservationSearchResult[];
}

/**
 * Get recent observations across all projects
 */
export function getRecentObservations(limit = 20): ObservationRow[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM observations 
    ORDER BY created_at_epoch DESC 
    LIMIT ?
  `);
  return stmt.all(limit) as ObservationRow[];
}

/**
 * Delete observations by session
 */
export function deleteObservationsBySession(memorySessionId: string): number {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM observations WHERE memory_session_id = ?');
  const result = stmt.run(memorySessionId);
  return result.changes;
}

/**
 * Get observation count by project
 */
export function getObservationCount(project?: string): number {
  const db = getDatabase();
  if (project) {
    const stmt = db.prepare('SELECT COUNT(*) as count FROM observations WHERE project = ?');
    const result = stmt.get(normalizeProjectPath(project)) as { count: number };
    return result.count;
  }
  const stmt = db.prepare('SELECT COUNT(*) as count FROM observations');
  const result = stmt.get() as { count: number };
  return result.count;
}

/**
 * Get all observations with optional limit and project filter
 */
export function getAllObservations(limit = 100, project?: string): ObservationRow[] {
  const db = getDatabase();
  if (project) {
    const stmt = db.prepare(`
      SELECT * FROM observations 
      WHERE project = ?
      ORDER BY created_at_epoch DESC 
      LIMIT ?
    `);
    return stmt.all(normalizeProjectPath(project), limit) as ObservationRow[];
  }
  const stmt = db.prepare(`
    SELECT * FROM observations 
    ORDER BY created_at_epoch DESC 
    LIMIT ?
  `);
  return stmt.all(limit) as ObservationRow[];
}

/**
 * Get observations by IDs (batch fetch)
 */
export function getObservationsByIds(ids: number[], project?: string): ObservationRow[] {
  if (!ids || ids.length === 0) return [];
  
  const db = getDatabase();
  const placeholders = ids.map(() => '?').join(',');
  
  let sql = `SELECT * FROM observations WHERE id IN (${placeholders})`;
  const params: (number | string)[] = [...ids];
  
  if (project) {
    sql += ' AND project = ?';
    params.push(normalizeProjectPath(project));
  }
  
  sql += ' ORDER BY created_at_epoch DESC';
  
  const stmt = db.prepare(sql);
  return stmt.all(...params) as ObservationRow[];
}

/**
 * Search observations with SQL LIKE (better for Chinese text)
 * Searches across text, title, subtitle, narrative, and facts fields
 */
export function searchObservationsLike(query: string, options: SearchOptions = {}): ObservationSearchResult[] {
  const db = getDatabase();
  const { project, type, limit = 20, orderBy = 'date_desc' } = options;
  
  // Build LIKE pattern - wrap with % for contains match
  const likePattern = `%${query}%`;
  
  let sql = `
    SELECT *, 0 as score
    FROM observations
    WHERE (
      text LIKE ? OR
      title LIKE ? OR
      subtitle LIKE ? OR
      narrative LIKE ? OR
      facts LIKE ?
    )
  `;
  
  const params: (string | number)[] = [likePattern, likePattern, likePattern, likePattern, likePattern];
  
  if (project) {
    sql += ' AND project = ?';
    params.push(normalizeProjectPath(project));
  }
  
  if (type) {
    if (Array.isArray(type)) {
      sql += ` AND type IN (${type.map(() => '?').join(',')})`;
      params.push(...type);
    } else {
      sql += ' AND type = ?';
      params.push(type);
    }
  }
  
  switch (orderBy) {
    case 'date_asc':
      sql += ' ORDER BY created_at_epoch ASC';
      break;
    default:
      sql += ' ORDER BY created_at_epoch DESC';
  }
  
  sql += ' LIMIT ?';
  params.push(limit);
  
  const stmt = db.prepare(sql);
  return stmt.all(...params) as ObservationSearchResult[];
}

/**
 * Get observations around a specific anchor ID (for timeline view)
 */
export function getObservationsTimeline(
  anchorId: number,
  depthBefore = 5,
  depthAfter = 5,
  project?: string
): { before: ObservationRow[]; anchor: ObservationRow | null; after: ObservationRow[] } {
  const db = getDatabase();
  
  // Get the anchor observation
  const anchorStmt = db.prepare('SELECT * FROM observations WHERE id = ?');
  const anchor = anchorStmt.get(anchorId) as ObservationRow | undefined;
  
  if (!anchor) {
    return { before: [], anchor: null, after: [] };
  }
  
  const anchorEpoch = anchor.created_at_epoch;
  const normalizedProject = project ? normalizeProjectPath(project) : anchor.project;
  
  // Get observations before the anchor
  const beforeStmt = db.prepare(`
    SELECT * FROM observations 
    WHERE project = ? AND created_at_epoch < ?
    ORDER BY created_at_epoch DESC 
    LIMIT ?
  `);
  const before = beforeStmt.all(normalizedProject, anchorEpoch, depthBefore) as ObservationRow[];
  
  // Get observations after the anchor
  const afterStmt = db.prepare(`
    SELECT * FROM observations 
    WHERE project = ? AND created_at_epoch > ?
    ORDER BY created_at_epoch ASC 
    LIMIT ?
  `);
  const after = afterStmt.all(normalizedProject, anchorEpoch, depthAfter) as ObservationRow[];
  
  return { 
    before: before.reverse(), // Reverse to get chronological order
    anchor, 
    after 
  };
}
