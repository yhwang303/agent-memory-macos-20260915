/**
 * ChromaSync — SQLite↔Chroma sync pipeline (agent-memory).
 *
 * Ported and heavily trimmed from claude-mem/src/services/sync/ChromaSync.ts
 * (AGPL-3.0). Agent-memory-specific adaptations:
 *
 *   • Strips user_prompts entirely (no such table in agent-memory).
 *   • Uses module-level SQLite accessors (getDatabase + observations/summaries
 *     modules) instead of claude-mem's SessionStore.
 *   • Tracks per-row sync state in the chroma_sync_state table so bulk reindex
 *     never re-embeds already-synced rows.
 *   • Single-document-per-row (obs:<id>, sum:<id>) instead of claude-mem's
 *     per-field fan-out, matching the simplified ChromaSearchStrategy contract.
 *   • Constructor injects ChromaMcpManager so tests can use a mock.
 */

import type { ChromaMcpManager } from './ChromaMcpManager.js';
import { getDatabase } from '../sqlite/Database.js';
import { getObservationsByIds } from '../sqlite/observations.js';
import { getSummariesByIds } from '../sqlite/summaries.js';
import type { ObservationRow, SessionSummaryRow } from '../../types/database.js';
import { logger } from '../../utils/logger.js';

const BATCH_SIZE = 100;

type DocType = 'observation' | 'session_summary';

interface ChromaSyncRow {
  sqlite_ids: number[];
  doc_types: DocType[];
  distances: number[];
}

export interface ChromaSyncQueryFilter {
  project?: string;
  memory_session_id?: string;
  type?: string[];
}

/**
 * Minimal MCP surface we actually use. Subset of ChromaMcpManager's public API,
 * declared as an interface so unit tests can inject a plain object mock.
 */
interface ChromaMcpLike {
  isConnected(): boolean;
  createCollection(name: string, metadata?: Record<string, unknown>): Promise<void>;
  addDocuments(
    collection: string,
    ids: string[],
    documents: string[],
    metadatas: Array<Record<string, unknown>>
  ): Promise<void>;
  query(collection: string, text: string, nResults: number, where?: Record<string, unknown>): Promise<{
    ids: unknown[];
    distances: number[];
    metadatas: Array<Record<string, unknown> | null>;
    documents?: string[];
  }>;
  deleteDocuments(collection: string, ids: string[]): Promise<void>;
}

export class ChromaSync {
  private readonly mcp: ChromaMcpLike;
  private readonly project: string;
  private readonly collectionName: string;
  private collectionEnsured = false;

  constructor(mcp: ChromaMcpManager | ChromaMcpLike, project: string, collectionName?: string) {
    this.mcp = mcp as unknown as ChromaMcpLike;
    this.project = project;
    this.collectionName = collectionName ?? deriveCollectionName(project);
  }

  getCollectionName(): string {
    return this.collectionName;
  }

  async ensureCollection(): Promise<void> {
    if (this.collectionEnsured) return;
    try {
      await this.mcp.createCollection(this.collectionName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('already exists')) throw err;
    }
    this.collectionEnsured = true;
  }

  // --- single-row sync ---------------------------------------------------

  async syncObservation(id: number): Promise<void> {
    const rows = getObservationsByIds([id]);
    const row = rows[0];
    if (!row) return;
    await this.ensureCollection();
    const doc = formatObservationDoc(row);
    try {
      await this.mcp.addDocuments(
        this.collectionName,
        [`obs:${row.id}`],
        [doc.document],
        [sanitizeMeta(doc.metadata)]
      );
      markSynced(`obs:${row.id}`);
    } catch (err) {
      markFailed(`obs:${row.id}`);
      throw err;
    }
  }

  async syncSummary(id: number): Promise<void> {
    const rows = getSummariesByIds([id]);
    const row = rows[0];
    if (!row) return;
    await this.ensureCollection();
    const doc = formatSummaryDoc(row);
    try {
      await this.mcp.addDocuments(
        this.collectionName,
        [`sum:${row.id}`],
        [doc.document],
        [sanitizeMeta(doc.metadata)]
      );
      markSynced(`sum:${row.id}`);
    } catch (err) {
      markFailed(`sum:${row.id}`);
      throw err;
    }
  }

  // --- bulk reindex ------------------------------------------------------

