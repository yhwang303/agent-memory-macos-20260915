/**
 * ObservationClassifier - 纯函数分档器（无 I/O）
 *
 * 在调用 LLM 之前，根据钩子层的确定性输入（observationType / toolName /
 * toolInput / toolOutput）把每个事件分到三档：
 *   - Tier 0：无有效负载或纯噪音，直接丢弃（不入库、不调 LLM）。
 *   - Tier 1：低价值但值得留面包屑的机械操作，用模板留痕（不调 LLM）。
 *   - Tier 2：真正有价值的事件才调 LLM；内部再按价值分到 high / light 两个模型。
 *
 * 总原则：先看有效负载（command / diff / 结果），空负载无论事件类型一律下踢；
 * 无法判断时 fail-open 到 { tier: 2, model: 'high' }。
 */

import { createHash } from 'node:crypto';

export interface NormalizedEvent {
  observationType?: string;
  toolName: string;
  toolInput: unknown;
  toolOutput: unknown;
}

export interface ClassifyResult {
  tier: 0 | 1 | 2;
  model?: 'high' | 'light';
  dropReason?: string;
  signature: string;
}

// 短文本阈值：极短 agent_response 视为面包屑
const SHORT_RESPONSE_LEN = 40;
// 极短 diff 视为缺失（编辑了文件但无实质内容变更）
const SHORT_DIFF_LEN = 30;
// 新建文件内容超过此长度视为「内容多」，走高级模型
const LARGE_NEW_FILE_LEN = 600;

// 图片/二进制后缀：这类文件编辑对召回零价值
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico',
  '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp4', '.mp3', '.wav', '.mov', '.avi', '.webm',
]);

// 文档/标记语言后缀：写文档语义召回价值高
const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.mdx', '.rst']);

// MCP 只读查询前缀
const MCP_READONLY_PREFIXES = ['get', 'list', 'search', 'read', 'query', 'fetch'];


/** 把可能是 JSON 字符串的值解析为对象/原值 */
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

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }

  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(key => {
    return `${JSON.stringify(key)}:${stableStringify(obj[key])}`;
  }).join(',')}}`;
}

/** 取文件名（兼容 / 与 \ 分隔符） */
function baseName(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/');
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/** 取小写扩展名（含点），无扩展名返回 '' */
function extName(filePath: string): string {
  const name = baseName(filePath);
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(idx).toLowerCase() : '';
}

function isBinaryFile(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(extName(filePath));
}

function isDocFile(filePath: string): boolean {
  return DOC_EXTENSIONS.has(extName(filePath));
}

/** Cursor 粘贴截图缓存（workspaceStorage 下的图片） */
function isWorkspaceStorageScreenshot(filePath: string): boolean {
  return filePath.replace(/\\/g, '/').toLowerCase().includes('workspacestorage');
}

/** 临时文件：提交消息、合并消息、编辑器临时文件等 */
function isTempFile(filePath: string): boolean {
  const name = baseName(filePath);
  if (name === 'COMMIT_EDITMSG' || name === 'MERGE_MSG' || name === 'TAG_EDITMSG') return true;
  if (/\.(tmp|temp|swp|swo|orig|bak)$/i.test(name)) return true;
  if (/^git-rebase/i.test(name)) return true;
  return false;
}

/** 打包 / 构建 / 测试类命令 */
function isBuildPackTestCommand(command: string): boolean {
  const c = command.toLowerCase();
  if (/\b(tsc|webpack|rollup|esbuild|vite|make|gradle|mvn|ninja|jest|vitest|mocha|pytest|ctest|jasmine|karma)\b/.test(c)) {
    return true;
  }
  if (/\b(npm|pnpm|yarn|bun|npx)\b[\s\S]*\b(build|test|pack|bundle|compile)\b/.test(c)) {
    return true;
  }
  if (/\b(go|cargo|dotnet)\b[\s\S]*\b(build|test)\b/.test(c)) {
    return true;
  }
  return false;
}

function mcpToolPart(toolName: string): string {
  // MCP 工具命名标准是 `mcp__<server>__<tool>`(Claude Code / Cursor / 等都遵循
  // Anthropic 约定),分隔符是连续两个下划线。也兼容历史上少数实现的 `:`,
  // 取分隔出的最后一段作为"动作名",例如 mcp__agentmemory__search → search。
  // 旧实现只看 `:`,把 `mcp__agentmemory__search` 当成整串小写,使
  // isReadOnlyMcp(startsWith get/list/search/...) 永远不命中,所有 MCP 查询都
  // 被错判成 tier=2,这是用户库里 17000+ tier=2 但只有 1 条 tier=1 mcp 的根因。
  const dunderIdx = toolName.lastIndexOf('__');
  if (dunderIdx >= 0) {
    return toolName.slice(dunderIdx + 2).toLowerCase();
  }
  const colonIdx = toolName.lastIndexOf(':');
  return (colonIdx >= 0 ? toolName.slice(colonIdx + 1) : toolName).toLowerCase();
}

function isReadOnlyMcp(toolName: string): boolean {
  const tool = mcpToolPart(toolName);
  return MCP_READONLY_PREFIXES.some((p) => tool.startsWith(p));
}

/** 判断 MCP 返回结果是否为空 */
function isEmptyResult(value: unknown): boolean {
  const v = coerce(value);
  if (v == null) return true;
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' || t === '{}' || t === '[]' || t === 'null';
  }
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return true;
    // 常见的结果容器字段：若全部为空则视为空结果
    const containers = ['content', 'results', 'result', 'data', 'items', 'rows', 'records', 'list'];
    const present = keys.filter((k) => containers.includes(k));
    if (present.length > 0 && present.length === keys.length) {
      return present.every((k) => isEmptyResult(obj[k]));
    }
    return false;
  }
  return false;
}

/** 证据全文上限：100KB（按字符近似），防止超大结果撑库 */
export const MAX_EVIDENCE_CHARS = 100 * 1024;

/** 判断是否为 MCP 事件（与 classify 内部判定一致） */
export function isMcpEvent(event: NormalizedEvent): boolean {
  return event.observationType === 'mcp' || event.toolName.includes(':') || event.toolName.startsWith('mcp__');
}

/**
 * 抽取 MCP 事件的原始证据全文（仅 MCP；其它事件返回 null）。
 * 超过 MAX_EVIDENCE_CHARS 截断并追加标记。结果为空则返回 null。
 */
export function extractMcpEvidence(event: NormalizedEvent, maxChars = MAX_EVIDENCE_CHARS): string | null {
  if (!isMcpEvent(event)) return null;
  if (isEmptyResult(event.toolOutput)) return null;
  const text = asText(event.toolOutput).trim();
  if (!text) return null;
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated]` : text;
}

