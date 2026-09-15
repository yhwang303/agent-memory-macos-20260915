/**
 * runImport orchestrator — wires adapters → AI → DB at PER-TURN granularity.
 *
 * One user→assistant exchange = one AgentMemory `session_summaries` row, matching
 * the online Stop-hook semantics (1 stop event = 1 summary). A 30-prompt
 * conversation produces 30 imported rows — same as if hook had been
 * running at the time.
 *
 * Pipeline:
 *
 *   1. Adapter discovery → list of TranscriptFile.
 *   2. collectSession(adapter, file) drains the per-turn iterator into a
 *      SessionData (so we can apply session-level filters: time range,
 *      project filter, substantive check).
 *   3. Session-level pre-filter: drop empty / out-of-range sessions.
 *   4. Expand each surviving session into TurnTask[] (one per turn).
 *   5. Per-turn pre-filter:
 *      - skip if `Turn.fingerprint` already in import_history_fingerprints
 *      - skip if a hook summary exists for the same project within the
 *        turn-boundary range [turn.startedAt - 60s, nextTurn.startedAt + 60s]
 *        (or +12h for the last turn). The asymmetric window matches the fact
 *        that hook fires AFTER the assistant finishes responding (its
 *        created_at ≈ end-of-turn) while imports use start-of-turn — so a
 *        symmetric small window misses obvious duplicates whose gap is just
 *        agent processing time.
 *      - skip if this specific turn isn't substantive (assistantText < 20)
 *   6. Apply maxTurns cap.
 *   7. Concurrency-limited worker pool runs buildImportTurnSummaryPrompt →
 *      SDKAgent → parseSummary → insertImportedSummary →
 *      recordTurnFingerprint.
 */

import { logger } from '../../utils/logger.js';
import { parseSummary } from '../../sdk/parser.js';
import {
  buildImportTurnSummaryPrompt,
  type ImportTurnPromptInput,
} from '../../sdk/prompts.js';
import { SDKAgent } from '../worker/SDKAgent.js';
import { discoverAll, getAdapter, getAllAdapters } from './discover.js';
import { insertImportedSummary } from './db-write.js';
import {
  getExistingFingerprints,
  hasHookSummaryInRange,
  hasHookSummaryInRangeAnyProject,
  hasHookSummaryNear,
  recordTurnFingerprint,
} from './fingerprints.js';
import { collectSession, isTurnSubstantive } from './turn-utils.js';
import { resolveProjectFromCwd } from './project-resolver.js';
import type {
  ImportAdapter,
  ImportAdapterId,
  ImportOptions,
  ImportProgressListener,
  ImportProgressSnapshot,
  ImportResult,
  SessionData,
  Turn,
} from './types.js';

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_RATE_PER_MINUTE = 30;
const DEFAULT_MAX_TURNS = 1000;
/**
 * Pre-turn cushion for hook-overlap matching.
 *
 * Adds a small slack on the LEFT edge of the per-turn dedup window so a hook
 * row that fired a few seconds before our recorded `turn.startedAt` (clock
 * skew, hook fired right at the boundary, etc.) still matches.
 *
 * The RIGHT edge is bounded by the next turn's start (see
 * `computeTurnEndBoundary`) so we don't need a symmetric tolerance there —
 * agent processing time, however long, is fully captured by reaching the
 * next turn's start.
 */
const HOOK_OVERLAP_PRE_MS = 60 * 1000;
/**
 * Post-turn cushion for the LAST turn of a session, where there is no
 * "next turn" to bound against. Hook fires after the agent finishes — for a
 * long final turn this can be tens of minutes after `turn.startedAt`. We pick
 * a wide window (12h) so any hook row that captured this same conversation
 * online still matches; false positives are bounded by the project filter
 * and the turn's own per-turn fingerprint check upstream.
 */
const HOOK_OVERLAP_LAST_TURN_TAIL_MS = 12 * 60 * 60 * 1000;

interface TurnTask {
  adapter: ImportAdapter;
  session: SessionData;
  turn: Turn;
}

/**
 * Run the full import pipeline at per-turn granularity.
 */
