export interface GitUserIdentity {
  name: string;
  email: string;
}

export function resolveAuthorPattern(identity: GitUserIdentity): string | null {
  const email = identity.email.trim();
  if (email) return email;
  const name = identity.name.trim();
  if (name) return name;
  return null;
}

export function authorLogArgs(pattern: string | null): string[] {
  return pattern ? ['--author', pattern] : [];
}

export function parseNumstatOutput(output: string): { files_changed: number; insertions: number; deletions: number } {
  const files = new Set<string>();
  let insertions = 0;
  let deletions = 0;

  for (const line of output.split('\n')) {
    const parts = line.split('\t');
    if (parts.length !== 3) continue;
    const [insRaw, delRaw, file] = parts;
    files.add(file);
    if (insRaw === '-' || delRaw === '-') continue;
    const ins = Number(insRaw);
    const del = Number(delRaw);
    if (Number.isFinite(ins)) insertions += ins;
    if (Number.isFinite(del)) deletions += del;
  }

  return {
    files_changed: files.size,
    insertions,
    deletions,
  };
}
