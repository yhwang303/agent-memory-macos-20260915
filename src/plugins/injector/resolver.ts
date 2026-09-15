/**
 * Resolver — single authoritative "targetKind × IDE → landing path" table.
 *
 * Each (injectable × IDE) expands into one or more concrete WriteActions.
 * Path conventions are the 2026 researched values (see design decision 3):
 * each IDE organizes skills/rules/mcp differently, so resolution is per-IDE.
 */
import fs from 'fs';
import path from 'path';
import { resolveLibraryDir } from './catalog.js';
import type { Injectable, WriteAction, ManagedBlock } from './types.js';

/** Recursively list files under a directory, returned as paths relative to it. */
function walkRelative(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, r);
      else out.push(r);
    }
  };
  if (fs.existsSync(root)) walk(root, '');
  return out;
}

function skillDir(ide: string, workspace: string, slug: string): string {
  switch (ide) {
    case 'cursor':
      return path.join(workspace, '.cursor', 'skills', slug);
    case 'claude-code':
      return path.join(workspace, '.claude', 'skills', slug);
    case 'codebuddy':
      return path.join(workspace, '.codebuddy', 'skills', slug);
    case 'codex-cli':
      return path.join(workspace, '.agents', 'skills', slug); // Codex skills live under .agents, not .codex
    default:
      return path.join(workspace, '.cursor', 'skills', slug);
  }
}

/** Returns the memory/instruction file a managed-block rule is written into. */
function ruleManagedTarget(ide: string, workspace: string): string | null {
  switch (ide) {
    case 'claude-code':
      return path.join(workspace, 'CLAUDE.md');
    case 'codex-cli':
      return path.join(workspace, 'AGENTS.md');
    default:
      return null;
  }
}

function readSourceFile(rel: string): string {
  return fs.readFileSync(path.join(resolveLibraryDir(), rel), 'utf-8');
}

function wrapManaged(block: ManagedBlock, body: string): string {
  return `${block.start}\n${body.trim()}\n${block.end}`;
}

/**
 * Build the write actions for one injectable targeting one IDE.
 * `ide` is '*' for IDE-agnostic spec items.
 */
export function resolveActions(item: Injectable, ide: string, workspace: string): WriteAction[] {
  const libDir = resolveLibraryDir();
  const conflict = item.conflict ?? 'overwrite';
  const actions: WriteAction[] = [];

  switch (item.targetKind) {
    case 'spec': {
      // Source mirrors the workspace layout; copy each file to its relative path under the project root.
      const srcRoot = path.join(libDir, item.source ?? '');
      for (const rel of walkRelative(srcRoot)) {
        actions.push({
          injectableId: item.id,
          ide: '*',
          targetPath: path.join(workspace, rel),
          mode: 'file',
          conflict,
          sourceAbsPath: path.join(srcRoot, rel),
        });
      }
      return actions;
    }

    case 'skill': {
      const slug = item.slug ?? item.id.split('.').pop() ?? item.id;
      const srcRoot = path.join(libDir, item.source ?? '');
      const destDir = skillDir(ide, workspace, slug);
      for (const rel of walkRelative(srcRoot)) {
        actions.push({
          injectableId: item.id,
          ide,
          targetPath: path.join(destDir, rel),
          mode: 'file',
          conflict,
          sourceAbsPath: path.join(srcRoot, rel),
        });
      }
      return actions;
    }

    case 'rule': {
      const ruleId = item.ruleId ?? item.id.split('.').pop() ?? item.id;
      const body = readSourceFile(item.source ?? '');
      const managedTarget = ruleManagedTarget(ide, workspace);

      if (managedTarget && item.managedBlock) {
        // Claude Code / Codex: append a managed block into CLAUDE.md / AGENTS.md
        actions.push({
          injectableId: item.id,
          ide,
          targetPath: managedTarget,
          mode: 'managed-block',
          conflict: 'managed-block',
          managedBlock: item.managedBlock,
          payload: wrapManaged(item.managedBlock, body),
        });
        return actions;
      }

      // Cursor: one .mdc file per rule; CodeBuddy: a folder per rule with RULE.mdc
      let target: string;
      if (ide === 'codebuddy') {
        target = path.join(workspace, '.codebuddy', 'rules', ruleId, 'RULE.mdc');
      } else {
        target = path.join(workspace, '.cursor', 'rules', `${ruleId}.mdc`);
      }
      actions.push({
        injectableId: item.id,
        ide,
        targetPath: target,
        mode: 'file',
        conflict,
        payload: body,
      });
      return actions;
    }

    case 'mcp': {
      const key = item.slug ?? item.id.split('.').pop() ?? item.id;
      const payload = readSourceFile(item.source ?? '');
      // Codex uses TOML config; everyone else uses JSON mcp files.
      if (ide === 'codex-cli') {
        actions.push({
          injectableId: item.id,
          ide,
          targetPath: path.join(workspace, '.codex', 'config.toml'),
          mode: 'toml-merge',
          conflict: 'toml-merge',
          payload,
        });
      } else {
        const file =
          ide === 'claude-code'
            ? path.join(workspace, '.mcp.json')
            : ide === 'codebuddy'
              ? path.join(workspace, '.codebuddy', 'settings.json')
              : path.join(workspace, '.cursor', 'mcp.json');
        actions.push({
          injectableId: item.id,
          ide,
          targetPath: file,
          mode: 'json-merge',
          conflict: 'json-merge',
          payload: JSON.stringify({ key, body: JSON.parse(payload) }),
        });
      }
      return actions;
    }

    default:
      return actions;
  }
}

/** The IDEs an item should be written to, given the user's requested IDE set. */
export function applicableIdes(item: Injectable, requested: string[]): string[] {
  if (item.targetKind === 'spec') return ['*']; // IDE-agnostic, written once
  const supported = item.ides ?? [];
  if (supported.includes('*')) return ['*'];
  return requested.filter((i) => supported.includes(i));
}
