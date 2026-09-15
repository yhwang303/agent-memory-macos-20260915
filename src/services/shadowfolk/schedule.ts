const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DEFAULT_TIME = '23:30';

function parseDailyTime(value: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value || '');
  if (!match) return { hour: 23, minute: 30 };
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { hour: 23, minute: 30 };
  }
  return { hour, minute };
}

export function normalizeBeijingDailyTime(value: string): string {
  const { hour, minute } = parseDailyTime(value || DEFAULT_TIME);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function nextBeijingDailyRun(time: string, now = new Date()): Date {
  const { hour, minute } = parseDailyTime(time || DEFAULT_TIME);
  const beijingNow = new Date(now.getTime() + BEIJING_OFFSET_MS);
  const y = beijingNow.getUTCFullYear();
  const m = beijingNow.getUTCMonth();
  const d = beijingNow.getUTCDate();
  let candidateUtcMs = Date.UTC(y, m, d, hour - 8, minute, 0, 0);
  if (candidateUtcMs <= now.getTime()) {
    candidateUtcMs = Date.UTC(y, m, d + 1, hour - 8, minute, 0, 0);
  }
  return new Date(candidateUtcMs);
}
