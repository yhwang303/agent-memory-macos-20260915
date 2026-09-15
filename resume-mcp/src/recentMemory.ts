/**
 * recentMemory — assemble the data that the formatter renders.
 *
 * Strategy: anchor on `session_summaries` (the rolling project summaries
 * AgentMemory produces — typically richer & more frequent than session-level data).
 * For each recent summary:
 *   - attach the originating session's metadata (user_prompt, status, ide)
 *     so the LLM can tell "this snapshot is from which task".
 *   - attach the top-K observations recorded for that session, newest first.
 *
 * Note that one AgentMemory session may have many rolling summaries; with N=10
 * default the result may include several snapshots of the same session at
 * different time points — that's intentional (it gives the LLM a sense of
 * how the project state evolved).
 *
 * This module does NOT do token-budget truncation — tokenBudget.ts handles
 * that. It DOES apply per-field head caps because raw narratives can be
 * 5–10 KB and aren't useful at full length anyway.
 */
import type { AgentMemoryDb, ObservationRow, SessionRow, SummaryRow } from './agentMemoryDb.js';

const PROMPT_HEAD_CHARS = 240;
const NARRATIVE_HEAD_CHARS = 700;
const SUBTITLE_HEAD_CHARS = 200;
const SUMMARY_FIELD_HEAD_CHARS = 600;

export interface RecentObservation {
  type: string;
  title: string;
  subtitle: string;
  narrative: string;
  /** ms since epoch, may be 0 if unknown */
  createdAtMs: number;
}

/** One summary row, with attached session metadata + observations. */
export interface RecentSummary {
  /** session_summaries.id */
  summaryId: number;
  memorySessionId: string | null;
  /** ms since epoch, may be 0 if unknown */
  createdAtMs: number;
  // ── summary body fields ─────────────────────────────────────
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  nextSteps: string;
  notes: string;
  // ── attached session metadata (may be missing if dangling) ──
  sessionId: number | null;
  userPrompt: string;
  sessionStatus: string;
  sessionSourceIde: string;
  sessionStartedAtMs: number;
  // ── attached observations ───────────────────────────────────
  observations: RecentObservation[];
}

export interface AssembleOpts {
  project: string;
  /** Number of recent summaries to fetch (anchor unit). */
  n: number;
  /** How many observations to attach per summary (newest-first). */
  obsPerSummary: number;
  /** If true, drop summaries whose originating session is currently 'active' (typically the calling session). */
  excludeActive?: boolean;
}

/** Pull and stitch together the recent-summary payload. */
export function assembleRecentMemory(agentMemoryDb: AgentMemoryDb, opts: AssembleOpts): RecentSummary[] {
  const { project, n, obsPerSummary } = opts;

  // Over-fetch so the excludeActive filter and the empty-summary filter
  // don't shrink the result below n. Cap at 3x to avoid pathological loads.
  const fetchN = Math.min(Math.max(n * 3, n + 5), 90);
  const summaryRows: SummaryRow[] = agentMemoryDb.getRecentSummaries(project, fetchN);
  if (summaryRows.length === 0) return [];

  // Pull session metadata for all distinct memory_session_ids in one shot.
  const distinctMemSids = Array.from(
    new Set(summaryRows.map((s) => s.memory_session_id).filter((x): x is string => !!x))
  );
  const sessionsByMemSid = agentMemoryDb.getSessionsByMemSids(project, distinctMemSids);

  // Cache observations per memory_session_id (multiple summaries from the
  // same session would otherwise issue redundant SELECTs).
  const obsCache = new Map<string, ObservationRow[]>();
  function obsFor(memSid: string | null): ObservationRow[] {
    if (!memSid || obsPerSummary <= 0) return [];
    const cached = obsCache.get(memSid);
    if (cached) return cached;
    const rows = agentMemoryDb.getObservationsForSession(project, memSid, obsPerSummary);
    obsCache.set(memSid, rows);
    return rows;
  }

  const out: RecentSummary[] = [];
  for (const s of summaryRows) {
    if (out.length >= n) break;

    const session: SessionRow | undefined = s.memory_session_id
      ? sessionsByMemSid.get(s.memory_session_id)
      : undefined;

    if (opts.excludeActive && session && (session.status ?? '').toLowerCase() === 'active') {
      continue;
    }

    const summary: RecentSummary = {
      summaryId: s.id,
      memorySessionId: s.memory_session_id,
      createdAtMs: s.created_at_epoch ?? 0,
      request: headTrim(s.request, SUMMARY_FIELD_HEAD_CHARS),
      investigated: headTrim(s.investigated, SUMMARY_FIELD_HEAD_CHARS),
      learned: headTrim(s.learned, SUMMARY_FIELD_HEAD_CHARS),
      completed: headTrim(s.completed, SUMMARY_FIELD_HEAD_CHARS),
      nextSteps: headTrim(s.next_steps, SUMMARY_FIELD_HEAD_CHARS),
      notes: headTrim(s.notes, SUMMARY_FIELD_HEAD_CHARS),
      sessionId: session?.id ?? null,
      userPrompt: headTrim(session?.user_prompt, PROMPT_HEAD_CHARS),
      sessionStatus: session?.status ?? '',
      sessionSourceIde: session?.source_ide ?? '',
      sessionStartedAtMs: session?.started_at_epoch ?? 0,
      observations: obsFor(s.memory_session_id).map(toRecentObservation),
    };

    // Drop summaries that have no body fields AND no observations AND no prompt.
    // (A truly empty row contributes nothing; otherwise keep it.)
    if (
      !summary.request &&
      !summary.investigated &&
      !summary.learned &&
      !summary.completed &&
      !summary.nextSteps &&
      !summary.notes &&
      summary.observations.length === 0 &&
      !summary.userPrompt
    ) {
      continue;
    }

    out.push(summary);
  }

  return out;
}

function toRecentObservation(row: ObservationRow): RecentObservation {
  // Prefer narrative; fall back to text if narrative is missing (older AgentMemory schema).
  const body = row.narrative ?? row.text ?? '';
  return {
    type: row.type ?? '',
    title: row.title ?? '',
    subtitle: headTrim(row.subtitle, SUBTITLE_HEAD_CHARS),
    narrative: headTrim(body, NARRATIVE_HEAD_CHARS),
    createdAtMs: row.created_at_epoch ?? 0,
  };
}

function headTrim(s: string | null | undefined, max: number): string {
  if (!s) return '';
  const t = String(s).trim();
  if (t.length <= max) return t;
  return t.slice(0, max).trimEnd() + '…';
}
