/**
 * Per-TURN completeness audit for the history-import feature.
 *
 * Mirrors the orchestrator's pre-filter pipeline at per-turn granularity
 * (v1.1) but produces a per-turn ledger instead of running the AI step.
 * Used by `GET /api/import/audit` so the user can verify nothing is
 * silently dropped.
 *
 * Status taxonomy:
 *   - imported     — Turn fingerprint exists in import_history_fingerprints
 *   - hook-overlap — A hook summary exists for this project within the
 *                    turn-boundary range (per-turn) or ±2h (session-level
 *                    fallback for adapters with flat timestamps)
 *   - pending      — Would be imported on next /api/import/run
 *   - empty        — User text empty or assistant reply < 20 chars
 */

import { logger } from '../../utils/logger.js';
import { discoverAll, getAdapter } from './discover.js';
import {
  getExistingFingerprints,
  hasHookSummaryInRange,
  hasHookSummaryInRangeAnyProject,
  hasHookSummaryNear,
} from './fingerprints.js';
import { collectSession, isTurnSubstantive } from './turn-utils.js';
import { resolveProjectFromCwd } from './project-resolver.js';
import type { ImportAdapterId, SessionData, Turn } from './types.js';

/**
 * Pre-turn left cushion for hook-overlap matching. Mirrors the orchestrator's
 * HOOK_OVERLAP_PRE_MS — see orchestrator.ts comments for the full rationale.
 */
const HOOK_OVERLAP_PRE_MS = 60 * 1000;
/**
 * Tail window for the LAST turn of a session, where there's no next turn to
 * bound against. Matches orchestrator.ts HOOK_OVERLAP_LAST_TURN_TAIL_MS.
 */
const HOOK_OVERLAP_LAST_TURN_TAIL_MS = 12 * 60 * 60 * 1000;

export interface AuditTurnEntry {
  adapterId: ImportAdapterId;
  filePath: string;
  sessionId: string;
  turnIndex: number;
  cwd: string | null;
  startedAt: number;
  status: 'imported' | 'hook-overlap' | 'pending' | 'empty';
  reason: string;
}

export interface AuditTotals {
  transcriptsDiscovered: number;
  turnsTotal: number;
  imported: number;
  hookOverlap: number;
  pending: number;
  empty: number;
  perAdapter: Record<
    ImportAdapterId,
    {
      transcripts: number;
      turns: number;
      imported: number;
      hookOverlap: number;
      pending: number;
      empty: number;
    }
  >;
}

export interface AuditLedger {
  summary: string;
  totals: AuditTotals;
  turns: AuditTurnEntry[];
}

