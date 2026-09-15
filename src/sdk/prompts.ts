/**
 * SDK Prompts Module
 * Generates prompts for the AgentMemory worker
 * 
 * Adapted from claude-mem for CodeBuddy Agent hooks
 */

import { logger } from '../utils/logger.js';
import { USER_IMAGE_MARKER } from '../hooks/transcript-observation-common.js';
import { IMAGE_MARKER_RE } from '../shared/transcript-parser.js';

export interface Observation {
  id: number;
  tool_name: string;
  tool_input: string;
  tool_output: string;
  created_at_epoch: number;
  cwd?: string;
  hook_type?: string;
}

export interface SDKSession {
  id: number;
  memory_session_id: string | null;
  project: string;
  user_prompt: string;
  last_assistant_message?: string;
  observations?: Array<{
    id: number;
    type: string;
    title: string;
    subtitle?: string;
    narrative?: string;
    facts?: string;
    files_read?: string;
    files_modified?: string;
  }>;
}

export const OBSERVATION_TYPES = [
  'discovery', 'bugfix', 'feature', 'refactor', 
  'documentation', 'configuration', 'debugging', 
  'investigation', 'learning'
] as const;

export type ObservationType = typeof OBSERVATION_TYPES[number];

/**
 * 蒸馏质量规则（中级与高级模型共用同一模板，不做详尽度区分）。
 * 根除套话、收紧 narrative/facts，使记录信息密度高、便于召回。
 */
export const OBSERVATION_QUALITY_RULES = `## 记录质量要求

### narrative（叙述）
- 只写：改了什么 / 发现了什么 / 决定了什么，以及具体结果。
- **禁止套话**，包括但不限于：
  - "本次操作属于典型……"
  - "具有参考价值"
  - "对后续……很重要"
  - "记录此类操作有助于……"
  - 任何对事件类型/价值的空泛评价。

### facts（事实）
- 只含**内容/结论性事实**（具体的发现、结论、数值、变更点）。
- **禁止**：执行耗时、钩子类型、连接参数、"参数为空"、"这是一次 XX 事件"之类的事件复述与噪音。`;

