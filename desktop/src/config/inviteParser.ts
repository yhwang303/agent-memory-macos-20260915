/**
 * Parse cmem:// invite links produced by agent-mem-server.
 *
 * Supported shapes:
 *   cmem://connect?server=<url>&user=<name>&token=<token>
 *   https://example.com/admin/invite?server=<url>&user=<name>&token=<token>
 *
 * server and token are URL-encoded by the issuer.
 */

export interface ParsedInvite {
  serverUrl: string;
  userName: string;
  token: string;
}

export interface InviteParseFailure {
  error: string;
}

export type InviteParseResult = ParsedInvite | InviteParseFailure | null;

function normalizeServerUrl(raw: string): string {
  if (!raw) return '';
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url.replace(/\/+$/, '');
}

export function parseCmemInvite(raw: string): ParsedInvite | null {
  const result = parseCmemInviteDetailed(raw);
  return result && 'serverUrl' in result ? result : null;
}

export function parseCmemInviteDetailed(raw: string): InviteParseResult {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  let queryStr: string;
  let legacyServerUrl = '';

  if (trimmed.startsWith('cmem://')) {
    try {
      const u = new URL(trimmed.replace(/^cmem:\/\//i, 'http://'));
      queryStr = u.search.replace(/^\?/, '');
      // Support legacy shape: cmem://host:port?token=xxx
      if (u.hostname && u.hostname !== 'connect') {
        legacyServerUrl = `http://${u.host}`;
      }
    } catch {
      // cmem://connect?... — fallback for environments with stricter URL parsing
      const idx = trimmed.indexOf('?');
      if (idx < 0) return null;
      queryStr = trimmed.slice(idx + 1);
    }
  } else if (/^https?:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      queryStr = u.search.replace(/^\?/, '');
    } catch {
      return null;
    }
  } else {
    return null;
  }

  const params = new URLSearchParams(queryStr);
  const serverUrl = normalizeServerUrl(params.get('server') || params.get('url') || legacyServerUrl);
  const userName = (params.get('user') || '').trim();
  const token = (params.get('token') || params.get('t') || '').trim();

  if (!serverUrl) return { error: '邀请链接里没有服务器地址，请复制完整邀请链接' };
  if (!token) return { error: '邀请链接里没有钥匙（Token），请让管理员重新生成/复制完整邀请链接' };
  return { serverUrl, userName, token };
}
