/**
 * EvolveEngine — adapted from Self-Evolve for Agent-Mem plugin.
 * Input: Agent-Mem observations + session_summary (instead of raw IDE events).
 */

import { getDatabase } from '../../services/sqlite/Database.js';
import { getObservationsBySession } from '../../services/sqlite/observations.js';
import { getSummaryBySession } from '../../services/sqlite/summaries.js';
import { normalizeProjectPath } from '../../types/database.js';
import { logger } from '../../utils/logger.js';
import { callEvolveAI, parseJsonResponse } from './aiCaller.js';
import { buildEvolvePrompt, buildRefineSkillPrompt } from './prompts/evolve.js';
import { PlatformWriter } from './PlatformWriter.js';
import { CriticEngine } from './CriticEngine.js';
import {
  getRulesByWorkspace, upsertRule, approveRule,
} from './db/rules.js';
import {
  getSkillsByWorkspace, upsertSkill,
} from './db/skills.js';
import {
  insertEvoLog, updateEvoLog, hasEvolvedSession,
} from './db/evoLog.js';
import { getAllNaturalSelections } from './db/naturalSelection.js';
import type {
  SelfEvolvePluginConfig, EvolvedRuleRow,
} from './types.js';

const QUALITY_PASS_THRESHOLD = 60;

export class EvolveEngine {
  private inProgress = new Set<string>();
  private writer = new PlatformWriter();
  private criticEngine = new CriticEngine();

  getInProgress(): string[] {
    return [...this.inProgress];
  }

