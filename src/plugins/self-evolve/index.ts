/**
 * Self-Evolve plugin entry point.
 * Provides the SelfEvolvePlugin interface and factory function used by WorkerService.
 */

import { logger } from '../../utils/logger.js';
import { EvolveEngine } from './EvolveEngine.js';
import { ContextBuilder } from './ContextBuilder.js';
import { PlatformWriter } from './PlatformWriter.js';
import { getRulesByWorkspace, getPendingRules, getRuleById, approveRule, rejectRule } from './db/rules.js';
import { getSkillsByWorkspace, getPendingSkills, getSkillById, approveSkill, rejectSkill } from './db/skills.js';
import { getEvoLogBySession, getEvoLogByWorkspace } from './db/evoLog.js';
import { normalizeProjectPath } from '../../types/database.js';
import { IncrementalEvolveScheduler, type ObservationRef, type EvolveSegment } from './IncrementalEvolveScheduler.js';
import type {
  SelfEvolvePluginConfig,
  SelfEvolveStatus,
  PendingItem,
  EvolvedRule,
  EvolvedSkill,
  EvolutionLog,
} from './types.js';

export type { SelfEvolvePluginConfig } from './types.js';
export { DEFAULT_SELF_EVOLVE_CONFIG } from './types.js';
export type { ObservationRef } from './IncrementalEvolveScheduler.js';

export interface SelfEvolvePlugin {
  initialize(config: SelfEvolvePluginConfig): void;
  onSessionEnd(memorySessionId: string, workspace: string): Promise<void>;
  onObservationAdded(obs: ObservationRef): void;
  destroy(): void;
  getStatus(): SelfEvolveStatus;
  triggerEvolve(memorySessionId: string, workspace: string, force?: boolean): Promise<void>;
  getPendingReview(workspace: string): PendingItem[];
  approveArtifact(id: number, type: 'rule' | 'skill', targetPlatforms?: string[]): Promise<void>;
  rejectArtifact(id: number, type: 'rule' | 'skill', reason: string): Promise<void>;
  getRules(workspace: string, category?: string): EvolvedRule[];
  getSkills(workspace: string): EvolvedSkill[];
  getEvoLog(workspace: string, limit?: number): EvolutionLog[];
  buildContext(workspace: string): string;
  writeToFiles(workspace: string): void;
}

class SelfEvolvePluginImpl implements SelfEvolvePlugin {
  private config!: SelfEvolvePluginConfig;
  private engine = new EvolveEngine();
  private contextBuilder = new ContextBuilder();
  private writer = new PlatformWriter();
  private scheduler: IncrementalEvolveScheduler | null = null;
  private currentState: SelfEvolveStatus['currentState'] = 'idle';
  private lastRunAt: string | null = null;
  private lastRunStatus: string | null = null;
  private lastError: string | null = null;

  initialize(config: SelfEvolvePluginConfig): void {
    this.config = config;

    // Initialize incremental evolve scheduler
    this.scheduler = new IncrementalEvolveScheduler(config);
    this.scheduler.restore();
    this.scheduler.onEvolve(async (segment: EvolveSegment) => {
      await this.evolveSegment(segment);
    });

    logger.info('SELF_EVOLVE', 'Plugin initialized', {
      reviewMode: config.reviewMode,
      targetPlatforms: config.targetPlatforms,
      incrementalEnabled: this.scheduler !== null,
    });
  }

  /** Called each time a new observation is written */
  onObservationAdded(obs: ObservationRef): void {
    if (!this.config?.enabled) return;
    this.scheduler?.onObservationAdded(obs);
  }

  async onSessionEnd(memorySessionId: string, workspace: string): Promise<void> {
    if (!this.config?.enabled) return;
    const ws = normalizeProjectPath(workspace);

    // Let scheduler flush remaining observations
    if (this.scheduler) {
      await this.scheduler.onSessionEnd(memorySessionId, ws);
    } else {
      // Fallback: legacy behavior (full session evolution)
      await this.triggerEvolve(memorySessionId, ws, false);
    }
  }

  /** Cleanup on Worker shutdown */
  destroy(): void {
    if (this.scheduler) {
      this.scheduler.persist();
      this.scheduler.destroy();
    }
  }

