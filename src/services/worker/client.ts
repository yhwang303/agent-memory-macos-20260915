/**
 * Worker Client for AgentMemory System
 * Handles communication with the Worker HTTP API
 */

import { logger } from '../../utils/logger.js';

// Debug logging for memory flow
function debugLog(stage: string, message: string, data?: any): void {
  logger.info('WORKER_CLIENT_DEBUG', `[${stage}] ${message}`, data);
}

const WORKER_PORT = parseInt(process.env.CODEBUDDY_MEM_PORT || '3847', 10);
const WORKER_HOST = process.env.CODEBUDDY_MEM_HOST || '127.0.0.1';
const WORKER_BASE_URL = `http://${WORKER_HOST}:${WORKER_PORT}`;

export interface InitSessionResult {
  sessionDbId: number;
  memorySessionId: string;
}

export interface AddObservationResult {
  observationId?: number;
  success: boolean;
}

export interface NormalizedObservation {
  sessionId: string;
  projectPath: string;
  timestamp: number;
  type: string;
  toolName: string;
  toolInput: any;
  toolOutput: any;
  metadata?: Record<string, any>;
  // 来源 IDE（原始 adapter id），透传给 worker 落库；未知时省略
  sourceIDE?: string;
}

/**
 * Worker Client class
 * Communicates with the Worker HTTP API
 */
