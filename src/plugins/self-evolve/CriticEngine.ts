/**
 * CriticEngine — ported from Self-Evolve, adapted to use plugin DB layer.
 */

import { logger } from '../../utils/logger.js';
import { callEvolveAI, parseJsonResponse } from './aiCaller.js';
import {
  buildRedundancyPrompt,
  buildConflictPrompt,
  buildSemanticQualityPrompt,
  buildGroupDeduplicationPrompt,
} from './prompts/critic.js';
import { getRulesByWorkspace, approveRule, rejectRule } from './db/rules.js';
import { getSkillsByWorkspace, approveSkill, rejectSkill } from './db/skills.js';
import { getAllNaturalSelections } from './db/naturalSelection.js';
import { PlatformWriter } from './PlatformWriter.js';
import type { EvolvedRuleRow, EvolvedSkillRow, SelfEvolvePluginConfig } from './types.js';

interface CriticResult {
  reviewed: number;
  flagged: number;
  merged: number;
  archived: number;
}

interface CriticCfg {
  checkRedundancy: boolean;
  checkConflict: boolean;
  checkSemanticQuality: boolean;
  autoApplyFixes: boolean;
  redundancyThreshold: number;
}

function defaultCriticCfg(): CriticCfg {
  return {
    checkRedundancy: true,
    checkConflict: true,
    checkSemanticQuality: true,
    autoApplyFixes: false,
    redundancyThreshold: 0.8,
  };
}

export class CriticEngine {
  private running = false;
  private writer = new PlatformWriter();

  async reviewNewArtifacts(
    workspace: string,
    newSkillSlugs: string[],
    newRuleTitles: string[],
    config: SelfEvolvePluginConfig,
  ): Promise<CriticResult> {
    const criticCfg = defaultCriticCfg();
    const result: CriticResult = { reviewed: 0, flagged: 0, merged: 0, archived: 0 };

    const allSkills = getSkillsByWorkspace(workspace, { status: 'active' });
    const allRules = getRulesByWorkspace(workspace, { status: 'active' });
    const newSkills = allSkills.filter(s => newSkillSlugs.includes(s.slug));
    const newRules = allRules.filter(r => newRuleTitles.includes(r.title));
    const directives = getAllNaturalSelections(true);

    logger.info('CRITIC', `Reviewing ${newSkills.length} new skills, ${newRules.length} new rules`);

    for (const skill of newSkills) {
      const others = allSkills.filter(s => s.id !== skill.id);
      await this.auditSingleSkill(skill, others, workspace, criticCfg, config, directives, result);
    }
    for (const rule of newRules) {
      const others = allRules.filter(r => r.id !== rule.id);
      await this.auditSingleRule(rule, others, workspace, criticCfg, config, directives, result);
    }

    if (result.merged > 0 || result.archived > 0) {
      this.writer.writeAll(workspace, config.targetPlatforms);
    }

    // FIXME(self-evolve): CriticResult 缺 index signature，先用 as any 闭嘴 TS。
    logger.info('CRITIC', 'Review complete', result as unknown as Record<string, unknown>);
    return result;
  }

  private async auditSingleSkill(
    skill: EvolvedSkillRow,
    existingSkills: EvolvedSkillRow[],
    workspace: string,
    criticCfg: CriticCfg,
    config: SelfEvolvePluginConfig,
    directives: ReturnType<typeof getAllNaturalSelections>,
    result: CriticResult,
  ): Promise<void> {
    result.reviewed++;

    if (criticCfg.checkRedundancy && existingSkills.length > 0) {
      const candidates = this.findSimilarSkillCandidates(skill, existingSkills);
      if (candidates.length > 0) {
        const prompt = buildRedundancyPrompt({ target: skill, targetType: 'skill', candidates, directives });
        const response = await callEvolveAI(prompt, config.aiModel);
        const parsed = parseJsonResponse<{ verdict: string; overlap_score?: number }>(response);
        if (parsed?.verdict === 'merge' && (parsed.overlap_score ?? 0) >= criticCfg.redundancyThreshold) {
          if (criticCfg.autoApplyFixes) {
            rejectSkill(skill.id);
            result.merged++;
          } else {
            result.flagged++;
          }
          return;
        }
      }
    }

    if (criticCfg.checkSemanticQuality) {
      const prompt = buildSemanticQualityPrompt({ target: skill, targetType: 'skill', directives });
      const response = await callEvolveAI(prompt, config.aiModel);
      const parsed = parseJsonResponse<{ verdict: string }>(response);
      if (parsed?.verdict === 'archive') {
        if (criticCfg.autoApplyFixes) {
          rejectSkill(skill.id);
          result.archived++;
        } else {
          result.flagged++;
        }
        return;
      }
    }

    approveSkill(skill.id);
  }