  async triggerEvolve(memorySessionId: string, workspace: string, force = false): Promise<void> {
    if (this.currentState === 'running') {
      logger.info('SELF_EVOLVE', 'Evolution already running; queuing skipped', { memorySessionId });
      return;
    }

    this.currentState = 'running';
    this.lastRunAt = new Date().toISOString();
    try {
      await this.engine.run(memorySessionId, workspace, this.config, force);
      const log = getEvoLogBySession(memorySessionId);
      this.lastRunStatus = log?.status ?? 'completed';
      this.lastError = log?.error_message ?? null;
      this.currentState = 'idle';
    } catch (err) {
      this.currentState = 'error';
      this.lastError = String(err);
      this.lastRunStatus = 'failed';
      logger.error('SELF_EVOLVE', 'Trigger failed', { memorySessionId }, err as Error);
    }
  }

  getStatus(): SelfEvolveStatus {
    return {
      enabled: this.config?.enabled ?? false,
      currentState: this.currentState,
      lastRunAt: this.lastRunAt,
      lastRunStatus: this.lastRunStatus,
      lastError: this.lastError,
    };
  }

  getPendingReview(workspace: string): PendingItem[] {
    const ws = normalizeProjectPath(workspace);
    const pendingRules = getPendingRules(ws);
    const pendingSkills = getPendingSkills(ws);
    return [...pendingRules, ...pendingSkills].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  }

  async approveArtifact(id: number, type: 'rule' | 'skill', targetPlatforms?: string[]): Promise<void> {
    const platforms = targetPlatforms ?? this.config?.targetPlatforms ?? ['claudecode'];
    if (type === 'rule') {
      const rule = getRuleById(id);
      approveRule(id);
      if (rule && platforms.length) {
        this.writer.writeAll(rule.workspace, platforms);
      }
    } else {
      const skill = getSkillById(id);
      approveSkill(id);
      if (skill && platforms.length) {
        this.writer.writeAll(skill.workspace, platforms);
      }
    }
  }

  async rejectArtifact(id: number, type: 'rule' | 'skill', reason: string): Promise<void> {
    if (type === 'rule') {
      rejectRule(id, reason);
    } else {
      rejectSkill(id);
    }
  }

  getRules(workspace: string, category?: string): EvolvedRule[] {
    const ws = normalizeProjectPath(workspace);
    return getRulesByWorkspace(ws, { status: 'active', ...(category ? { category } : {}) });
  }

  getSkills(workspace: string): EvolvedSkill[] {
    const ws = normalizeProjectPath(workspace);
    return getSkillsByWorkspace(ws, { status: 'active' });
  }

  getEvoLog(workspace: string, limit = 50): EvolutionLog[] {
    const ws = normalizeProjectPath(workspace);
    return getEvoLogByWorkspace(ws, limit);
  }

  buildContext(workspace: string): string {
    const ws = normalizeProjectPath(workspace);
    return this.contextBuilder.build(ws, this.config?.maxContextRules ?? 20);
  }

  writeToFiles(workspace: string): void {
    const ws = normalizeProjectPath(workspace);
    this.writer.writeAll(ws, this.config?.targetPlatforms ?? ['claudecode']);
  }

  // ─── Incremental evolution ───────────────────────────────────────────────

  private async evolveSegment(segment: EvolveSegment): Promise<void> {
    if (this.currentState === 'running') {
      logger.info('SELF_EVOLVE', 'Already running, segment evolution deferred', {
        reason: segment.triggerReason,
      });
      return;
    }

    const segmentSessionId = `${segment.sessionId}:seg-${Date.now()}`;
    this.currentState = 'running';
    this.lastRunAt = new Date().toISOString();

    try {
      // Run the engine with segment observations (reuses existing EvolveEngine)
      await this.engine.runFromSegment(
        segmentSessionId,
        segment.workspace,
        segment.observations,
        segment.triggerReason,
        this.config,
      );
      const log = getEvoLogBySession(segmentSessionId);
      this.lastRunStatus = log?.status ?? 'completed';
      this.lastError = log?.error_message ?? null;
      this.currentState = 'idle';
    } catch (err) {
      this.currentState = 'error';
      this.lastError = String(err);
      this.lastRunStatus = 'failed';
      logger.error('SELF_EVOLVE', 'Segment evolution failed', { segmentSessionId }, err as Error);
    }
  }
}

export function createSelfEvolvePlugin(): SelfEvolvePlugin {
  return new SelfEvolvePluginImpl();
}
