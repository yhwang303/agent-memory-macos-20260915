/**
 * RrfFusion — Reciprocal Rank Fusion (Cormack 2009 加权变体)
 *
 * 把多个排序列表融合成一个：
 *     score(item) = Σ over branches: weight_l / (k + rank_l(item))
 *
 * 不出现在某个分支的 item 在该分支贡献为 0。同分按"最佳 rank 升序"破。
 *
 * 默认 k=60、sqlite_weight=0.6、vector_weight=0.4。
 *   - k=60 出自 Cormack 2009 论文。
 *   - sqlite 权重略高: BM25/FTS5 是精度分支(关键词重叠时直接命中);dense vector
 *     是召回分支(救场 paraphrase / concept)。这跟 Lin et al. 2021 / Pyserini 文档
 *     的实证结论一致。
 *
 * 数学保证: 任何 sqlite top-K 项 RRF score ≥ 0.6/(60+K-1),vector top-1 score
 * = 0.4/60 ≈ 0.00667。要让 sqlite 失守需 K > 30,即 sqlite 至少返回 31 条候选
 * 后第 31 条才可能被 vector top-1 挤掉。这对 limit≤20 的查询是不可能发生的。
 *
 * 这个文件是从 agentmem-hybrid-mcp/src/rrf.ts 原样移植的。整合到 AgentMemory 主仓库后该函数
 * 由 HybridSearchService 调用,跑在 Worker 进程内。
 */

export interface RankItem<K> {
  key: K;
  /** 0-based rank within its source list. */
  rank: number;
  /** 可选,源排序中的原始得分。RRF 不使用,只看 rank。 */
  origScore?: number;
}

export interface RankedList<K> {
  items: RankItem<K>[];
  weight: number;
  /** 调试标识,如 "sqlite" / "vector" */
  source: string;
}

export interface FusedItem<K> {
  key: K;
  /** RRF 融合后得分。越大越好。 */
  score: number;
  /** 融合后的新 rank,0-based */
  rank: number;
  /** 每个源的原 rank (-1 表示不在该源中) */
  perSource: Array<{ source: string; rank: number; weight: number }>;
}

export interface RrfOptions {
  /** 饱和常数,默认 60 */
  k?: number;
  /** 截断长度,默认 = 各源总和(不截断) */
  limit?: number;
}

/**
 * 融合 N 个排序列表。纯函数,无副作用。
 */
export function rrfFuse<K>(lists: RankedList<K>[], opts: RrfOptions = {}): FusedItem<K>[] {
  const k = opts.k ?? 60;

  // 用 stringified key 索引;Map 保留首次插入顺序,提供稳定的 tie-break
  const acc = new Map<string, {
    key: K;
    score: number;
    bestRank: number;
    perSource: Array<{ source: string; rank: number; weight: number }>;
  }>();

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

  // 给所有 entry 补齐缺失的源(rank=-1),保证输出结构一致
  for (const entry of acc.values()) {
    for (const list of lists) {
      if (!entry.perSource.some((s) => s.source === list.source)) {
        entry.perSource.push({ source: list.source, rank: -1, weight: list.weight });
      }
    }
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
