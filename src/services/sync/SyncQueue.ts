/**
 * Sync queue for asynchronous upload of memory data to the remote server.
 * Uses a local SQLite table as persistent queue with exponential backoff retry.
 *
 * Priority queue (FR-11):
 *   - Real-time enqueues use priority=10
 *   - Backfill scans (historical data, retries after restart) use priority=0
 *   Consumer ORDER BY priority DESC, created_at ASC so live data syncs first.
 *
 * Backfill state is exposed via getBackfillStats() so the Desktop UI can show
 * a progress card while historical memories are being shipped.
 */

import type Database from 'better-sqlite3';
import { RemoteClient, type SyncItem } from './RemoteClient.js';
import { logger } from '../../utils/logger.js';
import { getDeviceId } from '../../shared/identity.js';

const MAX_ATTEMPTS = 10;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 3_600_000;
const BATCH_SIZE = 100;
const DEFAULT_INTERVAL_MS = 10_000;

export const PRIORITY_REALTIME = 10;
export const PRIORITY_BACKFILL = 0;

type SyncKind = 'session' | 'observation' | 'summary';

const KIND_TO_TABLE: Record<SyncKind, string> = {
  session: 'sdk_sessions',
  observation: 'observations',
  summary: 'session_summaries',
};

export interface BackfillState {
  running: boolean;
  total: number;        // total found at start of current scan
  enqueued: number;     // newly inserted to queue (excluding INSERT-OR-IGNORE skips)
  startedAt: number | null;
  completedAt: number | null;
  lastError: string | null;
}

export interface SyncStatus {
  queue: { pending: number; failed: number; sent: number; total: number };
  backfill: BackfillState & { remaining: number; sent_recently: number; eta_ms: number | null };
  remote: { configured: boolean; url: string | null };
}

export class SyncQueue {
  private db: Database.Database;
  private remoteClient: RemoteClient;
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;

  private backfillState: BackfillState = {
    running: false,
    total: 0,
    enqueued: 0,
    startedAt: null,
    completedAt: null,
    lastError: null,
  };

  // Track sent count when backfill is active so we can compute ETA
  private backfillBaselineSent = 0;
  private backfillStartTimeMs = 0;

  constructor(db: Database.Database, remoteClient: RemoteClient) {
    this.db = db;
    this.remoteClient = remoteClient;
  }

