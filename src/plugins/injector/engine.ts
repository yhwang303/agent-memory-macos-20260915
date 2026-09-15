/**
 * Injection engine — preview (dry-run), apply (idempotent write + ledger), uninstall.
 *
 * Flow (design decision 4): resolve dependency closure → resolve landing paths →
 * build a per-file plan (create/overwrite/merge/skip) → write per conflict strategy,
 * recording a backup descriptor in the ledger for reversible uninstall.
 */
import fs from 'fs';
import path from 'path';
import { resolveClosure, listItems } from './catalog.js';
import { resolveActions, applicableIdes } from './resolver.js';
import {
  insertLedger,
  getLedger,
  getLedgerById,
  deleteLedger,
  type SqliteLike,
  type LedgerInsert,
} from './ledger.js';
import type {
  Injectable,
  WriteAction,
  PlanEntry,
  PlanOp,
  PreviewResult,
  InjectResult,
} from './types.js';

interface ActionWithMeta extends WriteAction {
  viaDependency: boolean;
  version: string;
}

/** Expand selection → closure → concrete write actions across the requested IDEs. */
function buildActions(selected: string[], ides: string[], workspace: string): ActionWithMeta[] {
  const { resolved, addedByDependency } = resolveClosure(selected);
  const out: ActionWithMeta[] = [];
  for (const item of resolved) {
    const viaDependency = addedByDependency.has(item.id);
    for (const ide of applicableIdes(item, ides)) {
      for (const a of resolveActions(item, ide, workspace)) {
        out.push({ ...a, viaDependency, version: item.version });
      }
    }
  }
  return out;
}

function planOpFor(action: WriteAction): PlanOp {
  const exists = fs.existsSync(action.targetPath);
  switch (action.mode) {
    case 'managed-block': {
      if (!exists) return 'create';
      const cur = fs.readFileSync(action.targetPath, 'utf-8');
      return action.managedBlock && cur.includes(action.managedBlock.start) ? 'merge' : 'merge';
    }
    case 'json-merge':
    case 'toml-merge':
      return exists ? 'merge' : 'create';
    case 'file':
    default:
      if (action.conflict === 'skip-if-exists' && exists) return 'skip';
      return exists ? 'overwrite' : 'create';
  }
}

export function preview(selected: string[], ides: string[], workspace: string): PreviewResult {
  const { resolved } = resolveClosure(selected);
  const actions = buildActions(selected, ides, workspace);
  const plan: PlanEntry[] = actions.map((a) => ({
    injectableId: a.injectableId,
    ide: a.ide,
    targetPath: a.targetPath,
    op: planOpFor(a),
    viaDependency: a.viaDependency,
  }));
  return {
    workspace,
    ides,
    selected,
    resolved: resolved.map((r) => r.id),
    plan,
  };
}

// ── write helpers ──────────────────────────────────────────────────────────

