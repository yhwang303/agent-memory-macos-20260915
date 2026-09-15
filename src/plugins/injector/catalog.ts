/**
 * Catalog loader + dependency-closure resolver.
 *
 * Reads the built-in `library/catalog.json` and provides querying plus the
 * completeness logic (decision 4b): expanding bundles and `requires` so a
 * selection never produces a half-wired, orphaned system.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Catalog, Injectable } from './types.js';

let libDirCache: string | null = null;
let catalogCache: Catalog | null = null;

/** Resolve the library directory across dev / compiled / packaged layouts. */
export function resolveLibraryDir(): string {
  if (libDirCache) return libDirCache;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath;

  const candidates = [
    process.env.INJECTOR_LIBRARY_DIR,
    path.resolve(here, 'library'), // assets copied next to compiled output
    path.resolve(here, '..', '..', '..', 'src', 'plugins', 'injector', 'library'), // dist/plugins/injector → repo/src/...
    path.resolve(here, '..', '..', '..', '..', 'src', 'plugins', 'injector', 'library'),
    path.resolve(process.cwd(), 'src', 'plugins', 'injector', 'library'),
    // Packaged desktop: worker runs as a standalone node process from
    // resources/worker/plugins/injector, while the library is copied as a
    // sibling extraResource at resources/injector-library. process.resourcesPath
    // is undefined in this non-Electron process, so resolve it relative to `here`.
    path.resolve(here, '..', '..', '..', 'injector-library'),
    path.resolve(here, '..', '..', '..', '..', 'injector-library'),
    resourcesPath ? path.join(resourcesPath, 'injector-library') : undefined,
    resourcesPath ? path.join(resourcesPath, 'app', 'injector-library') : undefined,
  ].filter((c): c is string => Boolean(c));

  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'catalog.json'))) {
      libDirCache = c;
      return c;
    }
  }

  // Last resort: ascend from `here` looking for a sibling `injector-library`
  // or `library` directory that contains catalog.json.
  let dir = here;
  for (let i = 0; i < 7; i++) {
    for (const name of ['injector-library', 'library']) {
      const guess = path.join(dir, name);
      if (fs.existsSync(path.join(guess, 'catalog.json'))) {
        libDirCache = guess;
        return guess;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Fall back to the first sensible candidate even if missing (errors surface on read).
  libDirCache = candidates[1] ?? candidates[0];
  return libDirCache;
}

export function loadCatalog(force = false): Catalog {
  if (catalogCache && !force) return catalogCache;
  const file = path.join(resolveLibraryDir(), 'catalog.json');
  const raw = fs.readFileSync(file, 'utf-8');
  catalogCache = JSON.parse(raw) as Catalog;
  return catalogCache;
}

export function listItems(): Injectable[] {
  return loadCatalog().items;
}

export function getItem(id: string): Injectable | undefined {
  return loadCatalog().items.find((i) => i.id === id);
}

export interface ClosureResult {
  /** writable (non-bundle) injectables in dependency order, de-duplicated */
  resolved: Injectable[];
  /** ids that were pulled in by a bundle or `requires` (not directly selected) */
  addedByDependency: Set<string>;
  /** selected bundle ids (expanded into members) */
  bundles: string[];
}

/**
 * Expand a user selection into the full, closed set of writable injectables.
 * - bundles → their members
 * - each item → its `requires` (transitively)
 * Throws on unknown ids or circular dependencies.
 */
export function resolveClosure(selectedIds: string[]): ClosureResult {
  const resolved = new Map<string, Injectable>();
  const addedByDependency = new Set<string>();
  const bundles: string[] = [];
  const directly = new Set(selectedIds);
  const visiting = new Set<string>();

  const visit = (id: string, viaDep: boolean): void => {
    if (visiting.has(id)) {
      throw new Error(`Injector: circular dependency detected at "${id}"`);
    }
    const item = getItem(id);
    if (!item) throw new Error(`Injector: unknown injectable "${id}"`);

    if (viaDep && !directly.has(id)) addedByDependency.add(id);

    if (item.category === 'bundle') {
      if (!bundles.includes(id)) bundles.push(id);
      visiting.add(id);
      for (const m of item.members ?? []) visit(m, true);
      visiting.delete(id);
      return;
    }

    if (resolved.has(id)) return;
    visiting.add(id);
    for (const dep of item.requires ?? []) visit(dep, true);
    visiting.delete(id);
    resolved.set(id, item);
  };

  for (const id of selectedIds) visit(id, false);

  return { resolved: [...resolved.values()], addedByDependency, bundles };
}