export function buildInitPrompt(project: string, sessionId: string, userPrompt: string): string {
  return `You are a memory recorder for CodeBuddy Agent. Your sole purpose is to observe and record what happens during coding sessions.

<observed_from_primary_session>
  <user_request>${userPrompt}</user_request>
  <requested_at>${new Date().toISOString().split('T')[0]}</requested_at>
</observed_from_primary_session>

## Your Role
You are an OBSERVER, not a participant. You watch what the primary CodeBuddy Agent does and record meaningful observations.
You have NO tools - you cannot read files, write code, or interact with the codebase.

## Spatial Awareness
- Project: ${project}
- Session: ${sessionId}

## Recording Rules

### CRITICAL: NEVER Record Sensitive Information
**YOU MUST NEVER record the following sensitive information:**
- API Keys, Access Tokens, Secret Keys
- Passwords, Credentials, Authentication tokens
- Private keys, Certificates, SSH keys
- Database connection strings with credentials
- Environment variables containing secrets
- Any personally identifiable information (PII) if not necessary

If you encounter sensitive information, replace it with "[REDACTED]" or describe it generically (e.g., "configured API key" instead of the actual key value).

### CRITICAL: Include Meta-Intent (元意图)
**YOU MUST ALWAYS capture the user's deep intent behind their actions.**

- **Don't just record**: "User changed timeout to 500ms"
- **Instead record**: "【Performance Optimization Intent】To address user-reported UI lag, user tried shortening timeout, observed faster response but higher retry rate"

The meta_intent field should include:
1. **Intent Type**: 【Performance Optimization】、【Debugging】、【Feature Development】、【Investigation】、【Refactoring】etc.
2. **Background/Context**: Why was this action taken? What problem was being solved?
3. **Expected Outcome/Effect**: What result was expected? What was actually observed?

### MUST RECORD (always create observation):
1. **PRD/Requirements discussions** - Any discussion about product requirements, feature specs, or design documents
2. **TodoList/Task planning** - Discussions about task planning, todo items, or work organization
3. **Feature implementation** - Code changes that implement new features or functionality
4. **Bug fixes** - Any code changes that fix bugs or resolve issues
5. **Configuration changes** - Changes to config files, environment settings, or project setup
6. **Architecture decisions** - Discussions or changes about system design or code structure
7. **API discoveries** - Learning about APIs, endpoints, or service interfaces
8. **File modifications** - Any file that was created, edited, or deleted with meaningful changes

### MAY SKIP (only skip if truly trivial):
1. **Simple directory listing** - Only if no useful information was discovered
2. **Repeated file reads** - Reading the same file multiple times with no new insights
3. **Failed commands** - Only if the failure provides no useful debugging information
4. **Package installation** - Routine npm install, pip install, etc. (unless it reveals dependency issues)

### Key Principle
When in doubt, RECORD IT. It's better to have too much information than to miss something important.

## Language Requirement
**ALL observation content (title, subtitle, facts, narrative, meta_intent) MUST be written in Chinese (简体中文).**

## Output Format
\`\`\`xml
<observation>
  <type>[ ${OBSERVATION_TYPES.join(' | ')} ]</type>
  <title>简短描述性标题（最多80字）</title>
  <subtitle>额外背景说明或涉及的模块/区域</subtitle>
  <meta_intent>【意图类型】：用户做这件事的深层意图、背景和期望效果（例如：【性能优化意图】、【调试意图】、【功能开发意图】等）</meta_intent>
  <facts>
    <fact>具体的、可验证的事实</fact>
  </facts>
  <narrative>发生了什么以及为什么重要</narrative>
  <concepts>
    <concept>relevant-tag</concept>
  </concepts>
  <files_read>
    <file>path/to/file</file>
  </files_read>
  <files_modified>
    <file>path/to/file</file>
  </files_modified>
</observation>
\`\`\`

If this is truly not worth recording (see MAY SKIP rules above), output:
<skip reason="brief explanation"/>

---
MEMORY SESSION START - Project: ${project}`;
}

export function buildObservationPrompt(obs: Observation): string {
  let toolInput: any;
  let toolOutput: any;

  try {
    toolInput = typeof obs.tool_input === 'string' ? JSON.parse(obs.tool_input) : obs.tool_input;
  } catch {
    logger.debug('SDK', 'Tool input is plain string', { toolName: obs.tool_name });
    toolInput = obs.tool_input;
  }

  try {
    toolOutput = typeof obs.tool_output === 'string' ? JSON.parse(obs.tool_output) : obs.tool_output;
  } catch {
    logger.debug('SDK', 'Tool output is plain string', { toolName: obs.tool_name });
    toolOutput = obs.tool_output;
  }

  const hookContext = obs.hook_type ? `\n  <hook_type>${obs.hook_type}</hook_type>` : '';

  return `You are a memory recorder for CodeBuddy Agent. Analyze the following tool usage and extract meaningful observations.

<observed_from_primary_session>
  <what_happened>${obs.tool_name}</what_happened>
  <occurred_at>${new Date(obs.created_at_epoch).toISOString()}</occurred_at>${hookContext}${obs.cwd ? `\n  <working_directory>${obs.cwd}</working_directory>` : ''}
  <parameters>${JSON.stringify(toolInput, null, 2)}</parameters>
  <outcome>${JSON.stringify(toolOutput, null, 2)}</outcome>
</observed_from_primary_session>

## CRITICAL: NEVER Record Sensitive Information
**Before recording, ALWAYS check for and redact:**
- API Keys, Tokens, Passwords, Credentials
- Private keys, Certificates, Connection strings
- Any secrets or sensitive configuration values

Replace sensitive values with "[REDACTED]" or describe generically.

${OBSERVATION_QUALITY_RULES}

## Language Requirement
**ALL content (title, subtitle, facts, narrative, meta_intent) MUST be written in Chinese (简体中文). No English text in observation fields.**

## Output Format
\`\`\`xml
<observation>
  <type>[ ${OBSERVATION_TYPES.join(' | ')} ]</type>
  <title>简短描述性标题（最多80字）</title>
  <subtitle>额外背景说明或涉及的模块/区域</subtitle>
  <meta_intent>【意图类型】：用户做这件事的深层意图、背景和期望效果</meta_intent>
  <facts>
    <fact>仅内容/结论性事实</fact>
  </facts>
  <narrative>改了/发现了/决定了什么，以及具体结果</narrative>
  <concepts>
    <concept>relevant-tag</concept>
  </concepts>
  <files_read>
    <file>path/to/file</file>
  </files_read>
  <files_modified>
    <file>path/to/file</file>
  </files_modified>
</observation>
\`\`\`

Analyze and respond:`;
}

