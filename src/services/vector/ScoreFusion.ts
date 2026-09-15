/**
 * ScoreFusion — basic-memory 风格的 score-based hybrid fusion.
 *
 * 算法直接对齐 basic-memory 主仓库的 search_repository_base.py:
 *   _search_hybrid(): max(v, f) + FUSION_BONUS * min(v, f)
 *
 * 与原先的 Cormack 2009 加权 RRF 不同,这个融合方法工作在 [0, 1] 归一化分数上,
 * 而不是 rank 的倒数:
 *
 *   1. FTS 分数取绝对值后除以本轮的 max,统一到 [0, 1]。
 *      - SQLite FTS5 的 bm25() 返回负数(越小越好),因此需要 abs。
 *      - 任何归一化后小于 FTS_GATE_THRESHOLD 的分数视为 0,过滤极弱命中。
 *   2. Vector 分支返回 sqlite-vec 的 L2 距离;在 BGE-zh 这类单位归一化嵌入下,
 *        cos_sim = 1 - L2² / 2
 *      可直接还原为 [0, 1] 的余弦相似度,无需再次归一。
 *   3. 融合公式: max(v, f) + FUSION_BONUS * min(v, f)
 *      - 保留两路中的主导信号
 *      - 对双路都命中的条目给出 bonus 奖励 (FUSION_BONUS = 0.3)
 *      - 输出范围: 单路命中 [0, 1.0],双路命中 [0, 1.3]
 *
 * 这个算法在 basic-memory 上游评测中比 RRF 更稳定,原因:
 *   - 直接利用了两路的连续相似度信号,而不是只看排序。
 *   - 当 vector 给出强匹配但 FTS 完全没命中(paraphrase/concept)时,
 *     仍然能保留 vector 的 [0, 1] 分数,不会被 RRF 的 1/(60+rank) 压扁。
 *   - 双路一致性奖励 (bonus * min) 避免单路 outlier 直接刷榜。
 *
 * 纯函数,无副作用;由 HybridSearchService 在 Worker 进程内调用。
 */

/** basic-memory 的常量,直接对齐上游 search_repository_base.py 顶部定义。 */
export const FUSION_BONUS = 0.3;
export const FTS_GATE_THRESHOLD = 0.0;

export interface FtsScoreItem<K> {
  key: K;
  /** SQLite FTS5 的 bm25() 原始 score (通常为负数),将由 fuser 自行 abs+归一化。 */
  score: number;
}

export interface VectorScoreItem<K> {
  key: K;
  /** sqlite-vec 的 L2 距离;归一化嵌入下转为 cos_sim = 1 - L2²/2。 */
  distance: number;
}

export interface ScoreFusedItem<K> {
  key: K;
  /** 融合后得分,越大越好。 */
  score: number;
  /** 0-based 融合后排名。 */
  rank: number;
  /** 这条记录在每个分支中的归一化分数 (未命中为 0)。 */
  perSource: Array<{ source: 'sqlite' | 'vector'; score: number }>;
}

export interface ScoreFusionOptions {
  /** 截断长度,默认 = 全部融合结果。 */
  limit?: number;
  /** 覆盖 FTS gate 阈值;默认 0,与 basic-memory 一致。 */
  ftsGateThreshold?: number;
  /** 覆盖 fusion bonus;默认 0.3,与 basic-memory 一致。 */
  fusionBonus?: number;
  /** 是否参与 sqlite 分支 (mode=vector 时关闭)。 */
  includeFts?: boolean;
  /** 是否参与 vector 分支 (mode=sqlite 时关闭)。 */
  includeVector?: boolean;
}

/**
 * basic-memory 距离 → 余弦相似度: 单位向量下 cos_sim = 1 - L2² / 2,clamp 到 [0, 1]。
 *
 * 与 sqlite_search_repository.py::_distance_to_similarity 完全等价。
 */
export function distanceToSimilarity(distance: number): number {
  const sim = 1.0 - (distance * distance) / 2.0;
  return sim > 0 ? (sim < 1 ? sim : 1) : 0;
}

/**
 * basic-memory 风格的 score-based 融合。
 *
 * 输入两个排序列表 (FTS / Vector),输出按融合得分降序的统一排序列表。
 * 同分按 key 字符串升序破,保证稳定。
 */
export function scoreFuse<K>(
  ftsItems: FtsScoreItem<K>[],
  vectorItems: VectorScoreItem<K>[],
  opts: ScoreFusionOptions = {}
): ScoreFusedItem<K>[] {
  const fusionBonus = opts.fusionBonus ?? FUSION_BONUS;
  const gate = opts.ftsGateThreshold ?? FTS_GATE_THRESHOLD;
  const useFts = opts.includeFts !== false;
  const useVector = opts.includeVector !== false;

  // ── 1. FTS 归一化: abs(score) / max(abs(scores)),低于 gate 的归零 ──
  const ftsScores = new Map<string, { key: K; score: number }>();
  if (useFts && ftsItems.length > 0) {
    let ftsMax = 0;
    for (const it of ftsItems) {
      const a = Math.abs(it.score ?? 0);
      if (a > ftsMax) ftsMax = a;
    }
    if (ftsMax > 0) {
      for (const it of ftsItems) {
        const norm = Math.abs(it.score ?? 0) / ftsMax;
        const gated = norm < gate ? 0 : norm;
        ftsScores.set(stringifyKey(it.key), { key: it.key, score: gated });
      }
    } else {
      // 所有 FTS 分数都是 0:仍然保留候选 key,只是分数为 0。
      for (const it of ftsItems) {
        ftsScores.set(stringifyKey(it.key), { key: it.key, score: 0 });
      }
    }
  }

  // ── 2. Vector: distance → cos_sim (已经在 [0, 1]) ──
  const vecScores = new Map<string, { key: K; score: number }>();
  if (useVector) {
    for (const it of vectorItems) {
      const sim = distanceToSimilarity(it.distance ?? Infinity);
      vecScores.set(stringifyKey(it.key), { key: it.key, score: sim });
    }
  }

  // ── 3. Fuse: max(v, f) + FUSION_BONUS * min(v, f) ──
  const allKeys = new Set<string>([...ftsScores.keys(), ...vecScores.keys()]);
  const fused: Array<{ key: K; score: number; ftsScore: number; vecScore: number; sortKey: string }> = [];
  for (const k of allKeys) {
    const f = ftsScores.get(k)?.score ?? 0;
    const v = vecScores.get(k)?.score ?? 0;
    const fusedScore = Math.max(v, f) + fusionBonus * Math.min(v, f);
    const key = (ftsScores.get(k)?.key ?? vecScores.get(k)!.key) as K;
    fused.push({ key, score: fusedScore, ftsScore: f, vecScore: v, sortKey: k });
  }

  // 主排序:分数降序;tie-break:sortKey 升序,保证结果稳定可重现。
  fused.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0;
  });

  const limit = opts.limit ?? fused.length;
  return fused.slice(0, limit).map((e, i) => ({
    key: e.key,
    score: e.score,
    rank: i,
    perSource: [
      { source: 'sqlite' as const, score: e.ftsScore },
      { source: 'vector' as const, score: e.vecScore },
    ],
  }));
}

function stringifyKey(k: unknown): string {
  return typeof k === 'string' ? k : JSON.stringify(k);
}
