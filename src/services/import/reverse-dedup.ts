/**
 * Hook-side reverse deduplication.
 *
 * Import can race ahead of the live Stop hook on first install / restart:
 * it may summarize an in-progress transcript before the agent finishes.
 * When the real hook summary is later written, this module deletes the
 * superseded imported summary for the same transcript turn.
 */

import { basename } from 'node:path';
import { existsSync } from 'node:fs';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { getDatabase } from '../sqlite/Database.js';
import { streamCodexTurns } from './adapters/codex.js';
import { streamJsonlTurns } from './jsonl-stream.js';

export interface ReverseDedupInput {
  /** Absolute transcript path from the Stop hook. */
  transcriptPath: string | null | undefined;
  /** Row id of the hook summary that was just inserted. */
  hookSummaryId: number;
  /** Test-only DB override. Production uses the singleton database. */
  db?: BetterSqliteDatabase;
}

export interface ReverseDedupResult {
  deletedSummaryIds: number[];
  deletedFingerprints: number;
  skipReason?: 'no-transcript-path' | 'unsupported-format' | 'file-missing'
    | 'jsonl-empty' | 'no-matching-imported-row';
}

interface ImportedMemoryIdCandidate {
  memorySessionIdLike: string;
  source: 'jsonl-basename' | 'codex-session-meta';
  sessionId: string;
  lastTurnIndex: number;
}

export function reverseDedupAfterHookSummary(
  input: ReverseDedupInput,
): ReverseDedupResult {
  const tp = input.transcriptPath;
  if (!tp) {
    return { deletedSummaryIds: [], deletedFingerprints: 0, skipReason: 'no-transcript-path' };
  }
  if (!/\.jsonl$/i.test(tp)) {
    return { deletedSummaryIds: [], deletedFingerprints: 0, skipReason: 'unsupported-format' };
  }
  if (!existsSync(tp)) {
    return { deletedSummaryIds: [], deletedFingerprints: 0, skipReason: 'file-missing' };
  }

  const candidates = buildImportedMemoryIdCandidates(tp);
  if (candidates.length === 0) {
    return { deletedSummaryIds: [], deletedFingerprints: 0, skipReason: 'jsonl-empty' };
  }

  const db = input.db ?? getDatabase();
  const where = candidates.map(() => 'memory_session_id LIKE ?').join(' OR ');
  const rows = db
    .prepare(
      `SELECT id FROM session_summaries
       WHERE (${where})
         AND source_ide LIKE 'imported:%'
         AND id <> ?`,
    )
    .all(...candidates.map((c) => c.memorySessionIdLike), input.hookSummaryId) as Array<{ id: number }>;

  if (rows.length === 0) {
    return { deletedSummaryIds: [], deletedFingerprints: 0, skipReason: 'no-matching-imported-row' };
  }

  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');

  const tx = db.transaction(() => {
    const fpRes = db
      .prepare(
        `DELETE FROM import_history_fingerprints
         WHERE summary_id IN (${placeholders})`,
      )
      .run(...ids);
    db
      .prepare(
        `DELETE FROM session_summaries
         WHERE id IN (${placeholders})`,
      )
      .run(...ids);
    return fpRes.changes;
  });
  const deletedFingerprints = tx();

  logger.info(
    'REVERSE_DEDUP',
    'removed superseded imported row(s) after hook summary',
    {
      candidates,
      hookSummaryId: input.hookSummaryId,
      deletedSummaryIds: ids,
      deletedFingerprints,
    },
  );

  return { deletedSummaryIds: ids, deletedFingerprints };
}

function buildImportedMemoryIdCandidates(transcriptPath: string): ImportedMemoryIdCandidate[] {
  const candidates: ImportedMemoryIdCandidate[] = [];

  // Claude / Cursor-style imports use the JSONL basename as session id.
  try {
    let lastTurnIndex = -1;
    for (const turn of streamJsonlTurns('claude', transcriptPath, null)) {
      lastTurnIndex = turn.turnIndex;
    }
    if (lastTurnIndex >= 0) {
      const jsonlSid = basename(transcriptPath).replace(/\.jsonl$/i, '');
      candidates.push({
        memorySessionIdLike: `imp:%:${jsonlSid}:t${lastTurnIndex}`,
        source: 'jsonl-basename',
        sessionId: jsonlSid,
        lastTurnIndex,
      });
    }
  } catch (err) {
    logger.warn('REVERSE_DEDUP', 'failed to stream generic jsonl candidate', {
      transcriptPath,
      error: String(err),
    });
  }

  // Codex rollout imports use session_meta.payload.id, not the filename.
  try {
    let lastTurn: { turnIndex: number; sessionId: string | null } | null = null;
    for (const turn of streamCodexTurns(transcriptPath, null, codexSessionIdFromFilename(transcriptPath))) {
      lastTurn = { turnIndex: turn.turnIndex, sessionId: turn.sessionId };
    }
    if (lastTurn?.sessionId) {
      candidates.push({
        memorySessionIdLike: `imp:codex-cli:${lastTurn.sessionId}:t${lastTurn.turnIndex}`,
        source: 'codex-session-meta',
        sessionId: lastTurn.sessionId,
        lastTurnIndex: lastTurn.turnIndex,
      });
    }
  } catch (err) {
    logger.warn('REVERSE_DEDUP', 'failed to stream codex jsonl candidate', {
      transcriptPath,
      error: String(err),
    });
  }

  const seen = new Set<string>();
  return candidates.filter((c) => {
    if (seen.has(c.memorySessionIdLike)) return false;
    seen.add(c.memorySessionIdLike);
    return true;
  });
}

function codexSessionIdFromFilename(transcriptPath: string): string | null {
  const stem = basename(transcriptPath, '.jsonl');
  const match = stem.match(/rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match?.[1] ?? null;
}
