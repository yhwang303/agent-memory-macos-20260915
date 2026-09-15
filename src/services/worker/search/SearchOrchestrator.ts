import type {
  SearchInput,
  SearchResults,
  SearchStrategy,
  SearchMode,
} from './types.js';

export interface OrchestratorDeps {
  sqlite: SearchStrategy;
  chroma: SearchStrategy | null;
  hybrid: SearchStrategy | null;
}

/**
 * Routes a search to the requested mode. Gracefully degrades to sqlite
 * whenever chroma/hybrid is unavailable.
 */
export class SearchOrchestrator {
  constructor(private deps: OrchestratorDeps) {}

  async search(opts: SearchInput): Promise<SearchResults> {
    const mode: SearchMode = opts.mode ?? 'hybrid';

    if (mode === 'sqlite') {
      return this.deps.sqlite.search({ ...opts, mode: 'sqlite' });
    }
    if (mode === 'chroma') {
      if (this.deps.chroma) return this.deps.chroma.search({ ...opts, mode: 'chroma' });
      const r = await this.deps.sqlite.search({ ...opts, mode: 'sqlite' });
      return { ...r, fellBack: true };
    }
    // hybrid (default)
    if (this.deps.hybrid) return this.deps.hybrid.search({ ...opts, mode: 'hybrid' });
    const r = await this.deps.sqlite.search({ ...opts, mode: 'sqlite' });
    return { ...r, fellBack: true };
  }

  isChromaAvailable(): boolean {
    return this.deps.chroma !== null;
  }
}
