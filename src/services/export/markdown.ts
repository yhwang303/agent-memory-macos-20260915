/**
 * Markdown renderer for memory export.
 * Generates human-readable, narrative-style Markdown from observations and summaries.
 */

export interface ExportSession {
  memory_session_id: string;
  project: string;
  user_prompt?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  device_id?: string | null;
  device_name?: string | null;
  source_ide?: string | null;
}

export interface ExportObservation {
  id: number;
  memory_session_id: string;
  project: string;
  type: string;
  title?: string | null;
  subtitle?: string | null;
  narrative?: string | null;
  facts?: string | null;
  concepts?: string | null;
  files_read?: string | null;
  files_modified?: string | null;
  created_at?: string | null;
  created_at_epoch: number;
  device_id?: string | null;
  source_ide?: string | null;
}

export interface ExportSummary {
  id: number;
  memory_session_id: string;
  project: string;
  request?: string | null;
  investigated?: string | null;
  learned?: string | null;
  completed?: string | null;
  next_steps?: string | null;
  files_read?: string | null;
  files_edited?: string | null;
  notes?: string | null;
  created_at?: string | null;
  created_at_epoch: number;
  device_id?: string | null;
  source_ide?: string | null;
}

export interface ExportData {
  sessions: ExportSession[];
  observations: ExportObservation[];
  summaries: ExportSummary[];
}

export type GroupBy = 'date' | 'ide' | 'project';

function formatTime(epoch: number): string {
  const d = new Date(epoch);
  return d.toTimeString().slice(0, 5);
}

function formatDate(epoch: number): string {
  const d = new Date(epoch);
  return d.toISOString().slice(0, 10);
}

function getProjectBasename(project: string): string {
  if (!project) return 'unknown';
  const parts = project.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || project;
}

function parseFileList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter(Boolean).map(String);
  } catch { /* not JSON, try comma/newline split */ }
  return raw.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
}

function isSimilar(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  const shorter = na.length < nb.length ? na : nb;
  const longer = na.length < nb.length ? nb : na;
  return longer.includes(shorter) && shorter.length > 20;
}

const TYPE_LABELS: Record<string, string> = {
  feature: '功能',
  debugging: '调试',
  investigation: '调查',
  documentation: '文档',
  learning: '学习',
  refactoring: '重构',
  testing: '测试',
  configuration: '配置',
  performance: '性能',
};

