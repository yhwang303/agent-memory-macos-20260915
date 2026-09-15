/**
 * PlatformWriter — writes evolved rules/skills to IDE config files.
 * Ported from Self-Evolve, adapted for Agent-Mem's plugin data layer.
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger.js';
import { getRulesByWorkspace } from './db/rules.js';
import { getSkillsByWorkspace } from './db/skills.js';

const MANAGED_START = '<!-- self-evolve:managed:start -->';
const MANAGED_END = '<!-- self-evolve:managed:end -->';
const MANUAL_START = '<!-- self-evolve:manual:start -->';
const MANUAL_END = '<!-- self-evolve:manual:end -->';

// Claude Code sections in CLAUDE.md
const CLAUDE_RULES_START = '<!-- self-evolve rules start -->';
const CLAUDE_RULES_END = '<!-- self-evolve rules end -->';

function resolveClaudeMdPath(workspace: string): string {
  return path.join(workspace, 'CLAUDE.md');
}

function resolveCursorRulesDir(workspace: string): string {
  return path.join(workspace, '.cursor', 'rules');
}

function resolveSkillsDir(workspace: string, platform: string): string {
  if (platform === 'claudecode') {
    return path.join(workspace, '.claude', 'skills');
  }
  return path.join(workspace, '.cursor', 'skills');
}

export class PlatformWriter {
  writeAll(workspace: string, targetPlatforms: string[]): void {
    for (const platform of targetPlatforms) {
      try {
        this.writePlatform(workspace, platform);
      } catch (err) {
        logger.error('WRITER', `Failed to write platform ${platform}`, { workspace }, err as Error);
      }
    }
  }

  private writePlatform(workspace: string, platform: string): void {
    const activeRules = getRulesByWorkspace(workspace, { status: 'active', audit_status: 'approved' });
    const activeSkills = getSkillsByWorkspace(workspace, { status: 'active', audit_status: 'approved' });

    if (platform === 'claudecode') {
      const claudeMd = resolveClaudeMdPath(workspace);
      this.appendRulesToClaudeMd(claudeMd, activeRules.map(r => ({ category: r.category, content: r.content })));
      const skillsDir = resolveSkillsDir(workspace, 'claudecode');
      this.writeSkillFiles(skillsDir, activeSkills);
      return;
    }

    if (platform === 'cursor') {
      const rulesDir = resolveCursorRulesDir(workspace);
      const pathScopedRules = activeRules.filter(r => r.paths_glob && r.slug);
      const generalRules = activeRules.filter(r => !r.paths_glob || !r.slug);
      this.writeGeneralRulesFile(rulesDir, generalRules);
      this.writePathScopedRules(rulesDir, pathScopedRules);
      const skillsDir = resolveSkillsDir(workspace, 'cursor');
      this.writeSkillFiles(skillsDir, activeSkills);
      this.cleanupArchivedSkills(skillsDir, activeSkills.map(s => s.slug));
      return;
    }

    logger.warn('WRITER', `Unknown platform: ${platform}`);
  }

  private appendRulesToClaudeMd(
    claudeMdPath: string,
    rules: Array<{ category: string; content: string }>,
  ): void {
    if (rules.length === 0) return;
    const today = new Date().toISOString().slice(0, 10);

    const byCategory = new Map<string, string[]>();
    for (const r of rules) {
      const cat = r.category ?? '其他规范';
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(r.content);
    }

    const lines: string[] = [
      `<!-- Last updated: ${today} by self-evolve -->`,
      '',
      MANAGED_START,
    ];
    for (const [cat, contents] of byCategory) {
      lines.push(`## ${cat}`);
      for (const c of contents) lines.push(`- ${c}`);
      lines.push('');
    }
    lines.push(MANAGED_END);
    const rulesBlock = lines.join('\n');
    const section = `\n${CLAUDE_RULES_START}\n${rulesBlock}\n${CLAUDE_RULES_END}\n`;

    try {
      if (fs.existsSync(claudeMdPath)) {
        let existing = fs.readFileSync(claudeMdPath, 'utf-8');
        const startIdx = existing.indexOf(CLAUDE_RULES_START);
        const endIdx = existing.indexOf(CLAUDE_RULES_END);
        if (startIdx !== -1 && endIdx !== -1) {
          existing = existing.slice(0, startIdx) + section.trimStart() + existing.slice(endIdx + CLAUDE_RULES_END.length);
        } else {
          existing += section;
        }
        fs.writeFileSync(claudeMdPath, existing, 'utf-8');
      } else {
        fs.writeFileSync(claudeMdPath, `# Project Rules\n${section}`, 'utf-8');
      }
      logger.info('WRITER', `CLAUDE.md updated: ${claudeMdPath}`);
    } catch (err) {
      logger.error('WRITER', 'Failed to update CLAUDE.md', { claudeMdPath }, err as Error);
    }
  }

  private writeGeneralRulesFile(
    rulesDir: string,
    rules: Array<{ category: string; content: string }>,
  ): void {
    if (rules.length === 0) return;
    const today = new Date().toISOString().slice(0, 10);
    const rulesFile = path.join(rulesDir, 'self-evolved.mdc');

    const byCategory = new Map<string, string[]>();
    for (const r of rules) {
      const cat = r.category ?? '其他规范';
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(r.content);
    }

    const sections = [
      '---',
      'description: Self-evolved project rules managed by self-evolve',
      'alwaysApply: true',
      '---',
      '',
      '# Auto-Evolved Rules',
      `<!-- Last updated: ${today} by self-evolve -->`,
      '',
      MANAGED_START,
      '',
    ];
    for (const [cat, contents] of byCategory) {
      sections.push(`## ${cat}`);
      for (const c of contents) sections.push(`- ${c}`);
      sections.push('');
    }
    sections.push(MANAGED_END);

    const managedContent = sections.join('\n');
    const content = this.mergeWithManualSection(rulesFile, managedContent);

    try {
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.writeFileSync(rulesFile, content, 'utf-8');
      logger.info('WRITER', `Rules file written: ${rulesFile}`);
    } catch (err) {
      logger.error('WRITER', 'Failed to write rules file', { rulesFile }, err as Error);
    }
  }

  private writePathScopedRules(
    rulesDir: string,
    rules: Array<{ slug: string | null; paths_glob: string | null; content: string }>,
  ): void {
    const scopedDir = path.join(rulesDir, 'auto-evolved');
    try {
      fs.mkdirSync(scopedDir, { recursive: true });
      for (const rule of rules) {
        if (!rule.slug || !rule.paths_glob) continue;
        let pathsGlob: string[];
        try {
          pathsGlob = JSON.parse(rule.paths_glob);
          if (!Array.isArray(pathsGlob)) continue;
        } catch { continue; }

        const frontmatter = [
          '---',
          `description: Auto-evolved rule for ${rule.slug}`,
          'paths:',
          ...pathsGlob.map(p => `  - "${p}"`),
          '---',
          '',
        ].join('\n');
        const filePath = path.join(scopedDir, `${rule.slug}.mdc`);
        fs.writeFileSync(filePath, frontmatter + rule.content, 'utf-8');
        logger.info('WRITER', `Path-scoped rule written: ${filePath}`);
      }
    } catch (err) {
      logger.error('WRITER', 'Failed to write path-scoped rules', { scopedDir }, err as Error);
    }
  }

  private writeSkillFiles(
    skillsDir: string,
    skills: Array<{ slug: string; skill_md: string | null; manifest_json: string | null }>,
  ): void {
    if (skills.length === 0) return;
    try {
      fs.mkdirSync(skillsDir, { recursive: true });
      for (const skill of skills) {
        const skillDir = path.join(skillsDir, skill.slug);
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skill.skill_md ?? '', 'utf-8');
        logger.info('WRITER', `Skill written: ${path.join(skillDir, 'SKILL.md')}`);
      }
    } catch (err) {
      logger.error('WRITER', 'Failed to write skill files', { skillsDir }, err as Error);
    }
  }

  private cleanupArchivedSkills(skillsDir: string, activeSlugs: string[]): void {
    try {
      if (!fs.existsSync(skillsDir)) return;
      const active = new Set(activeSlugs);
      for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || active.has(entry.name)) continue;
        const dirPath = path.join(skillsDir, entry.name);
        fs.rmSync(dirPath, { recursive: true, force: true });
        logger.info('WRITER', `Cleaned up archived skill: ${dirPath}`);
      }
    } catch (err) {
      logger.error('WRITER', 'Failed to cleanup archived skills', { skillsDir }, err as Error);
    }
  }

  private mergeWithManualSection(rulesFile: string, managedContent: string): string {
    const defaultManual = [
      '',
      '## Manual Rules',
      MANUAL_START,
      '<!-- Manual section: add rules here if you do not want self-evolve to rewrite them. -->',
      MANUAL_END,
      '',
    ].join('\n');

    if (!fs.existsSync(rulesFile)) {
      return `${managedContent}${defaultManual}`;
    }

    const existing = fs.readFileSync(rulesFile, 'utf-8');
    const startIdx = existing.indexOf(MANUAL_START);
    const endIdx = existing.indexOf(MANUAL_END);
    const manualBlock = (startIdx !== -1 && endIdx !== -1)
      ? existing.slice(startIdx, endIdx + MANUAL_END.length)
      : [MANUAL_START, '<!-- Manual section -->', MANUAL_END].join('\n');

    return `${managedContent}\n\n## Manual Rules\n${manualBlock}\n`;
  }
}