  async run(
    memorySessionId: string,
    workspace: string,
    config: SelfEvolvePluginConfig,
    force = false,
  ): Promise<void> {
    if (this.inProgress.has(memorySessionId)) {
      logger.info('EVOLVE', 'Already running; skipping', { memorySessionId });
      return;
    }
    if (!force && hasEvolvedSession(memorySessionId)) {
      logger.info('EVOLVE', 'Session already evolved; skipping', { memorySessionId });
      return;
    }

    this.inProgress.add(memorySessionId);
    const start = Date.now();
    const logId = insertEvoLog({
      memory_session_id: memorySessionId,
      workspace,
      rules_added: 0,
      rules_updated: 0,
      skills_added: 0,
      rejected_rules: 0,
      rejected_skills: 0,
      status: 'running',
      error_message: null,
      raw_output: null,
      duration_ms: null,
    });

    try {
      logger.info('EVOLVE', '=== Evolution START ===', { memorySessionId, workspace, force });

      const ws = normalizeProjectPath(workspace);
      const observations = getObservationsBySession(memorySessionId);
      if (observations.length === 0) {
        logger.info('EVOLVE', 'No observations; skipping', { memorySessionId });
        updateEvoLog(logId, { status: 'skipped', duration_ms: Date.now() - start });
        return;
      }

      const sessionSummary = getSummaryBySession(memorySessionId);
      const existingRules = getRulesByWorkspace(ws, { status: 'active' });
      const naturalSelections = getAllNaturalSelections(true);

      const evolveInput = {
        memorySessionId,
        workspace: ws,
        observations: observations.map(o => ({
          type: o.type,
          title: o.title,
          text: o.text,
          narrative: o.narrative,
          facts: o.facts,
          files_modified: o.files_modified,
        })),
        sessionSummary: sessionSummary
          ? {
              request: sessionSummary.request,
              learned: sessionSummary.learned,
              completed: sessionSummary.completed,
              next_steps: sessionSummary.next_steps,
              meta_intent: sessionSummary.meta_intent,
            }
          : null,
        existingRules,
        naturalSelections,
      };

      const prompt = buildEvolvePrompt(evolveInput);
      const evidenceCorpus = buildEvidenceCorpus(evolveInput);
      const rawOutput = await callEvolveAI(prompt, config.aiModel);

      interface EvolveJsonResponse {
        analysis?: string;
        skip_reason?: string;
        rule_actions?: Array<{
          action: 'create' | 'replace' | 'archive';
          title?: string;
          content?: string;
          category?: string;
          slug?: string;
          paths_glob?: string[] | null;
          evidence?: string;
          target_content?: string;
        }>;
        new_rules?: Array<{ title?: string; content?: string; category?: string; slug?: string; evidence?: string }>;
        new_skills?: Array<{
          slug: string;
          name: string;
          trigger?: string;
          description?: string;
          skill_kind?: string;
          evidence?: string;
          skill_md?: string;
        }>;
      }
      const result = parseJsonResponse<EvolveJsonResponse>(rawOutput);

      if (!result) {
        logger.error('EVOLVE', 'Failed to parse output', { rawOutput: rawOutput.slice(0, 500) });
        updateEvoLog(logId, {
          status: 'failed',
          error_message: 'Parse failed',
          raw_output: rawOutput.slice(0, 2000),
          duration_ms: Date.now() - start,
        });
        return;
      }

      if (result.skip_reason?.trim()) {
        logger.info('EVOLVE', 'Session skipped by engine', { reason: result.skip_reason });
        updateEvoLog(logId, {
          status: 'skipped',
          raw_output: rawOutput.slice(0, 2000),
          duration_ms: Date.now() - start,
        });
        return;
      }

      const reviewMode = config.reviewMode;
      const qualityThreshold = config.qualityGateThreshold;
      let rulesAdded = 0;
      let rulesUpdated = 0;
      let rejectedRules = 0;
      let skillsAdded = 0;
      let rejectedSkills = 0;
      const addedRuleTitles: string[] = [];
      const addedSkillSlugs: string[] = [];

      // ─── Apply rule actions ─────────────────────────────────────────────
      const ruleActions = result.rule_actions ?? [];
      for (const action of ruleActions) {
        if (action.action === 'archive') {
          if (!action.target_content) continue;
          // Archive matching rule
          const existing = existingRules.find(r => r.content === action.target_content);
          if (existing) {
            getDatabase().prepare(
              `UPDATE evolved_rules SET status='deprecated', updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`
            ).run(existing.id);
          }
          continue;
        }

        if (!action.content?.trim() || !action.title) continue;
        const content = action.content.trim();

        if (isCorruptedText(content) || isCorruptedText(action.title)) {
          rejectedRules++;
          continue;
        }
        if (existingRules.some(r => r.content === content)) {
          logger.info('EVOLVE', 'Rule content already exists; skipping', { title: action.title });
          continue;
        }

        if ((config.verbatimEvidenceGate ?? true) && !isEvidenceGroundedInSource(action.evidence, evidenceCorpus)) {
          logger.warn('EVOLVE', 'Rule rejected: evidence not grounded in session source (suspected paraphrase)', {
            title: action.title,
          });
          rejectedRules++;
          continue;
        }

        // FIXME(self-evolve): action.paths_glob 类型在 LLM 输出里有时是 string[]，但
        // scoreRuleQuality 签名只接受 string | null。先用 any 桥接，由 self-evolve 团队对齐类型。
        const quality = scoreRuleQuality({ content, paths_glob: (action.paths_glob as unknown as string | null) ?? null });
        if (!quality.passed) {
          logger.warn('EVOLVE', 'Rule rejected: quality below threshold', {
            title: action.title, score: quality.score,
          });
          rejectedRules++;
          continue;
        }

        const auditStatus = reviewMode === 'auto' ? 'approved'
          : reviewMode === 'quality_gate' && quality.score >= qualityThreshold ? 'approved'
          : 'pending';

        const isReplace = action.action === 'replace';
        if (isReplace && action.target_content) {
          const existing = existingRules.find(r => r.content === action.target_content);
          if (existing) {
            getDatabase().prepare(
              `UPDATE evolved_rules SET status='deprecated', updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`
            ).run(existing.id);
          }
        }

        const rulePayload = {
          workspace: ws,
          title: action.title,
          content,
          category: action.category ?? 'general',
          slug: action.slug ?? null,
          paths_glob: action.paths_glob ? JSON.stringify(action.paths_glob) : null,
          source_session_id: memorySessionId,
          evidence: action.evidence ?? null,
          status: 'active' as const,
          rule_type: 'user_evolved' as const,
          quality_score: quality.score,
          feedback: null,
          audit_status: auditStatus as 'approved' | 'pending',
          review_status: (reviewMode === 'auto' ? 'auto' : 'manual') as 'auto' | 'manual',
        };
        const ruleId = upsertRule(rulePayload);

        if (isReplace) rulesUpdated++; else rulesAdded++;
        addedRuleTitles.push(action.title);

        if (auditStatus === 'approved') {
          approveRule(ruleId);
        }
      }

      // ─── Apply skills ───────────────────────────────────────────────────
      const existingSkills = getSkillsByWorkspace(ws, { status: 'active' });
      for (const s of (result.new_skills ?? [])) {
        if (!s.slug || !s.skill_md) continue;
        if (isCorruptedText(s.name) || isCorruptedText(s.slug)) { rejectedSkills++; continue; }
        if (existingSkills.some(e => e.slug === s.slug)) {
          logger.info('EVOLVE', 'Skill slug exists; skipping', { slug: s.slug });
          continue;
        }

        let finalMd = s.skill_md;
        const firstScore = scoreSkillQuality(finalMd);
        if (!firstScore.passed) {
          finalMd = enhanceSkillMd(finalMd, s.slug, s.skill_kind ?? 'workflow');
          const enhanced = scoreSkillQuality(finalMd);
          if (!enhanced.passed) {
            // AI refinement
            const refined = await callEvolveAI(
              buildRefineSkillPrompt({ slug: s.slug, name: s.name, skill_md: finalMd }, enhanced.warnings),
              config.aiModel,
            );
            const cleanRefined = refined.replace(/^```[\w]*\n?/gm, '').replace(/```\s*$/gm, '').trim();
            if (cleanRefined.startsWith('---')) finalMd = cleanRefined;
            if (!scoreSkillQuality(finalMd).passed) {
              logger.warn('EVOLVE', 'Skill rejected after refinement', { slug: s.slug });
              rejectedSkills++;
              continue;
            }
          }
        }

        const qualityScore = scoreSkillQuality(finalMd).score;
        const auditStatus = reviewMode === 'auto' ? 'approved'
          : reviewMode === 'quality_gate' && qualityScore >= qualityThreshold ? 'approved'
          : 'pending';

        upsertSkill({
          workspace: ws,
          slug: s.slug,
          name: s.name,
          trigger_scene: (s as any).trigger_scene ?? s.trigger ?? null,
          description: s.description ?? null,
          skill_kind: (s.skill_kind === 'tool' ? 'tool' : 'markdown') as 'tool' | 'markdown',
          skill_md: finalMd,
          manifest_json: null,
          source_session_id: memorySessionId,
          evidence: s.evidence ?? null,
          status: 'active',
          quality_score: qualityScore,
          audit_status: auditStatus,
          review_status: reviewMode === 'auto' ? 'auto' : 'manual',
        });
        addedSkillSlugs.push(s.slug);
        skillsAdded++;
      }

      // ─── Write to platform files if auto-approve ────────────────────────
      if (reviewMode === 'auto' && (rulesAdded + rulesUpdated + skillsAdded > 0)) {
        this.writer.writeAll(ws, config.targetPlatforms);
      }

      updateEvoLog(logId, {
        rules_added: rulesAdded,
        rules_updated: rulesUpdated,
        skills_added: skillsAdded,
        rejected_rules: rejectedRules,
        rejected_skills: rejectedSkills,
        status: (rulesAdded + rulesUpdated + skillsAdded + rejectedRules + rejectedSkills === 0)
          ? 'skipped' : 'completed',
        raw_output: rawOutput.slice(0, 2000),
        duration_ms: Date.now() - start,
      });

      logger.info('EVOLVE', '=== Evolution DONE ===', {
        memorySessionId, rulesAdded, rulesUpdated, skillsAdded,
        rejectedRules, rejectedSkills, durationMs: Date.now() - start,
      });

      if ((rulesAdded + skillsAdded > 0) && config.criticOnGenerate) {
        this.criticEngine.reviewNewArtifacts(ws, addedSkillSlugs, addedRuleTitles, config).catch(
          err => logger.error('CRITIC', 'Post-evolution review failed', { memorySessionId }, err as Error),
        );
      }
    } catch (err) {
      logger.error('EVOLVE', 'Evolution failed', { memorySessionId }, err as Error);
      updateEvoLog(logId, {
        status: 'failed',
        error_message: String(err),
        duration_ms: Date.now() - start,
      });
    } finally {
      this.inProgress.delete(memorySessionId);
    }
  }

