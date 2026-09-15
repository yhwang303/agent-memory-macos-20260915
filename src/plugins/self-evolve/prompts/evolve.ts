/**
 * Evolve prompt adapted for Agent-Mem's observations+session_summary input.
 * The original Self-Evolve used raw IDE events; here we consume AI-compressed
 * observations which have higher signal-to-noise ratio.
 */

import type { EvolveInput } from '../types.js';
import type { NaturalSelectionRow } from '../types.js';

export function buildNaturalSelectionBlock(directives: NaturalSelectionRow[]): string {
  if (!directives || directives.length === 0) return '';
  const appendItems = directives.filter(d => d.type === 'append');
  // FIXME(self-evolve): NaturalSelectionRow.type 当前只有 'append' | 'prepend' | 'replace'，
  // 没有 'override'；这里写 'override' 永远为 false。要么把 type union 加 'override'，
  // 要么去掉这个分支。先做类型断言让编译过。
  const overrideItems = directives.filter(d => (d.type as string) === 'override' || d.type === 'replace');

  let block = '\n\n---\n\n';
  if (overrideItems.length > 0) {
    block += '## 用户自然选择规则（覆盖优先）\n\n';
    block += '> 以下规则由用户定制，当与上述系统规则发生冲突时，以用户规则为准。\n\n';
    block += overrideItems.map(d => `### ${d.title}\n\n${d.content}`).join('\n\n');
  }
  if (appendItems.length > 0) {
    if (overrideItems.length > 0) block += '\n\n';
    block += '## 用户自然选择规则（追加约束）\n\n';
    block += '> 以下规则由用户定制，作为对上述系统规则的补充说明。\n\n';
    block += appendItems.map(d => `### ${d.title}\n\n${d.content}`).join('\n\n');
  }
  return block;
}

