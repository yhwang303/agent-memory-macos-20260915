import type { SearchResults } from './types.js';

/**
 * Normalize internal SearchResults to the JSON shape exposed by the Worker
 * HTTP API and the MCP search tool. Strips internal-only fields; the consumer
 * can fetch full content via /api/timeline or a direct lookup when needed.
 */
export function formatSearchResults(r: SearchResults): {
  mode: string;
  fellBack: boolean;
  observations: any[];
  summaries: any[];
} {
  return {
    mode: r.mode,
    fellBack: r.fellBack,
    observations: r.observations.map(o => ({
      id: (o.row as any).id,
      memory_session_id: (o.row as any).memory_session_id,
      type: (o.row as any).type,
      title: (o.row as any).title,
      subtitle: (o.row as any).subtitle,
      project: (o.row as any).project,
      created_at: (o.row as any).created_at,
      score: o.score,
      rank: o.rank,
      source: o.source,
    })),
    summaries: r.summaries.map(s => ({
      id: (s.row as any).id,
      memory_session_id: (s.row as any).memory_session_id,
      request: (s.row as any).request,
      learned: (s.row as any).learned,
      completed: (s.row as any).completed,
      project: (s.row as any).project,
      created_at: (s.row as any).created_at,
      score: s.score,
      rank: s.rank,
      source: s.source,
    })),
  };
}