  /** Shared result processing for both run() and runFromSegment() */
  private processEvolveResult(
    result: any,
    workspace: string,
    sessionId: string,
    config: SelfEvolvePluginConfig,
    existingRules: EvolvedRuleRow[],
    evidenceCorpus = '',
  ): { rulesAdded: number; rulesUpdated: number; skillsAdded: number; rejectedRules: number; rejectedSkills: number; addedRuleTitles: string[]; addedSkillSlugs: string[] } {
    const reviewMode = config.reviewMode;
    const qualityThreshold = config.qualityGateThreshold;
    let rulesAdded = 0;
    let rulesUpdated = 0;
    let rejectedRules = 0;
    let skillsAdded = 0;
    let rejectedSkills = 0;
    const addedRuleTitles: string[] = [];
    const addedSkillSlugs: string[] = [];

    // Process rule_actions
    const ruleActions = result.rule_actions ?? result.new_rules ?? [];
    for (const action of ruleActions) {
      const title = action.title?.trim();
      const content = action.content?.trim();
      if (!title || !content) continue;
      if (isCorruptedText(title) || isCorruptedText(content)) { rejectedRules++; continue; }
      if (existingRules.some(r => r.content === content)) continue;

      if ((config.verbatimEvidenceGate ?? true) && !isEvidenceGroundedInSource(action.evidence, evidenceCorpus)) {
        rejectedRules++;
        continue;
      }

      const quality = scoreRuleQuality({ content, paths_glob: action.paths_glob ? (Array.isArray(action.paths_glob) ? action.paths_glob.join(',') : action.paths_glob) : null });
      if (!quality.passed) { rejectedRules++; continue; }

      const auditStatus = reviewMode === 'auto' ? 'approved'
        : reviewMode === 'quality_gate' && quality.score >= qualityThreshold ? 'approved'
        : 'pending';

      upsertRule({
        workspace,
        title,
        content,
        category: action.category || 'general',
        slug: action.slug || null,
        paths_glob: action.paths_glob ? (Array.isArray(action.paths_glob) ? action.paths_glob.join(',') : action.paths_glob) : null,
        source_session_id: sessionId,
        evidence: action.evidence || null,
        status: 'active',
        rule_type: 'user_evolved',
        quality_score: quality.score,
        feedback: null,
        audit_status: auditStatus,
        review_status: reviewMode === 'auto' ? 'auto' : 'manual',
      });
      rulesAdded++;
      addedRuleTitles.push(title);
    }

    // Process new_skills
    const newSkills = result.new_skills ?? [];
    for (const skill of newSkills) {
      const slug = skill.slug?.trim();
      const skillMd = skill.skill_md?.trim();
      if (!slug || !skillMd) continue;
      if (isCorruptedText(slug) || isCorruptedText(skillMd)) { rejectedSkills++; continue; }

      const quality = scoreSkillQuality(skillMd);
      if (!quality.passed) { rejectedSkills++; continue; }

      const auditStatus = reviewMode === 'auto' ? 'approved'
        : reviewMode === 'quality_gate' && quality.score >= qualityThreshold ? 'approved'
        : 'pending';

      upsertSkill({
        workspace,
        slug,
        name: skill.name || slug,
        trigger_scene: skill.trigger || null,
        description: skill.description || null,
        skill_kind: 'markdown',
        skill_md: skillMd,
        manifest_json: null,
        source_session_id: sessionId,
        evidence: skill.evidence || null,
        status: 'active',
        quality_score: quality.score,
        audit_status: auditStatus,
        review_status: reviewMode === 'auto' ? 'auto' : 'manual',
      });
      skillsAdded++;
      addedSkillSlugs.push(slug);
    }

    // Auto-write if in auto mode
    if (reviewMode === 'auto' && (rulesAdded + rulesUpdated + skillsAdded > 0)) {
      this.writer.writeAll(workspace, config.targetPlatforms);
    }

    return { rulesAdded, rulesUpdated, skillsAdded, rejectedRules, rejectedSkills, addedRuleTitles, addedSkillSlugs };
  }