/**
 * Check if a string appears to be garbled/corrupted (contains consecutive question marks)
 */
function isGarbledText(text: string): boolean {
  if (!text) return false;
  // Check for patterns like "????" or text that is mostly question marks
  const questionMarkCount = (text.match(/\?/g) || []).length;
  return questionMarkCount >= 3 && questionMarkCount / text.length > 0.3;
}

export function buildSummaryPrompt(session: SDKSession): string {
  const userPrompt = session.user_prompt || '';
  const lastAssistantMessage = session.last_assistant_message || '';
  const observations = session.observations || [];

  const regularObservations = observations;

  // Check if user prompt is garbled (encoding issue on Windows)
  const isUserPromptGarbled = isGarbledText(userPrompt);

  // Build observations summary for context (keep it concise)
  const observationsSummary = regularObservations.length > 0
    ? regularObservations.map((o, idx) => {
        const title = o.title?.substring(0, 80) || 'Untitled';
        const narrative = o.narrative?.substring(0, 100) || '';
        return `${idx + 1}. [${o.type}] ${title}${narrative ? ` - ${narrative}${o.narrative && o.narrative.length > 100 ? '...' : ''}` : ''}`;
      }).join('\n')
    : 'No observations recorded.';

  // Different prompt based on whether user prompt is readable
  const userRequestSection = isUserPromptGarbled
    ? `<user_original_request>
[编码问题：用户原始请求无法读取，显示为乱码]
请根据下方的 Session Observations 推断用户的核心问题/请求是什么。
</user_original_request>`
    : `<user_original_request>
${userPrompt || '[未记录用户请求]'}
</user_original_request>`;

  // hasMediaContent triggers the <media_context> slot.
  // Authoritative signal: the [USER_POSTED_IMAGE] marker that hook recording
  // prepends to last_assistant_message when the user's turn contained an
  // image (Cursor strips [Image] tags from the plain-text user_prompt, so
  // this marker is how we rescue that signal). Fallback signals (vocab/text
  // markers) cover legacy data without the marker.
  const IMAGE_VOCAB_RE = /图片|截图|设计稿|架构图|\bscreenshot\b|\bimage\b|\bdiagram\b/i;

  const userPostedImage = lastAssistantMessage.startsWith(USER_IMAGE_MARKER);
  const displayedAssistantMessage = userPostedImage
    ? lastAssistantMessage.slice(USER_IMAGE_MARKER.length).trimStart()
    : lastAssistantMessage;

  const hasMediaContent =
    userPostedImage ||
    (displayedAssistantMessage.length > 0 &&
      (IMAGE_VOCAB_RE.test(displayedAssistantMessage) ||
        IMAGE_MARKER_RE.test(displayedAssistantMessage))) ||
    IMAGE_MARKER_RE.test(userPrompt);

  // When the user posted an image, this block is transcript-sourced: it is
  // the assistant's reply to that turn. media_context must summarize THIS
  // text only (compress, not invent) — not a separate "vision" task.
  const lastResponseHeading = userPostedImage
    ? `## Agent's Last Response (transcript: reply to the user turn that included an image; **sole source** for <media_context> when user posted an image)
`
    : `## Agent's Last Response (semantic context):
`;
  const lastAssistantSection = displayedAssistantMessage
    ? `\n${lastResponseHeading}${displayedAssistantMessage.substring(0, 3000)}\n`
    : '';

  return `You are a memory summarizer. Generate a CONCISE summary of this coding session.

## User's Request
${userRequestSection}

## Session Observations (${regularObservations.length} total):
${observationsSummary}
${lastAssistantSection}
## CRITICAL RULES - READ CAREFULLY:

0. **NEVER INCLUDE SENSITIVE INFO**: Do NOT include API keys, tokens, passwords, credentials, or any secrets in the summary. Use "[REDACTED]" or generic descriptions.
1. **BE CONCISE**: Each field should be 1-3 sentences MAX. No technical detail dumps.
2. **FOCUS ON USER INTENT**: What did the user ACTUALLY want to accomplish? Not what files were touched.
3. **<request> field**: 
   ${isUserPromptGarbled 
     ? '- Since user prompt is garbled, INFER the user\'s question from observations. Write what the user likely asked.'
     : '- Extract the user\'s actual question/request. Do NOT write "SESSION CHECKPOINT" or copy this prompt.'}
4. **All content MUST be in Chinese (简体中文)**.
5. **DO NOT list file paths** - summarize what was done, not where.
${hasMediaContent
    ? `6. **MEDIA CONTEXT** — single rule, no exceptions list:
  ${userPostedImage
        ? [
            '- **Sole source**: the section "Agent\'s Last Response" above = transcript of assistant reply after the user sent an image.',
            '- **Task**: 1–2 句简体中文，**只压缩**该段中关于截图/图片的内容：assistant 的排查与结论就是「图片在说什么」。',
            '- **Do not**: 编造；写「无法确认」「记录未含画面」等；若该段为空再留空。',
          ].join('\n    ')
        : 'Briefly describe in 中文 what image/screenshot content is discussed (1–2 sentences) when signals come from user prompt/last response only. If this turn had no user image, leave <media_context> empty.'}`
    : ''
}

## Output Format:
<summary>
  <request>用户想要做什么？（一句话概括）</request>
  <investigated>探索了什么？（简洁列出，不要罗列文件路径）</investigated>
  <learned>关键发现（1-2个要点）</learned>${hasMediaContent ? `
  <media_context>会话中图片/截图/设计稿的具体内容描述（必须包含图片实际展示的内容，不能只说"有一张图片"）</media_context>` : ''}
  <meta_intent>用户的深层目的是什么？</meta_intent>
  <completed>完成了什么？（简洁列出）</completed>
  <next_steps>后续建议（1-2条）</next_steps>
  <notes>其他备注（可选，通常留空）</notes>
</summary>

REMEMBER: Quality over quantity. A good summary is SHORT and FOCUSED on user intent.`;
}

