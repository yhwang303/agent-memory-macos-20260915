import { searchObservations } from '../../sqlite/observations.js';
import { searchSummariesLike } from '../../sqlite/summaries.js';
import type { SearchOptions } from '../../../types/database.js';
import type {
  SearchInput,
  SearchResults,
  SearchStrategy,
  RankedObservation,
  RankedSummary,
} from './types.js';

export class SQLiteSearchStrategy implements SearchStrategy {
  readonly name = 'sqlite' as const;

  async search(opts: SearchInput): Promise<SearchResults> {
    const limit = opts.limit ?? 20;

    const sqliteOpts: SearchOptions = {
      limit,
      project: opts.project,
    };
    if (opts.obs_type && opts.obs_type.length > 0) {
      // SQLite observations search accepts string | string[]
      sqliteOpts.type = opts.obs_type as any;
    }
    if (opts.dateStart || opts.dateEnd) {
      sqliteOpts.dateRange = { start: opts.dateStart, end: opts.dateEnd };
    }

    let obs: any[] = [];
    let sums: any[] = [];
    try {
      obs = searchObservations(opts.query, sqliteOpts) ?? [];
    } catch {
      obs = [];
    }
    try {
      sums = searchSummariesLike(opts.query, { ...sqliteOpts, type: undefined }) ?? [];
    } catch {
      sums = [];
    }

    const observations: RankedObservation[] = obs.slice(0, limit).map((row, i) => ({
      row,
      // FTS5 rank is a negative bm25 score where more-negative = better.
      // Use rank-position as a stable score: 1/(i+1). Downstream RRF ignores
      // the absolute score and uses `rank`.
      score: 1 / (i + 1),
      rank: i,
      source: 'sqlite' as const,
    }));
    const summaries: RankedSummary[] = sums.slice(0, limit).map((row, i) => ({
      row,
      score: 1 / (i + 1),
      rank: i,
      source: 'sqlite' as const,
    }));

    return {
      observations,
      summaries,
      mode: 'sqlite',
      fellBack: false,
    };
  }
}