  /**
   * Run evolution from an externally-provided segment of observations.
   * Used by the incremental scheduler — does NOT query observations from DB by session.
   */
  async runFromSegment(
    segmentSessionId: string,
    workspace: string,
    observations: Array<{ type: string; title: string; narrative?: string; text?: string; facts?: string; files_modified?: string }>,
    triggerReason: string,
    config: SelfEvolvePluginConfig,
  ): Promise<void> {
    if (this.inProgress.has(segmentSessionId)) return;
    this.inProgress.add(segmentSessionId);
    const start = Date.now();
    const logId = insertEvoLog({
      memory_session_id: segmentSessionId,
      workspace,
      rules_added: 0,
      rules_updated: 0,
      skills_added: 0,
      rejected_rules: 0,
      rejected_skills: 0,
      status: 'running',
      error_message: null,
      raw_output: null,
      duration_ms: null,
    });

    try {
      const ws = normalizeProjectPath(workspace);

      if (observations.length === 0) {
        updateEvoLog(logId, { status: 'skipped', duration_ms: Date.now() - start });
        return;
      }

      const existingRules = getRulesByWorkspace(ws, { status: 'active' });
      const naturalSelections = getAllNaturalSelections(true);

      const evolveInput = {
        memorySessionId: segmentSessionId,
        workspace: ws,
        observations: observations.map(o => ({
          type: o.type,
          title: o.title ?? null,
          text: o.text ?? null,
          narrative: o.narrative ?? null,
          facts: o.facts ?? null,
          files_modified: o.files_modified ?? null,
        })),
        sessionSummary: null, // Segments don't have a full summary
        existingRules,
        naturalSelections,
      };

      const prompt = buildEvolvePrompt(evolveInput);
      const evidenceCorpus = buildEvidenceCorpus(evolveInput);
      const rawOutput = await callEvolveAI(prompt, config.aiModel);

      // Reuse the same parsing and processing logic as run()
      // For brevity, delegate to the same internal flow
      // (The full processing block from run() starting at line 113 is identical)
      const result = parseJsonResponse<any>(rawOutput);

      if (!result) {
        updateEvoLog(logId, { status: 'failed', error_message: 'Parse failed', raw_output: rawOutput.slice(0, 2000), duration_ms: Date.now() - start });
        return;
      }

      if (result.skip_reason?.trim()) {
        updateEvoLog(logId, { status: 'skipped', raw_output: rawOutput.slice(0, 2000), duration_ms: Date.now() - start });
        return;
      }

      // Process rule_actions + new_skills using same logic
      const stats = this.processEvolveResult(result, ws, segmentSessionId, config, existingRules, evidenceCorpus);

      updateEvoLog(logId, {
        status: 'completed',
        rules_added: stats.rulesAdded,
        rules_updated: stats.rulesUpdated,
        skills_added: stats.skillsAdded,
        rejected_rules: stats.rejectedRules,
        rejected_skills: stats.rejectedSkills,
        raw_output: rawOutput.slice(0, 2000),
        duration_ms: Date.now() - start,
      });

      logger.info('EVOLVE', '=== Segment Evolution DONE ===', {
        segmentSessionId, triggerReason,
        ...stats, durationMs: Date.now() - start,
      });

      if ((stats.rulesAdded + stats.skillsAdded > 0) && config.criticOnGenerate) {
        this.criticEngine.reviewNewArtifacts(ws, stats.addedSkillSlugs, stats.addedRuleTitles, config).catch(
          err => logger.error('CRITIC', 'Post-segment review failed', {}, err as Error),
        );
      }
    } catch (err) {
      logger.error('EVOLVE', 'Segment evolution failed', { segmentSessionId }, err as Error);
      updateEvoLog(logId, { status: 'failed', error_message: String(err), duration_ms: Date.now() - start });
    } finally {
      this.inProgress.delete(segmentSessionId);
    }
  }
}