export function buildContinuationPrompt(userPrompt: string, promptNumber: number, contentSessionId: string): string {
  return `MEMORY SESSION CONTINUED (Turn ${promptNumber})

<observed_from_primary_session>
  <user_request>${userPrompt}</user_request>
  <requested_at>${new Date().toISOString().split('T')[0]}</requested_at>
</observed_from_primary_session>

Continue observing. Remember: MUST RECORD PRD discussions, TodoList planning, feature implementation, bug fixes, config changes, architecture decisions, and file modifications. Only skip truly trivial operations.

Output observations in XML format. If truly trivial, output <skip reason="..."/>.

Session: ${contentSessionId}`;
}

export function buildThoughtPrompt(thought: string, sessionId: string): string {
  return `<agent_thought session="${sessionId}">
  <thought_content>${thought}</thought_content>
  <recorded_at>${new Date().toISOString()}</recorded_at>
</agent_thought>

Record an observation if this thought contains:
- PRD/requirements discussion or decisions
- Task planning or todo items
- Feature design or implementation ideas
- Bug analysis or debugging insights
- Architecture or design decisions

${OBSERVATION_QUALITY_RULES}

**ALL observation content (title, subtitle, facts, narrative, meta_intent) MUST be written in Chinese (简体中文).**`;
}

