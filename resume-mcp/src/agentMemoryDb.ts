/**
 * AgentMemoryDb — read-only access to ~/.agent-memory/agent-memory.db.
 *
 * Hard guarantees:
 *   - opened with readonly: true → SQLite layer rejects any DML
 *   - never executes pragma journal_mode change (would write to db)
 *   - tolerates missing optional columns (AgentMemory auto-migrates schema; older
 *     installs may lack `narrative`, etc.)
 *
 * We rely on three AgentMemory tables:
 *   - sdk_sessions       (anchor: a "user task")
 *   - session_summaries  (rolling summary, possibly multiple per session)
 *   - observations       (fine-grained notes, joined via memory_session_id)
 *
 * All `project` values in AgentMemory are normalised to lowercase forward-slash
 * paths (e.g. "d:/agent-memory"). The resolver is responsible for that
 * normalisation; this module assumes the caller already normalised.
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { logger } from './logger.js';

export interface SessionRow {
  id: number;
  memory_session_id: string | null;
  content_session_id: string | null;
  user_prompt: string | null;
  started_at_epoch: number | null;
  completed_at_epoch: number | null;
  status: string | null;
  source_ide: string | null;
}

export interface SummaryRow {
  id: number;
  memory_session_id: string | null;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  created_at_epoch: number | null;
}

export interface ObservationRow {
  id: number;
  memory_session_id: string | null;
  type: string | null;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  text: string | null;
  created_at_epoch: number | null;
}

export interface ProjectStat {
  project: string;
  observations: number;
  summaries: number;
  sessions: number;
}

/** Read-only handle to AgentMemory's main SQLite database. */
export class AgentMemoryDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (!existsSync(dbPath)) {
      throw new Error(
        `AgentMemory main DB not found at ${dbPath}. Is AgentMemory installed and has it run at least once?`
      );
    }
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
    logger.info('AgentMemoryDb opened (read-only)', { path: dbPath });
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  /**
   * Most recent N sessions for the given project, ordered newest-first.
   * Sessions with NULL started_at_epoch are sorted to the bottom.
   */
  getRecentSessions(project: string, n: number): SessionRow[] {
    const sql = `
      SELECT id,
             memory_session_id,
             content_session_id,
             user_prompt,
             started_at_epoch,
             completed_at_epoch,
             status,
             source_ide
        FROM sdk_sessions
       WHERE project = ?
       ORDER BY COALESCE(started_at_epoch, 0) DESC, id DESC
       LIMIT ?
    `;
    return this.db.prepare(sql).all(project, n) as SessionRow[];
  }

  /**
   * Most recent N session_summaries for the given project, ordered newest-first.
   * Anchors directly on session_summaries (one AgentMemory session may have many
   * rolling summaries — this returns the latest N across the whole project,
   * not "latest per session"). This is the primary entry point for the
   * resume tool.
   */
  getRecentSummaries(project: string, n: number): SummaryRow[] {
    const sql = `
      SELECT id,
             memory_session_id,
             request,
             investigated,
             learned,
             completed,
             next_steps,
             notes,
             created_at_epoch
        FROM session_summaries
       WHERE project = ?
       ORDER BY COALESCE(created_at_epoch, 0) DESC, id DESC
       LIMIT ?
    `;
    return this.db.prepare(sql).all(project, n) as SummaryRow[];
  }

  /**
   * Look up sessions by memory_session_id. Used to attach session-level
   * metadata (user_prompt, status, source_ide) to each summary so the
   * formatter can show "this summary belongs to which task".
   *
   * Returns a map keyed by memory_session_id. Missing ids are omitted.
   */
  getSessionsByMemSids(project: string, memorySessionIds: string[]): Map<string, SessionRow> {
    const out = new Map<string, SessionRow>();
    const ids = memorySessionIds.filter((x) => typeof x === 'string' && x.length > 0);
    if (ids.length === 0) return out;

    const placeholders = ids.map(() => '?').join(',');
    const sql = `
      SELECT id,
             memory_session_id,
             content_session_id,
             user_prompt,
             started_at_epoch,
             completed_at_epoch,
             status,
             source_ide
        FROM sdk_sessions
       WHERE project = ?
         AND memory_session_id IN (${placeholders})
    `;
    const rows = this.db.prepare(sql).all(project, ...ids) as SessionRow[];
    for (const row of rows) {
      if (row.memory_session_id) out.set(row.memory_session_id, row);
    }
    return out;
  }

  /**
   * For each memory_session_id in the input list, return the **latest**
   * session_summary row (one AgentMemory session can have multiple rolling
   * summaries; we want the freshest one).
   *
   * Returns at most one row per memory_session_id. Missing ids are simply
   * omitted from the result; callers must handle that case.
   */
  getLatestSummariesForSessions(project: string, memorySessionIds: string[]): SummaryRow[] {
    if (memorySessionIds.length === 0) return [];
    // Filter NULL-equivalent ids defensively
    const ids = memorySessionIds.filter((x) => typeof x === 'string' && x.length > 0);
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    const sql = `
      SELECT s.id,
             s.memory_session_id,
             s.request,
             s.investigated,
             s.learned,
             s.completed,
             s.next_steps,
             s.notes,
             s.created_at_epoch
        FROM session_summaries s
        INNER JOIN (
          SELECT memory_session_id,
                 MAX(COALESCE(created_at_epoch, 0)) AS latest
            FROM session_summaries
           WHERE project = ?
             AND memory_session_id IN (${placeholders})
           GROUP BY memory_session_id
        ) latest_per_sid
          ON s.memory_session_id = latest_per_sid.memory_session_id
         AND COALESCE(s.created_at_epoch, 0) = latest_per_sid.latest
       WHERE s.project = ?
    `;
    // Bind params: project, ...ids, project (for the outer WHERE)
    return this.db.prepare(sql).all(project, ...ids, project) as SummaryRow[];
  }

  /**
   * Top-K observations for a single session, newest-first.
   * Returns [] if memorySessionId is null/empty or limit ≤ 0.
   */
  getObservationsForSession(
    project: string,
    memorySessionId: string | null,
    limit: number
  ): ObservationRow[] {
    if (!memorySessionId || limit <= 0) return [];
    const sql = `
      SELECT id,
             memory_session_id,
             type,
             title,
             subtitle,
             narrative,
             text,
             created_at_epoch
        FROM observations
       WHERE project = ?
         AND memory_session_id = ?
       ORDER BY COALESCE(created_at_epoch, 0) DESC, id DESC
       LIMIT ?
    `;
    return this.db.prepare(sql).all(project, memorySessionId, limit) as ObservationRow[];
  }

  /**
   * Distinct project keys that appear in AgentMemory (across observations,
   * summaries, sessions). Used by projectResolver as the
   * "ancestor fallback" candidate set and for friendly error messages.
   */
  listKnownProjects(): string[] {
    const sql = `
      SELECT DISTINCT project FROM (
        SELECT project FROM observations       WHERE project IS NOT NULL
        UNION
        SELECT project FROM session_summaries  WHERE project IS NOT NULL
        UNION
        SELECT project FROM sdk_sessions       WHERE project IS NOT NULL
      )
      ORDER BY project ASC
    `;
    const rows = this.db.prepare(sql).all() as Array<{ project: string }>;
    return rows.map((r) => r.project).filter((p) => typeof p === 'string' && p.length > 0);
  }

  /** Coarse stats per project, useful for picking the best ancestor match. */
  projectStats(): ProjectStat[] {
    const sql = `
      SELECT project,
             SUM(CASE WHEN src='observations'      THEN 1 ELSE 0 END) AS observations,
             SUM(CASE WHEN src='session_summaries' THEN 1 ELSE 0 END) AS summaries,
             SUM(CASE WHEN src='sdk_sessions'      THEN 1 ELSE 0 END) AS sessions
        FROM (
          SELECT project, 'observations'      AS src FROM observations       WHERE project IS NOT NULL
          UNION ALL
          SELECT project, 'session_summaries' AS src FROM session_summaries  WHERE project IS NOT NULL
          UNION ALL
          SELECT project, 'sdk_sessions'      AS src FROM sdk_sessions       WHERE project IS NOT NULL
        )
       GROUP BY project
       ORDER BY (observations + summaries + sessions) DESC
    `;
    return this.db.prepare(sql).all() as ProjectStat[];
  }
}
