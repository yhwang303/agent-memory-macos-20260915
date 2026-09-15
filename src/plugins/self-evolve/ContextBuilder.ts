/**
 * ContextBuilder — injects evolved rules/skills into Agent-Mem's session context.
 * Ported from Self-Evolve, adapted to Agent-Mem's data layer.
 */

import { logger } from '../../utils/logger.js';
import { getRulesByWorkspace } from './db/rules.js';
import { getSkillsByWorkspace } from './db/skills.js';
import type { EvolvedRuleRow, EvolvedSkillRow } from './types.js';

function ruleWeight(rule: EvolvedRuleRow): number {
  let w = 0;
  if (rule.quality_score) w += Math.round(rule.quality_score / 5);
  if (rule.audit_status === 'approved') w += 10;
  const ageMs = Date.now() - new Date(rule.created_at).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays <= 7) w += 20;
  else if (ageDays <= 30) w += 10;
  return w;
}

function skillWeight(skill: EvolvedSkillRow): number {
  let w = 0;
  if (skill.quality_score) w += Math.round(skill.quality_score / 5);
  if (skill.audit_status === 'approved') w += 10;
  const ageMs = Date.now() - new Date(skill.created_at).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays <= 7) w += 20;
  else if (ageDays <= 30) w += 10;
  return w;
}

export class ContextBuilder {
  build(workspace: string, maxRules = 20): string {
    const allRules = getRulesByWorkspace(workspace, { status: 'active', audit_status: 'approved' });
    const allSkills = getSkillsByWorkspace(workspace, { status: 'active', audit_status: 'approved' });

    if (allRules.length === 0 && allSkills.length === 0) return '';

    // Weighted sort
    const weightedRules = allRules
      .map(r => ({ r, w: ruleWeight(r) }))
      .sort((a, b) => b.w - a.w);
    const rules = weightedRules.slice(0, maxRules).map(x => x.r);
    const pruned = allRules.length > maxRules;

    const weightedSkills = allSkills
      .map(s => ({ s, w: skillWeight(s) }))
      .sort((a, b) => b.w - a.w);
    const skills = weightedSkills.map(x => x.s);

    const lines: string[] = ['<self_evolved_knowledge>'];
    lines.push(
      `<!-- 注入了 ${rules.length} 条规则、${skills.length} 个技能` +
      (pruned ? `（共 ${allRules.length} 条规则，按权重取 top-${maxRules}）` : '') +
      ' -->'
    );

    if (rules.length > 0) {
      lines.push('## 已沉淀的工作规范（请严格遵守）');
      const byCategory = new Map<string, EvolvedRuleRow[]>();
      for (const r of rules) {
        const cat = r.category ?? '其他';
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat)!.push(r);
      }
      for (const [cat, catRules] of byCategory) {
        lines.push(`### ${cat}`);
        for (const r of catRules) lines.push(`- ${r.content}`);
      }
    }

    if (skills.length > 0) {
      lines.push('');
      lines.push('## 已沉淀的可复用技能（遇到对应场景时优先使用）');
      for (const s of skills) {
        lines.push(`- **${s.name}**（${s.slug}）[${s.skill_kind}]: ${s.description ?? s.trigger_scene ?? ''}`);
      }
    }

    lines.push('</self_evolved_knowledge>');
    const context = lines.join('\n');

    logger.info('CTX', `Built self-evolve context: ${rules.length}/${allRules.length} rules, ${skills.length} skills`);
    return context;
  }
}