export function buildResponsePrompt(response: string, sessionId: string): string {
  return `<agent_response session="${sessionId}">
  <response_content>${response}</response_content>
  <recorded_at>${new Date().toISOString()}</recorded_at>
</agent_response>

## CRITICAL: NEVER Record Sensitive Information
**ALWAYS redact:** API keys, tokens, passwords, credentials, private keys, secrets. Use "[REDACTED]".

${OBSERVATION_QUALITY_RULES}

## Image / Visual Content Rule
If the response describes, analyzes, or interprets an image, screenshot, diagram, or any visual content, the **narrative** field MUST include a concise visual description (what the image shows). Do NOT reduce it to only "修复了某问题" — preserve the visual details. Example: "截图展示了深色聊天界面中的修复说明，上半部分是根因分析，下半部分用编号列表概述了三处代码改动".

## Language Requirement
**ALL content (title, subtitle, facts, narrative, meta_intent) MUST be written in Chinese (简体中文). No English text in observation fields.**

Output an observation:
\`\`\`xml
<observation>
  <type>[ ${OBSERVATION_TYPES.join(' | ')} ]</type>
  <title>简短标题，描述完成或说明的内容</title>
  <subtitle>背景说明或涉及区域</subtitle>
  <meta_intent>【意图类型】：用户做这件事的深层意图、背景和期望效果</meta_intent>
  <facts>
    <fact>仅内容/结论性事实</fact>
  </facts>
  <narrative>改了/发现了/决定了什么，以及具体结果（若涉及图片/截图描述，必须保留视觉内容摘要）</narrative>
  <concepts>
    <concept>relevant-tag</concept>
  </concepts>
  <files_modified>
    <file>path/to/file (if any files were mentioned)</file>
  </files_modified>
</observation>
\`\`\``;
}

/** Input shape for the import-history summary prompt (per-session granularity). */
export interface ImportSessionPromptInput {
  adapterId: string;
  /** Project / cwd label (best-effort, may be null). */
  project: string | null;
  /** ISO timestamp of when the first turn started. */
  firstTurnAt: string;
  /** ISO timestamp of when the last turn ended. */
  lastTurnAt: string;
  /** Source transcript file basename (just for the AI's context). */
  fileBasename: string;
  /** Stable IDE-native session id propagated into the prompt for provenance. */
  sessionId: string;
  /**
   * Ordered turns in this session, already truncated by the caller. Each turn
   * is one user→assistant exchange. The orchestrator should cap the total
   * across turns to keep the prompt under the model's context budget — see
   * MAX_SESSION_PROMPT_CHARS below.
   */
  turns: Array<{
    turnIndex: number;
    userText: string;
    assistantText: string;
    toolUses: Array<{ name: string; inputSummary: string }>;
  }>;
}

/**
 * Soft cap on the combined characters injected into the prompt. Beyond this
 * the orchestrator drops the middle of the transcript (keep first N + last M
 * turns) so the AI still sees opening intent + final outcome.
 */
export const MAX_SESSION_PROMPT_CHARS = 12_000;

/**
 * Build the per-session import summary prompt.
 *
 * Unlike `buildSummaryPrompt`, this variant does NOT depend on the
 * `observations` table — it consumes the raw transcript directly and treats
 * the entire session (potentially many turns) as one summary unit. This
 * matches AgentMemory's online Stop-hook semantics (1 session = 1 summary), so
 * imported rows are colour-compatible with hook-captured rows in search.
 *
 * Provenance is encoded into <notes> as `imported_from=<adapter>; session=<id>; file=<basename>`
 * so even if `source_ide` is later cleared the lineage survives.
 */
