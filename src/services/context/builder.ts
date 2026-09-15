/**
 * Context Builder Service
 * Builds memory context for injection into user prompts
 */

import { 
  getTieredObservationsByProject, 
  searchObservations
} from '../sqlite/observations.js';
import { 
  getSummariesByProject,
  searchSummaries
} from '../sqlite/summaries.js';
import type { ObservationRow, SessionSummaryRow, SearchOptions } from '../../types/database.js';

/**
 * Memory context configuration
 */
export interface ContextConfig {
  maxObservations: number;
  maxSummaries: number;
  maxTokens: number;
  includeRecentFirst: boolean;
}

/**
 * Memory context result
 */
export interface MemoryContext {
  observations: ObservationRow[];
  summaries: SessionSummaryRow[];
  totalTokens: number;
  formattedContext: string;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: ContextConfig = {
  maxObservations: 10,
  maxSummaries: 5,
  maxTokens: 4000,
  includeRecentFirst: true
};

/**
 * Context Builder class
 * Retrieves and formats memory context for prompt injection
 */
export class ContextBuilder {
  private config: ContextConfig;

  constructor(config: Partial<ContextConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Build memory context for a project
   */
  async buildContext(project: string, query?: string): Promise<MemoryContext> {
    // Fetch observations
    let observations: ObservationRow[];
    if (query) {
      observations = searchObservations(query, {
        project,
        limit: this.config.maxObservations,
        orderBy: this.config.includeRecentFirst ? 'date_desc' : 'date_asc'
      });
    } else {
      // 分档召回：默认只取 Tier ≥2，Tier 2 不足时用 Tier 1 trace 兜底。
      observations = getTieredObservationsByProject(project, this.config.maxObservations);
    }

    // Fetch summaries
    const summaries = getSummariesByProject(project, this.config.maxSummaries);

    // Format context
    const formattedContext = this.formatContext(observations, summaries);
    const totalTokens = this.estimateTokens(formattedContext);

    return {
      observations,
      summaries,
      totalTokens,
      formattedContext
    };
  }

  /**
   * Build context by semantic search
   */
  async buildSemanticContext(project: string, query: string): Promise<MemoryContext> {
    const observations = searchObservations(query, {
      project,
      limit: this.config.maxObservations,
      orderBy: 'relevance'
    });

    const summaries = searchSummaries(query, {
      project,
      limit: this.config.maxSummaries
    });

    const formattedContext = this.formatContext(observations, summaries);
    const totalTokens = this.estimateTokens(formattedContext);

    return {
      observations,
      summaries,
      totalTokens,
      formattedContext
    };
  }

  /**
   * Format observations and summaries into a context string
   */
  private formatContext(observations: ObservationRow[], summaries: SessionSummaryRow[]): string {
    const parts: string[] = [];

    // Add header
    parts.push('<memory_context>');

    // Format summaries section
    if (summaries.length > 0) {
      parts.push('\n<recent_sessions>');
      for (const summary of summaries) {
        parts.push(this.formatSummary(summary));
      }
      parts.push('</recent_sessions>');
    }

    // Format observations section
    if (observations.length > 0) {
      parts.push('\n<observations>');
      for (const obs of observations) {
        parts.push(this.formatObservation(obs));
      }
      parts.push('</observations>');
    }

    parts.push('\n</memory_context>');

    return parts.join('\n');
  }

  /**
   * Format a single observation
   */
  private formatObservation(obs: ObservationRow): string {
    const parts: string[] = [];
    parts.push(`\n<observation type="${obs.type}" date="${obs.created_at}">`);
    
    if (obs.title) {
      parts.push(`  <title>${obs.title}</title>`);
    }
    
    if (obs.narrative) {
      parts.push(`  <narrative>${obs.narrative}</narrative>`);
    }
    
    if (obs.facts) {
      parts.push(`  <facts>${obs.facts}</facts>`);
    }
    
    if (obs.files_modified) {
      parts.push(`  <files_modified>${obs.files_modified}</files_modified>`);
    }
    
    if (obs.concepts) {
      parts.push(`  <concepts>${obs.concepts}</concepts>`);
    }
    
    parts.push('</observation>');
    return parts.join('\n');
  }

  /**
   * Format a single session summary
   */
  private formatSummary(summary: SessionSummaryRow): string {
    const parts: string[] = [];
    parts.push(`\n<session date="${summary.created_at}">`);
    
    if (summary.request) {
      parts.push(`  <request>${summary.request}</request>`);
    }
    
    if (summary.learned) {
      parts.push(`  <learned>${summary.learned}</learned>`);
    }
    
    if (summary.completed) {
      parts.push(`  <completed>${summary.completed}</completed>`);
    }
    
    if (summary.next_steps) {
      parts.push(`  <next_steps>${summary.next_steps}</next_steps>`);
    }
    
    if (summary.files_edited) {
      parts.push(`  <files_edited>${summary.files_edited}</files_edited>`);
    }
    
    parts.push('</session>');
    return parts.join('\n');
  }

  /**
   * Estimate token count (rough approximation: 4 chars per token)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Truncate context to fit within token limit
   */
  truncateToFit(context: MemoryContext): MemoryContext {
    if (context.totalTokens <= this.config.maxTokens) {
      return context;
    }

    // Reduce observations first
    let observations = [...context.observations];
    let summaries = [...context.summaries];
    let formattedContext = context.formattedContext;
    let totalTokens = context.totalTokens;

    while (totalTokens > this.config.maxTokens && observations.length > 1) {
      observations.pop();
      formattedContext = this.formatContext(observations, summaries);
      totalTokens = this.estimateTokens(formattedContext);
    }

    // If still too large, reduce summaries
    while (totalTokens > this.config.maxTokens && summaries.length > 1) {
      summaries.pop();
      formattedContext = this.formatContext(observations, summaries);
      totalTokens = this.estimateTokens(formattedContext);
    }

    return {
      observations,
      summaries,
      totalTokens,
      formattedContext
    };
  }
}

export default ContextBuilder;
