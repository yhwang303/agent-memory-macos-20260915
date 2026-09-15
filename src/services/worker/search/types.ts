import type {
  ObservationRow,
  SessionSummaryRow,
} from '../../../types/database.js';

export type SearchMode = 'sqlite' | 'chroma' | 'hybrid';

export interface SearchInput {
  /** Search query text. May be FTS5 syntax for sqlite mode. */
  query: string;
  mode?: SearchMode;
  project?: string;
  limit?: number;
  dateStart?: string;
  dateEnd?: string;
  /** Observation types filter, e.g. ['bugfix', 'feature'] */
  obs_type?: string[];
}

export interface RankedObservation {
  row: ObservationRow;
  /** Strategy-specific score. Higher is better. */
  score: number;
  /** 0-based position in the strategy's result list (used by RRF). */
  rank: number;
  source: SearchMode;
}

export interface RankedSummary {
  row: SessionSummaryRow;
  score: number;
  rank: number;
  source: SearchMode;
}

export interface SearchResults {
  observations: RankedObservation[];
  summaries: RankedSummary[];
  mode: SearchMode;
  /** True when the mode requested was not fully available and results came from a fallback. */
  fellBack: boolean;
}

export interface SearchStrategy {
  readonly name: SearchMode;
  search(opts: SearchInput): Promise<SearchResults>;
}
