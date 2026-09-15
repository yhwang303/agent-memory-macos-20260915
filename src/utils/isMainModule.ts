/**
 * Return true when the module identified by `importMetaUrl` is being executed
 * directly as a script (i.e. `node file.js` or `tsx file.ts`), not imported
 * by another module (tests, library consumers).
 *
 * Handles Windows drive letters, backslash/forward slash, URL encoding,
 * and .ts/.js extension ambiguity.
 */
export function isMainModule(importMetaUrl: string): boolean {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;

    const url = new URL(importMetaUrl);
    const thisPath = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1');
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\.[tj]s$/, '');
    return norm(thisPath) === norm(argv1);
  } catch {
    return false;
  }
}