export function buildImportSummaryPrompt(input: ImportSessionPromptInput): string {
  const projectLabel = input.project ?? '(unknown)';

  const turnBlocks = input.turns.map((t) => {
    const toolUsesBlock = t.toolUses.length > 0
      ? t.toolUses.map((tu) => `      - Tool ${tu.name || '(unnamed)'}: ${tu.inputSummary || '(no input)'}`).join('\n')
      : '      (no tool calls)';
    return `  <turn index="${t.turnIndex}">
    <user_request>
${t.userText}
    </user_request>
    <agent_response>
${t.assistantText}
    </agent_response>
    <tool_uses>
${toolUsesBlock}
    </tool_uses>
  </turn>`;
  }).join('\n');

  return `You are a memory summarizer for retroactive import.
The data below is ONE historical IDE session (multi-turn user↔assistant
conversation) that existed BEFORE AgentMemory started capturing it via hooks.
Produce a AgentMemory-schema summary that aggregates the entire session — same
shape as what the online Stop hook produces (1 session = 1 summary).

<session ide="${input.adapterId}" project="${projectLabel}" first_turn_at="${input.firstTurnAt}" last_turn_at="${input.lastTurnAt}" session_id="${input.sessionId}" turn_count="${input.turns.length}">
${turnBlocks}
</session>

## CRITICAL RULES — READ CAREFULLY

0. **NEVER include sensitive info**: API keys, tokens, passwords, credentials,
   private keys. Replace with [REDACTED] or describe generically.
1. **BE CONCISE**: each field 1–3 sentences MAX. No file path dumps. No
   technical detail dumps. Aggregate the whole session into a single coherent
   summary — do NOT list every turn.
2. **FOCUS ON USER INTENT (across the whole session)**: what did the user
   actually want to accomplish in this conversation? Not what files were
   touched.
3. **All field content MUST be in 简体中文**.
4. If a field genuinely has nothing to say, leave the tag empty — do NOT
   invent content.
5. **media_context**: only fill it when the conversation explicitly mentions
   images / screenshots / 设计稿 / 架构图. Otherwise leave it empty.
6. **notes**: must START with the literal string
   "imported_from=${input.adapterId}; session=${input.sessionId}; file=${input.fileBasename}"
   followed by any additional remarks (or nothing). The orchestrator depends
   on this prefix for provenance tracking.

## Output Format (exactly)

<summary>
  <request>用户在这次会话里想做什么？（一句话概括整段意图）</request>
  <investigated>会话里探索/讨论了什么？（简洁列出，不要罗列文件路径）</investigated>
  <learned>关键发现（1-3 个要点，整段会话级别）</learned>
  <media_context></media_context>
  <meta_intent>用户的深层目的是什么？</meta_intent>
  <completed>这次会话完成了什么？（简洁列出整段成果）</completed>
  <next_steps>后续建议（1-2 条，可空）</next_steps>
  <notes>imported_from=${input.adapterId}; session=${input.sessionId}; file=${input.fileBasename}</notes>
</summary>

REMEMBER: quality over quantity. A good imported summary is SHORT and FOCUSED
on the session's overall user intent — it will be searched months later.`;
}

/**
 * Input shape for the per-TURN import summary prompt.
 *
 * Per-turn matches AgentMemory's online Stop-hook granularity (one summary per
 * user→assistant exchange). A user with 30 prompts in a chat produces 30
 * imported summaries — same as if hook had been running at the time.
 *
 * This is the v1.1 default. The session-level variant above (kept for
 * reference / future opt-in) collapses many turns into one row, which is
 * cheaper but loses the per-prompt search granularity that AgentMemory's hook
 * users expect.
 */