/**
 * 归一化事件签名：toolName + 归一化 payload 的哈希。
 *
 * 一般事件（shell/file_edit/mcp 等）的语义负载在 toolInput，用它去重（同一命令重复执行视为重复）。
 * 但对话型事件 agent_response / agent_thought 的实际内容在 toolOutput（recordResponse 发送
 * toolInput:{}、toolOutput:{response}），若用 toolInput 计算会导致同一会话内每轮签名相同，
 * 第二轮起被误判为 duplicate 而丢弃。因此这两类事件改用 toolOutput 作为签名负载。
 */
/**
 * 归一化事件签名:toolName + 归一化 payload 的哈希。
 *
 * 原则:签名负载必须包含**真正区分两次调用是否相同**的内容。
 *
 * - shell:toolInput.command 已经能区分每条命令;为稳健起见也附带 toolOutput
 *   (exit_code/output 摘要),让"同命令不同输出"也算两条。
 * - mcp:toolInput 通常已含 server/action/args;附带 toolOutput 让"同 query 不同
 *   结果"也算两条。
 * - file_edit:toolInput 在 hooks-cli 这一层只放了 file_path(diff 在 toolOutput
 *   里),所以**只用 toolInput 会让同一文件的所有编辑签名相同**,从第二次起被
 *   dedup 丢弃为 tier=0 duplicate — master 自己也有这个 bug。修复就是把
 *   toolOutput(diff)纳入签名。
 * - agent_response / agent_thought:recordResponse 发送 toolInput:{}、
 *   toolOutput:{response/thought},内容全在 toolOutput,沿用之前的 toolOutput-only
 *   分支(纯加一个空 {} 进哈希也无害,但这里保持原行为以减小 master diff)。
 *
 * 统一用 {toolInput, toolOutput} 双字段的好处是适配上面所有四种语义,不会因为
 * 某类事件 toolInput 太瘦或太肥而被误判去重。
 */
export function computeSignature(event: NormalizedEvent): string {
  const isConversational = event.toolName === 'agent_response' || event.toolName === 'agent_thought';
  const payload = isConversational
    ? event.toolOutput
    : { i: coerce(event.toolInput), o: coerce(event.toolOutput) };
  const input = isConversational ? coerce(payload) : payload;
  let normalized: string;
  if (typeof input === 'string') {
    normalized = input.trim();
  } else {
    try {
      normalized = stableStringify(input);
    } catch {
      normalized = asText(input);
    }
  }
  const hash = createHash('sha1').update(normalized).digest('hex');
  return `${event.toolName}:${hash}`;
}

function classifyAgentResponse(content: string): Omit<ClassifyResult, 'signature'> {
  const trimmed = content.trim();
  if (trimmed === '' || trimmed === '{}' || trimmed === '[]') {
    return { tier: 0, dropReason: 'empty agent_response' };
  }
  const hasCode = trimmed.includes('```');
  if (trimmed.length < SHORT_RESPONSE_LEN && !hasCode) {
    return { tier: 1 };
  }
  return { tier: 2, model: 'high' };
}

function classifyAgentThought(content: string): Omit<ClassifyResult, 'signature'> {
  const trimmed = content.trim();
  if (trimmed === '' || trimmed === '{}' || trimmed === '[]') {
    return { tier: 0, dropReason: 'empty agent_thought' };
  }
  return { tier: 2, model: 'high' };
}