  /**
   * Enqueue an entity for sync. Non-blocking, writes to local SQLite.
   * @param priority - PRIORITY_REALTIME (default, syncs first) or PRIORITY_BACKFILL.
   */
  enqueue(
    kind: SyncKind,
    localId: number,
    createdAtEpoch: number,
    sourceIde: string,
    payload: Record<string, unknown>,
    priority: number = PRIORITY_REALTIME,
  ): void {
    const clientUuid = `${kind}-${localId}-${createdAtEpoch}`;
    const deviceId = getDeviceId();

    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO sync_queue (kind, client_uuid, payload_json, status, attempts, created_at, priority)
        VALUES (?, ?, ?, 'pending', 0, ?, ?)
      `).run(
        kind,
        clientUuid,
        JSON.stringify({ ...payload, device_id: deviceId, source_ide: sourceIde }),
        Date.now(),
        priority,
      );
    } catch (error) {
      logger.debug('SYNC_QUEUE', 'Enqueue failed (non-fatal)', { kind, clientUuid, error: String(error) });
    }
  }

  /**
   * Start the background consumer loop.
   * Triggers an async backfill scan in the background (non-blocking) so the
   * worker becomes responsive immediately even with very large local DBs.
   */
  startWorker(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.timer) return;
    logger.info('SYNC_QUEUE', 'Starting sync worker', { intervalMs });

    setImmediate(() => this.backfillFromDatabase().catch(err =>
      logger.warn('SYNC_QUEUE', 'Initial backfill scan failed', { error: String(err) })
    ));

    this.timer = setInterval(() => this.processQueue(), intervalMs);
    this.processQueue();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('SYNC_QUEUE', 'Sync worker stopped');
    }
  }

  /**
   * Scan main tables for records that were never enqueued/synced
   * (synced_at IS NULL) and add them to the sync queue at priority=BACKFILL.
   * Idempotent via INSERT OR IGNORE on client_uuid.
   *
   * Public so it can be triggered by `POST /api/sync/rescan`.
   * Safe to call concurrently — the running flag prevents overlap.
   */
  async backfillFromDatabase(): Promise<{ enqueued: number; total: number }> {
    if (this.backfillState.running) {
      logger.debug('SYNC_QUEUE', 'Backfill already running, skipping');
      return { enqueued: 0, total: this.backfillState.total };
    }

    const baselineStats = this.getStats();
    this.backfillBaselineSent = baselineStats.sent;
    this.backfillStartTimeMs = Date.now();

    this.backfillState = {
      running: true,
      total: 0,
      enqueued: 0,
      startedAt: this.backfillStartTimeMs,
      completedAt: null,
      lastError: null,
    };

    try {
      // 1. Count totals first (fast, separate from streaming inserts)
      const counts = {
        sessions: (this.db.prepare(`SELECT COUNT(*) AS n FROM sdk_sessions WHERE synced_at IS NULL`).get() as { n: number }).n,
        observations: (this.db.prepare(`SELECT COUNT(*) AS n FROM observations WHERE synced_at IS NULL`).get() as { n: number }).n,
        summaries: (this.db.prepare(`SELECT COUNT(*) AS n FROM session_summaries WHERE synced_at IS NULL`).get() as { n: number }).n,
      };
      this.backfillState.total = counts.sessions + counts.observations + counts.summaries;

      let enqueued = 0;

      const sessions = this.db.prepare(`
        SELECT id, content_session_id, memory_session_id, project, user_prompt,
               status, started_at, started_at_epoch, completed_at, completed_at_epoch,
               device_id, source_ide
        FROM sdk_sessions WHERE synced_at IS NULL ORDER BY started_at_epoch ASC
      `).all() as any[];
      for (const s of sessions) {
        this.enqueue('session', s.id, s.started_at_epoch || 0, s.source_ide || '', {
          content_session_id: s.content_session_id,
          memory_session_id: s.memory_session_id,
          project: s.project,
          user_prompt: s.user_prompt,
          status: s.status,
          started_at: s.started_at,
          started_at_epoch: s.started_at_epoch,
          completed_at: s.completed_at,
          completed_at_epoch: s.completed_at_epoch,
        }, PRIORITY_BACKFILL);
        enqueued++;
        this.backfillState.enqueued = enqueued;
      }

      const obs = this.db.prepare(`
        SELECT id, memory_session_id, project, text, type, title, subtitle, meta_intent,
               facts, narrative, concepts, files_read, files_modified,
               prompt_number, discovery_tokens,
               created_at, created_at_epoch, device_id, source_ide
        FROM observations WHERE synced_at IS NULL ORDER BY created_at_epoch ASC
      `).all() as any[];
      for (const o of obs) {
        this.enqueue('observation', o.id, o.created_at_epoch || 0, o.source_ide || '', {
          memory_session_id: o.memory_session_id,
          project: o.project,
          text: o.text,
          type: o.type,
          title: o.title,
          subtitle: o.subtitle,
          meta_intent: o.meta_intent,
          facts: o.facts,
          narrative: o.narrative,
          concepts: o.concepts,
          files_read: o.files_read,
          files_modified: o.files_modified,
          prompt_number: o.prompt_number,
          discovery_tokens: o.discovery_tokens,
          created_at: o.created_at,
          created_at_epoch: o.created_at_epoch,
        }, PRIORITY_BACKFILL);
        enqueued++;
        this.backfillState.enqueued = enqueued;
      }

      const sums = this.db.prepare(`
        SELECT id, memory_session_id, project, request, investigated, learned,
               meta_intent, completed, next_steps, files_read, files_edited, notes,
               prompt_number, discovery_tokens,
               created_at, created_at_epoch, device_id, source_ide
        FROM session_summaries WHERE synced_at IS NULL ORDER BY created_at_epoch ASC
      `).all() as any[];
      for (const s of sums) {
        this.enqueue('summary', s.id, s.created_at_epoch || 0, s.source_ide || '', {
          memory_session_id: s.memory_session_id,
          project: s.project,
          request: s.request,
          investigated: s.investigated,
          learned: s.learned,
          meta_intent: s.meta_intent,
          completed: s.completed,
          next_steps: s.next_steps,
          files_read: s.files_read,
          files_edited: s.files_edited,
          notes: s.notes,
          prompt_number: s.prompt_number,
          discovery_tokens: s.discovery_tokens,
          created_at: s.created_at,
          created_at_epoch: s.created_at_epoch,
        }, PRIORITY_BACKFILL);
        enqueued++;
        this.backfillState.enqueued = enqueued;
      }

      if (enqueued > 0) {
        logger.info('SYNC_QUEUE',
          `Backfill: enqueued ${enqueued} unsynced records (sessions=${sessions.length}, observations=${obs.length}, summaries=${sums.length})`);
      } else {
        logger.debug('SYNC_QUEUE', 'Backfill: nothing to do');
      }

      return { enqueued, total: this.backfillState.total };
    } catch (error) {
      this.backfillState.lastError = String(error);
      logger.warn('SYNC_QUEUE', 'Backfill failed', { error: String(error) });
      return { enqueued: this.backfillState.enqueued, total: this.backfillState.total };
    } finally {
      this.backfillState.running = false;
      this.backfillState.completedAt = Date.now();
      // Trigger an immediate process pass so backfilled rows start uploading
      void this.processQueue();
    }
  }

  /**
   * Convenience: same as backfillFromDatabase but typed for the worker API.
   */
  async rescan(): Promise<{ enqueued: number; total: number }> {
    return this.backfillFromDatabase();
  }

  /**
   * Reset all sync state — used when switching to a different server.
   * Clears the sync_queue table and resets synced_at on all source tables
   * so backfill will re-upload everything to the new server.
   */
  resetForNewServer(): { cleared: number } {
    try {
      const countRow = this.db.prepare('SELECT COUNT(*) AS n FROM sync_queue').get() as { n: number };
      const cleared = countRow?.n || 0;

      this.db.exec('DELETE FROM sync_queue');
      this.db.exec('UPDATE sdk_sessions SET synced_at = NULL');
      this.db.exec('UPDATE observations SET synced_at = NULL');
      this.db.exec('UPDATE session_summaries SET synced_at = NULL');

      // Reset backfill state
      this.backfillState = {
        running: false, total: 0, enqueued: 0,
        startedAt: null, completedAt: null, lastError: null,
      };
      this.backfillBaselineSent = 0;
      this.backfillStartTimeMs = 0;

      logger.info('SYNC_QUEUE', `Reset sync state for server switch (cleared ${cleared} queue entries)`);
      return { cleared };
    } catch (error) {
      logger.warn('SYNC_QUEUE', 'Failed to reset sync state', { error: String(error) });
      return { cleared: 0 };
    }
  }

  getStats(): { pending: number; failed: number; sent: number; total: number } {
    try {
      const rows = this.db.prepare(`
        SELECT status, COUNT(*) as count FROM sync_queue GROUP BY status
      `).all() as Array<{ status: string; count: number }>;

      const stats = { pending: 0, failed: 0, sent: 0, total: 0 };
      for (const row of rows) {
        if (row.status === 'pending' || row.status === 'sending') {
          stats.pending += row.count;
        } else if (row.status === 'failed') {
          stats.failed = row.count;
        } else if (row.status === 'sent') {
          stats.sent = row.count;
        }
        stats.total += row.count;
      }
      return stats;
    } catch {
      return { pending: 0, failed: 0, sent: 0, total: 0 };
    }
  }

  /**
   * Compute backfill progress for the Desktop UI.
   * "remaining" counts pending/sending rows at priority=0 still waiting to ship.
   * "eta_ms" is a rough projection: (remaining / sent_per_ms) since backfill start.
   */
  getBackfillStats(): SyncStatus['backfill'] {
    let remaining = 0;
    try {
      const r = this.db.prepare(`
        SELECT COUNT(*) AS n FROM sync_queue
        WHERE status IN ('pending','sending') AND priority = ?
      `).get(PRIORITY_BACKFILL) as { n: number };
      remaining = r?.n || 0;
    } catch { /* ignore */ }

    const stats = this.getStats();
    const sentRecently = Math.max(0, stats.sent - this.backfillBaselineSent);

    let etaMs: number | null = null;
    if (remaining > 0 && sentRecently > 0 && this.backfillStartTimeMs > 0) {
      const elapsed = Date.now() - this.backfillStartTimeMs;
      const rate = sentRecently / elapsed;       // items per ms
      if (rate > 0) etaMs = Math.round(remaining / rate);
    }

    return {
      ...this.backfillState,
      remaining,
      sent_recently: sentRecently,
      eta_ms: etaMs,
    };
  }

  /**
   * Update synced_at column on the source table for the given client_uuids.
   */
  private markSourceSynced(kind: SyncKind, clientUuids: string[], syncedAt: number): void {
    const table = KIND_TO_TABLE[kind];
    if (!table) return;

    const localIds = clientUuids
      .map(uuid => {
        const parts = uuid.split('-');
        const id = parseInt(parts[1], 10);
        return Number.isFinite(id) ? id : null;
      })
      .filter((id): id is number => id !== null);

    if (localIds.length === 0) return;

    try {
      const placeholders = localIds.map(() => '?').join(',');
      this.db.prepare(`
        UPDATE ${table} SET synced_at = ? WHERE id IN (${placeholders})
      `).run(syncedAt, ...localIds);
    } catch (error) {
      logger.warn('SYNC_QUEUE', `Failed to mark ${kind} source synced`, { error: String(error) });
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      const now = Date.now();
      const rows = this.db.prepare(`
        SELECT id, kind, client_uuid, payload_json, attempts
        FROM sync_queue
        WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?)
        ORDER BY priority DESC, created_at ASC
        LIMIT ?
      `).all(now, BATCH_SIZE) as Array<{
        id: number;
        kind: string;
        client_uuid: string;
        payload_json: string;
        attempts: number;
      }>;

      if (rows.length === 0) return;

      // Group by kind for batch sending
      const grouped = new Map<string, typeof rows>();
      for (const row of rows) {
        const group = grouped.get(row.kind) || [];
        group.push(row);
        grouped.set(row.kind, group);
      }

      for (const [kind, items] of grouped) {
        const syncItems: SyncItem[] = items.map(item => {
          const payload = JSON.parse(item.payload_json);
          return {
            client_uuid: item.client_uuid,
            device_id: payload.device_id || getDeviceId(),
            source_ide: payload.source_ide || '',
            payload,
          };
        });

        try {
          const ids = items.map(i => i.id);
          this.db.prepare(`
            UPDATE sync_queue SET status = 'sending' WHERE id IN (${ids.map(() => '?').join(',')})
          `).run(...ids);

          await this.remoteClient.syncBatch(kind, syncItems);

          const sentAt = Date.now();
          this.db.prepare(`
            UPDATE sync_queue SET status = 'sent', synced_at = ? WHERE id IN (${ids.map(() => '?').join(',')})
          `).run(sentAt, ...ids);

          this.markSourceSynced(kind as SyncKind, items.map(i => i.client_uuid), sentAt);

          logger.info('SYNC_QUEUE', `Synced ${items.length} ${kind}(s)`);
        } catch (error) {
          const errorMsg = String(error);
          logger.warn('SYNC_QUEUE', `Sync failed for ${kind} batch`, { error: errorMsg });

          for (const item of items) {
            const newAttempts = item.attempts + 1;
            if (newAttempts >= MAX_ATTEMPTS) {
              this.db.prepare(`
                UPDATE sync_queue SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?
              `).run(newAttempts, errorMsg, item.id);
            } else {
              const backoff = Math.min(BASE_BACKOFF_MS * Math.pow(2, newAttempts), MAX_BACKOFF_MS);
              this.db.prepare(`
                UPDATE sync_queue SET status = 'pending', attempts = ?, last_error = ?, next_retry_at = ? WHERE id = ?
              `).run(newAttempts, errorMsg, now + backoff, item.id);
            }
          }
        }
      }
    } catch (error) {
      logger.debug('SYNC_QUEUE', 'Queue processing error', { error: String(error) });
    } finally {
      this.processing = false;
    }
  }
}
