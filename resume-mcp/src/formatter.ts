/**
 * formatter — render a list of RecentSummary into the final string the
 * MCP tool returns. The shape is XML-tagged (so an LLM can parse and reason
 * about boundaries) with markdown-style content inside (so a human reading
 * the transcript can scan it).
 *
 * Each <summary> tag is one entry in the most-recent-N rolling summaries
 * for the project. It carries:
 *   - the 6 summary body fields (request / investigated / learned / completed / next_steps / notes)
 *   - metadata about the originating session (so the LLM can tell tasks apart)
 *   - top-K observations from that session as a quick reference
 */
import type { RecentSummary, RecentObservation } from './recentMemory.js';
import type { TruncationLevel } from './tokenBudget.js';
import type { ResolveResult } from './projectResolver.js';

export interface FormatOpts {
  resolve: Extract<ResolveResult, { ok: true }>;
  summaries: RecentSummary[];
  tokensEst: number;
  truncated: TruncationLevel[];
  /** ISO-8601 timestamp; injected for tests. */
  loadedAt?: string;
}

export function format(opts: FormatOpts): string {
  const loadedAt = opts.loadedAt ?? new Date().toISOString();
  const lines: string[] = [];

  const sourceAttrs = [
    `project="${xmlAttr(opts.resolve.key)}"`,
    `loaded_at="${xmlAttr(loadedAt)}"`,
    `summaries="${opts.summaries.length}"`,
    `tokens_est="${opts.tokensEst}"`,
    `match="${xmlAttr(opts.resolve.source)}"`,
  ];
  if (opts.truncated.length > 0) {
    sourceAttrs.push(`truncated="${xmlAttr(opts.truncated.join(','))}"`);
  }
  if (opts.resolve.source === 'ancestor' && opts.resolve.attemptedCwd) {
    sourceAttrs.push(`cwd="${xmlAttr(opts.resolve.attemptedCwd)}"`);
  }

  lines.push(`<agentmemory_resume ${sourceAttrs.join(' ')}>`);
  lines.push(
    '  <hint>The following are the most recent AgentMemory (AgentMemory) rolling summaries for this project, loaded so a fresh IDE/agent session can resume work without re-reading the entire DB. Each <summary> is one snapshot in time; multiple snapshots of the same session may appear. Newest-first.</hint>'
  );

  if (opts.summaries.length === 0) {
    lines.push('  <empty>No summaries found for this project. The AgentMemory DB has no recorded work here yet.</empty>');
  } else {
    for (const s of opts.summaries) {
      lines.push(renderSummary(s));
    }
  }

  lines.push('</agentmemory_resume>');
  return lines.join('\n');
}

function renderSummary(s: RecentSummary): string {
  const lines: string[] = [];
  const attrs: string[] = [`id="${s.summaryId}"`];
  if (s.createdAtMs > 0) attrs.push(`created="${xmlAttr(new Date(s.createdAtMs).toISOString())}"`);
  if (s.sessionId !== null) attrs.push(`session_id="${s.sessionId}"`);
  if (s.sessionStatus) attrs.push(`session_status="${xmlAttr(s.sessionStatus)}"`);
  if (s.sessionSourceIde) attrs.push(`ide="${xmlAttr(s.sessionSourceIde)}"`);

  lines.push(`  <summary ${attrs.join(' ')}>`);

  if (s.userPrompt) {
    lines.push(`    <prompt>${xmlText(s.userPrompt)}</prompt>`);
  }

  const body = renderSummaryBody(s);
  if (body.trim().length > 0) {
    lines.push('    <body>');
    for (const line of body.split('\n')) {
      lines.push(`      ${xmlText(line)}`);
    }
    lines.push('    </body>');
  }

  if (s.observations.length > 0) {
    lines.push('    <observations>');
    for (const o of s.observations) {
      lines.push(`      ${xmlText(renderObservation(o))}`);
    }
    lines.push('    </observations>');
  }

  lines.push('  </summary>');
  return lines.join('\n');
}

function renderSummaryBody(s: RecentSummary): string {
  const parts: string[] = [];
  if (s.request) parts.push(`Request: ${s.request}`);
  if (s.investigated) parts.push(`Investigated: ${s.investigated}`);
  if (s.learned) parts.push(`Learned: ${s.learned}`);
  if (s.completed) parts.push(`Completed: ${s.completed}`);
  if (s.nextSteps) parts.push(`Next steps: ${s.nextSteps}`);
  if (s.notes) parts.push(`Notes: ${s.notes}`);
  return parts.join('\n');
}

function renderObservation(o: RecentObservation): string {
  const head = o.type ? `[${o.type}] ` : '';
  const main = o.title || '(untitled)';
  const tail: string[] = [];
  if (o.subtitle) tail.push(o.subtitle);
  if (o.narrative) tail.push(o.narrative);
  const tailStr = tail.length > 0 ? ` — ${tail.join(' / ')}` : '';
  return `- ${head}${main}${tailStr}`;
}

/** Escape for use inside an XML attribute value. */
function xmlAttr(v: string): string {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Escape for use inside XML text content. */
function xmlText(v: string): string {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