  private async auditSingleRule(
    rule: EvolvedRuleRow,
    existingRules: EvolvedRuleRow[],
    workspace: string,
    criticCfg: CriticCfg,
    config: SelfEvolvePluginConfig,
    directives: ReturnType<typeof getAllNaturalSelections>,
    result: CriticResult,
  ): Promise<void> {
    result.reviewed++;

    if (criticCfg.checkRedundancy && existingRules.length > 0) {
      const candidates = this.findSimilarRuleCandidates(rule, existingRules);
      if (candidates.length > 0) {
        const prompt = buildRedundancyPrompt({ target: rule, targetType: 'rule', candidates, directives });
        const response = await callEvolveAI(prompt, config.aiModel);
        const parsed = parseJsonResponse<{ verdict: string; overlap_score?: number }>(response);
        if (parsed?.verdict === 'merge' && (parsed.overlap_score ?? 0) >= criticCfg.redundancyThreshold) {
          if (criticCfg.autoApplyFixes) {
            rejectRule(rule.id, 'Redundant: merged into existing rule');
            result.merged++;
          } else {
            result.flagged++;
          }
          return;
        }
      }
    }

    if (criticCfg.checkConflict && existingRules.length > 0) {
      const related = this.findRelatedRules(rule, existingRules);
      if (related.length > 0) {
        const prompt = buildConflictPrompt({ target: rule, relatedRules: related, directives });
        const response = await callEvolveAI(prompt, config.aiModel);
        const parsed = parseJsonResponse<{ verdict: string }>(response);
        if (parsed?.verdict === 'flagged') {
          result.flagged++;
          return;
        }
      }
    }

    if (criticCfg.checkSemanticQuality) {
      const prompt = buildSemanticQualityPrompt({ target: rule, targetType: 'rule', directives });
      const response = await callEvolveAI(prompt, config.aiModel);
      const parsed = parseJsonResponse<{ verdict: string }>(response);
      if (parsed?.verdict === 'archive') {
        if (criticCfg.autoApplyFixes) {
          rejectRule(rule.id, 'Archived: no semantic value');
          result.archived++;
        } else {
          result.flagged++;
        }
        return;
      }
    }

    approveRule(rule.id);
  }

  // ── Similarity helpers ────────────────────────────────────────────────────

  private findSimilarSkillCandidates(
    target: EvolvedSkillRow,
    existing: EvolvedSkillRow[],
  ): EvolvedSkillRow[] {
    const tw = this.extractKeywords(`${target.name} ${target.description ?? ''} ${target.trigger_scene ?? ''} ${target.skill_md ?? ''}`);
    return existing
      .map(s => ({ s, score: this.keywordOverlap(tw, this.extractKeywords(`${s.name} ${s.description ?? ''} ${s.trigger_scene ?? ''} ${s.skill_md ?? ''}`)) }))
      .filter(x => x.score > 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(x => x.s);
  }

  private findSimilarRuleCandidates(
    target: EvolvedRuleRow,
    existing: EvolvedRuleRow[],
  ): EvolvedRuleRow[] {
    const tw = this.extractKeywords(`${target.title} ${target.content}`);
    return existing
      .map(r => ({ r, score: this.keywordOverlap(tw, this.extractKeywords(`${r.title} ${r.content}`)) }))
      .filter(x => x.score > 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(x => x.r);
  }

  private findRelatedRules(target: EvolvedRuleRow, existing: EvolvedRuleRow[]): EvolvedRuleRow[] {
    if (!target.paths_glob) return [];
    return existing
      .filter(r => r.paths_glob && (r.paths_glob === target.paths_glob || r.paths_glob.includes(target.paths_glob!) || target.paths_glob!.includes(r.paths_glob)))
      .slice(0, 5);
  }

  clusterRules(rules: EvolvedRuleRow[]): EvolvedRuleRow[][] {
    const kwSets = rules.map(r => ({ r, w: this.extractKeywords(`${r.title} ${r.content}`) }));
    const assigned = new Set<number>();
    const clusters: EvolvedRuleRow[][] = [];

    for (let i = 0; i < rules.length; i++) {
      if (assigned.has(i)) continue;
      const cluster = [i];
      for (let j = i + 1; j < rules.length; j++) {
        if (assigned.has(j)) continue;
        if (this.keywordOverlap(kwSets[i].w, kwSets[j].w) > 0.2) cluster.push(j);
      }
      if (cluster.length >= 3) {
        for (const idx of cluster) assigned.add(idx);
        clusters.push(cluster.map(idx => rules[idx]));
      }
    }
    return clusters;
  }

  async auditRuleGroup(
    group: EvolvedRuleRow[],
    workspace: string,
    config: SelfEvolvePluginConfig,
    result: CriticResult,
  ): Promise<void> {
    const prompt = buildGroupDeduplicationPrompt({ rules: group });
    const response = await callEvolveAI(prompt, config.aiModel);
    const parsed = parseJsonResponse<{ actions: Array<{ slug: string; verdict: string; reason: string }> }>(response);
    if (!parsed) return;

    for (const action of parsed.actions) {
      if (action.verdict !== 'archive') continue;
      const rule = group.find(r => r.slug === action.slug);
      if (!rule || rule.audit_status === 'rejected') continue;
      rejectRule(rule.id, `[整组去重] ${action.reason}`);
      result.archived++;
    }
  }

  private extractKeywords(text: string): Set<string> {
    const stopWords = new Set(['的', '了', '在', '是', '和', '与', '或', '对', '要', '必须', 'the', 'a', 'an', 'is', 'are', 'and', 'or', 'to', 'of', 'for', 'in']);
    return new Set(
      text.toLowerCase()
        .replace(/[^\w一-鿿-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 1 && !stopWords.has(w))
    );
  }

  private keywordOverlap(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const w of a) { if (b.has(w)) intersection++; }
    return intersection / Math.min(a.size, b.size);
  }
}
