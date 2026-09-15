import path from 'path';

export interface HookProjectInput {
  workspace?: unknown;
  workspace_roots?: unknown;
  cwd?: unknown;
  projectPath?: unknown;
  project_path?: unknown;
}

const PROJECT_ENV_VARS = [
  'CURSOR_PROJECT_DIR',
  'WINDSURF_PROJECT_DIR',
  'CODEBUDDY_PROJECT_DIR',
  'CODEBUDDY_IDE_PROJECT_DIR',
  'CLAUDE_PROJECT_DIR',
  'GEMINI_PROJECT_DIR',
  'OPENCODE_PROJECT_DIR',
  'CODEX_PROJECT_DIR',
] as const;

function firstString(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.find((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function isAbsoluteOnAnyPlatform(value: string): boolean {
  return path.isAbsolute(value)
    || /^[a-zA-Z]:[\\/]/.test(value)
    || /^\\\\[^\\]+\\[^\\]+/.test(value)
    || /^\/\/[^/]+\/[^/]+/.test(value);
}

/** Confirmed invalid packaged-macOS fallback; other absolute directories may be intentional. */
export function isLowConfidenceProjectPath(value: string | null | undefined): boolean {
  if (!value?.trim()) return true;
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() || '/';
  return normalized === '/';
}

function usable(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim();
  if (!candidate || !isAbsoluteOnAnyPlatform(candidate) || isLowConfidenceProjectPath(candidate)) {
    return undefined;
  }
  return candidate;
}

/**
 * Resolve the workspace consistently for every hook event.
 * Explicit workspace roots win over adapter environment variables; event cwd
 * and the hook process cwd are progressively weaker fallbacks.
 */
export function resolveHookProjectPath(
  input: unknown = {},
  env: NodeJS.ProcessEnv = process.env,
  runtimeCwd?: string,
): string {
  const hookInput = (input && typeof input === 'object' ? input : {}) as HookProjectInput;
  const candidates: unknown[] = [
    firstString(hookInput.workspace),
    firstString(hookInput.workspace_roots),
    hookInput.projectPath,
    hookInput.project_path,
    ...PROJECT_ENV_VARS.map((name) => env[name]),
    hookInput.cwd,
  ];

  for (const candidate of candidates) {
    const resolved = usable(candidate);
    if (resolved) return resolved;
  }

  // A hook can inherit an inaccessible or deleted cwd. Only read it when
  // event metadata and environment paths are unavailable, and keep capture alive.
  try {
    return usable(runtimeCwd ?? process.cwd()) || '';
  } catch {
    return '';
  }
}