  async bulkReindex(
    onProgress?: (done: number, total: number) => void
  ): Promise<{ observationsSynced: number; summariesSynced: number }> {
    await this.ensureCollection();
    const db = getDatabase();

    // LEFT JOIN chroma_sync_state to pick only un-synced (or failed) rows.
    const obsRows = db.prepare(`
      SELECT o.* FROM observations o
      LEFT JOIN chroma_sync_state s ON s.doc_id = 'obs:' || o.id
      WHERE o.project = ? AND (s.status IS NULL OR s.status != 'synced')
      ORDER BY o.id ASC
    `).all(this.project) as ObservationRow[];

    const sumRows = db.prepare(`
      SELECT s.* FROM session_summaries s
      LEFT JOIN chroma_sync_state cs ON cs.doc_id = 'sum:' || s.id
      WHERE s.project = ? AND (cs.status IS NULL OR cs.status != 'synced')
      ORDER BY s.id ASC
    `).all(this.project) as SessionSummaryRow[];

    const total = obsRows.length + sumRows.length;
    let done = 0;
    let observationsSynced = 0;
    let summariesSynced = 0;

    // Stream rows through in BATCH_SIZE chunks.
    for (let i = 0; i < obsRows.length; i += BATCH_SIZE) {
      const batch = obsRows.slice(i, i + BATCH_SIZE);
      const ids = batch.map(r => `obs:${r.id}`);
      const docs = batch.map(r => formatObservationDoc(r).document);
      const metas = batch.map(r => sanitizeMeta(formatObservationDoc(r).metadata));
      try {
        await this.mcp.addDocuments(this.collectionName, ids, docs, metas);
        for (const id of ids) markSynced(id);
        observationsSynced += batch.length;
      } catch (err) {
        for (const id of ids) markFailed(id);
        logger.error('CHROMA_SYNC', 'bulkReindex obs batch failed', {
          project: this.project, batchStart: i, batchSize: batch.length
        }, err as Error);
      }
      done += batch.length;
      onProgress?.(done, total);
    }

    for (let i = 0; i < sumRows.length; i += BATCH_SIZE) {
      const batch = sumRows.slice(i, i + BATCH_SIZE);
      const ids = batch.map(r => `sum:${r.id}`);
      const docs = batch.map(r => formatSummaryDoc(r).document);
      const metas = batch.map(r => sanitizeMeta(formatSummaryDoc(r).metadata));
      try {
        await this.mcp.addDocuments(this.collectionName, ids, docs, metas);
        for (const id of ids) markSynced(id);
        summariesSynced += batch.length;
      } catch (err) {
        for (const id of ids) markFailed(id);
        logger.error('CHROMA_SYNC', 'bulkReindex sum batch failed', {
          project: this.project, batchStart: i, batchSize: batch.length
        }, err as Error);
      }
      done += batch.length;
      onProgress?.(done, total);
    }

    return { observationsSynced, summariesSynced };
  }

  // --- query -------------------------------------------------------------

  async query(
    text: string,
    nResults: number,
    filter?: ChromaSyncQueryFilter
  ): Promise<ChromaSyncRow> {
    await this.ensureCollection();
    const where = buildWhere(filter);
    // ChromaMcpManager.query has a (collection, text, nResults) signature —
    // the `where` 4th argument is forwarded via a duck-typed call since the
    // current manager implementation doesn't forward it yet. Tests use a mock
    // with 3 params, so we prefer the 3-arg form and pass `where` via
    // `callTool` shape only if the underlying method accepts 4 args.
    const raw = (this.mcp.query as any).length >= 4
      ? await (this.mcp.query as any)(this.collectionName, text, nResults, where)
      : await this.mcp.query(this.collectionName, text, nResults);

    const ids = Array.isArray(raw?.ids) ? raw.ids : [];
    const distances = Array.isArray(raw?.distances) ? raw.distances : [];
    const metadatas = Array.isArray(raw?.metadatas) ? raw.metadatas : [];

    const sqlite_ids: number[] = [];
    const doc_types: DocType[] = [];
    const dists: number[] = [];

    for (let i = 0; i < ids.length; i++) {
      const meta = metadatas[i];
      if (!meta || typeof meta !== 'object') continue;
      const sqliteId = (meta as any).sqlite_id;
      const docType = (meta as any).doc_type;
      if (typeof sqliteId !== 'number' || !Number.isInteger(sqliteId)) continue;
      if (docType !== 'observation' && docType !== 'session_summary') continue;
      sqlite_ids.push(sqliteId);
      doc_types.push(docType);
      dists.push(typeof distances[i] === 'number' ? distances[i] : 0);
    }

    return { sqlite_ids, doc_types, distances: dists };
  }

  // --- deletion ----------------------------------------------------------

  async deleteObservation(id: number): Promise<void> {
    await this.ensureCollection();
    await this.mcp.deleteDocuments(this.collectionName, [`obs:${id}`]);
    clearSyncState(`obs:${id}`);
  }

  async deleteSummary(id: number): Promise<void> {
    await this.ensureCollection();
    await this.mcp.deleteDocuments(this.collectionName, [`sum:${id}`]);
    clearSyncState(`sum:${id}`);
  }
}

