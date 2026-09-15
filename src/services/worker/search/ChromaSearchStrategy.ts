import {
  getObservationsByIds as defaultGetObs,
} from '../../sqlite/observations.js';
import {
  getSummariesByIds as defaultGetSum,
} from '../../sqlite/summaries.js';
import type {
  SearchInput,
  SearchResults,
  SearchStrategy,
  RankedObservation,
  RankedSummary,
} from './types.js';

export interface ChromaQueryResult {
  sqlite_ids: number[];
  doc_types: string[]; // 'observation' | 'session_summary'
  distances: number[];
}

export interface ChromaSyncLike {
  query(
    text: string,
    nResults: number,
    filter?: { project?: string; type?: string[] }
  ): Promise<ChromaQueryResult>;
}

export interface ChromaStrategyDeps {
  getObservationsByIds?: (ids: number[], project?: string) => any[];
  getSummariesByIds?: (ids: number[], project?: string) => any[];
}

export class ChromaSearchStrategy implements SearchStrategy {
  readonly name = 'chroma' as const;
  private getObs: (ids: number[], project?: string) => any[];
  private getSum: (ids: number[], project?: string) => any[];

  constructor(private sync: ChromaSyncLike, deps?: ChromaStrategyDeps) {
    this.getObs = deps?.getObservationsByIds ?? defaultGetObs;
    this.getSum = deps?.getSummariesByIds ?? defaultGetSum;
  }

  async search(opts: SearchInput): Promise<SearchResults> {
    const limit = opts.limit ?? 20;

    const filter: { project?: string; type?: string[] } = {};
    if (opts.project) filter.project = opts.project;
    if (opts.obs_type && opts.obs_type.length > 0) filter.type = opts.obs_type;

    let chromaResult: ChromaQueryResult;
    try {
      // Fetch 2x limit to give headroom when doc_types split between observations and summaries.
      chromaResult = await this.sync.query(opts.query, Math.max(limit * 2, limit), filter);
    } catch {
      return {
        observations: [],
        summaries: [],
        mode: 'chroma',
        fellBack: true,
      };
    }

    // Preserve Chroma's ordering (by distance ascending).
    const obsIds: number[] = [];
    const obsDistances: number[] = [];
    const sumIds: number[] = [];
    const sumDistances: number[] = [];
    for (let i = 0; i < chromaResult.sqlite_ids.length; i++) {
      const id = chromaResult.sqlite_ids[i];
      const type = chromaResult.doc_types[i];
      const dist = chromaResult.distances[i];
      if (type === 'observation') {
        obsIds.push(id);
        obsDistances.push(dist);
      } else if (type === 'session_summary') {
        sumIds.push(id);
        sumDistances.push(dist);
      }
    }

    // Hydrate rows from SQLite. The hydrator preserves input order; if a row
    // was deleted, it is simply missing from the result.
    const obsRows = this.getObs(obsIds, opts.project);
    const sumRows = this.getSum(sumIds, opts.project);

    // Map id → original distance so dropped rows don't shift distances.
    const obsDistById = new Map(obsIds.map((id, i) => [id, obsDistances[i]]));
    const sumDistById = new Map(sumIds.map((id, i) => [id, sumDistances[i]]));

    const observations: RankedObservation[] = obsRows.map((row: any, i: number) => ({
      row,
      score: 1 - (obsDistById.get(row.id) ?? 0),
      rank: i,
      source: 'chroma' as const,
    })).slice(0, limit);

    const summaries: RankedSummary[] = sumRows.map((row: any, i: number) => ({
      row,
      score: 1 - (sumDistById.get(row.id) ?? 0),
      rank: i,
      source: 'chroma' as const,
    })).slice(0, limit);

    return {
      observations,
      summaries,
      mode: 'chroma',
      fellBack: false,
    };
  }
}
