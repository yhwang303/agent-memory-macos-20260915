/**
 * RRF (Reciprocal Rank Fusion) — combine multiple ranked lists into one.
 *
 * Given two or more ranklists, each item gets a score:
 *     score(item) = sum over ranklists of: weight_l / (k + rank_l(item))
 *
 * Items not present in a list contribute 0 from that list. Tie-breaking is
 * by descending score, then by ascending best rank, then by stable insert order.
 *
 * Defaults match AgentMemory's original HybridSearchStrategy:
 *   k = 60, sqlite_weight = 0.4, vector_weight = 0.6
 *
 * Why these defaults?
 *   - k=60 is the canonical RRF "saturation" constant from the original paper
 *     (Cormack 2009). Larger k = flatter weighting; 60 strikes a balance.
 *   - vector slightly outweighs sqlite because sqlite FTS5 already drives most
 *     of the easy "exact" / "subtitle" hits; the marginal gain from vector
 *     is on paraphrase / concept queries where it's the only signal.
 *
 * The function is generic over key type so it works for both observation IDs
 * and summary IDs (we run RRF separately per kind to avoid mixing).
 */

export interface RankItem<K> {
  key: K;
  /** 0-based rank within its source list. */
  rank: number;
  /** Optional original score from the source (NOT used by RRF; we only use rank). */
  origScore?: number;
}

export interface RankedList<K> {
  items: RankItem<K>[];
  weight: number;
  /** Identifier for debugging — e.g. "sqlite", "vector". */
  source: string;
}

export interface FusedItem<K> {
  key: K;
  /** Combined RRF score. Higher is better. */
  score: number;
  /** New rank in the fused list, 0-based. */
  rank: number;
  /** Per-source ranks (-1 = not present in that source) */
  perSource: Array<{ source: string; rank: number; weight: number }>;
}

export interface RrfOptions {
  /** Saturation constant. Default 60. */
  k?: number;
  /** Limit final results. Default = sum of input list lengths (no truncation). */
  limit?: number;
}

/**
 * Fuse N ranked lists into one. Pure function; no side effects.
 */
export function rrfFuse<K>(lists: RankedList<K>[], opts: RrfOptions = {}): FusedItem<K>[] {
  const k = opts.k ?? 60;

  // accumulator keyed by stringified key (Map preserves first-seen insertion order for stable tiebreaks)
  const acc = new Map<string, {
    key: K;
    score: number;
    bestRank: number;
    perSource: Array<{ source: string; rank: number; weight: number }>;
  }>();

  // Pre-fill perSource template so every output has uniform structure
  for (const list of lists) {
    if (list.weight <= 0) continue;
    for (const item of list.items) {
      const k_str = stringifyKey(item.key);
      const contribution = list.weight / (k + item.rank);
      let entry = acc.get(k_str);
      if (!entry) {
        entry = {
          key: item.key,
          score: 0,
          bestRank: item.rank,
          perSource: [],
        };
        acc.set(k_str, entry);
      }
      entry.score += contribution;
      if (item.rank < entry.bestRank) entry.bestRank = item.rank;
      entry.perSource.push({ source: list.source, rank: item.rank, weight: list.weight });
    }
  }

  // Fill in missing source entries (rank = -1) so output shape is consistent
  for (const entry of acc.values()) {
    for (const list of lists) {
      if (!entry.perSource.some((s) => s.source === list.source)) {
        entry.perSource.push({ source: list.source, rank: -1, weight: list.weight });
      }
    }
    // sort sources by name for stable display
    entry.perSource.sort((a, b) => a.source.localeCompare(b.source));
  }

  const sorted = Array.from(acc.values()).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.bestRank - b.bestRank;
  });

  const limit = opts.limit ?? sorted.length;
  return sorted.slice(0, limit).map((e, i) => ({
    key: e.key,
    score: e.score,
    rank: i,
    perSource: e.perSource,
  }));
}

function stringifyKey(k: unknown): string {
  return typeof k === 'string' ? k : JSON.stringify(k);
}
