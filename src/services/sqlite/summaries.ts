/**
 * Summaries store - CRUD operations for session summaries
 */
import { getDatabase } from './Database.js';
import { SessionSummaryRow, SessionSummarySearchResult, SearchOptions, normalizeTimestamp, normalizeProjectPath } from '../../types/database.js';

/**
 * 取该 sid 在 session_summaries 表中的最新一条 created_at_epoch。供 generateSummary
 * 的 "无新观测则跳过" guard 使用。从未产生过 summary 的 sid 返回 null。
 */
export function getLatestSummaryEpochForSession(memorySessionId: string): number | null {
  if (!memorySessionId) return null;
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT MAX(created_at_epoch) AS ep FROM session_summaries WHERE memory_session_id = ?`
    )
    .get(memorySessionId) as { ep: number | null } | undefined;
  if (!row || row.ep == null) return null;
  return row.ep;
}

/**
 * Insert a new session summary.
 *
 * 使用 INSERT OR IGNORE 配合 idx_summaries_unique_minute (memory_session_id,
 * created_at_epoch/60000) 唯一索引:如果 Stop hook 在同一分钟内触发了多次
 * generateSummary 而 SDKAgent 的 inflight / no-new-obs guard 都没拦下,
 * 数据库层在这里把第二次插入静默吞掉,返回 -1。
 */
export function insertSummary(summary: Omit<SessionSummaryRow, 'id'>): number {
  try {
    const db = getDatabase();
    const { isoString, epoch } = normalizeTimestamp(summary.created_at);

    const stmt = db.prepare(`
      INSERT OR IGNORE INTO session_summaries (
        memory_session_id, project, request, investigated, learned, media_context, meta_intent,
        completed, next_steps, files_read, files_edited, notes,
        prompt_number, discovery_tokens, source_ide, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      summary.memory_session_id,
      normalizeProjectPath(summary.project),
      summary.request,
      summary.investigated,
      summary.learned,
      summary.media_context,
      summary.meta_intent,
      summary.completed,
      summary.next_steps,
      summary.files_read,
      summary.files_edited,
      summary.notes,
      summary.prompt_number,
      summary.discovery_tokens || 0,
      summary.source_ide || null,
      isoString,
      epoch
    );

    if (result.changes === 0) {
      console.warn('[DB:summaries] INSERT OR IGNORE matched UNIQUE constraint (duplicate minute) for session', summary.memory_session_id);
      return -1;
    }
    return result.lastInsertRowid as number;
  } catch (error) {
    console.error('[DB:summaries] !!! INSERT FAILED !!!', {
      sessionId: summary.memory_session_id,
      error: String(error),
      stack: (error as Error).stack
    });
    throw error;
  }
}

/**
 * Get summaries by project
 */
export function getSummariesByProject(project: string, limit = 20): SessionSummaryRow[] {
  const db = getDatabase();
  const normalizedProject = normalizeProjectPath(project);
  const stmt = db.prepare(`
    SELECT * FROM session_summaries 
    WHERE project = ? 
    ORDER BY created_at_epoch DESC 
    LIMIT ?
  `);
  return stmt.all(normalizedProject, limit) as SessionSummaryRow[];
}

/**
 * Get summary by session
 */
export function getSummaryBySession(memorySessionId: string): SessionSummaryRow | undefined {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM session_summaries 
    WHERE memory_session_id = ? 
    ORDER BY created_at_epoch DESC 
    LIMIT 1
  `);
  return stmt.get(memorySessionId) as SessionSummaryRow | undefined;
}

/**
 * Search summaries with full-text search
 */
export function searchSummaries(query: string, options: SearchOptions = {}): SessionSummarySearchResult[] {
  const db = getDatabase();
  const { project, limit = 20, orderBy = 'relevance' } = options;
  
  let sql = `
    SELECT s.*, fts.rank as score
    FROM session_summaries s
    JOIN summaries_fts fts ON s.id = fts.rowid
    WHERE summaries_fts MATCH ?
  `;
  
  const params: (string | number)[] = [query];
  
  if (project) {
    sql += ' AND s.project = ?';
    params.push(normalizeProjectPath(project));
  }
  
  switch (orderBy) {
    case 'date_desc':
      sql += ' ORDER BY s.created_at_epoch DESC';
      break;
    case 'date_asc':
      sql += ' ORDER BY s.created_at_epoch ASC';
      break;
    default:
      sql += ' ORDER BY fts.rank';
  }
  
  sql += ' LIMIT ?';
  params.push(limit);
  
  const stmt = db.prepare(sql);
  return stmt.all(...params) as SessionSummarySearchResult[];
}

/**
 * Get recent summaries across all projects
 */
export function getRecentSummaries(limit = 10): SessionSummaryRow[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM session_summaries 
    ORDER BY created_at_epoch DESC 
    LIMIT ?
  `);
  return stmt.all(limit) as SessionSummaryRow[];
}