export async function auditImport(): Promise<AuditLedger> {
  const discovery = await discoverAll();
  const turnsLedger: AuditTurnEntry[] = [];
  const perAdapter: AuditTotals['perAdapter'] = {} as AuditTotals['perAdapter'];

  for (const adapterReport of discovery.adapters) {
    const adapter = getAdapter(adapterReport.adapterId);
    if (!adapter) continue;
    perAdapter[adapter.id] = {
      transcripts: adapterReport.files.length,
      turns: 0,
      imported: 0,
      hookOverlap: 0,
      pending: 0,
      empty: 0,
    };

    // Collect every turn from every transcript for this adapter.
    const allTurns: Array<{ session: SessionData; turn: Turn }> = [];
    for (const file of adapterReport.files) {
      let session: SessionData | null = null;
      try {
        session = await collectSession(adapter, file);
      } catch (err) {
        logger.warn('IMPORT_AUDIT', `collectSession failed for ${file.filePath}`, {
          error: String(err),
        });
        continue;
      }
      if (!session) continue;
      for (const turn of session.turns) {
        allTurns.push({ session, turn });
      }
    }
    perAdapter[adapter.id].turns = allTurns.length;

    // First pass: substantive check.
    const substantive: Array<{ session: SessionData; turn: Turn }> = [];
    for (const { session, turn } of allTurns) {
      if (!isTurnSubstantive(turn.userText, turn.assistantText)) {
        turnsLedger.push({
          adapterId: adapter.id,
          filePath: turn.filePath,
          sessionId: session.sessionId,
          turnIndex: turn.turnIndex,
          cwd: turn.cwd ?? session.cwd,
          startedAt: turn.startedAt,
          status: 'empty',
          reason: 'user/assistant text empty or under 20 chars',
        });
        perAdapter[adapter.id].empty += 1;
        continue;
      }
      substantive.push({ session, turn });
    }

    // Bulk fingerprint dedup.
    const fingerprints = substantive.map((s) => s.turn.fingerprint);
    const existing = getExistingFingerprints(fingerprints);

    // Pre-compute session-level hook coverage for sessions that have
    // identical first/last turn timestamps (i.e. no per-turn ts — cursor-agent).
    // Without this, per-turn match would miss most turns from those
    // sessions even though hook had captured the whole conversation.
    const SESSION_LEVEL_TOLERANCE_MS = 2 * 60 * 60 * 1000;
    const sessionCoverage = new Map<string, boolean>();
    const isFlat = (s: SessionData): boolean =>
      s.firstTurnAtMs > 0 &&
      s.lastTurnAtMs > 0 &&
      s.firstTurnAtMs === s.lastTurnAtMs;

    // Cache sorted turn-start arrays per session for O(1) "next turn start"
    // lookup (see orchestrator step 5b for the same trick).
    const sessionTurnStartsCache = new Map<string, number[]>();
    const turnStartsFor = (s: SessionData): number[] => {
      const key = `${s.adapterId}|${s.sessionId}|${s.filePath}`;
      let arr = sessionTurnStartsCache.get(key);
      if (!arr) {
        arr = s.turns
          .map((t) => t.startedAt)
          .filter((ms) => ms > 0)
          .sort((a, b) => a - b);
        sessionTurnStartsCache.set(key, arr);
      }
      return arr;
    };

    for (const { session, turn } of substantive) {
      // Same git-toplevel resolution as runImport so the audit reflects
      // exactly what the run would record / dedup against. Falls back to
      // literal cwd when not a git repo.
      const cwd = resolveProjectFromCwd(turn.cwd ?? session.cwd);
      if (existing.has(turn.fingerprint)) {
        turnsLedger.push({
          adapterId: adapter.id,
          filePath: turn.filePath,
          sessionId: session.sessionId,
          turnIndex: turn.turnIndex,
          cwd,
          startedAt: turn.startedAt,
          status: 'imported',
          reason: 'turn fingerprint already in import_history_fingerprints',
        });
        perAdapter[adapter.id].imported += 1;
        continue;
      }

      // Hook-overlap check. Two regimes:
      //   - Session has per-turn timestamps (claude jsonl) → turn-boundary range
      //     [start - PRE, nextStart + PRE] (or +TAIL if last turn).
      //   - Session has flat timestamps (cursor-agent's mtime fallback) OR
      //     turn.startedAt is 0 but session has an mtime → session-level ±2h.
      let overlap = false;
      let overlapReason = '';
      const flat = isFlat(session);
      const turnTs = turn.startedAt;
      const sessionTs = session.lastTurnAtMs;
      if (flat || turnTs <= 0) {
        // Use session timestamp (mtime). If the whole session looks
        // hook-covered, every turn is dropped.
        if (sessionTs > 0) {
          const key = `${adapter.id}|${session.sessionId}`;
          let cached = sessionCoverage.get(key);
          if (cached == null) {
            cached = hasHookSummaryNear(cwd, sessionTs, SESSION_LEVEL_TOLERANCE_MS);
            sessionCoverage.set(key, cached);
          }
          overlap = cached;
          overlapReason = 'session-level hook coverage within ±2h (no per-turn ts)';
        }
      } else {
        const starts = turnStartsFor(session);
        let nextStart = -1;
        for (let i = 0; i < starts.length; i++) {
          if (starts[i] > turnTs) {
            nextStart = starts[i];
            break;
          }
        }
        const fromMs = turnTs - HOOK_OVERLAP_PRE_MS;
        const toMs =
          nextStart > 0
            ? nextStart + HOOK_OVERLAP_PRE_MS
            : turnTs + HOOK_OVERLAP_LAST_TURN_TAIL_MS;
        // Pass A: project-matched.
        overlap = hasHookSummaryInRange(cwd, fromMs, toMs);
        overlapReason =
          'hook summary already exists for this project within turn-boundary range';
        // Pass B: project-agnostic fallback over the SAME turn-boundary
        // range. Identical safety net as orchestrator step 5b.
        if (!overlap) {
          overlap = hasHookSummaryInRangeAnyProject(fromMs, toMs);
          if (overlap) {
            overlapReason =
              'hook summary exists for ANOTHER project in this turn boundary (cwd attribution diverged)';
          }
        }
      }
      if (overlap) {
        turnsLedger.push({
          adapterId: adapter.id,
          filePath: turn.filePath,
          sessionId: session.sessionId,
          turnIndex: turn.turnIndex,
          cwd,
          startedAt: turn.startedAt,
          status: 'hook-overlap',
          reason: overlapReason,
        });
        perAdapter[adapter.id].hookOverlap += 1;
        continue;
      }

      turnsLedger.push({
        adapterId: adapter.id,
        filePath: turn.filePath,
        sessionId: session.sessionId,
        turnIndex: turn.turnIndex,
        cwd,
        startedAt: turn.startedAt,
        status: 'pending',
        reason: 'will be imported on next /api/import/run',
      });
      perAdapter[adapter.id].pending += 1;
    }
  }

  const totals: AuditTotals = {
    transcriptsDiscovered: discovery.totalFiles,
    turnsTotal: turnsLedger.length,
    imported: turnsLedger.filter((f) => f.status === 'imported').length,
    hookOverlap: turnsLedger.filter((f) => f.status === 'hook-overlap').length,
    pending: turnsLedger.filter((f) => f.status === 'pending').length,
    empty: turnsLedger.filter((f) => f.status === 'empty').length,
    perAdapter,
  };

  const summary =
    `共发现 ${totals.transcriptsDiscovered} 份转录,共 ${totals.turnsTotal} 个 user→agent 交互(turn): ` +
    `已导入 ${totals.imported} | hook 已覆盖 ${totals.hookOverlap} | ` +
    `待导入 ${totals.pending} | 空/过短 ${totals.empty}`;

  return { summary, totals, turns: turnsLedger };
}