export class WorkerClient {
  private baseUrl: string;
  private isRunning = false;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || WORKER_BASE_URL;
  }

  /**
   * Ensure the worker is running
   */
  async ensureRunning(): Promise<void> {
    if (this.isRunning) return;

    try {
      const response = await fetch(`${this.baseUrl}/health`);
      if (response.ok) {
        this.isRunning = true;
        logger.debug('WORKER_CLIENT', 'Worker is running');
      } else {
        throw new Error('Worker health check failed');
      }
    } catch (error) {
      logger.warn('WORKER_CLIENT', 'Worker not available, some features may be limited');
      // Don't throw - graceful degradation
    }
  }

  /**
   * Initialize a new session
   */
  async initSession(context: {
    sessionId: string;
    projectPath: string;
    prompt?: string;
    sourceIDE?: string;
  }): Promise<InitSessionResult> {
    debugLog('initSession', 'Starting', { sessionId: context.sessionId, projectPath: context.projectPath });
    try {
      const requestBody = {
        sessionId: context.sessionId,
        project: context.projectPath,
        userPrompt: context.prompt,
        sourceIDE: context.sourceIDE
      };
      debugLog('initSession', 'Sending request', { url: `${this.baseUrl}/api/session/start`, body: requestBody });
      
      const response = await fetch(`${this.baseUrl}/api/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(requestBody)
      });

      debugLog('initSession', 'Response received', { status: response.status, ok: response.ok });
      
      if (!response.ok) {
        const errorText = await response.text();
        debugLog('initSession', 'Response error', { status: response.status, errorText });
        throw new Error(`Init session failed: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as any;
      debugLog('initSession', 'Session created', data);
      return {
        sessionDbId: data.sessionDbId,
        memorySessionId: data.memorySessionId
      };
    } catch (error) {
      debugLog('initSession', 'ERROR', { error: String(error) });
      logger.error('WORKER_CLIENT', 'initSession failed', {}, error as Error);
      // Return placeholder for graceful degradation
      return {
        sessionDbId: 0,
        memorySessionId: `placeholder-${context.sessionId}`
      };
    }
  }

  /**
   * Get context for injection
   */
  async getContext(projectPath: string): Promise<string | null> {
    try {
      const params = new URLSearchParams({ project: projectPath });
      const response = await fetch(`${this.baseUrl}/api/context/inject?${params}`);

      if (!response.ok) {
        return null;
      }

      const data = await response.json() as any;
      return data.context || null;
    } catch (error) {
      logger.debug('WORKER_CLIENT', 'getContext failed (graceful)', { projectPath });
      return null;
    }
  }

  /**
   * Update a whitelisted field on sdk_sessions.
   * Fire-and-forget: logs but does not throw on failure.
   */
  async updateSessionField(
    sessionId: string,
    field: 'last_assistant_message' | 'transcript_path' | 'user_prompt',
    value: string | null
  ): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/api/session/field`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ sessionId, field, value })
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        logger.debug('WORKER_CLIENT', `updateSessionField non-OK: ${response.status} ${text}`);
      }
    } catch (err) {
      logger.debug('WORKER_CLIENT', `updateSessionField failed (graceful): ${String(err)}`);
    }
  }

  /**
   * Record an agent response
   */
  async recordResponse(sessionId: string, response: string, sourceIDE?: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/api/observation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          sessionId,
          sourceIDE,
          toolName: 'agent_response',
          toolInput: {},
          toolOutput: { response }
        })
      });
    } catch (error) {
      logger.debug('WORKER_CLIENT', 'recordResponse failed (graceful)');
    }
  }

  /**
   * Record an agent thought
   */
  async recordThought(sessionId: string, thought: string, sourceIDE?: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/api/observation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          sessionId,
          sourceIDE,
          toolName: 'agent_thought',
          toolInput: {},
          toolOutput: { thought }
        })
      });
    } catch (error) {
      logger.debug('WORKER_CLIENT', 'recordThought failed (graceful)');
    }
  }

  /**
   * Add an observation
   */
  async addObservation(observation: NormalizedObservation): Promise<AddObservationResult> {
    debugLog('addObservation', 'Starting', { 
      sessionId: observation.sessionId, 
      toolName: observation.toolName,
      type: observation.type 
    });
    try {
      const requestBody = {
        sessionId: observation.sessionId,
        projectPath: observation.projectPath,
        toolName: observation.toolName,
        toolInput: observation.toolInput,
        toolOutput: observation.toolOutput,
        observationType: observation.type,
        sourceIDE: observation.sourceIDE
      };
      debugLog('addObservation', 'Sending request', { 
        url: `${this.baseUrl}/api/observation`,
        sessionId: observation.sessionId,
        toolName: observation.toolName
      });
      
      const response = await fetch(`${this.baseUrl}/api/observation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(requestBody)
      });

      debugLog('addObservation', 'Response received', { status: response.status, ok: response.ok });

      if (!response.ok) {
        const errorText = await response.text();
        debugLog('addObservation', 'Response error', { status: response.status, errorText });
        return { success: false };
      }

      const data = await response.json() as any;
      debugLog('addObservation', 'Observation recorded', { success: data.success, observationId: data.observationId });
      return { success: true, observationId: data.observationId };
    } catch (error) {
      debugLog('addObservation', 'ERROR', { error: String(error) });
      logger.debug('WORKER_CLIENT', 'addObservation failed (graceful)');
      return { success: false };
    }
  }

  /**
   * Summarize and end a session
   *
   * @param transcriptPath optional absolute path to the IDE's jsonl transcript
   *   the Stop hook fired for. When provided, the worker will run reverse
   *   dedup against any imported summary row for the same (jsonl sid, last
   *   turn index) — closing the timing window where import wrote a row at
   *   start-of-turn before the hook had a chance to fire.
   * @param sourceIDE optional IDE identifier (claude-code, cursor, codebuddy …)
   *   so the worker can stamp summaries with which IDE they originated from.
   */
  async summarizeSession(
    sessionId: string,
    transcriptPath?: string,
    sourceIDE?: string,
  ): Promise<void> {
    debugLog('summarizeSession', 'Starting', { sessionId, transcriptPath, sourceIDE });
    try {
      const response = await fetch(`${this.baseUrl}/api/session/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          sessionId,
          reason: 'session_complete',
          transcript_path: transcriptPath,
          sourceIDE,
        })
      });
      debugLog('summarizeSession', 'Response received', { status: response.status, ok: response.ok });
      if (!response.ok) {
        const errorText = await response.text();
        debugLog('summarizeSession', 'Response error', { status: response.status, errorText });
      }
    } catch (error) {
      debugLog('summarizeSession', 'ERROR', { error: String(error) });
      logger.debug('WORKER_CLIENT', 'summarizeSession failed (graceful)');
    }
  }
}

export default WorkerClient;