export async function runImport(
  options: ImportOptions = {},
  onProgress?: ImportProgressListener,
): Promise<ImportResult> {
  const startedAt = Date.now();
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const ratePerMinute = Math.max(1, options.ratePerMinute ?? DEFAULT_RATE_PER_MINUTE);
  const maxTurns = Math.max(1, options.maxTurns ?? options.maxSessions ?? DEFAULT_MAX_TURNS);
  const skipFingerprinted = options.skipFingerprinted ?? true;
  const skipHookOverlap = options.skipHookOverlap ?? true;
  const dryRun = options.dryRun ?? false;

  const adapters = resolveAdapters(options.adapterIds);
  if (adapters.length === 0) {
    logger.warn('IMPORT', 'runImport: no adapters resolved', {
      requested: options.adapterIds,
    });
    return emptyResult(startedAt);
  }

  const stats: AdapterStats = {
    perAdapter: new Map(),
    importedSummaries: 0,
    skippedTurns: 0,
    preFilteredTurns: 0,
    failedTurns: 0,
    failedTasks: [],
    processedTurns: 0,
    totalTurns: 0,
  };
  for (const a of adapters) {
    stats.perAdapter.set(a.id, { imported: 0, skipped: 0, failed: 0 });
  }

  emit(onProgress, snapshotFromStats(stats, 'discovering'));

  // Step 1+2: discover sessions and collect their turns.
  //
  // CPU PROTECTION: collectSession reads + parses the entire transcript
  // file synchronously (better-sqlite3-style). For users with hundreds of
  // big jsonl files (claude has 1500+ turns across 34 files on a typical
  // long-running install), this loop can block the Worker event loop for
  // multiple seconds. Yield to setImmediate every N files so concurrent
  // Worker requests (settings page polling, MCP search, etc.) don't queue
  // up and the user's CPU isn't pegged on a single core during install.
  const COLLECT_YIELD_EVERY = 8;
  const allSessions: Array<{ adapter: ImportAdapter; session: SessionData }> = [];
  let collectedSinceYield = 0;
  for (const adapter of adapters) {
    const result = await adapter.discoverSessions();
    for (const file of result.files) {
      let session: SessionData | null = null;
      try {
        session = await collectSession(adapter, file);
      } catch (err) {
        logger.warn('IMPORT', `collectSession failed for ${file.filePath}`, {
          error: String(err),
        });
        continue;
      }
      if (!session) continue;
      allSessions.push({ adapter, session });
      collectedSinceYield += 1;
      if (collectedSinceYield >= COLLECT_YIELD_EVERY) {
        collectedSinceYield = 0;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }

  // Step 3: session-level filters (time range + project filter).
  let filteredSessions = allSessions.filter(({ session }) => {
    if (
      options.sinceMs !== undefined &&
      session.lastTurnAtMs > 0 &&
      session.lastTurnAtMs < options.sinceMs
    ) return false;
    if (
      options.untilMs !== undefined &&
      session.firstTurnAtMs > 0 &&
      session.firstTurnAtMs > options.untilMs
    ) return false;
    if (
      options.projectFilter &&
      !matchesProjectFilter(session.cwd, options.projectFilter)
    ) return false;
    return true;
  });
  // Sessions filtered out at this step counted as session-level skips don't
  // map cleanly to per-turn stats; we just drop them silently (they had no
  // valid turns to count anyway from a user perspective).

  // Step 4: expand sessions → per-turn tasks.
  let candidates: TurnTask[] = [];
  for (const { adapter, session } of filteredSessions) {
    for (const turn of session.turns) {
      // Per-turn substantive check: drop turns with empty user text or
      // tiny assistant reply (likely a probe / abandoned).
      if (!isTurnSubstantive(turn.userText, turn.assistantText)) {
        stats.perAdapter.get(adapter.id)!.skipped += 1;
        stats.preFilteredTurns += 1;
        continue;
      }
      candidates.push({ adapter, session, turn });
    }
  }
  logger.info('IMPORT', 'expanded sessions to turns', {
    sessions: filteredSessions.length,
    turns: candidates.length,
    droppedNonSubstantive: stats.preFilteredTurns,
  });

  // Step 5a: bulk fingerprint pre-filter (per-turn).
  if (skipFingerprinted && candidates.length > 0) {
    const fps = candidates.map((c) => c.turn.fingerprint);
    const existing = getExistingFingerprints(fps);
    if (existing.size > 0) {
      const before = candidates.length;
      const remaining: TurnTask[] = [];
      for (const c of candidates) {
        if (existing.has(c.turn.fingerprint)) {
          stats.perAdapter.get(c.adapter.id)!.skipped += 1;
          stats.preFilteredTurns += 1;
        } else {
          remaining.push(c);
        }
      }
      candidates = remaining;
      logger.info('IMPORT', 'fingerprint pre-filter applied (per-turn)', {
        before, skipped: existing.size, remaining: remaining.length,
      });
    }
  }

  // Step 5b: per-turn hook-overlap pre-filter (turn-boundary-aware).
  //
  // Why turn-boundary-aware: the online Stop hook fires AFTER the assistant
  // finishes responding, so its `created_at_epoch` ≈ end-of-turn. Imports use
  // `turn.startedAt` (start-of-turn) as the row timestamp. The gap = "agent
  // processing time", which can easily be 30+ minutes for a long tool-using
  // turn. A symmetric ±5min window around start-of-turn misses the hook row
  // sitting at end-of-turn → duplicate summaries. Fix: use the next turn's
  // start as the right boundary so the entire processing window is covered.
  //
  // Two regimes:
  //   - Adapters with per-turn timestamps (claude jsonl `timestamp`,
  //     codebuddy-ide per-turn ts): use turn-boundary range
  //     [turn.startedAt - PRE, nextTurn.startedAt + PRE] — the next turn's
  //     start cleanly bounds agent processing time. For the last turn,
  //     extend by HOOK_OVERLAP_LAST_TURN_TAIL_MS since there's no next turn
  //     to bound against.
  //   - Adapters without per-turn timestamps (cursor-agent — every turn in a
  //     file shares the file's mtime): degrade to SESSION-level dedup with
  //     a ±2h window around the session's flat timestamp. If any hook
  //     summary exists for the session's project within that window, every
  //     turn of the session is dropped as covered.
  if (skipHookOverlap && candidates.length > 0) {
    const before = candidates.length;
    let overlapSkipped = 0;
    const remaining: TurnTask[] = [];
    // Pre-decide per session whether the WHOLE session is hook-covered (flat-ts case).
    const sessionCoverageCache = new Map<string, boolean>();
    const SESSION_LEVEL_TOLERANCE_MS = 2 * 60 * 60 * 1000; // ±2h
    const isSessionLevelTimestamps = (s: SessionData): boolean =>
      s.firstTurnAtMs > 0 &&
      s.lastTurnAtMs > 0 &&
      s.firstTurnAtMs === s.lastTurnAtMs;

    // Pre-compute, per session, the sorted list of turn start timestamps so
    // we can resolve "next turn start" in O(1) per candidate. We do this once
    // per session (not per turn) because the same session.turns array is
    // reused across all that session's TurnTasks.
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

    for (const c of candidates) {
      const turnTs = c.turn.startedAt;
      const sessionTs = c.session.lastTurnAtMs;
      // CRITICAL: resolve to git toplevel before doing ANY hook-overlap
      // lookup. Otherwise a turn whose literal cwd is `D:/agent-memory/desktop`
      // tries to match against the hook row stored under `D:/agent-memory`
      // (because hook used CLAUDE_PROJECT_DIR which is the git root) and
      // misses every time. Resolving import-side to the same shape closes
      // the gap. resolveProjectFromCwd is memoized so this is cheap even
      // when called per-turn.
      const cwd = resolveProjectFromCwd(c.turn.cwd ?? c.session.cwd);
      const flat = isSessionLevelTimestamps(c.session);
      // Decide which timestamp regime applies:
      //   - flat (no per-turn ts, e.g. cursor-agent): session-level ±2h match
      //   - turnTs unavailable but sessionTs is: also session-level ±2h
      //   - turnTs available: turn-boundary range [start-PRE, nextStart+PRE]
      if (flat || turnTs <= 0) {
        if (sessionTs <= 0) {
          // Truly no timestamp anywhere → conservatively keep.
          remaining.push(c);
          continue;
        }
        const cacheKey = `${c.adapter.id}|${c.session.sessionId}`;
        let covered = sessionCoverageCache.get(cacheKey);
        if (covered == null) {
          covered = hasHookSummaryNear(cwd, sessionTs, SESSION_LEVEL_TOLERANCE_MS);
          sessionCoverageCache.set(cacheKey, covered);
        }
        if (covered) {
          stats.perAdapter.get(c.adapter.id)!.skipped += 1;
          stats.preFilteredTurns += 1;
          overlapSkipped += 1;
        } else {
          remaining.push(c);
        }
        continue;
      }
      // Per-turn check: project + turn-boundary range.
      const starts = turnStartsFor(c.session);
      // Find this turn's index inside the sorted starts (binary search would
      // help on giant sessions, but linear is fine for typical N≤200 turns).
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
      // Pass A: project-matched range. Catches the typical case where import
      // and hook agree on cwd (after git-toplevel resolution).
      let covered = hasHookSummaryInRange(cwd, fromMs, toMs);
      // Pass B: project-AGNOSTIC fallback over the SAME turn-boundary range.
      // Covers any residual attribution drift the project-matched check
      // missed — e.g. hook stored a workspace folder that diverges from the
      // git toplevel, or a non-git project where our fallback returned the
      // literal cwd while hook had something else. Within a turn boundary
      // (typically the next user turn's start, or +12h for the last turn),
      // having ANY hook row is overwhelming evidence it's the same
      // conversation; two unrelated conversations starting in different
      // projects within seconds-to-minutes of each other is rare in
      // practice and the per-turn fingerprint already protects us against
      // a re-run of the same import.
      if (!covered) {
        covered = hasHookSummaryInRangeAnyProject(fromMs, toMs);
      }
      if (covered) {
        stats.perAdapter.get(c.adapter.id)!.skipped += 1;
        stats.preFilteredTurns += 1;
        overlapSkipped += 1;
      } else {
        remaining.push(c);
      }
    }
    candidates = remaining;
    logger.info(
      'IMPORT',
      'hook-overlap pre-filter applied (turn-boundary range / session-level ±2h)',
      { before, skipped: overlapSkipped, remaining: remaining.length },
    );
  }

  // Step 6: cap by maxTurns.
  if (candidates.length > maxTurns) {
    logger.info('IMPORT', `capping turns to maxTurns=${maxTurns}`, {
      discovered: candidates.length, cap: maxTurns,
    });
    candidates = candidates.slice(0, maxTurns);
  }

  // After all pre-filters: totalTurns = the AI-budget for this run. The
  // progress bar denominator stays equal to actual AI work, so users see
  // e.g. "75 / 75" instead of "75 / 2147" when 1942 of those were free
  // pre-filter drops. Pre-filter skips are still surfaced in the final
  // ImportResult.skippedTurns (they get folded back in finalize()).
  stats.totalTurns = candidates.length;

  if (dryRun || candidates.length === 0) {
    emit(onProgress, snapshotFromStats(stats, 'done'));
    return finalize(stats, startedAt);
  }

  // Step 7: concurrency-limited worker pool with rate gate.
  const sdk = new SDKAgent();
  const limiter = new RateLimiter(ratePerMinute);
  const queue = [...candidates];
  const inFlight: Array<Promise<void>> = [];
  const runStartedAt = Date.now();

  const runOne = async (): Promise<void> => {
    while (queue.length > 0) {
      const task = queue.shift()!;
      try {
        await limiter.acquire();
        await processOneTurn(sdk, task, stats);
      } catch (err) {
        logger.error(
          'IMPORT',
          `task failed: ${task.adapter.id} session=${task.session.sessionId} turn=${task.turn.turnIndex}`,
          {}, err as Error,
        );
        stats.perAdapter.get(task.adapter.id)!.failed += 1;
        stats.failedTurns += 1;
        // Save the task data for the background retry pass that runs after
        // the main pool drains. Keeps transient TIMI hiccups from leaving
        // permanent gaps in the imported set — see retryFailedTasks below.
        stats.failedTasks.push(task);
      } finally {
        stats.processedTurns += 1;
        emit(
          onProgress,
          snapshotFromStats(stats, 'running', task.adapter.id, task.session.filePath, runStartedAt),
        );
      }
    }
  };

  for (let i = 0; i < concurrency; i++) inFlight.push(runOne());
  await Promise.all(inFlight);

  // Hand failed tasks to the module-level retry queue. WorkerService runs
  // a delayed background pass that drains this. From the user's
  // perspective: the main UI completion event fires immediately with
  // current numbers, then a few minutes later the failed turns get
  // silently retried and (if any succeed) auto-reindex runs.
  if (stats.failedTasks.length > 0) {
    pushPendingRetryTasks(stats.failedTasks);
  }

  emit(onProgress, snapshotFromStats(stats, 'done'));
  return finalize(stats, startedAt);
}

// ─── per-turn processor ─────────────────────────────────────────────────

async function processOneTurn(
  sdk: SDKAgent,
  task: TurnTask,
  stats: AdapterStats,
): Promise<void> {
  const { adapter, session, turn } = task;
  const fileBasename = (session.filePath.split(/[\\/]/).pop() ?? '').replace(
    /\.(jsonl|json)$/i, '',
  );

  // Resolve to git toplevel so the project string we write matches what the
  // online Stop hook would have written for the same conversation. See
  // project-resolver.ts for the full rationale. The fallback chain is:
  //   1. git toplevel of (turn.cwd ?? session.cwd)
  //   2. literal (turn.cwd ?? session.cwd) when not a git repo / git fails
  //   3. `unknown:<adapter>` if even that is null
  const resolvedProject =
    resolveProjectFromCwd(turn.cwd ?? session.cwd) ?? `unknown:${adapter.id}`;

  const promptInput: ImportTurnPromptInput = {
    adapterId: adapter.id,
    project: resolvedProject,
    startedAt: turn.startedAt > 0
      ? new Date(turn.startedAt).toISOString()
      : '(unknown)',
    fileBasename,
    sessionId: session.sessionId,
    turnIndex: turn.turnIndex,
    userText: turn.userText,
    assistantText: turn.assistantText,
    toolUses: turn.toolUses,
  };

  const prompt = buildImportTurnSummaryPrompt(promptInput);
  const response = await sdk.runPrompt(prompt);
  const parsed = parseSummary(response);
  if (!parsed) {
    logger.warn('IMPORT', 'parseSummary returned null — skipping', {
      adapter: adapter.id,
      sessionId: session.sessionId,
      turnIndex: turn.turnIndex,
    });
    stats.perAdapter.get(adapter.id)!.skipped += 1;
    stats.skippedTurns += 1;
    return;
  }

  // memory_session_id is now per-turn so each row gets a unique synthetic
  // identifier: `imp:<adapter>:<sessionId>:t<turnIndex>`.
  const summaryId = insertImportedSummary({
    memorySessionId: `imp:${adapter.id}:${session.sessionId}:t${turn.turnIndex}`,
    project: resolvedProject,
    adapterId: adapter.id,
    parsed,
    originalPath: session.filePath,
    // Per-turn timestamp when available (claude). Else fall back to session
    // boundary times (cursor-agent uses file mtime as both first and last).
    // Last fallback is Date.now() so the row always has a valid created_at,
    // but that should never happen in practice — discovery requires mtime>0.
    startedAtMs:
      turn.startedAt > 0
        ? turn.startedAt
        : session.firstTurnAtMs > 0
          ? session.firstTurnAtMs
          : Date.now(),
  });
  recordTurnFingerprint(turn, summaryId);

  stats.perAdapter.get(adapter.id)!.imported += 1;
  stats.importedSummaries += 1;
}

// ─── helpers ─────────────────────────────────────────────────────────────

interface AdapterStats {
  perAdapter: Map<ImportAdapterId, { imported: number; skipped: number; failed: number }>;
  importedSummaries: number;
  /**
   * Mid-run skip count (parseSummary returned null after the AI call). These
   * are turns that DID consume an AI call so they count against the
   * `processedTurns / totalTurns` progress fraction.
   */
  skippedTurns: number;
  /**
   * Pre-filter skip count: turns dropped before the AI step (already-imported
   * fingerprint, hook-overlap, empty/non-substantive, out-of-range).
   * Tracked separately so the progress bar denominator stays equal to the
   * actual AI work — otherwise users see "75 / 2147" and panic, when 1942 of
   * those 2147 are zero-cost pre-filter drops, not pending AI calls.
   *
   * Reported back in skippedTurns / skippedSessions of the FINAL ImportResult
   * (where it's added to in-run skippedTurns), but during the running phase
   * the snapshot treats only AI candidates as totalTurns.
   */
  preFilteredTurns: number;
  failedTurns: number;
  /**
   * Tasks whose AI call exhausted SDKAgent's internal retries — typically
   * transient TIMI / network glitches. Kept here so the orchestrator can
   * hand them up to WorkerService for a background retry pass after the
   * main run emits 'done'. Not exposed to UI directly — they show as
   * `failedTurns` count, but the retry loop will silently re-process them
   * a couple of minutes later and write the rows that succeed.
   */
  failedTasks: TurnTask[];
  processedTurns: number;
  totalTurns: number;
}

function resolveAdapters(ids?: ImportAdapterId[]): ImportAdapter[] {
  if (!ids || ids.length === 0) return getAllAdapters();
  return ids.map((id) => getAdapter(id)).filter((a): a is ImportAdapter => a != null);
}

function matchesProjectFilter(cwd: string | null, filter: string): boolean {
  if (!cwd) return false;
  const normalize = (s: string) => s.replace(/\\/g, '/').toLowerCase();
  return normalize(cwd).includes(normalize(filter));
}

function emit(
  listener: ImportProgressListener | undefined,
  snapshot: ImportProgressSnapshot,
): void {
  if (!listener) return;
  try {
    listener(snapshot);
  } catch (err) {
    logger.warn('IMPORT', 'progress listener threw — ignoring', {
      error: String(err),
    });
  }
}

function snapshotFromStats(
  stats: AdapterStats,
  phase: ImportProgressSnapshot['phase'],
  currentAdapterId?: ImportAdapterId,
  currentFilePath?: string,
  runStartedAt?: number,
): ImportProgressSnapshot {
  const etaSec =
    runStartedAt && stats.processedTurns >= 3 && stats.totalTurns > stats.processedTurns
      ? Math.round(
          ((Date.now() - runStartedAt) / stats.processedTurns) *
            (stats.totalTurns - stats.processedTurns) / 1000,
        )
      : null;

  // skippedTurns (mid-run, AI work consumed but parser failed) is shown in
  // the snapshot's `skippedTurns` field; pre-filter drops live in
  // `preFilteredTurns`. The `skippedSessions` legacy alias remains the
  // combined count so any older consumer still sees the same total.
  const skippedReportedCombined = stats.skippedTurns + stats.preFilteredTurns;
  return {
    phase,
    // Legacy "Sessions" fields kept as aliases of turn counts for IPC compat.
    totalSessions: stats.totalTurns,
    totalTurns: stats.totalTurns,
    processedSessions: stats.processedTurns,
    processedTurns: stats.processedTurns,
    importedSummaries: stats.importedSummaries,
    skippedSessions: skippedReportedCombined,
    skippedTurns: stats.skippedTurns,
    preFilteredTurns: stats.preFilteredTurns,
    failedSessions: stats.failedTurns,
    failedTurns: stats.failedTurns,
    currentAdapterId,
    currentFilePath,
    etaSec,
  };
}

function finalize(stats: AdapterStats, startedAt: number): ImportResult {
  const skippedReported = stats.skippedTurns + stats.preFilteredTurns;
  return {
    totalSessions: stats.totalTurns,
    totalTurns: stats.totalTurns,
    importedSummaries: stats.importedSummaries,
    skippedSessions: skippedReported,
    skippedTurns: skippedReported,
    failedSessions: stats.failedTurns,
    failedTurns: stats.failedTurns,
    durationMs: Date.now() - startedAt,
    perAdapter: [...stats.perAdapter.entries()].map(([adapterId, s]) => ({
      adapterId,
      imported: s.imported,
      skipped: s.skipped,
      failed: s.failed,
    })),
  };
}

function emptyResult(startedAt: number): ImportResult {
  return {
    totalSessions: 0,
    totalTurns: 0,
    importedSummaries: 0,
    skippedSessions: 0,
    skippedTurns: 0,
    failedSessions: 0,
    failedTurns: 0,
    durationMs: Date.now() - startedAt,
    perAdapter: [],
  };
}

class RateLimiter {
  private readonly perMinute: number;
  private readonly stamps: number[] = [];

  constructor(perMinute: number) {
    this.perMinute = perMinute;
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    while (this.stamps.length > 0 && now - this.stamps[0] >= 60_000) {
      this.stamps.shift();
    }
    if (this.stamps.length < this.perMinute) {
      this.stamps.push(now);
      return;
    }
    const waitMs = 60_000 - (now - this.stamps[0]) + 5;
    await new Promise((r) => setTimeout(r, waitMs));
    return this.acquire();
  }
}

// Re-export discovery helpers.
export { discoverAll };

// ─── background retry of TIMI-hiccup failures ─────────────────────────────

/**
 * Failed-task buffer. Each call to runImport that hits TIMI failures
 * appends here; WorkerService schedules a delayed retry pass that drains
 * this buffer in the background. Module-level so it survives across the
 * runImport call boundary without changing public types.
 *
 * NOT persisted to disk: if the user quits AgentMemory mid-retry, those tasks are
 * lost — but the next AgentMemory startup's auto-import will re-discover them
 * (fingerprints aren't recorded for failures, so the discovery scan picks
 * them up again).
 */
const _pendingRetryTasks: TurnTask[] = [];

/** Snapshot the pending-retry queue and clear it. WorkerService calls this. */
export function takePendingRetryTasks(): TurnTask[] {
  if (_pendingRetryTasks.length === 0) return [];
  const out = _pendingRetryTasks.splice(0, _pendingRetryTasks.length);
  return out;
}

/** Push more tasks onto the pending-retry queue. */
export function pushPendingRetryTasks(tasks: TurnTask[]): void {
  if (tasks.length > 0) _pendingRetryTasks.push(...tasks);
}

export function pendingRetryTaskCount(): number {
  return _pendingRetryTasks.length;
}

/**
 * Process a list of pre-built TurnTasks via the same per-task pipeline as
 * the main pool, but with NO discovery / pre-filters / progress emission.
 * Used by the WorkerService background retry loop to recover from
 * transient TIMI failures silently.
 *
 * Returns counts so WorkerService can decide whether to trigger a follow-
 * up auto-reindex (only meaningful when imported > 0).
 */
export async function retryFailedTasks(
  tasks: TurnTask[],
  opts: { concurrency?: number; ratePerMinute?: number } = {},
): Promise<{ imported: number; failed: number; stillFailedTasks: TurnTask[] }> {
  if (tasks.length === 0) {
    return { imported: 0, failed: 0, stillFailedTasks: [] };
  }
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const ratePerMinute = Math.max(1, opts.ratePerMinute ?? DEFAULT_RATE_PER_MINUTE);
  const sdk = new SDKAgent();
  const limiter = new RateLimiter(ratePerMinute);
  const queue = [...tasks];
  const stillFailed: TurnTask[] = [];
  // Local mini-stats, only used to satisfy processOneTurn's signature.
  const localStats: AdapterStats = {
    perAdapter: new Map(),
    importedSummaries: 0,
    skippedTurns: 0,
    preFilteredTurns: 0,
    failedTurns: 0,
    failedTasks: [],
    processedTurns: 0,
    totalTurns: tasks.length,
  };
  for (const t of tasks) {
    if (!localStats.perAdapter.has(t.adapter.id)) {
      localStats.perAdapter.set(t.adapter.id, { imported: 0, skipped: 0, failed: 0 });
    }
  }
  const runOne = async (): Promise<void> => {
    while (queue.length > 0) {
      const task = queue.shift()!;
      try {
        await limiter.acquire();
        await processOneTurn(sdk, task, localStats);
      } catch (err) {
        logger.warn('IMPORT', 'retry-pass task failed (will keep for next cycle)', {
          adapter: task.adapter.id,
          sessionId: task.session.sessionId,
          turnIndex: task.turn.turnIndex,
          error: String(err),
        });
        stillFailed.push(task);
      }
    }
  };
  const inflight: Array<Promise<void>> = [];
  for (let i = 0; i < concurrency; i++) inflight.push(runOne());
  await Promise.all(inflight);
  return {
    imported: localStats.importedSummaries,
    failed: stillFailed.length,
    stillFailedTasks: stillFailed,
  };
}

export async function runImportDryRun(
  options: Omit<ImportOptions, 'dryRun'> = {},
  onProgress?: ImportProgressListener,
): Promise<ImportResult> {
  return runImport({ ...options, dryRun: true }, onProgress);
}
