/**
 * Critic prompts — direct port from Self-Evolve.
 */

import type { EvolvedRuleRow, EvolvedSkillRow, NaturalSelectionRow } from '../types.js';
import { buildNaturalSelectionBlock } from './evolve.js';

type ArtifactTarget = EvolvedRuleRow | EvolvedSkillRow;
type TargetType = 'rule' | 'skill';

function getTargetContent(target: ArtifactTarget, type: TargetType): string {
  if (type === 'skill') return (target as EvolvedSkillRow).skill_md ?? '';
  return (target as EvolvedRuleRow).content;
}

function getTargetName(target: ArtifactTarget, type: TargetType): string {
  if (type === 'skill') {
    const s = target as EvolvedSkillRow;
    return `${s.name}（${s.slug}）`;
  }
  const r = target as EvolvedRuleRow;
  return `${r.title}（${r.slug ?? 'no-slug'}）`;
}

function getCandidateDesc(c: ArtifactTarget, type: TargetType, index: number): string {
  if (type === 'skill') {
    const s = c as EvolvedSkillRow;
    return `### 候选${index + 1}: ${s.name}（${s.slug}）\n${s.skill_md ?? ''}`;
  }
  const r = c as EvolvedRuleRow;
  return `### 候选${index + 1}: ${r.title}（${r.slug ?? 'no-slug'}）\n${r.content}`;
}

export function buildRedundancyPrompt(input: {
  target: ArtifactTarget;
  targetType: TargetType;
  candidates: ArtifactTarget[];
  directives?: NaturalSelectionRow[];
}): string {
  const { target, targetType, candidates, directives = [] } = input;
  const targetContent = getTargetContent(target, targetType);
  const targetName = getTargetName(target, targetType);
  const candidateDescriptions = candidates.map((c, i) => getCandidateDesc(c, targetType, i)).join('\n\n');
  const typeLabel = targetType === 'skill' ? '技能' : '规则';

  return `你是一个**极度保守**的AI系统审查员。你的职责是检测语义冗余——即两个${typeLabel}是否在做本质上完全相同的事情。

⚠️ **核心原则：宁可多留，绝不错删。合并是破坏性操作，必须极度审慎。**

## 待审查${typeLabel}

### ${targetName}
${targetContent}

## 已有的${typeLabel}（可能与之重叠）

${candidateDescriptions}

## 判定标准

### 判定为 merge 的前提条件（必须同时满足全部）：

1. **功能完全覆盖**：待审查项的每一条具体指令/步骤/能力，在候选项中都能找到语义等价的对应。
2. **无独特价值**：待审查项不包含任何候选项中没有的独特约束、边界条件、异常处理或使用场景。
3. **前后对比无损**：合并后不会丢失任何原有的含义、能力、触发场景或适用范围。
4. **不得缺斤少两**：如果待审查项中有 5 条规则，合并后的目标也必须能覆盖这 5 条。${targetType === 'skill' ? '\n5. **功能一致性**：对于功能性技能，合并前后必须能产出完全相同的结果。如果无法确认功能等价，一律判定 keep。' : ''}

### 判定为 keep 的条件（满足任意一条即可）：

- 两者解决的问题有任何差异（即使有部分重叠）
- 两者的适用场景、触发条件不完全相同
- 待审查项包含候选项中没有的特殊约束或边界条件
- 无法确认合并后不丢失信息
- **存疑时一律 keep**

## 输出格式

仅输出一个 JSON 对象：
\`\`\`json
{
  "verdict": "keep" | "merge",
  "reason": "详细说明判定理由，如果是merge必须逐条对比证明无损",
  "merge_target_slug": "如果verdict=merge，指定应合并到哪个slug；否则为null",
  "overlap_score": 0.0-1.0,
  "coverage_analysis": "列出待审查项的每个核心要点，以及在候选项中是否有对应覆盖"
}
\`\`\`${buildNaturalSelectionBlock(directives)}`;
}

export function buildConflictPrompt(input: {
  target: EvolvedRuleRow;
  relatedRules: EvolvedRuleRow[];
  directives?: NaturalSelectionRow[];
}): string {
  const { target, relatedRules, directives = [] } = input;
  const targetDesc = `### ${target.title}（${target.slug ?? 'no-slug'}）\n路径：${target.paths_glob ?? '全局'}\n${target.content}`;
  const relatedDescs = relatedRules.map((r, i) =>
    `### 已有规则${i + 1}: ${r.title}（${r.slug ?? 'no-slug'}）\n路径：${r.paths_glob ?? '全局'}\n${r.content}`
  ).join('\n\n');

  return `你是一个**极度保守**的AI系统审查员。你的职责是检测规则冲突——即两条规则是否对同一作用域的同一行为给出矛盾指令。

⚠️ **核心原则：冲突标记会导致规则被删除或修改，必须极度审慎。仅标记真正的逻辑矛盾，不要标记"角度不同但可互补"的规则。**

## 待审查规则

${targetDesc}

## 同路径/相关规则

${relatedDescs}

## 判定标准

### 判定为 flagged 的前提条件（必须同时满足）：

1. **直接逻辑矛盾**：两条规则对完全相同的行为给出了不可调和的指令。
2. **同一作用域**：两条规则的适用路径、适用场景完全重叠。
3. **无法共存**：不存在任何合理的解读方式使两条规则同时成立。

### 判定为 keep 的条件（满足任意一条即可）：

- 两条规则从不同角度约束同一行为，但并不矛盾（互补关系）
- 两条规则虽然涉及同一主题，但适用场景有差异
- 存在合理的优先级解读
- **存疑时一律 keep**

## 输出格式

仅输出一个 JSON 对象：
\`\`\`json
{
  "verdict": "keep" | "flagged",
  "reason": "详细说明判定理由，如果是flagged必须指出具体哪两条指令矛盾",
  "conflicting_rule_slug": "如果有冲突，指定冲突的规则slug；否则为null"
}
\`\`\`${buildNaturalSelectionBlock(directives)}`;
}