function renderSessionBlock(
  session: ExportSession,
  observations: ExportObservation[],
  summary: ExportSummary | undefined,
  headingLevel: number,
): string {
  const h = (n: number) => '#'.repeat(n);
  const lines: string[] = [];

  const startTime = session.started_at ? formatTime(new Date(session.started_at).getTime()) : '??:??';
  const endTime = session.completed_at ? formatTime(new Date(session.completed_at).getTime()) : '进行中';
  const ide = session.source_ide || '';
  const proj = getProjectBasename(session.project);

  const titleParts = [`${startTime} – ${endTime}`, proj];
  if (ide) titleParts.push(ide);
  lines.push(`${h(headingLevel)} ${titleParts.join(' | ')}`);
  lines.push('');

  // --- Task description ---
  const userPrompt = session.user_prompt?.trim();
  const summaryRequest = summary?.request?.trim();

  if (userPrompt && summaryRequest && !isSimilar(userPrompt, summaryRequest)) {
    lines.push(`${h(headingLevel + 1)} 任务描述`);
    lines.push('');
    lines.push(summaryRequest);
    lines.push('');
    lines.push(`> **用户原话**: ${userPrompt}`);
    lines.push('');
  } else if (summaryRequest) {
    lines.push(`${h(headingLevel + 1)} 任务描述`);
    lines.push('');
    lines.push(summaryRequest);
    lines.push('');
  } else if (userPrompt) {
    lines.push(`${h(headingLevel + 1)} 任务描述`);
    lines.push('');
    lines.push(userPrompt);
    lines.push('');
  }

  // --- Summary ---
  if (summary) {
    const items: { label: string; text: string }[] = [];
    if (summary.completed) items.push({ label: '完成', text: summary.completed });
    if (summary.learned) items.push({ label: '发现', text: summary.learned });
    if (summary.investigated) items.push({ label: '调查过程', text: summary.investigated });
    if (summary.next_steps) items.push({ label: '下一步', text: summary.next_steps });
    if (summary.notes) items.push({ label: '备注', text: summary.notes });

    if (items.length > 0) {
      lines.push(`${h(headingLevel + 1)} 完成情况`);
      lines.push('');
      for (const item of items) {
        lines.push(`- **${item.label}**: ${item.text}`);
      }
      lines.push('');
    }
  }

  // --- Observations ---
  if (observations.length > 0) {
    lines.push(`${h(headingLevel + 1)} 观察记录`);
    lines.push('');

    for (const obs of observations) {
      const typeLabel = TYPE_LABELS[obs.type] || obs.type;
      const title = obs.title || obs.subtitle || '未命名观察';
      lines.push(`${h(headingLevel + 2)} [${typeLabel}] ${title}`);
      lines.push('');

      if (obs.narrative) {
        lines.push(obs.narrative);
        lines.push('');
      }

      const facts = parseFileList(obs.facts);
      if (facts.length > 0) {
        lines.push(`**关键事实**:`);
        for (const f of facts) {
          lines.push(`- ${f}`);
        }
        lines.push('');
      }

      const concepts = parseFileList(obs.concepts);
      if (concepts.length > 0) {
        lines.push(`**涉及概念**: ${concepts.join('、')}`);
        lines.push('');
      }
    }
  }

  // --- Files involved ---
  const allFilesRead = new Set<string>();
  const allFilesModified = new Set<string>();

  for (const obs of observations) {
    for (const f of parseFileList(obs.files_read)) allFilesRead.add(f);
    for (const f of parseFileList(obs.files_modified)) allFilesModified.add(f);
  }
  if (summary) {
    for (const f of parseFileList(summary.files_read)) allFilesRead.add(f);
    for (const f of parseFileList(summary.files_edited)) allFilesModified.add(f);
  }
  // Don't show files that appear in both read and modified under "read"
  for (const f of allFilesModified) allFilesRead.delete(f);

  if (allFilesRead.size > 0 || allFilesModified.size > 0) {
    lines.push(`${h(headingLevel + 1)} 涉及文件`);
    lines.push('');
    if (allFilesModified.size > 0) {
      lines.push(`**修改**: ${Array.from(allFilesModified).map(f => `\`${f}\``).join(', ')}`);
    }
    if (allFilesRead.size > 0) {
      lines.push(`**读取**: ${Array.from(allFilesRead).map(f => `\`${f}\``).join(', ')}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

/**
 * Render export data as a single Markdown string.
 */
export function renderMarkdown(data: ExportData, groupBy: GroupBy = 'date'): string {
  const { sessions, observations, summaries } = data;

  const obsBySession = new Map<string, ExportObservation[]>();
  for (const obs of observations) {
    const list = obsBySession.get(obs.memory_session_id) || [];
    list.push(obs);
    obsBySession.set(obs.memory_session_id, list);
  }

  const sumBySession = new Map<string, ExportSummary>();
  for (const sum of summaries) {
    sumBySession.set(sum.memory_session_id, sum);
  }

  switch (groupBy) {
    case 'date':
      return renderByDate(sessions, obsBySession, sumBySession);
    case 'ide':
      return renderByIDE(sessions, obsBySession, sumBySession);
    case 'project':
      return renderByProject(sessions, obsBySession, sumBySession);
    default:
      return renderByDate(sessions, obsBySession, sumBySession);
  }
}

function renderByDate(
  sessions: ExportSession[],
  obsBySession: Map<string, ExportObservation[]>,
  sumBySession: Map<string, ExportSummary>,
): string {
  const byDate = new Map<string, ExportSession[]>();
  for (const s of sessions) {
    const epoch = s.started_at ? new Date(s.started_at).getTime() : Date.now();
    const date = formatDate(epoch);
    const list = byDate.get(date) || [];
    list.push(s);
    byDate.set(date, list);
  }

  const lines: string[] = [];
  const sortedDates = Array.from(byDate.keys()).sort().reverse();

  for (const date of sortedDates) {
    const daySessions = byDate.get(date)!;
    const dayObsCount = daySessions.reduce(
      (n, s) => n + (obsBySession.get(s.memory_session_id)?.length || 0), 0,
    );

    lines.push(`# 工作记忆 – ${date}`);
    lines.push('');
    lines.push(`> 共 ${daySessions.length} 个任务会话，${dayObsCount} 条观察记录`);
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const session of daySessions) {
      const obs = obsBySession.get(session.memory_session_id) || [];
      const sum = sumBySession.get(session.memory_session_id);
      lines.push(renderSessionBlock(session, obs, sum, 2));
    }
  }

  return lines.join('\n');
}

function renderByIDE(
  sessions: ExportSession[],
  obsBySession: Map<string, ExportObservation[]>,
  sumBySession: Map<string, ExportSummary>,
): string {
  const byIDE = new Map<string, ExportSession[]>();
  for (const s of sessions) {
    const ide = s.source_ide || 'unknown';
    const list = byIDE.get(ide) || [];
    list.push(s);
    byIDE.set(ide, list);
  }

  const lines: string[] = [];
  lines.push('# 工作记忆 – 按 IDE 汇总');
  lines.push('');

  for (const [ide, ideSessions] of byIDE) {
    const ideObsCount = ideSessions.reduce(
      (n, s) => n + (obsBySession.get(s.memory_session_id)?.length || 0), 0,
    );
    lines.push(`## ${ide} (${ideSessions.length} 个会话，${ideObsCount} 条观察)`);
    lines.push('');

    const byDate = new Map<string, ExportSession[]>();
    for (const s of ideSessions) {
      const epoch = s.started_at ? new Date(s.started_at).getTime() : Date.now();
      const date = formatDate(epoch);
      const list = byDate.get(date) || [];
      list.push(s);
      byDate.set(date, list);
    }

    for (const [date, daySessions] of Array.from(byDate.entries()).sort((a, b) => b[0].localeCompare(a[0]))) {
      lines.push(`### ${date}`);
      lines.push('');

      for (const session of daySessions) {
        const obs = obsBySession.get(session.memory_session_id) || [];
        const sum = sumBySession.get(session.memory_session_id);
        lines.push(renderSessionBlock(session, obs, sum, 4));
      }
    }
  }

  return lines.join('\n');
}

function renderByProject(
  sessions: ExportSession[],
  obsBySession: Map<string, ExportObservation[]>,
  sumBySession: Map<string, ExportSummary>,
): string {
  const byProject = new Map<string, ExportSession[]>();
  for (const s of sessions) {
    const proj = getProjectBasename(s.project);
    const list = byProject.get(proj) || [];
    list.push(s);
    byProject.set(proj, list);
  }

  const lines: string[] = [];
  lines.push('# 工作记忆 – 按项目汇总');
  lines.push('');

  for (const [proj, projSessions] of byProject) {
    const projObsCount = projSessions.reduce(
      (n, s) => n + (obsBySession.get(s.memory_session_id)?.length || 0), 0,
    );
    lines.push(`## ${proj} (${projSessions.length} 个会话，${projObsCount} 条观察)`);
    lines.push('');

    const byDate = new Map<string, ExportSession[]>();
    for (const s of projSessions) {
      const epoch = s.started_at ? new Date(s.started_at).getTime() : Date.now();
      const date = formatDate(epoch);
      const list = byDate.get(date) || [];
      list.push(s);
      byDate.set(date, list);
    }

    for (const [date, daySessions] of Array.from(byDate.entries()).sort((a, b) => b[0].localeCompare(a[0]))) {
      lines.push(`### ${date}`);
      lines.push('');

      for (const session of daySessions) {
        const obs = obsBySession.get(session.memory_session_id) || [];
        const sum = sumBySession.get(session.memory_session_id);
        lines.push(renderSessionBlock(session, obs, sum, 4));
      }
    }
  }

  return lines.join('\n');
}
