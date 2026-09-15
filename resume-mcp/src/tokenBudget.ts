/**
 * tokenBudget — keep the rendered output below max_tokens by progressively
 * cutting expensive fields. Returns trimmed summaries plus a record of
 * which truncation levels fired so the caller can surface that to the LLM.
 *
 * The character→token estimate is intentionally conservative (over-estimates
 * for ASCII) so we err on the side of returning a bit less than asked.
 *   - Chinese:  ~1.0 token per char
 *   - English:  ~0.25 token per char
 *   - Mixed:    we use chars/2.5 → ≈0.4 tokens per char as a soft middle.
 */
import type { RecentSummary } from './recentMemory.js';

export type TruncationLevel =
  | 'narrative_to_300'
  | 'narrative_to_150'
  | 'drop_observation_detail'
  | 'drop_observations'
  | 'summary_fields_to_300'
  | 'drop_summary_notes_and_next_steps'
  | 'truncate_oldest_summaries'
  | 'truncate_summary_body';

export interface BudgetResult {
  summaries: RecentSummary[];
  tokensEst: number;
  truncated: TruncationLevel[];
}

/** Coarse char→token estimate. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 2.5);
}

/** Rough estimate of a single summary's render cost (in tokens). */
export function estimateSummary(s: RecentSummary): number {
  let chars = 0;
  chars += s.userPrompt.length;
  chars += s.request.length;
  chars += s.investigated.length;
  chars += s.learned.length;
  chars += s.completed.length;
  chars += s.nextSteps.length;
  chars += s.notes.length;
  for (const o of s.observations) {
    chars += o.type.length + o.title.length + o.subtitle.length + o.narrative.length;
  }
  // overhead for tags / labels / spacing
  chars += 200;
  return Math.ceil(chars / 2.5);
}

export function estimateAll(summaries: RecentSummary[]): number {
  return summaries.reduce((acc, s) => acc + estimateSummary(s), 0) + 100; // envelope overhead
}

function clone(summaries: RecentSummary[]): RecentSummary[] {
  return summaries.map((s) => ({
    ...s,
    observations: s.observations.map((o) => ({ ...o })),
  }));
}

function trimEllipsis(text: string, max: number): string {
  if (!text || text.length <= max) return text;
  return text.slice(0, max).trimEnd() + '…';
}

/**
 * Apply progressive truncation until the estimate fits under maxTokens.
 * Always returns at least one summary (the most recent), even if that
 * means harshly truncating its body.
 */
export function applyBudget(summaries: RecentSummary[], maxTokens: number): BudgetResult {
  let working = clone(summaries);
  const truncated: TruncationLevel[] = [];

  if (estimateAll(working) <= maxTokens) {
    return { summaries: working, tokensEst: estimateAll(working), truncated };
  }

  // Step 1: narrative → 300
  for (const s of working) {
    for (const o of s.observations) {
      o.narrative = trimEllipsis(o.narrative, 300);
    }
  }
  truncated.push('narrative_to_300');
  if (estimateAll(working) <= maxTokens) return done(working, truncated);

  // Step 2: narrative → 150
  for (const s of working) {
    for (const o of s.observations) {
      o.narrative = trimEllipsis(o.narrative, 150);
    }
  }
  truncated.push('narrative_to_150');
  if (estimateAll(working) <= maxTokens) return done(working, truncated);

  // Step 3: drop observation detail (keep only type+title)
  for (const s of working) {
    for (const o of s.observations) {
      o.subtitle = '';
      o.narrative = '';
    }
  }
  truncated.push('drop_observation_detail');
  if (estimateAll(working) <= maxTokens) return done(working, truncated);

  // Step 4: drop observations entirely
  for (const s of working) {
    s.observations = [];
  }
  truncated.push('drop_observations');
  if (estimateAll(working) <= maxTokens) return done(working, truncated);

  // Step 5: summary fields → 300 chars each
  for (const s of working) {
    s.request = trimEllipsis(s.request, 300);
    s.investigated = trimEllipsis(s.investigated, 300);
    s.learned = trimEllipsis(s.learned, 300);
    s.completed = trimEllipsis(s.completed, 300);
    s.nextSteps = trimEllipsis(s.nextSteps, 300);
    s.notes = trimEllipsis(s.notes, 300);
  }
  truncated.push('summary_fields_to_300');
  if (estimateAll(working) <= maxTokens) return done(working, truncated);

  // Step 6: drop summary.notes + nextSteps (lower-value fields)
  for (const s of working) {
    s.notes = '';
    s.nextSteps = '';
  }
  truncated.push('drop_summary_notes_and_next_steps');
  if (estimateAll(working) <= maxTokens) return done(working, truncated);

  // Step 7: drop oldest summaries one by one until ≤1 remains
  while (working.length > 1 && estimateAll(working) > maxTokens) {
    working.pop();
  }
  if (working.length < summaries.length) truncated.push('truncate_oldest_summaries');
  if (estimateAll(working) <= maxTokens) return done(working, truncated);

  // Step 8: last resort — hard-truncate the remaining summary body
  for (const s of working) {
    s.request = trimEllipsis(s.request, 150);
    s.investigated = trimEllipsis(s.investigated, 100);
    s.learned = trimEllipsis(s.learned, 150);
    s.completed = trimEllipsis(s.completed, 150);
    s.userPrompt = trimEllipsis(s.userPrompt, 100);
  }
  truncated.push('truncate_summary_body');

  return done(working, truncated);
}

function done(working: RecentSummary[], truncated: TruncationLevel[]): BudgetResult {
  return { summaries: working, tokensEst: estimateAll(working), truncated };
}