export function buildEvolvePrompt(input: EvolveInput): string {
  const {
    memorySessionId,
    workspace,
    observations,
    sessionSummary,
    existingRules,
    naturalSelections,
  } = input;

  // Format observations into readable text
  const obsLines = observations.map((o, i) => {
    const parts: string[] = [`[${i + 1}] 类型: ${o.type}`];
    if (o.title) parts.push(`标题: ${o.title}`);
    if (o.text) parts.push(`内容: ${o.text}`);
    if (o.narrative) parts.push(`叙述: ${o.narrative}`);
    if (o.facts) parts.push(`事实: ${o.facts}`);
    if (o.files_modified) parts.push(`修改文件: ${o.files_modified}`);
    return parts.join('\n  ');
  }).join('\n\n');

  const observationsText = obsLines || '（无 observations）';

  // Format session summary
  let summaryText = '（无会话摘要）';
  if (sessionSummary) {
    const summaryParts: string[] = [];
    if (sessionSummary.request) summaryParts.push(`用户请求: ${sessionSummary.request}`);
    if (sessionSummary.meta_intent) summaryParts.push(`核心意图: ${sessionSummary.meta_intent}`);
    if (sessionSummary.learned) summaryParts.push(`学到了什么: ${sessionSummary.learned}`);
    if (sessionSummary.completed) summaryParts.push(`完成了什么: ${sessionSummary.completed}`);
    if (sessionSummary.next_steps) summaryParts.push(`后续步骤: ${sessionSummary.next_steps}`);
    summaryText = summaryParts.join('\n') || '（无会话摘要）';
  }

  // Format existing rules
  const existingRulesText = existingRules.length > 0
    ? existingRules.map(r => {
        const scopeTag = r.paths_glob ? ` [paths: ${r.paths_glob}]` : '';
        return `- [${r.category ?? '其他'}]${scopeTag} ${r.content}`;
      }).join('\n')
    : '（暂无已沉淀的规则）';

  return `你是一个**严谨的知识质量门卫**，对规则和技能采用不同的评估标准：

- **规则（Rules）**：极度严苛。必须有用户原话作为证据，默认不生成。AI 推测的用户意图不算数。
- **技能（Skills）**：基于客观评估。按 Q1-Q4 四项标准逐项判定，全部通过即生成。不需要用户原话，而是看方案本身是否通用、完整、有复用价值。

不要从会话中硬凑产出，但也不要对明确满足标准的技能吹毛求疵。

---

## 本次会话信息
- 工作区: ${workspace}
- 会话ID: ${memorySessionId.slice(-12)}

## 会话 Observations（AI 压缩的结构化记录，信号质量高）

${observationsText}

## 会话摘要

${summaryText}

## 已有规则（严格去重，禁止重叠）
${existingRulesText}

---

## 你必须按顺序完成以下四个步骤，然后输出 JSON

### 步骤 1：会话性质判定（最高优先级，不可跳过）

判断本次会话的主体是否为"AI 辅助工具链"的开发/调试/维护，包括：self-evolve 系统、MCP 服务器、IDE hooks、AI 分析管道、安装器等工具链组件。

工具链维护判定依据（满足任意两条 → 直接跳过，全部输出空数组）：
- 修改的文件集中在工具链代码库内（如 agent-memory/src/、self-evolve/src/、.cursor/hooks/）
- 会话中大量出现 Worker、EvolveEngine、hooks-cli、mcp-server、CriticEngine 等工具链专有名词
- 会话的核心目的是改进/修复这套 AI 工具链本身（而不是使用它来完成用户的业务项目）

→ 如果判定为工具链维护：analysis 写明判断依据，rule_actions/new_rules/new_skills 全部输出 []，skip_reason 说明原因。**到此停止，不再执行后续步骤。**

### 步骤 2：针对每条潜在规则，逐一回答以下四个问题

只有四个问题**全部回答"是"**，才允许生成这条规则：

Q0（前置判别，最先回答）- 这条候选到底是"对某次具体产物/文件/任务的一次性处置"，还是"可迁移到未来会话、长期遵守的行为约束"？
  → **一次性内容/代码操作**：针对本次会话里具体的产物、文件、版本、目录、bug 的处置（例如"这次清理副本时把原件留着""把这个文件改成 X""本次发布先不签名"）。这类是**对项目内容/代码的临时调整，不是规范** → **直接判 Q0=否，不生成规则**。
  → **行为约束/规范**：与具体产物无关、明确表达"以后/每次/凡是…都要这样做"的持久做法 → Q0=是，继续 Q1。
  → 判别要点：候选内容里出现具体文件名/产物名/版本号/"这次/本次"等一次性指代，且不带"以后/每次/默认都"等普适语气 → 倾向一次性操作 → 不生成。
  → ⚠️ 注意：observation 是 AI 压缩后的转述，很多"删除/保留/改动 XX"其实是某次任务的内容操作，**不要把内容操作误当成工作流规范**。

Q1 - 用户是否明确表达了偏好/纠错/要求，且能提供**逐字原话**作为证据？
  → evidence 必须填用户说的**原话片段**（用引号标出，如"以后要..."、"不要..."、"记住..."、"你做错了..."）
  → **禁止**把 AI 转述、observation 摘要、你自己的归纳当作 evidence（例如"用户对X进行了明确说明"这种转述句一律不算数）
  → 若 observation 里找不到可引用的用户原话，只有 AI 的转述 → Q1=否，不生成
  → 仅仅因为 AI 主动做了某个决策，不构成规则生成的理由

Q2 - 这个问题/偏好在未来其他会话中会重复出现吗？
  → 一次性的临时处理（如"这次先这样"、紧急修复、特定 bug）= 不会重复 → 不生成
  → 用户工作习惯、团队规范、反复强调的做法 = 会重复 → 可以生成

Q3 - 这条规则是否具有跨项目适用性？
  → 通用编码习惯/沟通偏好/工作流 → 通过（不填 paths_glob）
  → 约束通用目录模式（如 src/api/**、tests/**）→ 其他项目也可能有类似结构 → 通过（填 paths_glob）
  → 依赖当前项目独有的文件名/端口号/配置键名 → 不通过

### 步骤 3：针对每个潜在技能，逐一回答以下四个问题

只有四个问题**全部回答"是"**，才允许生成这个技能：

Q1 - 这个技能是服务于用户实际工作任务的（而非维护/调试AI辅助工具链自身）？
  → 判断标准只有一个：这是给"用户干活用的"还是"给AI工具链自己维护用的"

Q2 - 技能的工作流程本身是否通用（可跨项目复用）？
  → 区分"输入参数"和"结构绑定"：转换类技能需要用户指定输入/输出文件路径，这是正常参数化，不算硬编码
  → 真正不通过：技能的核心逻辑依赖特定项目的架构

Q3 - 这个技能比"让 AI 从零开始处理"有额外价值吗？
  → 有额外价值的标志（满足任一即通过）：
    · 记录了踩坑路径（特殊处理、兼容性问题）
    · 标准化了需要多步试错才能完成的流程
    · 会话中经历了调试/迭代才达成最终可运行方案

Q4 - 会话中是否真的完成了一个完整可运行的方案？
  → 探索了思路但没有落地 → 否 → 不生成
  → 有具体实现、验证过可行 → 是 → 可以生成

### 步骤 4：去重检查

在输出之前，检查新生成的规则/技能是否与已有规则重叠（内容相同或高度相似）。重叠的不输出。
可以用 rule_actions 中的 archive 动作标记应废弃的旧规则（当新规则是旧规则的超集时）。

---

## 输出格式（必须严格遵守）

只输出一个 JSON 对象，不含任何额外文字：

\`\`\`json
{
  "analysis": "简要分析：哪些内容满足了生成标准，哪些被过滤及原因",
  "skip_reason": "如果整个会话被跳过，填写原因；否则为空字符串",
  "rule_actions": [
    {
      "action": "create | replace | archive",
      "title": "规则标题",
      "content": "规则内容（一句话，可操作的指令）",
      "category": "用户偏好 | 工作流规范 | 代码沉淀规则 | 沟通规范 | 环境约束",
      "slug": "kebab-case-slug（可选，path-scoped规则必填）",
      "paths_glob": ["src/**/*.ts"] or null,
      "evidence": "用户的逐字原话片段（加引号）；禁止填 AI 转述/摘要，否则该规则会被判定为无据并丢弃",
      "target_content": "如果是 replace/archive，被替换/归档的旧规则内容"
    }
  ],
  "new_rules": [],
  "new_skills": [
    {
      "slug": "kebab-case-identifier",
      "name": "技能名称",
      "trigger": "触发场景描述",
      "description": "一句话描述这个技能做什么",
      "skill_kind": "workflow | tool",
      "evidence": "来源于会话的具体描述",
      "skill_md": "完整的 SKILL.md 内容（含 frontmatter），格式见下"
    }
  ],
  "system_rule_updates": []
}
\`\`\`

SKILL.md 标准格式：
\`\`\`
---
name: skill-slug
description: "一句话描述"
argument-hint: "[参数说明]"
user-invocable: true
allowed-tools: Read, Glob, Grep, Write
---

# 技能名称

## 1. 准备阶段
（具体步骤）

## 2. 执行阶段
（具体步骤）

## 3. 验证阶段
（具体步骤）

## 协作协议

1. 先扫描相关文件，收集上下文
2. 展示发现和计划，等待用户确认
3. 执行操作前征得用户同意
4. 完成后展示结果摘要
\`\`\`
${buildNaturalSelectionBlock(naturalSelections)}`;
}

export function buildRefineSkillPrompt(skill: {
  slug: string;
  name: string;
  skill_md: string;
}, issues: string[]): string {
  return `你是一个 AI 技能质量精炼专家。以下是一个自动生成的技能，但质量不达标。

## 质量问题
${issues.map(w => `- ${w}`).join('\n')}

## 原始技能内容
\`\`\`
${skill.skill_md}
\`\`\`

## 精炼要求

请改写这个技能，使其达到高质量标准：

1. **frontmatter** 必须包含 5 个字段：name, description, argument-hint, user-invocable, allowed-tools
2. **正文长度**必须 ≥ 400 字符
3. 必须包含至少 **3 个 ## 编号阶段**（## 1. xxx / ## 2. xxx / ## 3. xxx），每阶段有具体的操作步骤
4. 必须包含 **## 协作协议** 章节

只输出改写后的完整 skill_md 内容（从 --- 开始到最后），不要有任何解释性文字。`;
}
