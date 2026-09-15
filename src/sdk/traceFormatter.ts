/**
 * TraceFormatter - 纯函数（无 I/O）
 *
 * 为 Tier 1 事件确定性地拼装一条轻量「面包屑」记录。只用钩子已有的结构化字段
 * （command 前若干字、file_path 相对路径、exit_code），narrative 留空、无套话，
 * type 记原始 tool 类型。零 LLM。
 */

import type { NormalizedEvent } from './observationClassifier.js';

export interface TraceRecord {
  title: string;
  facts: string;
  type: string;
}

// title 中命令/文本截断长度
const COMMAND_PREVIEW_LEN = 80;

function coerce(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return value;
      }
    }
  }
  return value;
}

function asObject(value: unknown): Record<string, unknown> {
  const v = coerce(value);
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

/** 归一化为相对路径风格（统一正斜杠） */
function relPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').trim();
}

/**
 * 为一个事件生成确定性 trace 记录。
 */
export function formatTrace(event: NormalizedEvent): TraceRecord {
  const type = event.observationType || event.toolName;
  const toolName = event.toolName;

  if (type === 'shell' || toolName === 'shell') {
    const input = asObject(event.toolInput);
    const output = asObject(event.toolOutput);
    const command = asText(input.command).trim();
    const exitRaw = output.exitCode ?? (output as Record<string, unknown>).exit_code;
    const facts: string[] = [`命令: ${truncate(command, COMMAND_PREVIEW_LEN * 2)}`];
    if (exitRaw !== undefined && exitRaw !== null && exitRaw !== '') {
      facts.push(`退出码: ${exitRaw}`);
    }
    return {
      title: `执行命令: ${truncate(command, COMMAND_PREVIEW_LEN)}`,
      facts: facts.join('\n'),
      type,
    };
  }

  if (
    type === 'file_edit' || type === 'search_replace' ||
    toolName === 'file_edit' || toolName === 'search_replace'
  ) {
    const input = asObject(event.toolInput);
    const file = relPath(asText(input.filePath || (input as Record<string, unknown>).file_path));
    const editType = asText(input.editType || (input as Record<string, unknown>).edit_type).trim();
    const facts: string[] = [`文件: ${file}`];
    if (editType) {
      facts.push(`操作: ${editType}`);
    }
    return {
      title: `编辑文件: ${file}`,
      facts: facts.join('\n'),
      type,
    };
  }

  if (type === 'mcp' || toolName.includes(':')) {
    return {
      title: `MCP 查询: ${toolName}`,
      facts: `工具: ${toolName}`,
      type: type || 'mcp',
    };
  }

  // 兜底：仅记录工具名
  return {
    title: `操作: ${toolName}`,
    facts: `工具: ${toolName}`,
    type,
  };
}
