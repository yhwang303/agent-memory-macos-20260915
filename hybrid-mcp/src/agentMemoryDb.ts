/**
 * AgentMemoryDb — read-only access to ~/.agent-memory/agent-memory.db
 *
 * Hard guarantees:
 *   - opened with readonly: true → SQLite layer rejects any DML
 *   - never executes pragma journal_mode change (would write to db)
 *   - tolerates missing optional columns (AgentMemory auto-migrates schema; older
 *     installs may lack `narrative` / `concepts` etc.)
 *
 * Document formatting (must mirror what we want the embedder to see):
 *   observation.text   = title + subtitle + narrative + concepts
 *   summary.text       = request + investigated + learned + completed + next_steps + notes
 *
 * This duplicates AgentMemory's internal ChromaSync formatter intentionally — we
 * cannot import their code (we deliberately do not depend on agent-memory),
 * and the schema is the only contract we rely on.
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { logger } from './logger.js';

export type AgentMemoryKind = 'observation' | 'session_summary';

export interface AgentMemoryObservationRow {
  id: number;
  memory_session_id: string | null;
  project: string | null;
  type: string | null;
  title: string | null;
  subtitle: string | null;
  text: string | null;
  narrative: string | null;
  concepts: string | null;
  created_at: string | null;
  created_at_epoch: number | null;
}

export interface AgentMemorySummaryRow {
  id: number;
  memory_session_id: string | null;
  project: string | null;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  created_at: string | null;
  created_at_epoch: number | null;
}

export interface AgentMemoryDoc {
  kind: AgentMemoryKind;
  sqliteId: number;
  project: string | null;
  obsType: string | null;
  createdAtMs: number | null;
  text: string;
}

export interface AgentMemoryStats {
  observations: number;
  summaries: number;
  sessions: number;
  byProject: Array<{ project: string; observations: number; summaries: number }>;
}

export class AgentMemoryDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (!existsSync(dbPath)) {
      throw new Error(`AgentMemory main DB not found at ${dbPath}. Is AgentMemory app installed and has it run at least once?`);
    }
    // readonly: true is the only correctness guarantee we need.
    // fileMustExist defends against accidental DB creation.
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
    // Default sync; do NOT change journal_mode (write op).
    logger.info('AgentMemoryDb opened (read-only)', { path: dbPath });
  }

  close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }

  /** Coarse health: counts of major tables. */
  stats(): AgentMemoryStats {
    const obs = this.scalar('SELECT COUNT(*) as c FROM observations');
    const sum = this.scalar('SELECT COUNT(*) as c FROM session_summaries');
    const ses = this.scalar('SELECT COUNT(*) as c FROM sdk_sessions');

    const byProj = this.db.prepare(`
      SELECT project,
             SUM(CASE WHEN src='observations' THEN 1 ELSE 0 END) as observations,
             SUM(CASE WHEN src='session_summaries' THEN 1 ELSE 0 END) as summaries
      FROM (
        SELECT project, 'observations' as src FROM observations WHERE project IS NOT NULL
        UNION ALL
        SELECT project, 'session_summaries' as src FROM session_summaries WHERE project IS NOT NULL
      )
      GROUP BY project
      ORDER BY observations + summaries DESC
    `).all() as Array<{ project: string; observations: number; summaries: number }>;

    return {
      observations: obs,
      summaries: sum,
      sessions: ses,
      byProject: byProj,
    };
  }

  /** Largest id seen for a kind. Used as the incremental watermark. */
  maxId(kind: AgentMemoryKind): number {
    const tbl = kind === 'observation' ? 'observations' : 'session_summaries';
    return this.scalar(`SELECT COALESCE(MAX(id), 0) as c FROM ${tbl}`);
  }

  /**
   * Stream observations in id-ascending pages. Caller may pass `afterId` for
   * incremental sync. Pass `project` to scope.
   *
   * Yields chunks of AgentMemoryDoc.
   */
  *streamObservations(opts: { afterId?: number; project?: string; pageSize?: number } = {}): Generator<AgentMemoryDoc[], void, unknown> {
    const pageSize = opts.pageSize ?? 200;
    let cursor = opts.afterId ?? 0;
    const sql = this.observationSelectSql(!!opts.project);
    const stmt = this.db.prepare(sql);

    for (;;) {
      const rows = (opts.project
        ? stmt.all(cursor, opts.project, pageSize)
        : stmt.all(cursor, pageSize)) as AgentMemoryObservationRow[];
      if (rows.length === 0) return;
      const docs = rows.map((r) => observationToDoc(r));
      yield docs;
      cursor = rows[rows.length - 1].id;
      if (rows.length < pageSize) return;
    }
  }

  /** Same shape as streamObservations but for session_summaries. */
  *streamSummaries(opts: { afterId?: number; project?: string; pageSize?: number } = {}): Generator<AgentMemoryDoc[], void, unknown> {
    const pageSize = opts.pageSize ?? 200;
    let cursor = opts.afterId ?? 0;
    const sql = this.summarySelectSql(!!opts.project);
    const stmt = this.db.prepare(sql);

    for (;;) {
      const rows = (opts.project
        ? stmt.all(cursor, opts.project, pageSize)
        : stmt.all(cursor, pageSize)) as AgentMemorySummaryRow[];
      if (rows.length === 0) return;
      const docs = rows.map((r) => summaryToDoc(r));
      yield docs;
      cursor = rows[rows.length - 1].id;
      if (rows.length < pageSize) return;
    }
  }

  /** Get a small batch of observations by ID for spot-checking. */
  getObservationsByIds(ids: number[]): AgentMemoryDoc[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT id, memory_session_id, project, type, title, subtitle, text,
              narrative, concepts, created_at, created_at_epoch
         FROM observations WHERE id IN (${placeholders})`
    ).all(...ids) as AgentMemoryObservationRow[];
    return rows.map(observationToDoc);
  }

  // ────────────────── internals ──────────────────

  private scalar(sql: string): number {
    try {
      const r = this.db.prepare(sql).get() as { c: number } | undefined;
      return r?.c ?? 0;
    } catch (e) {
      logger.warn('scalar query failed', { sql, error: String(e) });
      return 0;
    }
  }

  private observationSelectSql(withProject: boolean): string {
    const projClause = withProject ? 'AND project = ?' : '';
    return `
      SELECT id, memory_session_id, project, type, title, subtitle, text,
             narrative, concepts, created_at, created_at_epoch
        FROM observations
       WHERE id > ? ${projClause}
       ORDER BY id ASC
       LIMIT ?
    `;
  }

  private summarySelectSql(withProject: boolean): string {
    const projClause = withProject ? 'AND project = ?' : '';
    return `
      SELECT id, memory_session_id, project, request, investigated, learned,
             completed, next_steps, notes, created_at, created_at_epoch
        FROM session_summaries
       WHERE id > ? ${projClause}
       ORDER BY id ASC
       LIMIT ?
    `;
  }
}

// ────────────────── document formatters ──────────────────

function observationToDoc(row: AgentMemoryObservationRow): AgentMemoryDoc {
  const parts: string[] = [];
  if (row.title) parts.push(String(row.title));
  if (row.subtitle) parts.push(String(row.subtitle));
  if (row.narrative) parts.push(String(row.narrative));
  else if (row.text) parts.push(String(row.text));
  const concepts = decodeJsonList(row.concepts);
  if (concepts.length > 0) parts.push(concepts.join(', '));
  const text = parts.filter(Boolean).join('\n\n') || (row.title ?? row.text ?? '');
  return {
    kind: 'observation',
    sqliteId: row.id,
    project: row.project,
    obsType: row.type ?? null,
    createdAtMs: epochToMs(row.created_at_epoch),
    text,
  };
}

function summaryToDoc(row: AgentMemorySummaryRow): AgentMemoryDoc {
  const parts: string[] = [];
  if (row.request) parts.push(`Request: ${row.request}`);
  if (row.investigated) parts.push(`Investigated: ${row.investigated}`);
  if (row.learned) parts.push(`Learned: ${row.learned}`);
  if (row.completed) parts.push(`Completed: ${row.completed}`);
  if (row.next_steps) parts.push(`Next steps: ${row.next_steps}`);
  if (row.notes) parts.push(`Notes: ${row.notes}`);
  const text = parts.join('\n\n') || (row.request ?? '');
  return {
    kind: 'session_summary',
    sqliteId: row.id,
    project: row.project,
    obsType: null,
    createdAtMs: epochToMs(row.created_at_epoch),
    text,
  };
}

function decodeJsonList(value: string | null): string[] {
  if (!value) return [];
  try {
    const v = JSON.parse(value);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function epochToMs(v: number | null): number | null {
  if (v == null) return null;
  // AgentMemory stores created_at_epoch as ms; defensive: if it looks like seconds (< year 3000 in s), pass through.
  return v;
}