/**
 * Delete summary by session
 */
export function deleteSummaryBySession(memorySessionId: string): number {
  const db = getDatabase();
  const stmt = db.prepare('DELETE FROM session_summaries WHERE memory_session_id = ?');
  const result = stmt.run(memorySessionId);
  return result.changes;
}

/**
 * Get summary count by project
 */
export function getSummaryCount(project?: string): number {
  const db = getDatabase();
  if (project) {
    const stmt = db.prepare('SELECT COUNT(*) as count FROM session_summaries WHERE project = ?');
    const result = stmt.get(normalizeProjectPath(project)) as { count: number };
    return result.count;
  }
  const stmt = db.prepare('SELECT COUNT(*) as count FROM session_summaries');
  const result = stmt.get() as { count: number };
  return result.count;
}

/**
 * Get all summaries with optional limit and project filter
 */
export function getAllSummaries(limit = 100, project?: string): SessionSummaryRow[] {
  const db = getDatabase();
  // We compute a `display_rank` window function that re-numbers summaries
  // chronologically every time the list is queried. Rank 1 = oldest,
  // rank N = newest. The viewer renders `#${display_rank}` instead of
  // `#${id}` so that:
  //   - When sorted by display_rank DESC, IDs are strictly monotonic
  //     (top = highest rank = most recent).
  //   - Newly inserted rows (e.g. import) cause every other row's rank to
  //     shift, so the user's mental model "label = chronological position"
  //     holds even after history imports backfill old sessions in the middle.
  // We deliberately use created_at_epoch ASC as the rank order so an import
  // dropping a row in the past gets a low rank, pushing all newer rows'
  // ranks up by one. The id ASC tiebreak keeps rank stable for two rows
  // with identical timestamps (rare but possible during burst imports).
  if (project) {
    const stmt = db.prepare(`
      SELECT *,
             ROW_NUMBER() OVER (ORDER BY created_at_epoch ASC, id ASC) AS display_rank
      FROM session_summaries
      WHERE project = ?
      ORDER BY display_rank DESC
      LIMIT ?
    `);
    return stmt.all(normalizeProjectPath(project), limit) as SessionSummaryRow[];
  }
  const stmt = db.prepare(`
    SELECT *,
           ROW_NUMBER() OVER (ORDER BY created_at_epoch ASC, id ASC) AS display_rank
    FROM session_summaries
    ORDER BY display_rank DESC
    LIMIT ?
  `);
  return stmt.all(limit) as SessionSummaryRow[];
}

/**
 * Search summaries with SQL LIKE (better for Chinese text)
 * Searches across request, completed, learned, investigated, and notes fields
 */
export function searchSummariesLike(query: string, options: SearchOptions = {}): SessionSummarySearchResult[] {
  const db = getDatabase();
  const { project, limit = 20, orderBy = 'date_desc' } = options;
  
  // Build LIKE pattern - wrap with % for contains match
  const likePattern = `%${query}%`;
  
  let sql = `
    SELECT *, 0 as score
    FROM session_summaries
    WHERE (
      request LIKE ? OR
      completed LIKE ? OR
      learned LIKE ? OR
      investigated LIKE ? OR
      media_context LIKE ? OR
      notes LIKE ?
    )
  `;
  
  const params: (string | number)[] = [likePattern, likePattern, likePattern, likePattern, likePattern, likePattern];
  
  if (project) {
    sql += ' AND project = ?';
    params.push(normalizeProjectPath(project));
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
  return stmt.all(...params) as SessionSummarySearchResult[];
}

/**
 * Get summaries by IDs (batch fetch)
 */
export function getSummariesByIds(ids: number[], project?: string): SessionSummaryRow[] {
  if (!ids || ids.length === 0) return [];
  
  const db = getDatabase();
  const placeholders = ids.map(() => '?').join(',');
  
  let sql = `SELECT * FROM session_summaries WHERE id IN (${placeholders})`;
  const params: (number | string)[] = [...ids];
  
  if (project) {
    sql += ' AND project = ?';
    params.push(normalizeProjectPath(project));
  }
  
  sql += ' ORDER BY created_at_epoch DESC';
  
  const stmt = db.prepare(sql);
  return stmt.all(...params) as SessionSummaryRow[];
}