// ── Evidence grounding ───────────────────────────────────────────────────────

/**
 * Concatenate the session's source text (observations + summary) into one corpus,
 * used to verify a rule's evidence is actually grounded in this session rather than
 * an AI hallucination/over-generalization.
 *
 * NOTE: observation narrative is itself AI-compressed, so this is a *groundedness*
 * gate (evidence must overlap the source text), not a strict verbatim-quote check.
 * True逐字原话校验需等 observation 管线保留 user_quote 字段（见 design.md 目标4）。
 */
function buildEvidenceCorpus(input: {
  observations: Array<{ title: string | null; text: string | null; narrative: string | null; facts: string | null }>;
  sessionSummary: { request: string | null; learned: string | null; completed: string | null; next_steps: string | null; meta_intent: string | null } | null;
}): string {
  const parts: string[] = [];
  for (const o of input.observations) {
    if (o.title) parts.push(o.title);
    if (o.text) parts.push(o.text);
    if (o.narrative) parts.push(o.narrative);
    if (o.facts) parts.push(o.facts);
  }
  const s = input.sessionSummary;
  if (s) {
    for (const v of [s.request, s.learned, s.completed, s.next_steps, s.meta_intent]) {
      if (v) parts.push(v);
    }
  }
  return parts.join('\n');
}

/** Normalize text for fuzzy overlap matching: keep letters/digits only, lowercase. */
function normalizeForMatch(s: string): string {
  return (s.toLowerCase().match(/[\p{L}\p{N}]/gu) ?? []).join('');
}

/**
 * Returns true if `evidence` is grounded in `corpus` (i.e. shares a sufficiently long
 * contiguous fragment). Rejects evidence that looks fabricated / detached from the
 * session source. Empty evidence is treated as ungrounded.
 */
