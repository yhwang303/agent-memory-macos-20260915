/**
 * Attachments metadata recorder.
 * Captures user-uploaded file metadata (type/name/size) as an observation,
 * WITHOUT binary content. Enables summaries to reference user attachments.
 *
 * TODO: the observation `type` is currently 'agent_response' because that's the
 * only bucket that survives the summary pipeline today; consider adding
 * 'user_input' / 'user_attachment' types in a later milestone.
 */

// Minimal local shape — avoids coupling to hooks-cli.ts internal interfaces.
interface BeforeSubmitPromptInput {
  session_id?: string;
  conversation_id?: string;
  attachments?: any[];
}

export interface AttachmentsContext {
  client: {
    addObservation: (o: any) => Promise<any>;
  };
  projectPath: string;
  sourceIDE?: string;        // 来源 IDE（原始 adapter id），透传落库
  now?: () => number;        // for deterministic tests; defaults to Date.now
  maxAttachments?: number;   // cap to prevent runaway payloads; defaults to 64
}

const DEFAULT_MAX = 64;

function isRuleAttachment(attachment: any): boolean {
  const type = String(attachment?.type || attachment?.kind || '').toLowerCase();
  return type === 'rule' || type === 'rules';
}

function attachmentName(attachment: any): string {
  const explicit = attachment?.name || attachment?.filename;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();

  const filePath = attachment?.file_path || attachment?.filePath || attachment?.path;
  if (typeof filePath === 'string' && filePath.trim()) {
    const normalized = filePath.replace(/\\/g, '/');
    return normalized.split('/').filter(Boolean).pop() || 'unnamed';
  }

  return 'unnamed';
}

export async function recordAttachmentsMetadata(
  input: BeforeSubmitPromptInput,
  ctx: AttachmentsContext
): Promise<void> {
  const sessionId = input.session_id || input.conversation_id || '';
  if (!sessionId) return;
  if (!input.attachments || input.attachments.length === 0) return;

  const cap = ctx.maxAttachments ?? DEFAULT_MAX;
  const raw = input.attachments.filter((attachment) => !isRuleAttachment(attachment));
  if (raw.length === 0) return;

  const truncated = raw.length > cap;
  const slice = truncated ? raw.slice(0, cap) : raw;

  const attachments = slice.map((a: any) => ({
    type: a.type || a.mime_type || 'unknown',
    name: attachmentName(a),
    size: typeof a.size === 'number' ? a.size : undefined,
  }));

  await ctx.client.addObservation({
    sessionId,
    projectPath: ctx.projectPath,
    timestamp: (ctx.now ?? Date.now)(),
    type: 'agent_response',
    toolName: 'user_attachments',
    sourceIDE: ctx.sourceIDE,
    toolInput: { attachments },
    toolOutput: {
      count: raw.length,
      recorded: slice.length,
      truncated,
    },
  });
}
