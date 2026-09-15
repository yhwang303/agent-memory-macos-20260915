/**
 * Injector plugin entry point.
 *
 * Distributes built-in content (skills / rules / mcp / specs / bundles) into
 * target projects, mapping each item to the correct per-IDE landing path.
 * Follows the self-evolve manual-wiring transition pattern; the SQLite handle
 * is injected (no direct core Database import) per the plugin DB-access rule.
 */
import { logger } from '../../utils/logger.js';
import { detectInstalledIDEs } from '../../services/integrations/ide-detection.js';
import { listItems } from './catalog.js';
import { preview as enginePreview, apply as engineApply, uninstall as engineUninstall, catalogWithStatus } from './engine.js';
import { getLedger } from './ledger.js';
import type { SqliteLike } from './ledger.js';
import { SUPPORTED_IDES } from './types.js';
import type { InjectorPluginConfig, DetectedIde, IdeId, PreviewResult, InjectResult, LedgerRow } from './types.js';

export type { InjectorPluginConfig } from './types.js';
export { DEFAULT_INJECTOR_CONFIG } from './types.js';

export interface InjectorContext {
  /** better-sqlite3 handle, supplied by WorkerService (PluginContext.db). */
  db: SqliteLike;
}

export interface InjectorPlugin {
  initialize(config: InjectorPluginConfig, ctx: InjectorContext): void;
  getCatalog(workspace?: string): unknown[];
  detectIdes(): Promise<DetectedIde[]>;
  getLedger(workspace?: string): LedgerRow[];
  preview(selected: string[], ides: string[], workspace: string): PreviewResult;
  inject(selected: string[], ides: string[], workspace: string): InjectResult;
  uninstall(ledgerId: number): { removed: number; details: unknown[] };
}

/** Map ide-detection ids to the catalog's supported IDE ids. */
const DETECTION_ID_MAP: Record<string, IdeId> = {
  cursor: 'cursor',
  'claude-code': 'claude-code',
  'codebuddy-ide': 'codebuddy',
  codebuddy: 'codebuddy',
  'codex-cli': 'codex-cli',
};

class InjectorPluginImpl implements InjectorPlugin {
  private config!: InjectorPluginConfig;
  private db!: SqliteLike;

  initialize(config: InjectorPluginConfig, ctx: InjectorContext): void {
    this.config = config;
    this.db = ctx.db;
    // Eagerly validate the library is reachable.
    try {
      const n = listItems().length;
      logger.info('INJECTOR', 'Plugin initialized', { items: n });
    } catch (err) {
      logger.error('INJECTOR', 'Failed to load catalog', {}, err as Error);
    }
  }

  getCatalog(workspace?: string): unknown[] {
    if (workspace) return catalogWithStatus(this.db, workspace);
    return listItems();
  }

  async detectIdes(): Promise<DetectedIde[]> {
    let detectedIds = new Set<string>();
    try {
      const results = await detectInstalledIDEs();
      for (const r of results) {
        if (r.detected) {
          const mapped = DETECTION_ID_MAP[r.id];
          if (mapped) detectedIds.add(mapped);
        }
      }
    } catch (err) {
      logger.warn('INJECTOR', 'IDE detection failed', { error: String(err) });
    }
    return SUPPORTED_IDES.map((ide) => ({
      id: ide.id,
      displayName: ide.displayName,
      detected: detectedIds.has(ide.id),
    }));
  }

  getLedger(workspace?: string): LedgerRow[] {
    return getLedger(this.db, workspace);
  }

  preview(selected: string[], ides: string[], workspace: string): PreviewResult {
    return enginePreview(selected, ides, workspace);
  }

  inject(selected: string[], ides: string[], workspace: string): InjectResult {
    const result = engineApply(this.db, selected, ides, workspace);
    logger.info('INJECTOR', 'Injection applied', {
      workspace,
      selected: selected.length,
      written: result.written,
      skipped: result.skipped,
    });
    return result;
  }

  uninstall(ledgerId: number): { removed: number; details: unknown[] } {
    return engineUninstall(this.db, ledgerId);
  }
}

export function createInjectorPlugin(): InjectorPlugin {
  return new InjectorPluginImpl();
}