function ensureDir(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function writeManagedBlock(action: WriteAction): string {
  const block = action.managedBlock!;
  const payload = action.payload ?? '';
  let existing = fs.existsSync(action.targetPath) ? fs.readFileSync(action.targetPath, 'utf-8') : '';
  const start = existing.indexOf(block.start);
  const end = existing.indexOf(block.end);
  if (start !== -1 && end !== -1) {
    existing = existing.slice(0, start) + payload + existing.slice(end + block.end.length);
  } else {
    existing = existing.trim().length ? `${existing.trimEnd()}\n\n${payload}\n` : `${payload}\n`;
  }
  ensureDir(action.targetPath);
  fs.writeFileSync(action.targetPath, existing, 'utf-8');
  return JSON.stringify({ kind: 'managed', start: block.start, end: block.end });
}

function writeJsonMerge(action: WriteAction): string {
  const { key, body } = JSON.parse(action.payload ?? '{}') as { key: string; body: unknown };
  const obj: any = fs.existsSync(action.targetPath)
    ? JSON.parse(fs.readFileSync(action.targetPath, 'utf-8') || '{}')
    : {};
  obj.mcpServers = obj.mcpServers ?? {};
  obj.mcpServers[key] = body;
  ensureDir(action.targetPath);
  fs.writeFileSync(action.targetPath, JSON.stringify(obj, null, 2), 'utf-8');
  return JSON.stringify({ kind: 'json', key });
}

function writeFile(action: WriteAction): string {
  const prev = fs.existsSync(action.targetPath)
    ? fs.readFileSync(action.targetPath, 'utf-8')
    : null;
  ensureDir(action.targetPath);
  const content = action.payload ?? fs.readFileSync(action.sourceAbsPath!, 'utf-8');
  fs.writeFileSync(action.targetPath, content, 'utf-8');
  return JSON.stringify({ kind: 'file', prev });
}

export function apply(
  db: SqliteLike,
  selected: string[],
  ides: string[],
  workspace: string,
): InjectResult {
  const actions = buildActions(selected, ides, workspace);
  let written = 0;
  let skipped = 0;
  const plan: PlanEntry[] = [];

  for (const action of actions) {
    const op = planOpFor(action);
    plan.push({
      injectableId: action.injectableId,
      ide: action.ide,
      targetPath: action.targetPath,
      op,
      viaDependency: action.viaDependency,
    });
    if (op === 'skip') {
      skipped++;
      continue;
    }

    let backup: string;
    if (action.mode === 'managed-block') backup = writeManagedBlock(action);
    else if (action.mode === 'json-merge') backup = writeJsonMerge(action);
    else if (action.mode === 'toml-merge') {
      // v1: TOML merge not yet implemented; record intent, skip write to avoid corruption.
      skipped++;
      continue;
    } else backup = writeFile(action);

    const row: LedgerInsert = {
      workspace,
      ide: action.ide,
      injectable_id: action.injectableId,
      version: action.version,
      target_path: action.targetPath,
      mode: action.mode,
      backup,
    };
    insertLedger(db, row);
    written++;
  }

  const { resolved } = resolveClosure(selected);
  return { workspace, ides, selected, resolved: resolved.map((r) => r.id), plan, written, skipped };
}

// ── uninstall ────────────────────────────────────────────────────────────────

function pruneEmptyDirs(file: string, stopAt: string): void {
  let dir = path.dirname(file);
  while (dir.startsWith(stopAt) && dir !== stopAt) {
    try {
      if (fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
        dir = path.dirname(dir);
      } else break;
    } catch {
      break;
    }
  }
}

export interface UninstallResult {
  removed: number;
  details: Array<{ id: number; targetPath: string; action: string }>;
}

/** Uninstall a single ledger row, restoring per the recorded backup descriptor. */
export function uninstall(db: SqliteLike, ledgerId: number): UninstallResult {
  const row = getLedgerById(db, ledgerId);
  if (!row) return { removed: 0, details: [] };
  const details: UninstallResult['details'] = [];
  let backup: any = {};
  try {
    backup = row.backup ? JSON.parse(row.backup) : {};
  } catch {
    backup = {};
  }

  if (backup.kind === 'managed') {
    if (fs.existsSync(row.target_path)) {
      let cur = fs.readFileSync(row.target_path, 'utf-8');
      const s = cur.indexOf(backup.start);
      const e = cur.indexOf(backup.end);
      if (s !== -1 && e !== -1) {
        cur = (cur.slice(0, s) + cur.slice(e + String(backup.end).length)).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
        fs.writeFileSync(row.target_path, cur, 'utf-8');
      }
    }
    details.push({ id: ledgerId, targetPath: row.target_path, action: 'removed-managed-block' });
  } else if (backup.kind === 'json') {
    if (fs.existsSync(row.target_path)) {
      const obj: any = JSON.parse(fs.readFileSync(row.target_path, 'utf-8') || '{}');
      if (obj.mcpServers) delete obj.mcpServers[backup.key];
      fs.writeFileSync(row.target_path, JSON.stringify(obj, null, 2), 'utf-8');
    }
    details.push({ id: ledgerId, targetPath: row.target_path, action: 'removed-json-key' });
  } else {
    // file
    if (backup.prev != null) {
      fs.writeFileSync(row.target_path, backup.prev, 'utf-8');
      details.push({ id: ledgerId, targetPath: row.target_path, action: 'restored-backup' });
    } else if (fs.existsSync(row.target_path)) {
      fs.rmSync(row.target_path, { force: true });
      pruneEmptyDirs(row.target_path, row.workspace);
      details.push({ id: ledgerId, targetPath: row.target_path, action: 'deleted' });
    }
  }

  deleteLedger(db, ledgerId);
  return { removed: 1, details };
}

/** Catalog grouped by category, annotated with installed/update status from the ledger. */
export function catalogWithStatus(db: SqliteLike, workspace: string) {
  const ledger = getLedger(db, workspace);
  const installedVersion = new Map<string, string>();
  for (const r of ledger) {
    if (!installedVersion.has(r.injectable_id)) installedVersion.set(r.injectable_id, r.version);
  }
  const annotate = (item: Injectable) => {
    const installed = installedVersion.get(item.id);
    let status: 'none' | 'installed' | 'update' = 'none';
    if (installed) status = installed === item.version ? 'installed' : 'update';
    return { ...item, installedVersion: installed ?? null, status };
  };
  return listItems().map(annotate);
}