// --- helpers -------------------------------------------------------------

/**
 * Chroma collection names must be 3-63 chars and match [a-zA-Z0-9._-]+.
 * Agent-memory prefixes `am_` and replaces anything non-conforming with `_`.
 */
export function deriveCollectionName(project: string): string {
  const sanitized = (project || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '');
  const base = sanitized.length > 0 ? sanitized : 'default';
  let name = `am_${base}`;
  if (name.length > 63) name = name.slice(0, 63);
  // Trim trailing non-alphanumeric to satisfy the "must end with alphanumeric"
  // convention that chroma enforces in practice.
  name = name.replace(/[._-]+$/, '');
  if (name.length < 3) name = (name + '___').slice(0, 3);
  return name;
}

interface FormattedDoc {
  document: string;
  metadata: Record<string, unknown>;
}

function formatObservationDoc(row: ObservationRow): FormattedDoc {
  const parts: string[] = [];
  if (row.title) parts.push(String(row.title));
  if (row.subtitle) parts.push(String(row.subtitle));
  if (row.narrative) parts.push(String(row.narrative));
  else if (row.text) parts.push(String(row.text));
  if (row.concepts) parts.push(decodeJsonList(row.concepts).join(', '));
  const document = parts.filter(Boolean).join('\n\n') || String(row.title ?? row.text ?? '');

  const metadata: Record<string, unknown> = {
    sqlite_id: row.id,
    doc_type: 'observation',
    memory_session_id: row.memory_session_id,
    project: row.project,
    type: row.type ?? 'discovery',
    created_at: row.created_at,
    created_at_epoch: row.created_at_epoch
  };
  if (row.title) metadata.title = row.title;
  if (row.subtitle) metadata.subtitle = row.subtitle;
  return { document, metadata };
}

function formatSummaryDoc(row: SessionSummaryRow): FormattedDoc {
  const parts: string[] = [];
  if (row.request) parts.push(`Request: ${row.request}`);
  if (row.investigated) parts.push(`Investigated: ${row.investigated}`);
  if (row.learned) parts.push(`Learned: ${row.learned}`);
  if (row.completed) parts.push(`Completed: ${row.completed}`);
  if (row.next_steps) parts.push(`Next steps: ${row.next_steps}`);
  if (row.notes) parts.push(`Notes: ${row.notes}`);
  const document = parts.join('\n\n') || String(row.request ?? '');

  const metadata: Record<string, unknown> = {
    sqlite_id: row.id,
    doc_type: 'session_summary',
    memory_session_id: row.memory_session_id,
    project: row.project,
    type: 'session_summary',
    created_at: row.created_at,
    created_at_epoch: row.created_at_epoch,
    prompt_number: row.prompt_number ?? 0
  };
  return { document, metadata };
}

function decodeJsonList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * chroma-mcp rejects null / undefined / '' metadata values. Strip them.
 */
function sanitizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(meta).filter(([, v]) => v !== null && v !== undefined && v !== '')
  );
}

function buildWhere(filter?: ChromaSyncQueryFilter): Record<string, unknown> | undefined {
  if (!filter) return undefined;
  const clauses: Record<string, unknown>[] = [];
  if (filter.project) clauses.push({ project: filter.project });
  if (filter.memory_session_id) clauses.push({ memory_session_id: filter.memory_session_id });
  if (filter.type && filter.type.length > 0) {
    clauses.push({ type: { $in: filter.type } });
  }
  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0];
  return { $and: clauses };
}

// --- chroma_sync_state writers -----------------------------------------

function markSynced(docId: string): void {
  try {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO chroma_sync_state (doc_id, synced_at, embedding_hash, status)
      VALUES (?, ?, NULL, 'synced')
      ON CONFLICT(doc_id) DO UPDATE SET synced_at = excluded.synced_at, status = 'synced'
    `).run(docId, Date.now());
  } catch (err) {
    logger.warn('CHROMA_SYNC', 'markSynced failed', { docId, error: String(err) });
  }
}

function markFailed(docId: string): void {
  try {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO chroma_sync_state (doc_id, synced_at, embedding_hash, status)
      VALUES (?, ?, NULL, 'failed')
      ON CONFLICT(doc_id) DO UPDATE SET synced_at = excluded.synced_at, status = 'failed'
    `).run(docId, Date.now());
  } catch (err) {
    logger.warn('CHROMA_SYNC', 'markFailed failed', { docId, error: String(err) });
  }
}

function clearSyncState(docId: string): void {
  try {
    const db = getDatabase();
    db.prepare(`DELETE FROM chroma_sync_state WHERE doc_id = ?`).run(docId);
  } catch (err) {
    logger.warn('CHROMA_SYNC', 'clearSyncState failed', { docId, error: String(err) });
  }
}
