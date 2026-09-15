/**
 * SDK Agent for AgentMemory System
 * Handles AI-powered observation processing and summary generation
 *
 * Supports two AI providers:
 *   - 'api' (default): OpenAI-compatible HTTP API (e.g. TIMIAI, OpenAI, Anthropic)
 *   - 'claude-code': Local claude CLI (no API key needed, requires claude CLI installed)
 *
 * Switch provider via: CODEBUDDY_MEM_PROVIDER=claude-code
 */

import { spawn, execSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { insertObservation, getObservationsBySession, hasRecentSignature, getSessionSourceIde, getLatestObservationEpochForSession } from '../sqlite/observations.js';
import { insertSummary, getLatestSummaryEpochForSession } from '../sqlite/summaries.js';
import { getSessionByMemoryId } from '../sqlite/sessions.js';
import { normalizeTimestamp } from '../../types/database.js';
import { buildObservationPrompt, buildSummaryPrompt, buildResponsePrompt, buildThoughtPrompt, type Observation } from '../../sdk/prompts.js';
import { parseObservations, parseSummary } from '../../sdk/parser.js';
import { classify, extractMcpEvidence, type NormalizedEvent } from '../../sdk/observationClassifier.js';
import { formatTrace } from '../../sdk/traceFormatter.js';
import { logger } from '../../utils/logger.js';

/**
 * 解析 summary 的来源 IDE：取「最后一条非空 observation 的 source_ide」→ session 行兜底 → null。
 * 同一会话同一 IDE，取末条最贴近本次问答实际收尾所在的 IDE。纯函数，便于单测。
 */
export function resolveSourceIdeForSummary(
  observations: Array<{ source_ide?: string | null }>,
  session?: { source_ide?: string | null } | null,
  hint?: string | null
): string | null {
  // hook 透传的当前 IDE 最权威，且不受 observation 异步入库时序影响。
  if (typeof hint === 'string' && hint.trim()) return hint.trim();
  for (let i = observations.length - 1; i >= 0; i--) {
    const v = observations[i]?.source_ide;
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  if (typeof session?.source_ide === 'string' && session.source_ide.trim()) {
    return session.source_ide.trim();
  }
  return null;
}

export interface ObservationInput {
  memorySessionId: string;
  project: string;
  toolName: string;
  toolInput: unknown;
  toolOutput: unknown;
  observationType?: string;
  // 来源 IDE（原始 adapter id），随 observation 一并落库；未知时为 undefined
  sourceIde?: string;
}

export interface SummaryInput {
  memorySessionId: string;
  project: string;
  request?: string;
}

/**
 * Resolved endpoint/key/model triple for a single API call. The advanced
 * (high) and mid-tier (light) channels each produce one of these so a request
 * can target a different provider/endpoint/key.
 */
interface CallTarget {
  model: string;
  endpoint: string;
  apiKey: string | undefined;
}

export class SDKAgent {
  private provider: 'api' | 'claude-code';
  private claudeCodePath: string;
  private apiKey: string | undefined;
  private apiEndpoint: string;
  private model: string;
  // Tier 2 中级（便宜）模型；用于普通蒸馏，留空回退到 model
  private modelLight: string;
  // Mid-tier (light) channel endpoint/key. Empty env falls back to the high
  // channel, i.e. "mid-tier follows advanced".
  private apiEndpointLight: string;
  private apiKeyLight: string | undefined;
  private requestTimeout: number;
  private maxRetries: number;
  // 进行中的 observation 占位集合,key = `${memorySessionId}:${signature}`。
  // 在 hasRecentSignature 通过后立刻 add,finally 中 delete。
  // 防止"两个相同 sig 的事件同时进 LLM 阶段、各自完成后双插"的竞态。
  // DB 层的读后写检查只能拦截 sequential dup,这里拦截 concurrent dup。
  private inflightSignatures = new Set<string>();
  // 进行中的 summary 生成占位,key = memorySessionId。
  // Stop hook 在某些 IDE 下会重复触发(claude-internal 一会话曾经写出 16 条),
  // 这里把同一 sid 的 generateSummary 串行化。
  private inflightSummaries = new Set<string>();
  private aiCallQueue: Promise<void> = Promise.resolve();
  private lastAiCallAt = 0;

  constructor() {
    // AI provider: 'api' (default HTTP endpoint) or 'claude-code' (local claude CLI)
    const rawProvider = process.env.CODEBUDDY_MEM_PROVIDER || 'api';
    this.provider = rawProvider === 'claude-code' ? 'claude-code' : 'api';
    // Path to the claude CLI binary (defaults to 'claude' on PATH)
    const rawClaudeCodePath = process.env.CODEBUDDY_MEM_CLAUDE_CODE_PATH || 'claude';
    this.claudeCodePath = this.resolveBareCommand(rawClaudeCodePath);

    this.apiEndpoint = process.env.CODEBUDDY_MEM_API_ENDPOINT || 'http://api.timiai.woa.com/ai_api_manage/llmproxy/chat/completions';
    // Credentials must come from user configuration, never a built-in key.
    this.apiKey = process.env.TIMIAI_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || undefined;
    this.model = process.env.CODEBUDDY_MEM_MODEL || 'gpt-5.4';
    this.modelLight = process.env.CODEBUDDY_MEM_MODEL_LIGHT || this.model;
    // Mid-tier channel: dedicated endpoint/key, falling back to the high channel.
    this.apiEndpointLight = process.env.CODEBUDDY_MEM_LIGHT_ENDPOINT || this.apiEndpoint;
    this.apiKeyLight = process.env.CODEBUDDY_MEM_LIGHT_API_KEY ?? this.apiKey;
    // Request timeout in milliseconds (default 60 seconds - increased for summary generation)
    this.requestTimeout = parseInt(process.env.CODEBUDDY_MEM_TIMEOUT || '60000', 10);
    // Max retries for failed requests (default 3)
    this.maxRetries = parseInt(process.env.CODEBUDDY_MEM_MAX_RETRIES || '3', 10);

    logger.info('SDK', 'SDKAgent initialized', {
      provider: this.provider,
      ...(this.provider === 'claude-code'
        ? { claudeCodePath: this.claudeCodePath }
        : { endpoint: this.apiEndpoint, model: this.model })
    });
  }

  private isClaudeInternalCli(): boolean {
    const binaryName = path.basename(this.claudeCodePath).toLowerCase();
    return binaryName.includes('claude-internal');
  }

  private resolveBareCommand(inputPath: string): string {
    // 已包含路径分隔符或扩展名 → 视为显式路径，不做解析
    if (inputPath.includes(path.sep) || inputPath.includes('/') || path.extname(inputPath)) {
      return inputPath;
    }

    // 裸名称：尝试 which/where 查找
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      const result = execSync(`${cmd} ${inputPath}`, { encoding: 'utf8', timeout: 5000 });
      const resolved = result.trim().split('\n')[0].trim();
      if (resolved) {
        logger.info('SDK', `Resolved bare command "${inputPath}" to "${resolved}"`);
        return resolved;
      }
    } catch {
      logger.warn('SDK', `Could not resolve bare command "${inputPath}", using as-is`);
    }

    return inputPath;
  }

  private buildClaudeCommand(args: string[]): { command: string; commandArgs: string[] } {
    const normalizedPath = this.claudeCodePath.toLowerCase();

    if (process.platform === 'win32') {
      if (normalizedPath.endsWith('.cmd') || normalizedPath.endsWith('.bat')) {
        const wrapperDir = path.dirname(this.claudeCodePath);
        const internalJsPath = path.join(wrapperDir, 'node_modules', '@tencent', 'claude-code-internal', 'dist', 'claude-code-internal.js');
        const bundledNodePath = path.join(wrapperDir, 'node.exe');

        if (existsSync(internalJsPath)) {
          return {
            command: existsSync(bundledNodePath) ? bundledNodePath : 'node',
            commandArgs: [internalJsPath, ...args]
          };
        }

        return {
          command: 'cmd.exe',
          commandArgs: ['/d', '/s', '/c', this.claudeCodePath, ...args]
        };
      }

      if (normalizedPath.endsWith('.ps1')) {
        return {
          command: 'powershell.exe',
          commandArgs: ['-ExecutionPolicy', 'Bypass', '-File', this.claudeCodePath, ...args]
        };
      }
    }

    return {
      command: this.claudeCodePath,
      commandArgs: args
    };
  }

  /**
   * Process an observation from tool usage
   */
  async processObservation(input: ObservationInput): Promise<any> {
    const { memorySessionId, project, toolName, toolInput, toolOutput, observationType, sourceIde } = input;
    let sourceIdeValue = sourceIde && sourceIde.trim() ? sourceIde.trim() : null;

    // 同会话 source_ide 强一致性:如果该 sid 已经有 observation/summary 写过,
    // 后续所有写入必须用那一个 source_ide,即使本次 hook 报的不一样。
    // 这是兜底数据完整性保险,防御 desktop wrapper 漏注入 AGENTMEM_IDE / 跨 IDE
    // 并发触发等无法在 hook 层完全堵死的场景。
    const lockedIde = getSessionSourceIde(memorySessionId);
    if (lockedIde && lockedIde !== sourceIdeValue) {
      logger.warn('SDK', 'source_ide overridden by session lock', {
        memorySessionId,
        incoming: sourceIdeValue,
        locked: lockedIde,
      });
      sourceIdeValue = lockedIde;
    }

    logger.info('SDK', '=== Processing Observation START ===', {
      memorySessionId,
      project,
      toolName,
      observationType,
      inputType: typeof toolInput,
      outputType: typeof toolOutput
    });

    // === 分档（在调用 LLM 之前） ===
    const event: NormalizedEvent = { observationType, toolName, toolInput, toolOutput };
    // 从本会话已入库记录派生去重签名（与 classifier 同一算法、由插入时持久化）
    const recentSignatures = getObservationsBySession(memorySessionId)
      .map((o) => o.signature)
      .filter((s): s is string => !!s);
    const classification = classify(event, recentSignatures);

    // 跨 session 去重兜底:同一 project + 同 signature 在最近 60s 已存在,视为重复。
    // catch 多个 IDE hook 并发触发同一条用户行为、彼此用不同 memory_session_id
    // 写入而绕过 classify 会话内去重的场景。Tier 0 已经被 classify 标记,此处只
    // 对 Tier 1 / Tier 2 的有效写入再过一遍 guard。
    if (classification.tier !== 0 && classification.signature) {
      if (hasRecentSignature(project, classification.signature, 60_000)) {
        logger.info('SDK', '=== Observation DROPPED (cross-session duplicate) ===', {
          toolName,
          signature: classification.signature.slice(0, 12) + '...',
          project,
        });
        return null;
      }
    }

    // 并发竞态兜底:hasRecentSignature 是先读后写,两个 sig 相同的事件同时进入时
    // 都会读到"DB 中无此 sig",都通过 guard,各自调 LLM,先后写库 → 双插。
    // 这里在 LLM 调用 *之前* 用 in-memory Set 做原子占位,第二个并发请求直接 drop,
    // 既省 LLM 成本,又彻底堵住竞态。配套 DB 层 UNIQUE INDEX 兜底。
    const inflightKey = classification.signature
      ? `${memorySessionId}:${classification.signature}`
      : '';
    if (classification.tier !== 0 && inflightKey) {
      if (this.inflightSignatures.has(inflightKey)) {
        logger.info('SDK', '=== Observation DROPPED (concurrent in-flight duplicate) ===', {
          toolName,
          signature: classification.signature!.slice(0, 12) + '...',
          memorySessionId,
        });
        return null;
      }
      this.inflightSignatures.add(inflightKey);
    }

    try {
      return await this.processObservationInner({
        memorySessionId,
        project,
        toolName,
        toolInput,
        toolOutput,
        observationType,
      }, classification, sourceIdeValue, event);
    } finally {
      if (inflightKey) this.inflightSignatures.delete(inflightKey);
    }
  }

  /**
   * 真正执行 classify → LLM → insert 的内层流程。从 processObservation 中抽出来,
   * 让外层只负责 inflight 占位 + finally 释放,避免在多个 return 点都去 delete。
   */
  private async processObservationInner(
    input: Pick<ObservationInput, 'memorySessionId' | 'project' | 'toolName' | 'toolInput' | 'toolOutput' | 'observationType'>,
    classification: ReturnType<typeof classify>,
    sourceIdeValue: string | null,
    event: NormalizedEvent
  ): Promise<any> {
    const { memorySessionId, project, toolName, toolInput, toolOutput, observationType } = input;

    logger.info('SDK', 'Observation classified', {
      tier: classification.tier,
      model: classification.model,
      dropReason: classification.dropReason,
      toolName
    });

    // Tier 0：丢弃，不入库、不调 LLM
    if (classification.tier === 0) {
      logger.info('SDK', '=== Observation DROPPED (Tier 0) ===', {
        toolName,
        dropReason: classification.dropReason
      });
      return null;
    }

    // MCP 原始证据全文（仅 MCP；其它事件为 null），Tier1/Tier2 均落库以便溯源
    const evidence = extractMcpEvidence(event);

    // Tier 1：模板留痕，不调 LLM
    if (classification.tier === 1) {
      const trace = formatTrace(event);
      const { isoString, epoch } = normalizeTimestamp(new Date());
      const obsRow = {
        memory_session_id: memorySessionId,
        project,
        type: trace.type,
        title: trace.title,
        subtitle: null,
        meta_intent: null,
        text: trace.facts,
        facts: trace.facts,
        narrative: null,
        concepts: null,
        files_read: null,
        files_modified: null,
        prompt_number: 0,
        discovery_tokens: 0,
        tier: 1,
        signature: classification.signature,
        evidence,
        source_ide: sourceIdeValue,
        created_at: isoString,
        created_at_epoch: epoch
      };
      const obsId = insertObservation(obsRow);
      if (obsId === -1) {
        logger.info('SDK', '=== Trace DROPPED (DB-level UNIQUE dedup, Tier 1) ===', { toolName, title: trace.title });
        return null;
      }
      logger.info('SDK', '=== Trace STORED (Tier 1) ===', { obsId, toolName, title: trace.title });
      return { id: obsId, ...obsRow };
    }

    // Tier 2：模型精写，按 classify 结果选择高级/中级通道（含各自 endpoint+key）
    const target: CallTarget = classification.model === 'light' ? this.lightTarget() : this.highTarget();
    const selectedModel = target.model;

    // Build prompt based on tool type
    let prompt: string;
    // LLM 若返回 skip/无有效结果时的兜底原文（Tier 2 必须落库，不交由 LLM 决定）
    let rawContentText = JSON.stringify({ toolInput, toolOutput });
    
    if (toolName === 'agent_response') {
      // Extract response content from toolOutput
      let responseContent = '';
      if (typeof toolOutput === 'string') {
        responseContent = toolOutput;
      } else if (toolOutput && typeof toolOutput === 'object') {
        const output = toolOutput as Record<string, unknown>;
        responseContent = (output.response as string) || JSON.stringify(toolOutput, null, 2);
      }
      rawContentText = responseContent;
      prompt = buildResponsePrompt(responseContent, memorySessionId);
      logger.debug('SDK', 'Built agent_response prompt', { 
        promptLength: prompt.length, 
        responseContentLength: responseContent.length,
        promptPreview: prompt.substring(0, 500) 
      });
    } else if (toolName === 'agent_thought') {
      // Extract thought content from toolOutput
      let thoughtContent = '';
      if (typeof toolOutput === 'string') {
        thoughtContent = toolOutput;
      } else if (toolOutput && typeof toolOutput === 'object') {
        const output = toolOutput as Record<string, unknown>;
        thoughtContent = (output.thought as string) || JSON.stringify(toolOutput, null, 2);
      }
      rawContentText = thoughtContent;
      prompt = buildThoughtPrompt(thoughtContent, memorySessionId);
      logger.debug('SDK', 'Built agent_thought prompt', { 
        promptLength: prompt.length, 
        thoughtContentLength: thoughtContent.length,
        promptPreview: prompt.substring(0, 500) 
      });
    } else {
      // Use generic observation prompt for other tool types
      const obs: Observation = {
        id: 0,
        tool_name: toolName,
        tool_input: typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput, null, 2),
        tool_output: typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput, null, 2),
        created_at_epoch: Date.now(),
        hook_type: observationType
      };
      prompt = buildObservationPrompt(obs);
      logger.debug('SDK', 'Built generic observation prompt', { promptLength: prompt.length, promptPreview: prompt.substring(0, 500) });
    }

    try {
      // Call AI to extract structured observation
      logger.info('SDK', 'Calling AI for observation extraction...', { model: selectedModel, endpoint: target.endpoint });
      let response = '';
      let extractionFailed = false;
      try {
        response = await this.callAI(prompt, target);
      } catch (error) {
        extractionFailed = true;
        logger.warn('SDK', 'AI extraction failed; preserving observation with deterministic fallback', {
          toolName, memorySessionId, error: String(error),
        });
      }
      logger.info('SDK', 'AI response received', { responseLength: response.length, responsePreview: response.substring(0, 300) });
      
      const parsed = parseObservations(response);
      logger.info('SDK', 'Parsed observations from AI response', { parsedCount: parsed.length, parsed: JSON.stringify(parsed).substring(0, 500) });

      if (parsed.length > 0) {
        const firstObs = parsed[0];
        const { isoString, epoch } = normalizeTimestamp(new Date());
        
        logger.info('SDK', 'Inserting observation into database', {
          type: firstObs.type,
          title: firstObs.title,
          narrativePreview: firstObs.narrative?.substring(0, 100)
        });
        
        // Store the observation
        const obsRow = {
          memory_session_id: memorySessionId,
          project,
          type: firstObs.type || 'discovery',
          title: firstObs.title,
          subtitle: firstObs.subtitle,
          meta_intent: firstObs.meta_intent,
          text: firstObs.narrative,
          facts: firstObs.facts?.join('\n') || null,
          narrative: firstObs.narrative,
          concepts: firstObs.concepts?.join(', ') || null,
          files_read: firstObs.files_read?.join(', ') || null,
          files_modified: firstObs.files_modified?.join(', ') || null,
          prompt_number: 0,
          discovery_tokens: 0,
          tier: 2,
          signature: classification.signature,
          evidence,
          source_ide: sourceIdeValue,
          created_at: isoString,
          created_at_epoch: epoch
        };
        const obsId = insertObservation(obsRow);
        if (obsId === -1) {
          logger.info('SDK', '=== Observation DROPPED (DB-level UNIQUE dedup, Tier 2 LLM) ===', {
            memorySessionId,
            toolName,
            type: firstObs.type,
            title: firstObs.title,
          });
          return null;
        }

        logger.info('SDK', '=== Observation STORED successfully ===', {
          obsId,
          memorySessionId,
          type: firstObs.type,
          title: firstObs.title
        });

        return { id: obsId, ...obsRow };
      } else {
        // Tier 2 必须落库：LLM 返回 skip / 无有效结果时，用确定性兜底记录入库，
        // 不再交由 LLM 决定是否记录，避免观测被静默丢弃。
        logger.info('SDK', 'AI returned skip/empty for Tier 2; storing deterministic fallback', {
          toolName,
          responsePreview: response.substring(0, 200)
        });

        const trace = formatTrace(event);
        const { isoString, epoch } = normalizeTimestamp(new Date());
        const FALLBACK_NARRATIVE_MAX = 5000;
        const narrative = rawContentText
          ? (rawContentText.length > FALLBACK_NARRATIVE_MAX
              ? rawContentText.slice(0, FALLBACK_NARRATIVE_MAX) + '…'
              : rawContentText)
          : null;
        const obsRow = {
          memory_session_id: memorySessionId,
          project,
          type: trace.type || observationType || 'discovery',
          title: trace.title,
          subtitle: extractionFailed ? 'AI 提取失败，已保留原始记录' : null,
          meta_intent: null,
          text: narrative ?? trace.facts,
          facts: trace.facts,
          narrative,
          concepts: null,
          files_read: null,
          files_modified: null,
          prompt_number: 0,
          discovery_tokens: 0,
          tier: 2,
          signature: classification.signature,
          evidence,
          source_ide: sourceIdeValue,
          created_at: isoString,
          created_at_epoch: epoch
        };
        const obsId = insertObservation(obsRow);
        if (obsId === -1) {
          logger.info('SDK', '=== Tier 2 fallback DROPPED (DB-level UNIQUE dedup) ===', { toolName, title: trace.title });
          return null;
        }
        logger.info('SDK', '=== Tier 2 fallback STORED (LLM skip) ===', { obsId, toolName, title: trace.title });
        return { id: obsId, ...obsRow };
      }
    } catch (error) {
      logger.error('SDK', '=== Observation Processing FAILED ===', { toolName, memorySessionId }, error as Error);
      throw error;
    }
  }

  /**
   * Generate a session summary
   * Includes retry mechanism to wait for async observations to complete
   */
  async generateSummary(memorySessionId: string, project: string, sourceIdeHint?: string): Promise<any> {
    logger.info('SDK', '=== Generating Summary START ===', { memorySessionId, project });

    // 并发兜底:Stop hook 在 claude-internal 等 IDE 下可能短时间内反复触发(实测
    // 一会话曾经累计写出 16 条 summary)。在 LLM 调用 *之前* 用 in-memory Set
    // 串行化同 sid 的 summary 生成,第二个并发请求直接返回。
    if (this.inflightSummaries.has(memorySessionId)) {
      logger.info('SDK', '=== Summary SKIPPED (concurrent in-flight) ===', { memorySessionId });
      return null;
    }

    // 无新观测兜底:如果该 sid 最新 summary 的 epoch 已经覆盖最新 obs 的 epoch,
    // 说明上次 summary 之后没有新增任何 observation,这一次再生成会得到几乎同样的内容。
    // 直接 skip,避免重复入库。导入流程会 lazy-create 没有 obs 的 sid,这里也保护它。
    try {
      const latestSum = getLatestSummaryEpochForSession(memorySessionId);
      const latestObs = getLatestObservationEpochForSession(memorySessionId);
      if (latestSum != null && latestObs != null && latestSum >= latestObs) {
        logger.info('SDK', '=== Summary SKIPPED (no new observations since last summary) ===', {
          memorySessionId,
          latestSumEpoch: latestSum,
          latestObsEpoch: latestObs,
        });
        return null;
      }
    } catch (err) {
      logger.warn('SDK', 'no-new-obs guard query failed (continuing)', { err: String(err) });
    }

    this.inflightSummaries.add(memorySessionId);
    try {
      return await this.generateSummaryInner(memorySessionId, project, sourceIdeHint);
    } finally {
      this.inflightSummaries.delete(memorySessionId);
    }
  }

  /**
   * 真正执行 summary 生成的内层流程,只在通过并发 / no-new-obs 兜底之后执行。
   */
  private async generateSummaryInner(memorySessionId: string, project: string, sourceIdeHint?: string): Promise<any> {
    // Get session info to retrieve user_prompt
    const session = getSessionByMemoryId(memorySessionId);
    const userPrompt = session?.user_prompt || '';
    logger.info('SDK', 'Retrieved session info', {
      memorySessionId,
      hasSession: !!session,
      userPromptLength: userPrompt.length,
      userPromptPreview: userPrompt.substring(0, 100)
    });
    
    // Wait for observations to be available (handles race condition with async observation processing)
    // Retry up to 6 times with 5 second intervals (30 seconds total)
    const MAX_WAIT_RETRIES = 6;
    const WAIT_INTERVAL_MS = 5000;
    const MAX_OBSERVATIONS_FOR_SUMMARY = 20;
    
    let observations: any[] = [];
    let allObservations: any[] = [];
    
    for (let waitAttempt = 0; waitAttempt < MAX_WAIT_RETRIES; waitAttempt++) {
      allObservations = getObservationsBySession(memorySessionId);
      
      if (allObservations.length > 0) {
        logger.info('SDK', 'Found observations', { 
          memorySessionId, 
          totalObservations: allObservations.length,
          waitAttempt
        });
        break;
      }
      
      // No observations yet, wait and retry
      if (waitAttempt < MAX_WAIT_RETRIES - 1) {
        logger.info('SDK', 'No observations yet, waiting for async processing...', { 
          memorySessionId, 
          waitAttempt: waitAttempt + 1,
          maxRetries: MAX_WAIT_RETRIES,
          waitMs: WAIT_INTERVAL_MS
        });
        await this.sleep(WAIT_INTERVAL_MS);
      }
    }
    
    // Limit observations to most recent 20 to avoid prompt too long (which causes API timeout)
    observations = allObservations.length > MAX_OBSERVATIONS_FOR_SUMMARY
      ? allObservations.slice(-MAX_OBSERVATIONS_FOR_SUMMARY)  // Take last N (most recent)
      : allObservations;
    
    logger.info('SDK', 'Retrieved observations for summary', { 
      memorySessionId, 
      totalObservations: allObservations.length,
      usedObservations: observations.length,
      truncated: allObservations.length > MAX_OBSERVATIONS_FOR_SUMMARY,
      observations: observations.map(o => ({ id: o.id, type: o.type, title: o.title }))
    });

    // Aggregate files from all observations
    const allFilesRead = new Set<string>();
    const allFilesModified = new Set<string>();
    for (const obs of observations) {
      if (obs.files_read) {
        obs.files_read.split(',').map((f: string) => f.trim()).filter((f: string) => f).forEach((f: string) => allFilesRead.add(f));
      }
      if (obs.files_modified) {
        obs.files_modified.split(',').map((f: string) => f.trim()).filter((f: string) => f).forEach((f: string) => allFilesModified.add(f));
      }
    }
    const aggregatedFilesRead = allFilesRead.size > 0 ? Array.from(allFilesRead).join(', ') : null;
    const aggregatedFilesEdited = allFilesModified.size > 0 ? Array.from(allFilesModified).join(', ') : null;

    // 来源 IDE：hook 透传的权威值优先（消除异步 observation 入库竞态）→
    // 末条非空 observation → session 行兜底 → NULL。
    let resolvedSourceIde = resolveSourceIdeForSummary(allObservations, session, sourceIdeHint);
    // 同会话强一致性:用最早一条已落库的 source_ide 覆盖。即使本次 hook 误传
    // 了别的 IDE 标识,summary 也跟随 sid 已有的 source_ide,防止"会话所有 obs
    // 都是 claude-internal 但 summary 标 cursor"这种倒挂。
    const lockedIdeForSummary = getSessionSourceIde(memorySessionId);
    if (lockedIdeForSummary && lockedIdeForSummary !== resolvedSourceIde) {
      logger.warn('SDK', 'summary source_ide overridden by session lock', {
        memorySessionId,
        resolved: resolvedSourceIde,
        locked: lockedIdeForSummary,
      });
      resolvedSourceIde = lockedIdeForSummary;
    }
    logger.info('SDK', 'Resolved source_ide for summary', { source_ide: resolvedSourceIde, hint: sourceIdeHint });
    logger.info('SDK', 'Aggregated files from observations', { 
      filesReadCount: allFilesRead.size, 
      filesEditedCount: allFilesModified.size 
    });

    if (observations.length === 0) {
      logger.info('SDK', '=== Summary SKIPPED (no observations after waiting) ===', { memorySessionId });
      return null;
    }

    // Resolve last_assistant_message from the session row (populated by
    // T5's stop-transcript handler via updateSessionField).
    // Note: we intentionally do NOT implement an observation-level fallback.
    // Observations are typed by semantic categories (bugfix/feature/etc.),
    // not by source (e.g. 'agent_response'), and their narrative field is
    // a Chinese summary — not the raw assistant text. The session field is
    // the single source of truth for this value.
    const lastAssistantMessage = session?.last_assistant_message || '';
    logger.info('SDK', 'last_assistant_message resolved', {
      source: lastAssistantMessage ? 'session-field' : 'none',
      length: lastAssistantMessage.length,
    });

    // Build prompt for summary generation with observations context
    const prompt = buildSummaryPrompt({
      id: 0,
      memory_session_id: memorySessionId,
      project,
      user_prompt: userPrompt,
      last_assistant_message: lastAssistantMessage,
      observations: observations.map(o => ({
        id: o.id,
        type: o.type,
        title: o.title || 'Untitled Observation',
        subtitle: o.subtitle || undefined,
        narrative: o.narrative || undefined,
        facts: o.facts || undefined,
        files_read: o.files_read || undefined,
        files_modified: o.files_modified || undefined
      }))
    });

    try {
      logger.info('SDK', 'Calling AI for summary generation...');
      const response = await this.callAI(prompt);
      logger.info('SDK', 'AI summary response received', { responseLength: response.length, responsePreview: response.substring(0, 300) });
      
      const parsed = parseSummary(response);
      logger.info('SDK', 'Parsed summary from AI response', { parsed: JSON.stringify(parsed).substring(0, 500) });

      if (parsed) {
        // CRITICAL: Check for placeholder content before storing
        // This prevents storing useless data when API key was missing or API failed
        const isPlaceholder = this.isPlaceholderContent(parsed);
        if (isPlaceholder) {
          logger.error('SDK', '=== Summary REJECTED (detected placeholder content) ===', { 
            memorySessionId,
            request: parsed.request,
            investigated: parsed.investigated 
          });
          throw new Error('Summary contains placeholder content - API may have failed. Will not store invalid data.');
        }

        const { isoString, epoch } = normalizeTimestamp(new Date());
        
        logger.info('SDK', 'Inserting summary into database', {
          request: parsed.request?.substring(0, 100),
          learned: parsed.learned?.substring(0, 100)
        });
        
        // Store the summary with aggregated files from observations
        const sumRow = {
          memory_session_id: memorySessionId,
          project,
          request: parsed.request,
          investigated: parsed.investigated,
          learned: parsed.learned,
          media_context: parsed.media_context,
          meta_intent: parsed.meta_intent,
          completed: parsed.completed,
          next_steps: parsed.next_steps,
          files_read: aggregatedFilesRead,
          files_edited: aggregatedFilesEdited,
          notes: parsed.notes,
          prompt_number: 0,
          discovery_tokens: 0,
          source_ide: resolvedSourceIde,
          created_at: isoString,
          created_at_epoch: epoch
        };
        const sumId = insertSummary(sumRow);
        if (sumId === -1) {
          logger.info('SDK', '=== Summary DROPPED (DB-level UNIQUE dedup) ===', { memorySessionId });
          return null;
        }

        logger.info('SDK', '=== Summary STORED successfully ===', { sumId, memorySessionId });
        return { id: sumId, ...sumRow };
      }

      logger.info('SDK', '=== Summary SKIPPED (failed to parse) ===', { memorySessionId, responsePreview: response.substring(0, 200) });
      return null;
    } catch (error) {
      logger.error('SDK', '=== Summary Generation FAILED; storing deterministic fallback ===', { memorySessionId }, error as Error);
      return this.storeDeterministicSummaryFallback({
        memorySessionId,
        project,
        userPrompt,
        observations,
        aggregatedFilesRead,
        aggregatedFilesEdited,
        resolvedSourceIde,
        error: error as Error,
      });
    }
  }

  private cleanSummaryText(value: unknown, maxLen: number): string {
    const text = String(value ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return '';
    return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
  }

  private storeDeterministicSummaryFallback(input: {
    memorySessionId: string;
    project: string;
    userPrompt: string;
    observations: any[];
    aggregatedFilesRead: string | null;
    aggregatedFilesEdited: string | null;
    resolvedSourceIde: string | null;
    error: Error;
  }): any {
    const { isoString, epoch } = normalizeTimestamp(new Date());
    const obsTitles = input.observations
      .map(o => this.cleanSummaryText(o.title || o.narrative || o.facts || o.type, 90))
      .filter(Boolean);
    const obsDetails = input.observations
      .map(o => this.cleanSummaryText(o.narrative || o.facts || o.text || o.title, 140))
      .filter(Boolean);
    const request = this.cleanSummaryText(input.userPrompt, 220) || '本轮会话未记录明确的用户请求。';
    const investigated = obsTitles.length
      ? `记录并梳理了本轮交互中的 ${input.observations.length} 条 observation：${obsTitles.slice(0, 6).join('；')}。`
      : '本轮交互没有可用于摘要的 observation 明细。';
    const learned = obsDetails.length
      ? obsDetails.slice(0, 3).join('；')
      : 'AI 摘要服务临时不可用，已保留本轮会话的基础结构化摘要。';
    const completed = obsTitles.length
      ? '已完成本轮会话的观测记录，并在 AI 摘要失败时写入兜底 summary，避免会话结束后没有摘要。'
      : '已写入兜底 summary，保留会话结束事实。';

    const sumRow = {
      memory_session_id: input.memorySessionId,
      project: input.project,
      request,
      investigated,
      learned,
      media_context: null,
      meta_intent: '在摘要模型限流或临时失败时，仍保证本轮交互有标准 session summary 记录。',
      completed,
      next_steps: '模型恢复后如需更精确内容，可重新触发摘要或基于已有 observations 补充总结。',
      files_read: input.aggregatedFilesRead,
      files_edited: input.aggregatedFilesEdited,
      notes: `AI summary fallback: ${this.cleanSummaryText(input.error.message, 240)}`,
      prompt_number: 0,
      discovery_tokens: 0,
      source_ide: input.resolvedSourceIde,
      created_at: isoString,
      created_at_epoch: epoch
    };
    const sumId = insertSummary(sumRow);
    if (sumId === -1) {
      logger.info('SDK', '=== Fallback summary DROPPED (DB-level UNIQUE dedup) ===', {
        memorySessionId: input.memorySessionId,
      });
      return null;
    }
    logger.info('SDK', '=== Fallback summary STORED successfully ===', {
      sumId,
      memorySessionId: input.memorySessionId,
      reason: input.error.message,
    });
    return { id: sumId, ...sumRow };
  }

  /** Advanced (high) channel target. */
  private highTarget(): CallTarget {
    return { model: this.model, endpoint: this.apiEndpoint, apiKey: this.apiKey };
  }

  /** Mid-tier (light) channel target — its own endpoint/key/model. */
  private lightTarget(): CallTarget {
    return { model: this.modelLight, endpoint: this.apiEndpointLight, apiKey: this.apiKeyLight };
  }

  /**
   * Public single-shot prompt runner.
   *
   * Used by the retroactive history import feature to run an arbitrary
   * import-summary prompt through the same provider plumbing
   * (TIMIAI / OpenAI / Anthropic API key resolution, retry, timeout)
   * without going through processObservation / generateSummary — both
   * of which are tightly bound to existing DB rows.
   *
   * The caller is responsible for parsing the returned text (e.g. via
   * `parseSummary`) and writing the result wherever it belongs.
   */
  async runPrompt(prompt: string): Promise<string> {
    return this.callAI(prompt);
  }

  /**
   * Dispatch AI call to the configured provider.
   * Includes retry with exponential backoff for both providers.
   * `target` selects which channel (endpoint/key/model) to use; defaults to
   * the advanced (high) channel for backward compatibility.
   */
  private async callAI(prompt: string, target: CallTarget = this.highTarget()): Promise<string> {
    logger.debug('SDK', 'callAI invoked', {
      provider: this.provider,
      model: target.model,
      endpoint: target.endpoint,
      promptLength: prompt.length,
      timeout: this.requestTimeout,
      maxRetries: this.maxRetries
    });

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        if (this.provider === 'claude-code') {
          // 本地 claude CLI 不需要 endpoint/key/model，忽略 target
          return await this.callClaudeCodeProvider(prompt, attempt);
        }
        return await this.runSerializedAiCall(() => this.callApiProvider(prompt, attempt, target));
      } catch (error) {
        lastError = error as Error;
        logger.warn('SDK', `AI call failed (provider=${this.provider})`, {
          attempt,
          maxRetries: this.maxRetries,
          errorMessage: (error as Error).message
        });

        if (attempt < this.maxRetries) {
          const delay = this.isRateLimitError(error as Error)
            ? Math.min(parseInt(process.env.CODEBUDDY_MEM_RATE_LIMIT_RETRY_BASE_MS || '8000', 10) * attempt, 30000)
            : Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          logger.info('SDK', `Retrying in ${delay}ms...`, { attempt, nextAttempt: attempt + 1, delay });
          await this.sleep(delay);
        }
      }
    }

    logger.error('SDK', 'AI call failed after all retries', {
      provider: this.provider,
      maxRetries: this.maxRetries
    }, lastError as Error);
    throw lastError;
  }

  private async runSerializedAiCall<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.aiCallQueue;
    let release!: () => void;
    this.aiCallQueue = new Promise<void>(resolve => {
      release = resolve;
    });

    await previous.catch(() => {});
    try {
      const minIntervalMs = parseInt(process.env.CODEBUDDY_MEM_AI_MIN_INTERVAL_MS || '1200', 10);
      const waitMs = Math.max(0, this.lastAiCallAt + minIntervalMs - Date.now());
      if (waitMs > 0) {
        logger.debug('SDK', 'Throttling AI call to avoid provider rate limit', { waitMs });
        await this.sleep(waitMs);
      }
      this.lastAiCallAt = Date.now();
      return await fn();
    } finally {
      release();
    }
  }

  private isRateLimitError(error: Error): boolean {
    return /请求频率过高|rate limit|too many requests|code\s*434|429/i.test(error.message || '');
  }

  /**
   * Call OpenAI-compatible HTTP API (TIMIAI / OpenAI / Anthropic).
   * This is the original implementation extracted from callAI.
   */
  private async callApiProvider(prompt: string, attempt: number, target: CallTarget = this.highTarget()): Promise<string> {
    const { model, endpoint, apiKey } = target;

    if (!apiKey) {
      const errorMsg = 'No API key configured (set TIMIAI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY). Cannot process without API key.';
      logger.error('SDK', errorMsg);
      throw new Error(errorMsg);
    }

    const isTimiaiApi = endpoint.includes('timiai.woa.com');
    const authHeader = isTimiaiApi ? apiKey : `Bearer ${apiKey}`;

    const isGpt5Model = model.toLowerCase().startsWith('gpt-5');
    const maxTokens = isGpt5Model ? 8000 : 2000;

    const requestBody: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: 'You are a memory extraction assistant. Extract structured information from tool usage. All output content (title, subtitle, facts, narrative, meta_intent) MUST be written in Chinese (简体中文). No English text in observation fields.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: maxTokens,
      stream: false
    };

    if (!isGpt5Model) {
      requestBody.temperature = 0.3;
    }

    logger.info('SDK', 'Making API request', {
      endpoint,
      model,
      isTimiaiApi,
      isGpt5Model,
      maxTokens,
      promptLength: prompt.length,
      attempt,
      maxRetries: this.maxRetries
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
      logger.warn('SDK', 'API request timeout, aborting...', { timeout: this.requestTimeout, attempt });
    }, this.requestTimeout);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });

      logger.info('SDK', 'API response status', { status: response.status, statusText: response.statusText, attempt });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('SDK', 'API request failed', { status: response.status, errorText, attempt });
        throw new Error(`API request failed: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data = await response.json() as any;

      logger.debug('SDK', 'API raw response', {
        hasChoices: !!data.choices,
        choicesLength: data.choices?.length,
        dataKeys: Object.keys(data),
        rawDataPreview: JSON.stringify(data).substring(0, 500)
      });

      if (data.error) {
        const message = typeof data.error?.message === 'string'
          ? data.error.message
          : JSON.stringify(data.error);
        const code = data.error?.code != null ? ` code ${data.error.code}` : '';
        logger.error('SDK', 'API returned error object', {
          message,
          code: data.error?.code,
          rawData: JSON.stringify(data).substring(0, 1000),
        });
        throw new Error(`API returned error object:${code} ${message}`.trim());
      }

      if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
        logger.error('SDK', 'API returned invalid response structure', {
          hasChoices: !!data.choices,
          isArray: Array.isArray(data.choices),
          choicesLength: data.choices?.length,
          dataKeys: Object.keys(data),
          rawData: JSON.stringify(data).substring(0, 1000)
        });
        throw new Error(`Invalid API response: missing or empty choices array. Keys: ${Object.keys(data).join(', ')}`);
      }

      const content = data.choices[0]?.message?.content || '';
      logger.info('SDK', 'API call successful', {
        responseContentLength: content.length,
        usage: data.usage,
        attempt
      });
      return content;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Call the local claude CLI in non-interactive print mode.
   * Official claude CLI reads prompt from stdin well, while Tencent's
   * claude-internal variant expects the prompt as a positional argument.
   *
   * Requires: claude CLI installed and authenticated (https://claude.ai/code)
   * Switch via: CODEBUDDY_MEM_PROVIDER=claude-code
   */
  private callClaudeCodeProvider(prompt: string, attempt: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const isInternalCli = this.isClaudeInternalCli();
      const systemPrompt = 'You are a memory extraction assistant. Extract structured information from tool usage. All output content (title, subtitle, facts, narrative, meta_intent) MUST be written in Chinese (简体中文). No English text in observation fields.';
      const args = isInternalCli
        ? ['--system-prompt', systemPrompt, '-p', prompt, '--output-format', 'text']
        : ['--system-prompt', systemPrompt, '-p', '--output-format', 'text'];
      const { command, commandArgs } = this.buildClaudeCommand(args);

      logger.info('SDK', 'Calling Claude Code CLI', {
        path: this.claudeCodePath,
        cliVariant: isInternalCli ? 'claude-internal' : 'claude',
        spawnCommand: command,
        argsPreview: commandArgs.slice(0, 4),
        promptLength: prompt.length,
        timeout: this.requestTimeout,
        attempt
      });

      let child: ReturnType<typeof spawn>;
      // Only use shell mode when the command itself requires it (e.g. cmd.exe, powershell.exe).
      // When command is 'node' or a direct executable, shell mode causes Windows to
      // misinterpret special characters in long prompt arguments, breaking the AI call.
      const needsShell = process.platform === 'win32' && 
        (command === 'cmd.exe' || command === 'powershell.exe');
      try {
        child = spawn(command, commandArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: needsShell,
          windowsHide: true,
          env: { ...process.env }
        });
      } catch (spawnErr) {
        const err = spawnErr as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          reject(new Error(
            `Claude Code CLI not found at "${this.claudeCodePath}". ` +
            `Please install it: https://claude.ai/code, or set CODEBUDDY_MEM_CLAUDE_CODE_PATH to the correct path.`
          ));
        } else {
          reject(err);
        }
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout!.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr!.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      // Timeout: kill the process if it runs too long
      const timer = setTimeout(() => {
        logger.warn('SDK', 'Claude Code CLI request timed out, killing process', {
          timeout: this.requestTimeout,
          attempt
        });
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already dead */ }
        }, 1000);
        reject(new Error(`Claude Code CLI request timed out after ${this.requestTimeout}ms`));
      }, this.requestTimeout);

      child.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (err.code === 'ENOENT') {
          reject(new Error(
            `Claude Code CLI not found at "${this.claudeCodePath}". ` +
            `Please install it: https://claude.ai/code, or set CODEBUDDY_MEM_CLAUDE_CODE_PATH to the correct path.`
          ));
        } else {
          reject(err);
        }
      });

      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');

        if (code !== 0) {
          logger.error('SDK', 'Claude Code CLI exited with non-zero code', {
            code,
            stderrPreview: stderr.substring(0, 500),
            attempt
          });
          reject(new Error(
            `Claude Code CLI exited with code ${code}: ${stderr.substring(0, 500)}`
          ));
          return;
        }

        const trimmed = stdout.trim();
        if (!trimmed) {
          logger.error('SDK', 'Claude Code CLI returned empty response', { attempt });
          reject(new Error('Claude Code CLI returned empty response'));
          return;
        }

        logger.info('SDK', 'Claude Code CLI call successful', {
          responseLength: trimmed.length,
          responsePreview: trimmed.substring(0, 200),
          attempt
        });
        resolve(trimmed);
      });

      // Official claude CLI supports stdin prompt input.
      // claude-internal expects the prompt as a positional argument, so we just close stdin.
      if (!isInternalCli) {
        child.stdin!.write(prompt, 'utf8');
      }
      child.stdin!.end();
    });
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Check if summary content is placeholder/invalid
   * Returns true if the content appears to be placeholder data
   */
  private isPlaceholderContent(parsed: {
    request?: string | null;
    investigated?: string | null;
    learned?: string | null;
    completed?: string | null;
  }): boolean {
    // Known placeholder strings that indicate API failure
    const placeholderPatterns = [
      'Session completed',
      'Various files and tools',
      'Information gathered during session',
      'Tasks completed',
      'Tool Execution',
      'Tool was executed successfully'
    ];

    const fieldsToCheck = [
      parsed.request,
      parsed.investigated,
      parsed.learned,
      parsed.completed
    ].filter(Boolean) as string[];

    // If any field exactly matches a placeholder pattern, it's invalid
    for (const field of fieldsToCheck) {
      for (const pattern of placeholderPatterns) {
        if (field.trim() === pattern) {
          logger.warn('SDK', 'Detected placeholder content', { field, pattern });
          return true;
        }
      }
    }

    // Additional check: if most fields are very short generic text
    const shortGenericCount = fieldsToCheck.filter(f => f.length < 30).length;
    if (fieldsToCheck.length > 0 && shortGenericCount === fieldsToCheck.length) {
      logger.warn('SDK', 'All fields are suspiciously short, may be placeholder', { 
        fields: fieldsToCheck 
      });
      // Don't reject, just warn - short content might be legitimate
    }

    return false;
  }

  /**
   * Verify the configured AI provider is reachable.
   * For 'api' provider: checks API key and makes a test HTTP request.
   * For 'claude-code' provider: checks claude CLI is available and responds.
   */
  async verifyApiConnection(): Promise<boolean> {
    if (this.provider === 'claude-code') {
      return this.verifyClaudeCodeAvailable();
    }

    if (!this.apiKey) {
      logger.error('SDK', 'API key not configured');
      return false;
    }

    try {
      logger.info('SDK', 'Verifying API connection...');
      const response = await this.callAI('Reply with just "OK" to confirm connection.');
      const isValid = Boolean(response && response.length > 0);
      logger.info('SDK', 'API connection verified', { success: isValid });
      return isValid;
    } catch (error) {
      logger.error('SDK', 'API connection verification failed', {}, error as Error);
      return false;
    }
  }

  /**
   * Verify claude CLI is installed and can respond to a simple prompt.
   */
  private async verifyClaudeCodeAvailable(): Promise<boolean> {
    try {
      logger.info('SDK', 'Verifying Claude Code CLI availability...', { path: this.claudeCodePath });
      const response = await this.callClaudeCodeProvider('Reply with just "OK" to confirm connection.', 1);
      const isValid = Boolean(response && response.length > 0);
      logger.info('SDK', 'Claude Code CLI verified', { success: isValid });
      return isValid;
    } catch (error) {
      logger.error('SDK', 'Claude Code CLI verification failed', { path: this.claudeCodePath }, error as Error);
      return false;
    }
  }
}
