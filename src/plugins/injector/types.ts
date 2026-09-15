/**
 * Injector plugin — shared types.
 *
 * Injector distributes built-in, versioned content (skills / rules / mcp / specs /
 * bundles) into target projects, mapping each item to the correct per-IDE landing
 * path. Content lives as real files under `library/`; SQLite only stores the ledger.
 */

export type TargetKind = 'skill' | 'rule' | 'mcp' | 'spec';
export type Category = TargetKind | 'bundle';
export type ConflictStrategy =
  | 'overwrite'
  | 'managed-block'
  | 'json-merge'
  | 'toml-merge'
  | 'skip-if-exists';

/** IDE ids supported by the resolver (catalog `ides`). `*` = IDE-agnostic (project root). */
export type IdeId = 'cursor' | 'claude-code' | 'codebuddy' | 'codex-cli';

export interface ManagedBlock {
  start: string;
  end: string;
}

export interface Injectable {
  id: string;
  category: Category;
  name: string;
  description?: string;
  version: string;
  tags?: string[];
  official?: boolean;
  /** bundle-only: atomic bundles cannot be split — members never appear standalone */
  atomic?: boolean;
  /** bundle-only: member injectable ids */
  members?: string[];
  /** non-bundle: path relative to the library dir (file or directory) */
  source?: string;
  targetKind?: TargetKind;
  conflict?: ConflictStrategy;
  /** supported IDEs; spec items use ["*"] (project root, IDE-agnostic) */
  ides?: string[];
  /** skill: destination directory name */
  slug?: string;
  /** rule: id used for filenames / managed-block keys */
  ruleId?: string;
  managedBlock?: ManagedBlock;
  /** false = system component, cannot be injected alone (pulls in deps / bundle) */
  standalone?: boolean;
  /** hard dependencies (other injectable ids), resolved transitively */
  requires?: string[];
  /** owning bundle id (for UI grouping/hints) */
  partOf?: string;
}

export interface Catalog {
  libraryVersion: string;
  items: Injectable[];
}

export type PlanOp = 'create' | 'overwrite' | 'merge' | 'skip';

/** A single concrete write the engine intends to perform. */
export interface WriteAction {
  injectableId: string;
  ide: string;
  targetPath: string;
  /** how the write is performed */
  mode: 'file' | 'managed-block' | 'json-merge' | 'toml-merge';
  conflict: ConflictStrategy;
  /** absolute source file path (file mode) */
  sourceAbsPath?: string;
  /** precomputed payload (managed-block / merge modes) */
  payload?: string;
  managedBlock?: ManagedBlock;
}

export interface PlanEntry {
  injectableId: string;
  ide: string;
  targetPath: string;
  op: PlanOp;
  /** true when this item was pulled in by a bundle or `requires`, not directly selected */
  viaDependency: boolean;
}

export interface PreviewResult {
  workspace: string;
  ides: string[];
  selected: string[];
  resolved: string[];
  plan: PlanEntry[];
}

export interface InjectResult extends PreviewResult {
  written: number;
  skipped: number;
}

export interface LedgerRow {
  id: number;
  workspace: string;
  ide: string;
  injectable_id: string;
  version: string;
  target_path: string;
  mode: string;
  backup: string | null;
  injected_at: string;
}

export interface DetectedIde {
  id: IdeId;
  displayName: string;
  detected: boolean;
}

export interface InjectorPluginConfig {
  enabled: boolean;
}

export const DEFAULT_INJECTOR_CONFIG: InjectorPluginConfig = {
  enabled: false,
};

/** The four IDEs whose landing paths the resolver currently implements. */
export const SUPPORTED_IDES: Array<{ id: IdeId; displayName: string }> = [
  { id: 'cursor', displayName: 'Cursor' },
  { id: 'claude-code', displayName: 'Claude Code' },
  { id: 'codebuddy', displayName: 'CodeBuddy' },
  { id: 'codex-cli', displayName: 'Codex App / CLI' },
];