function classifyShell(event: NormalizedEvent): Omit<ClassifyResult, 'signature'> {
  const input = asObject(event.toolInput);
  const output = asObject(event.toolOutput);
  const command = asText(input.command || (input as Record<string, unknown>).cmd).trim();

  // 空命令（只有耗时、无命令文本）→ 丢弃
  if (!command) {
    return { tier: 0, dropReason: 'empty command' };
  }

  const exitRaw = output.exitCode ?? (output as Record<string, unknown>).exit_code;
  const exitCode = typeof exitRaw === 'number' ? exitRaw : Number(exitRaw);
  const failed = Number.isFinite(exitCode) && exitCode !== 0;

  if (failed) {
    // 打包/测试失败 → 中级；其余报错（debugging 价值）→ 高级
    if (isBuildPackTestCommand(command)) {
      return { tier: 2, model: 'light' };
    }
    return { tier: 2, model: 'high' };
  }

  // 成功的命令（只读检查、打包构建成功、一般机械命令）→ 模板留痕
  return { tier: 1 };
}

function classifyFileEdit(event: NormalizedEvent): Omit<ClassifyResult, 'signature'> {
  const input = asObject(event.toolInput);
  const output = asObject(event.toolOutput);
  const filePath = asText(input.filePath || (input as Record<string, unknown>).file_path).trim();
  const editType = asText(input.editType || (input as Record<string, unknown>).edit_type).trim();
  const diff = asText(output.diff).trim();

  // 无 file_path → 丢弃
  if (!filePath) {
    return { tier: 0, dropReason: 'no file_path' };
  }
  // 图片/二进制后缀、粘贴截图缓存、临时文件 → 丢弃
  if (isBinaryFile(filePath)) {
    return { tier: 0, dropReason: 'binary file' };
  }
  if (isWorkspaceStorageScreenshot(filePath)) {
    return { tier: 0, dropReason: 'workspaceStorage screenshot' };
  }
  if (isTempFile(filePath)) {
    return { tier: 0, dropReason: 'temp file' };
  }
  // diff 为空 → 丢弃
  if (!diff) {
    return { tier: 0, dropReason: 'empty diff' };
  }
  // 真实源码但 diff 极短 → 模板留痕
  if (diff.length < SHORT_DIFF_LEN) {
    return { tier: 1 };
  }
  // 写文档/markdown 带实质 diff → 高级
  if (isDocFile(filePath)) {
    return { tier: 2, model: 'high' };
  }
  // 内容多的新建文件 → 高级
  if (editType === 'create' && diff.length >= LARGE_NEW_FILE_LEN) {
    return { tier: 2, model: 'high' };
  }
  // 普通源码编辑带 diff → 中级
  return { tier: 2, model: 'light' };
}

function classifyMcp(event: NormalizedEvent): Omit<ClassifyResult, 'signature'> {
  const readOnly = isReadOnlyMcp(event.toolName);
  if (isEmptyResult(event.toolOutput)) {
    return { tier: 0, dropReason: 'empty mcp result' };
  }
  if (readOnly) {
    // 只读查询有结果 → 模板留痕
    return { tier: 1 };
  }
  // MCP 业务结果 → 中级
  return { tier: 2, model: 'light' };
}

/**
 * 对一个事件分档。
 * @param event 归一化事件
 * @param recentSignatures 本会话已入库记录的签名集合（用于去重）
 */
export function classify(event: NormalizedEvent, recentSignatures: string[]): ClassifyResult {
  const signature = computeSignature(event);

  // 会话内完全重复 → 丢弃
  if (recentSignatures.includes(signature)) {
    return { tier: 0, dropReason: 'duplicate', signature };
  }

  const toolName = event.toolName;
  const type = event.observationType;

  let base: Omit<ClassifyResult, 'signature'>;

  if (toolName === 'agent_response') {
    const content = extractAgentContent(event.toolOutput, 'response');
    base = classifyAgentResponse(content);
  } else if (toolName === 'agent_thought') {
    const content = extractAgentContent(event.toolOutput, 'thought');
    base = classifyAgentThought(content);
  } else if (type === 'shell' || toolName === 'shell') {
    base = classifyShell(event);
  } else if (
    type === 'file_edit' || type === 'search_replace' ||
    toolName === 'file_edit' || toolName === 'search_replace'
  ) {
    base = classifyFileEdit(event);
  } else if (isMcpEvent(event)) {
    base = classifyMcp(event);
  } else {
    // 无法判断 → 保守 fail-open 到 Tier 2 高级
    base = { tier: 2, model: 'high' };
  }

  return { ...base, signature };
}

/** 从 toolOutput 中抽取 agent 回复/思考的正文（兼容字符串或对象） */
function extractAgentContent(toolOutput: unknown, key: 'response' | 'thought'): string {
  if (typeof toolOutput === 'string') return toolOutput;
  const obj = asObject(toolOutput);
  const direct = obj[key];
  if (typeof direct === 'string') return direct;
  // 空对象返回空串以触发 Tier 0
  return Object.keys(obj).length === 0 ? '' : asText(toolOutput);
}
