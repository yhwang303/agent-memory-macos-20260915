/**
 * Type definitions for Self-Evolve plugin database entities and configuration.
 */

// ─── Database row types ────────────────────────────────────────────────────

export interface EvolvedRuleRow {
  id: number;
  workspace: string;
  title: string;
  content: string;
  category: string;
  slug: string | null;
  paths_glob: string | null;
  source_session_id: string | null;
  evidence: string | null;
  status: 'active' | 'deprecated' | 'rejected';
  rule_type: 'user_evolved' | 'natural_selection';
  quality_score: number | null;
  feedback: string | null;
  audit_status: 'pending' | 'approved' | 'rejected';
  review_status: 'auto' | 'manual';
  created_at: string;
  updated_at: string;
}

export interface EvolvedSkillRow {
  id: number;
  workspace: string;
  slug: string;
  name: string;
  trigger_scene: string | null;
  description: string | null;
  skill_kind: 'markdown' | 'tool';
  skill_md: string | null;
  manifest_json: string | null;
  source_session_id: string | null;
  evidence: string | null;
  status: 'active' | 'deprecated' | 'rejected';
  quality_score: number | null;
  audit_status: 'pending' | 'approved' | 'rejected';
  review_status: 'auto' | 'manual';
  created_at: string;
  updated_at: string;
}

export interface EvolutionLogRow {
  id: number;
  memory_session_id: string;
  workspace: string;
  rules_added: number;
  rules_updated: number;
  skills_added: number;
  rejected_rules: number;
  rejected_skills: number;
  status: 'running' | 'completed' | 'failed' | 'skipped';
  error_message: string | null;
  raw_output: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface NaturalSelectionRow {
  id: number;
  title: string;
  content: string;
  scope: 'all' | 'rules' | 'skills';
  type: 'append' | 'prepend' | 'replace';
  enabled: number;
  created_at: string;
}

// ─── Plugin configuration ──────────────────────────────────────────────────

export interface IncrementalEvolveConfig {
  /** Enable incremental (segment-based) evolution instead of session-end only */
  enabled: boolean;
  /** Trigger after N observations accumulate */
  observationThreshold: number;
  /** Trigger after N minutes of user inactivity with pending observations */
  idleMinutes: number;
  /** Detect topic switches and evolve the previous segment */
  topicSwitchEnabled: boolean;
  /** Minimum minutes between two incremental evolutions */
  cooldownMinutes: number;
  /** Maximum evolutions per day */
  maxDailyRuns: number;
  /** Minimum observations in a segment to be worth evolving */
  minSegmentSize: number;
}

export const DEFAULT_INCREMENTAL_CONFIG: IncrementalEvolveConfig = {
  enabled: true,
  observationThreshold: 8,
  idleMinutes: 30,
  topicSwitchEnabled: true,
  cooldownMinutes: 10,
  maxDailyRuns: 30,
  minSegmentSize: 3,
};

export interface SelfEvolvePluginConfig {
  enabled: boolean;
  reviewMode: 'auto' | 'manual' | 'quality_gate';
  qualityGateThreshold: number;
  targetPlatforms: string[];
  maxContextRules: number;
  criticOnGenerate: boolean;
  aiModel?: string;
  incremental?: Partial<IncrementalEvolveConfig>;
  /**
   * 证据接地门禁：拒绝 evidence 无法在本次 observation/summary 文本中找到依据的规则
   * （即疑似 AI 转述/臆造）。默认开启。
   */
  verbatimEvidenceGate?: boolean;
}

export const DEFAULT_SELF_EVOLVE_CONFIG: SelfEvolvePluginConfig = {
  enabled: false,
  reviewMode: 'manual',
  qualityGateThreshold: 70,
  targetPlatforms: ['claudecode'],
  maxContextRules: 20,
  criticOnGenerate: true,
  verbatimEvidenceGate: true,
};

// ─── Domain objects (returned to callers) ─────────────────────────────────

export interface EvolvedRule extends EvolvedRuleRow {}
export interface EvolvedSkill extends EvolvedSkillRow {}
export interface EvolutionLog extends EvolutionLogRow {}

export interface PendingItem {
  id: number;
  type: 'rule' | 'skill';
  title: string;
  content: string;
  workspace: string;
  source_session_id: string | null;
  quality_score: number | null;
  created_at: string;
}

export interface SelfEvolveStatus {
  enabled: boolean;
  currentState: 'idle' | 'running' | 'error';
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastError: string | null;
}

// ─── Engine I/O types ──────────────────────────────────────────────────────

export interface EvolveInput {
  memorySessionId: string;
  workspace: string;
  observations: Array<{
    type: string;
    title: string | null;
    text: string | null;
    narrative: string | null;
    facts: string | null;
    files_modified: string | null;
  }>;
  sessionSummary: {
    request: string | null;
    learned: string | null;
    completed: string | null;
    next_steps: string | null;
    meta_intent: string | null;
  } | null;
  existingRules: EvolvedRuleRow[];
  naturalSelections: NaturalSelectionRow[];
}

export interface EvolveOutput {
  rules: Array<{
    title: string;
    content: string;
    category: string;
    slug?: string;
    paths_glob?: string;
    evidence?: string;
    is_update?: boolean;
  }>;
  skills: Array<{
    slug: string;
    name: string;
    trigger_scene?: string;
    description?: string;
    skill_md?: string;
    evidence?: string;
  }>;
}

export interface CriticResult {
  quality_score: number;
  feedback: string;
  approved: boolean;
}