export function buildSemanticQualityPrompt(input: {
  target: ArtifactTarget;
  targetType: TargetType;
  directives?: NaturalSelectionRow[];
}): string {
  const { target, targetType, directives = [] } = input;
  const content = getTargetContent(target, targetType);
  const name = getTargetName(target, targetType);
  const typeLabel = targetType === 'skill' ? '技能' : '规则';

  const typeSpecific = targetType === 'skill'
    ? `- 步骤是否足够具体，能指导AI完成任务？还是只有泛泛的描述？
- frontmatter 是否完整（name, description, argument-hint, user-invocable, allowed-tools）？
- 是否有协作协议/错误处理等关键章节？`
    : `- 规则是否具有可操作性？还是过于抽象/空洞？
- 路径作用域是否合理？`;

  const skillSpecificArchive = targetType === 'skill' ? `
**技能专属归档条件（满足任意一条即 archive）：**
4. **元系统操作**：技能的核心功能是维护 AI 辅助工具链自身，而非服务用户的业务场景。
5. **无跨项目复用性**：技能正文硬编码了当前仓库特有的端口号、绝对路径、特定配置文件名，换一个不同项目即完全失效。` : '';

  return `你是一个**极度保守**的AI系统审查员。你的职责是从语义实用性角度评估一个${typeLabel}的质量。

⚠️ **核心原则：归档意味着永久移除该${typeLabel}。即使质量不高，只要它表达了一个有效的意图或能力，就应该保留。仅归档真正无意义的废话。**

## 待审查${typeLabel}

### ${name}
${content}

## 评估维度

${typeSpecific}
- 内容长度是否达标？（技能 ≥ 400字符，规则正文 ≥ 80字符）
- 整体是否值得保留在知识库中？

## 归档的严格条件（满足**任意一条**即可判定 archive）：

**通用条件（满足以下全部三条）：**
1. **内容无实质信息**：全文都是泛泛而谈的废话，没有任何具体的、可执行的指令或步骤。
2. **无法指导行为**：即使给 AI 看了这个${typeLabel}，也完全不知道该做什么或不做什么。
3. **不反映任何用户意图**：不是基于用户真实需求或偏好产生的。
${skillSpecificArchive}

## 保留条件（满足任意一条即保留）：

- 包含至少一条具体的、可操作的指令
- 反映了用户的某个真实偏好或习惯
- 描述了一个真实存在的工作流或能力
- 虽然简短，但意图明确
- **存疑时一律 keep**

## 输出格式

仅输出一个 JSON 对象：
\`\`\`json
{
  "verdict": "keep" | "archive",
  "reason": "详细说明判定理由，如果是archive必须证明内容完全无价值",
  "quality_score": 0-100,
  "issues": ["问题1", "问题2"],
  "preserved_value": "如果verdict=keep，说明该${typeLabel}保留的核心价值是什么"
}
\`\`\`${buildNaturalSelectionBlock(directives)}`;
}

export function buildGroupDeduplicationPrompt(input: {
  rules: EvolvedRuleRow[];
}): string {
  const { rules } = input;
  const ruleDescs = rules.map((r, i) =>
    `### [${i + 1}] ${r.title}（slug: ${r.slug ?? 'no-slug'}）\n路径：${r.paths_glob ?? '全局'}\n\n${r.content}`
  ).join('\n\n---\n\n');

  return `你是AI知识库整理助手，专门负责消除冗余。以下 ${rules.length} 条规则关键词高度重叠，可能存在重复或包含关系。

## 待审查规则组

${ruleDescs}

## 任务

1. 逐条对比所有规则的**完整内容**（不只是标题）
2. 若规则 A 的所有核心约束都被规则 B 覆盖（B ⊇ A），则 A 冗余，应归档
3. 若两条规则各有一部分独特内容且无法完全互相覆盖，都保留
4. 对于同一主题有 3 条以上规则时，保留内容**最完整、最具体**的一条，归档其余

## 输出格式

仅输出一个 JSON 对象：
\`\`\`json
{
  "analysis": "整体分析：哪些规则存在包含关系？",
  "actions": [
    {
      "slug": "被处理规则的slug",
      "verdict": "keep 或 archive",
      "reason": "判定原因（archive时必须指出哪条规则已覆盖其内容）",
      "keep_instead": "如果archive，指定应保留的规则slug；否则为null"
    }
  ]
}
\`\`\`

重要：每条规则都必须出现在 actions 中，verdict 为 keep 或 archive。`;
}
