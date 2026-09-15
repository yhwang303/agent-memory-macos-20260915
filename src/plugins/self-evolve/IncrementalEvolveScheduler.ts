/**
 * IncrementalEvolveScheduler
 *
 * Instead of evolving only when a session ends, this scheduler triggers
 * evolution in segments based on:
 *   1. Observation count threshold
 *   2. Idle timeout (user inactive with pending observations)
 *   3. Topic switch detection (file prefix / obs type / time gap)
 *
 * It maintains a watermark so observations are never processed twice,
 * and persists state to survive Worker restarts.
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger.js';
import { getDataDir } from '../../shared/paths.js';
import type { IncrementalEvolveConfig, SelfEvolvePluginConfig } from './types.js';
import { DEFAULT_INCREMENTAL_CONFIG } from './types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ObservationRef {
  id: number;
  type: string;
  title: string;
  narrative?: string;
  files_modified?: string;
  project: string;
  workspace: string;
  memorySessionId: string;
  timestamp: number; // epoch ms
}

export type TriggerReason = 'count_threshold' | 'idle_timeout' | 'topic_switch' | 'session_end';

export interface EvolveSegment {
  observations: ObservationRef[];
  workspace: string;
  sessionId: string;
  triggerReason: TriggerReason;
}

interface SchedulerState {
  lastEvolvedObsId: number;
  lastEvolveAt: string | null;
  dailyRunCount: number;
  dailyResetDate: string;
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

export class IncrementalEvolveScheduler {
  private config: IncrementalEvolveConfig;
  private pluginConfig: SelfEvolvePluginConfig;
  private pendingObservations: ObservationRef[] = [];
  private lastEvolvedObsId: number = 0;
  private lastEvolveAt: number = 0;
  private dailyRunCount: number = 0;
  private dailyResetDate: string = '';
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onEvolveCallback: ((segment: EvolveSegment) => Promise<void>) | null = null;

  constructor(pluginConfig: SelfEvolvePluginConfig) {
    this.pluginConfig = pluginConfig;
    this.config = {
      ...DEFAULT_INCREMENTAL_CONFIG,
      ...(pluginConfig.incremental || {}),
    };
    this.dailyResetDate = this.todayStr();
  }

  /** Register the callback that actually performs evolution on a segment */
  onEvolve(callback: (segment: EvolveSegment) => Promise<void>): void {
    this.onEvolveCallback = callback;
  }

  /** Called each time a new observation is inserted */
  onObservationAdded(obs: ObservationRef): void {
    if (!this.config.enabled) return;
    if (obs.id <= this.lastEvolvedObsId) return; // already processed

    this.pendingObservations.push(obs);
    this.resetIdleTimer();

    // Path 1: count threshold
    if (this.pendingObservations.length >= this.config.observationThreshold) {
      this.tryEvolve('count_threshold');
      return;
    }

    // Path 2: topic switch detection
    if (this.config.topicSwitchEnabled && this.pendingObservations.length >= this.config.minSegmentSize) {
      if (this.detectTopicSwitch(obs)) {
        this.tryEvolve('topic_switch');
      }
    }
  }

  /** Flush remaining observations (called on session end) */
  flushRemaining(): ObservationRef[] {
    const remaining = [...this.pendingObservations];
    return remaining;
  }

  /** Called when session ends — evolve whatever's left */
  async onSessionEnd(sessionId: string, workspace: string): Promise<void> {
    if (!this.config.enabled) return;
    const remaining = this.flushRemaining();
    if (remaining.length >= this.config.minSegmentSize) {
      await this.doEvolve({
        observations: remaining,
        workspace,
        sessionId,
        triggerReason: 'session_end',
      });
    } else {
      // Not enough to evolve, just clear
      this.pendingObservations = [];
    }
  }

  /** Persist state to disk (call on Worker shutdown) */
  persist(): void {
    const state: SchedulerState = {
      lastEvolvedObsId: this.lastEvolvedObsId,
      lastEvolveAt: this.lastEvolveAt ? new Date(this.lastEvolveAt).toISOString() : null,
      dailyRunCount: this.dailyRunCount,
      dailyResetDate: this.dailyResetDate,
    };
    try {
      const dir = path.join(getDataDir(), 'plugins', 'self-evolve');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'scheduler-state.json'),
        JSON.stringify(state, null, 2),
      );
    } catch (err) {
      logger.error('EVOLVE_SCHEDULER', 'Failed to persist state', {}, err as Error);
    }
  }

  /** Restore state from disk (call on Worker startup) */
  restore(): void {
    try {
      const filePath = path.join(getDataDir(), 'plugins', 'self-evolve', 'scheduler-state.json');
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, 'utf8');
      const state: SchedulerState = JSON.parse(raw);
      this.lastEvolvedObsId = state.lastEvolvedObsId ?? 0;
      this.lastEvolveAt = state.lastEvolveAt ? new Date(state.lastEvolveAt).getTime() : 0;
      this.dailyRunCount = state.dailyRunCount ?? 0;
      this.dailyResetDate = state.dailyResetDate ?? this.todayStr();

      // Reset daily counter if date changed
      if (this.dailyResetDate !== this.todayStr()) {
        this.dailyRunCount = 0;
        this.dailyResetDate = this.todayStr();
      }
      logger.info('EVOLVE_SCHEDULER', 'State restored', {
        lastEvolvedObsId: this.lastEvolvedObsId,
        dailyRunCount: this.dailyRunCount,
      });
    } catch {
      // Fresh start if file doesn't exist or is corrupted
    }
  }

  /** Stop idle timer (call on Worker shutdown) */
  destroy(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private tryEvolve(reason: TriggerReason): void {
    const now = Date.now();

    // Cooldown check
    if (now - this.lastEvolveAt < this.config.cooldownMinutes * 60_000) {
      logger.debug('EVOLVE_SCHEDULER', 'Cooldown active, skipping', { reason });
      return;
    }

    // Daily limit check
    if (this.dailyResetDate !== this.todayStr()) {
      this.dailyRunCount = 0;
      this.dailyResetDate = this.todayStr();
    }
    if (this.dailyRunCount >= this.config.maxDailyRuns) {
      logger.info('EVOLVE_SCHEDULER', 'Daily limit reached', { dailyRunCount: this.dailyRunCount });
      return;
    }

    // Min segment size check
    if (this.pendingObservations.length < this.config.minSegmentSize) {
      return;
    }

    // Determine segment to evolve
    let segment: ObservationRef[];
    if (reason === 'topic_switch') {
      // Evolve everything BEFORE the last observation (which triggered the switch)
      segment = this.pendingObservations.slice(0, -1);
      this.pendingObservations = [this.pendingObservations[this.pendingObservations.length - 1]];
    } else {
      // Evolve all pending
      segment = [...this.pendingObservations];
      this.pendingObservations = [];
    }

    if (segment.length < this.config.minSegmentSize) return;

    const workspace = segment[0]?.workspace || '';
    const sessionId = segment[0]?.memorySessionId || `incremental-${Date.now()}`;

    this.doEvolve({ observations: segment, workspace, sessionId, triggerReason: reason });
  }

  private async doEvolve(segment: EvolveSegment): Promise<void> {
    this.lastEvolveAt = Date.now();
    this.dailyRunCount++;

    // Update watermark
    const maxId = Math.max(...segment.observations.map(o => o.id));
    if (maxId > this.lastEvolvedObsId) {
      this.lastEvolvedObsId = maxId;
    }

    // Remove evolved observations from pending
    this.pendingObservations = this.pendingObservations.filter(o => o.id > this.lastEvolvedObsId);

    logger.info('EVOLVE_SCHEDULER', 'Triggering segment evolution', {
      reason: segment.triggerReason,
      observationCount: segment.observations.length,
      workspace: segment.workspace,
      dailyRunCount: this.dailyRunCount,
    });

    if (this.onEvolveCallback) {
      try {
        await this.onEvolveCallback(segment);
      } catch (err) {
        logger.error('EVOLVE_SCHEDULER', 'Evolution callback failed', {}, err as Error);
      }
    }

    // Persist after successful evolution
    this.persist();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.pendingObservations.length >= this.config.minSegmentSize) {
        this.tryEvolve('idle_timeout');
      }
    }, this.config.idleMinutes * 60_000);
  }

  /**
   * Detect if the new observation represents a topic switch.
   * Uses local heuristics (no AI call):
   *   - File path prefix shift
   *   - Observation type shift
   *   - Time gap > 15 minutes
   *   - Project/workspace change
   * Requires 2+ signals to fire.
   */
  private detectTopicSwitch(newObs: ObservationRef): boolean {
    const recent = this.pendingObservations.slice(-4, -1); // last 3 before newObs
    if (recent.length < 2) return false;

    let signals = 0;

    // Signal 1: file path prefix shift
    if (this.hasPathPrefixShift(recent, newObs)) signals++;

    // Signal 2: observation type shift
    if (this.hasTypeShift(recent, newObs)) signals++;

    // Signal 3: time gap > 15 minutes
    const lastTimestamp = recent[recent.length - 1]?.timestamp ?? 0;
    if (lastTimestamp > 0 && (newObs.timestamp - lastTimestamp) > 15 * 60_000) signals++;

    // Signal 4: project change
    const lastProject = recent[recent.length - 1]?.project;
    if (lastProject && newObs.project && lastProject !== newObs.project) signals++;

    return signals >= 2;
  }

  private hasPathPrefixShift(recent: ObservationRef[], newObs: ObservationRef): boolean {
    const recentPrefixes = new Set(
      recent
        .flatMap(o => (o.files_modified || '').split(','))
        .map(f => f.trim().split('/').slice(0, 2).join('/'))
        .filter(Boolean),
    );
    const newPrefixes = (newObs.files_modified || '').split(',')
      .map(f => f.trim().split('/').slice(0, 2).join('/'))
      .filter(Boolean);

    if (recentPrefixes.size === 0 || newPrefixes.length === 0) return false;
    return newPrefixes.every(p => !recentPrefixes.has(p));
  }

  private hasTypeShift(recent: ObservationRef[], newObs: ObservationRef): boolean {
    const recentTypes = new Set(recent.map(o => o.type));
    // If recent were all one type and new is different, that's a shift
    if (recentTypes.size === 1 && !recentTypes.has(newObs.type)) return true;
    return false;
  }

  private todayStr(): string {
    return new Date().toISOString().slice(0, 10);
  }
}