function isEvidenceGroundedInSource(evidence: string | null | undefined, corpus: string, minGram = 6): boolean {
  if (!evidence || !evidence.trim()) return false;
  const e = normalizeForMatch(evidence);
  const c = normalizeForMatch(corpus);
  if (!e || !c) return false;
  if (e.length <= minGram) return c.includes(e);
  for (let i = 0; i + minGram <= e.length; i++) {
    if (c.includes(e.slice(i, i + minGram))) return true;
  }
  return false;
}

// ── Quality scoring ────────────────────────────────────────────────────────────

function scoreRuleQuality(rule: { content: string; paths_glob: string | null }): {
  passed: boolean; score: number;
} {
  let score = 0;
  const content = rule.content.trim();
  if (content.length >= 80) score += 40;
  else if (content.length >= 30) score += 20;
  else if (content.length < 8) return { passed: false, score: 0 };
  // Has a concrete instruction word
  if (/必须|应该|不要|禁止|always|never|must|should/i.test(content)) score += 20;
  if (rule.paths_glob) score += 20;
  if (content.length >= 40) score += 20;
  return { passed: score >= QUALITY_PASS_THRESHOLD, score };
}

function scoreSkillQuality(md: string): { passed: boolean; score: number; warnings: string[] } {
  const warnings: string[] = [];
  let score = 0;
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    warnings.push('[FAIL] Missing YAML frontmatter');
  } else {
    const fm = fmMatch[1];
    for (const field of ['name:', 'description:', 'argument-hint:', 'user-invocable:', 'allowed-tools:']) {
      if (fm.includes(field)) score += 5;
      else warnings.push(`[WARN] Frontmatter missing: ${field.replace(':', '')}`);
    }
  }
  if (md.length >= 400) score += 15;
  else if (md.length >= 200) { score += 10; warnings.push(`[WARN] Content too short`); }
  else warnings.push(`[FAIL] Content too short: ${md.length} chars`);

  const headingCount = (md.match(/^##\s/gm) ?? []).length;
  score += Math.min(headingCount * 5, 20);
  if (headingCount < 3) warnings.push(`[WARN] Only ${headingCount} sections`);
  if (/##\s*(协作协议|Collaborat)/i.test(md)) score += 10;
  else warnings.push('[WARN] Missing collaboration protocol section');
  if ((md.match(/```/g) ?? []).length >= 2) score += 10;
  const numberedSteps = (md.match(/^##\s+\d+\.\s/gm) ?? []).length;
  if (numberedSteps >= 3) score += 20;
  else if (numberedSteps >= 1) score += 10;

  return { passed: score >= QUALITY_PASS_THRESHOLD, score, warnings };
}

function enhanceSkillMd(md: string, slug: string, kind: string): string {
  let enhanced = md;
  const fmMatch = enhanced.match(/^---\n([\s\S]*?)\n---/);
  const tools = kind === 'tool' ? 'Read, Glob, Grep, Shell, Write' : 'Read, Glob, Grep, Write';
  if (!fmMatch) {
    enhanced = `---\nname: ${slug}\nargument-hint: "[参数]"\nuser-invocable: true\nallowed-tools: ${tools}\n---\n\n${enhanced}`;
  } else {
    const fm = fmMatch[1];
    const additions: string[] = [];
    if (!fm.includes('argument-hint:')) additions.push('argument-hint: "[参数]"');
    if (!fm.includes('user-invocable:')) additions.push('user-invocable: true');
    if (!fm.includes('allowed-tools:')) additions.push(`allowed-tools: ${tools}`);
    if (additions.length) {
      enhanced = enhanced.replace(/^---\n[\s\S]*?\n---/, `---\n${fm}\n${additions.join('\n')}\n---`);
    }
  }
  if (!/##\s*(协作协议|Collaborat)/i.test(enhanced)) {
    enhanced += '\n\n## 协作协议\n\n1. 先扫描相关文件，收集上下文\n2. 展示发现和计划，等待用户确认\n3. 执行操作前征得用户同意\n4. 完成后展示结果摘要\n';
  }
  return enhanced;
}

function isCorruptedText(text: string | null | undefined): boolean {
  if (!text) return false;
  // Detect encoding garbage: high ratio of non-printable / non-CJK chars
  const problematic = text.replace(/[ -~一-鿿　-〿＀-￯\n\r\t]/g, '');
  return problematic.length / Math.max(text.length, 1) > 0.3;
}