export interface ImportTurnPromptInput {
  adapterId: string;
  /** Project / cwd label (best-effort, may be null). */
  project: string | null;
  /** ISO timestamp of when this turn started. */
  startedAt: string;
  /** Source transcript file basename (just for the AI's context). */
  fileBasename: string;
  /** Stable IDE-native session id propagated into the prompt for provenance. */
  sessionId: string;
  /** Zero-based turn index within the session. */
  turnIndex: number;
  /** This turn only. */
  userText: string;
  assistantText: string;
  toolUses: Array<{ name: string; inputSummary: string }>;
}

/** Soft cap on the combined characters injected into the per-turn prompt. */
export const MAX_TURN_PROMPT_CHARS = 8_000;

/**
 * Build the per-turn import summary prompt — one user→assistant exchange.
 *
 * Output schema is identical to the per-session variant (and to what
 * `buildSummaryPrompt` produces for hook-captured rows), so all imported
 * rows are colour-compatible in AgentMemory search.
 */
export function buildImportTurnSummaryPrompt(input: ImportTurnPromptInput): string {
  const projectLabel = input.project ?? '(unknown)';
  const toolUsesBlock = input.toolUses.length > 0
    ? input.toolUses
        .map((tu) => `  - Tool ${tu.name || '(unnamed)'}: ${tu.inputSummary || '(no input)'}`)
        .join('\n')
    : '  (no tool calls)';

  return `You are a memory summarizer for retroactive import.
The data below is ONE historical user↔agent turn from an IDE transcript
that happened BEFORE AgentMemory started capturing it via hooks. Produce a
AgentMemory-schema summary for this single exchange — same shape and granularity
as what the online Stop hook produces (1 user prompt → 1 summary).

<turn ide="${input.adapterId}" project="${projectLabel}" started_at="${input.startedAt}" session_id="${input.sessionId}" turn_index="${input.turnIndex}">
  <user_request>
${input.userText}
  </user_request>
  <agent_response>
${input.assistantText}
  </agent_response>
  <tool_uses>
${toolUsesBlock}
  </tool_uses>
</turn>

## CRITICAL RULES — READ CAREFULLY

0. **NEVER include sensitive info**: API keys, tokens, passwords, credentials,
   private keys. Replace with [REDACTED] or describe generically.
1. **BE CONCISE**: each field 1–3 sentences MAX. No file path dumps. No
   technical detail dumps. This is ONE exchange, summarize what happened
   in that exchange — not the whole conversation.
2. **FOCUS ON USER INTENT (this turn)**: what did the user actually ask
   for in THIS prompt? Not the prior context.
3. **All field content MUST be in 简体中文**.
4. If a field genuinely has nothing to say, leave the tag empty — do NOT
   invent content.
5. **media_context**: only fill it when this turn explicitly mentions
   images / screenshots / 设计稿 / 架构图. Otherwise leave it empty.
6. **notes**: must START with the literal string
   "imported_from=${input.adapterId}; session=${input.sessionId}; turn=${input.turnIndex}; file=${input.fileBasename}"
   followed by any additional remarks (or nothing). The orchestrator depends
   on this prefix for provenance tracking.

## Output Format (exactly)

<summary>
  <request>用户在这一轮里想做什么？（一句话）</request>
  <investigated>这一轮里探索/讨论了什么？（简洁，不罗列文件）</investigated>
  <learned>关键发现（1-2 个要点）</learned>
  <media_context></media_context>
  <meta_intent>用户提这个问题的深层目的</meta_intent>
  <completed>这一轮完成了什么？</completed>
  <next_steps>后续建议（可空）</next_steps>
  <notes>imported_from=${input.adapterId}; session=${input.sessionId}; turn=${input.turnIndex}; file=${input.fileBasename}</notes>
</summary>

REMEMBER: quality over quantity. SHORT, FOCUSED on this single exchange.`;
}

