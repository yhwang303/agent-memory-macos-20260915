import type {
  SearchInput,
  SearchResults,
  SearchStrategy,
  RankedObservation,
  RankedSummary,
} from './types.js';

export interface HybridWeights {
  k: number;
  sqliteWeight: number;
  chromaWeight: number;
}

export function rrfScore(rank: number, k: number): number {
  return 1 / (k + rank);
}

export class HybridSearchStrategy implements SearchStrategy {
  readonly name = 'hybrid' as const;
  private weights: HybridWeights;

  constructor(
    private sqlite: SearchStrategy,
    private chroma: SearchStrategy,
    weights?: Partial<HybridWeights>
  ) {
    this.weights = {
      k: weights?.k ?? 60,
      sqliteWeight: weights?.sqliteWeight ?? 0.4,
      chromaWeight: weights?.chromaWeight ?? 0.6,
    };
  }

  async search(opts: SearchInput): Promise<SearchResults> {
    const [sqliteRes, chromaRes] = await Promise.all([
      this.sqlite.search({ ...opts, mode: 'sqlite' }).catch(() => ({
        observations: [], summaries: [], mode: 'sqlite' as const, fellBack: true,
      })),
      this.chroma.search({ ...opts, mode: 'chroma' }).catch(() => ({
        observations: [], summaries: [], mode: 'chroma' as const, fellBack: true,
      })),
    ]);

    const limit = opts.limit ?? 20;
    const mergedObs = this.merge<RankedObservation>(
      sqliteRes.observations as RankedObservation[],
      chromaRes.observations as RankedObservation[]
    ).slice(0, limit);
    const mergedSum = this.merge<RankedSummary>(
      sqliteRes.summaries as RankedSummary[],
      chromaRes.summaries as RankedSummary[]
    ).slice(0, limit);

    return {
      observations: mergedObs,
      summaries: mergedSum,
      mode: 'hybrid',
      fellBack: sqliteRes.fellBack || chromaRes.fellBack,
    };
  }

  private merge<T extends { row: { id: number }; rank: number; score: number; source: any }>(
    sqliteList: T[],
    chromaList: T[]
  ): T[] {
    const k = this.weights.k;
    const sw = this.weights.sqliteWeight;
    const cw = this.weights.chromaWeight;
    const byId = new Map<number, { entry: T; score: number }>();

    if (sw > 0) {
      for (const r of sqliteList) {
        const s = sw * rrfScore(r.rank, k);
        byId.set(r.row.id, { entry: r, score: s });
      }
    }
    if (cw > 0) {
      for (const r of chromaList) {
        const add = cw * rrfScore(r.rank, k);
        const prev = byId.get(r.row.id);
        if (prev) {
          prev.score += add;
        } else {
          byId.set(r.row.id, { entry: r, score: add });
        }
      }
    }

    return Array.from(byId.values())
      .sort((a, b) => b.score - a.score)
      .map(({ entry, score }, i) => ({
        ...entry,
        score,
        rank: i,
        source: 'hybrid',
      } as unknown as T));
  }
}
