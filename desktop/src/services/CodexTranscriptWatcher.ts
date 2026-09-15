import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Writable } from 'stream';
import type { HooksConfigPaths } from '../shared/hooks-config';

interface FileState {
  size: number;
  mtimeMs: number;
}

interface WatcherState {
  files: Record<string, FileState>;
}

interface ToolEvent {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput: Record<string, unknown>;
}

interface TranscriptDelta {
  userPrompts: string[];
  toolEvents: ToolEvent[];
  taskComplete: boolean;
}

const SCAN_INTERVAL_MS = 6_000;
const QUIET_MS = 5_000;
const MAX_FILES_PER_SCAN = 40;

export function writeHookPayload(stdin: Writable, payload: string): void {
  stdin.on('error', (error: NodeJS.ErrnoException) => {
    // The short-lived hook may exit before Electron finishes writing the
    // payload. That expected race reports EPIPE on stdin and must not reach
    // Electron's uncaught-exception dialog.
    if (error.code !== 'EPIPE') {
      console.warn('[CodexTranscriptWatcher] Failed to write hook payload:', error.message);
    }
  });
  stdin.end(payload);
}

export class CodexTranscriptWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private state: WatcherState = { files: {} };
  private readonly startedAtMs = Date.now();
  private readonly codexHome = path.join(os.homedir(), '.codex');
  private readonly sessionsDir = path.join(this.codexHome, 'sessions');
  private readonly statePath = path.join(os.homedir(), '.agent-memory', 'codex-live-watcher-state.json');
  private readonly transcriptProjectCache = new Map<string, string | null>();

  constructor(private readonly paths: HooksConfigPaths) {}

  start(): void {
    if (this.timer) return;
    if (!fs.existsSync(this.sessionsDir)) return;
    this.state = this.readState();
    void this.scanOnce();
    this.timer = setInterval(() => {
      void this.scanOnce();
    }, SCAN_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async scanOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const files = this.findRecentTranscripts();
      const now = Date.now();

      for (const file of files) {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        if (stat.size <= 0) continue;
        if (now - stat.mtimeMs < QUIET_MS) continue;

        const prev = this.state.files[file];
        const changed = !prev || prev.size !== stat.size || prev.mtimeMs !== stat.mtimeMs;
        if (!changed) continue;

        const deltaStart = prev?.size && prev.size < stat.size ? prev.size : stat.size;
        this.state.files[file] = { size: stat.size, mtimeMs: stat.mtimeMs };
        this.writeState();

        // Live-only means the desktop app should not backfill Codex activity
        // that happened while AgentMemory was not running. If the file was already
        // modified before this watcher started, advance the watermark only.
        if (stat.mtimeMs < this.startedAtMs) {
          continue;
        }

        // On first sight of an existing transcript, establish a baseline only.
        // This master-bugs-only build has no history importer; the live watcher
        // should only synthesize hooks for newly appended transcript data.
        if (!prev) {
          continue;
        }

        const delta = this.readDelta(file, deltaStart);
        for (const userPrompt of delta.userPrompts) {
          await this.invokeUserPromptHook(file, stat.mtimeMs, userPrompt);
        }
        for (const tool of delta.toolEvents) {
          await this.invokePostToolHook(file, stat.mtimeMs, tool);
        }

        // A quiet transcript file can simply mean the agent is waiting on a
        // long-running tool. Codex writes task_complete after the final
        // assistant response; only then should AgentMemory generate the per-turn summary.
        if (delta.taskComplete) {
          await this.invokeStopHook(file, stat.mtimeMs);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private findRecentTranscripts(): string[] {
    const out: Array<{ file: string; mtimeMs: number }> = [];
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(p);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        try {
          out.push({ file: p, mtimeMs: fs.statSync(p).mtimeMs });
        } catch {
          /* ignore disappearing files */
        }
      }
    };
    walk(this.sessionsDir);
    return out
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_FILES_PER_SCAN)
      .map((x) => x.file);
  }

  private async invokeStopHook(transcriptPath: string, mtimeMs: number): Promise<void> {
    await this.invokeHook('stop', transcriptPath, mtimeMs, {
      stop_hook_active: false,
      reason: 'codex_transcript_watcher',
    });
  }

  private async invokeUserPromptHook(transcriptPath: string, mtimeMs: number, prompt: string): Promise<void> {
    await this.invokeHook('user_prompt_submit', transcriptPath, mtimeMs, { prompt });
  }

  private async invokePostToolHook(transcriptPath: string, mtimeMs: number, tool: ToolEvent): Promise<void> {
    await this.invokeHook('post_tool_use', transcriptPath, mtimeMs, {
      tool_name: tool.toolName,
      tool_input: tool.toolInput,
      tool_response: tool.toolOutput,
      output: typeof tool.toolOutput.output === 'string' ? tool.toolOutput.output : undefined,
      error: typeof tool.toolOutput.error === 'string' ? tool.toolOutput.error : undefined,
      exit_code: typeof tool.toolOutput.exit_code === 'number' ? tool.toolOutput.exit_code : undefined,
    });
  }

  private async invokeHook(
    eventName: 'user_prompt_submit' | 'post_tool_use' | 'stop',
    transcriptPath: string,
    mtimeMs: number,
    extra: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = this.sessionIdFromTranscript(transcriptPath);
    const projectPath = this.projectPathForSession(sessionId, transcriptPath) ?? '';
    const payload = {
      hook_event_name: eventName,
      session_id: sessionId,
      turn_id: `codex-live-${eventName}-${Math.round(mtimeMs)}`,
      cwd: projectPath,
      transcript_path: transcriptPath,
      ...extra,
    };

    await new Promise<void>((resolve) => {
      const child = spawn(this.paths.nodePath, [this.paths.hooksCliPath, eventName], {
        env: {
          ...process.env,
          AGENTMEM_IDE: 'codex-cli',
          CODEX_PROJECT_DIR: projectPath,
        },
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      });
      child.on('error', () => resolve());
      child.on('exit', () => resolve());
      writeHookPayload(child.stdin, JSON.stringify(payload));
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* best effort */
        }
        resolve();
      }, 30_000).unref?.();
    });
  }

  private readDelta(transcriptPath: string, startOffset: number): TranscriptDelta {
    const text = this.readFromOffset(transcriptPath, startOffset);
    const calls = new Map<string, { toolName: string; toolInput: Record<string, unknown> }>();
    const outputs = new Map<string, Record<string, unknown>>();
    const userPrompts: string[] = [];
    let taskComplete = false;

    for (const line of text.split(/\r?\n/)) {
      const obj = this.parseJson(line);
      const payload = obj?.payload;

      if (obj?.type === 'event_msg') {
        if (payload?.type === 'task_complete') {
          taskComplete = true;
          continue;
        }
        if (payload?.type === 'mcp_tool_call_end' && typeof payload.call_id === 'string') {
          outputs.set(
            payload.call_id,
            this.mergeToolOutput(outputs.get(payload.call_id), this.parseMcpToolCallEnd(payload)),
          );
          continue;
        }
      }

      if (obj?.type !== 'response_item' || !payload || typeof payload !== 'object') continue;

      if (payload.type === 'message' && payload.role === 'user') {
        const content = this.contentToText(payload.content);
        if (content.trim()) userPrompts.push(content.trim());
        continue;
      }

      if (payload.type === 'function_call' && typeof payload.call_id === 'string') {
        const toolName = this.normalizeTranscriptToolName(payload);
        if (!this.shouldRecordTool(toolName)) continue;
        calls.set(payload.call_id, {
          toolName,
          toolInput: this.normalizeToolInput(toolName, this.parseToolArguments(payload.arguments)),
        });
      } else if (payload.type === 'custom_tool_call' && typeof payload.call_id === 'string') {
        const call = this.normalizeCustomToolCall(payload);
        if (!this.shouldRecordTool(call.toolName)) continue;
        calls.set(payload.call_id, call);
      } else if (payload.type === 'function_call_output' && typeof payload.call_id === 'string') {
        outputs.set(
          payload.call_id,
          this.mergeToolOutput(outputs.get(payload.call_id), this.parseToolOutput(payload.output)),
        );
      } else if (payload.type === 'custom_tool_call_output' && typeof payload.call_id === 'string') {
        outputs.set(
          payload.call_id,
          this.mergeToolOutput(outputs.get(payload.call_id), this.parseToolOutput(payload.output)),
        );
      }
    }

    const events: ToolEvent[] = [];
    for (const [callId, call] of calls) {
      events.push({
        ...call,
        toolOutput: outputs.get(callId) ?? {},
      });
    }
    return { userPrompts, toolEvents: events.slice(-30), taskComplete };
  }

  private normalizeTranscriptToolName(payload: Record<string, unknown>): string {
    const name = String(payload.name ?? '');
    const namespace = typeof payload.namespace === 'string' ? payload.namespace : '';
    if (namespace.startsWith('mcp__') && name && !name.startsWith('mcp__')) {
      return `${namespace}__${name}`;
    }
    return name;
  }

  private normalizeCustomToolCall(payload: Record<string, unknown>): {
    toolName: string;
    toolInput: Record<string, unknown>;
  } {
    const name = String(payload.name ?? '');
    const raw = typeof payload.input === 'string' ? payload.input : '';

    // Current Codex Desktop records the outer orchestration call as `exec`.
    // Preserve the nested operation's semantics so the existing hooks route it
    // to shell/file-edit Tier 1 processing instead of dropping it as unknown.
    if (name === 'exec' && /\bawait\s+tools\.apply_patch\s*\(/.test(raw)) {
      const patch = this.extractJavaScriptStringAssignment(raw, 'patch') ?? raw;
      return {
        toolName: 'apply_patch',
        toolInput: this.normalizeToolInput('apply_patch', { raw: patch }),
      };
    }
    if (name === 'exec' && /\bawait\s+tools\.exec_command\s*\(/.test(raw)) {
      const command = this.extractJavaScriptStringProperty(raw, 'cmd') ?? raw;
      const workdir = this.extractJavaScriptStringProperty(raw, 'workdir');
      return {
        toolName: 'shell_command',
        toolInput: { command, ...(workdir ? { workdir } : {}), raw },
      };
    }
    if (name === 'exec') {
      return { toolName: 'exec', toolInput: { command: raw, raw } };
    }
    return {
      toolName: name,
      toolInput: this.normalizeToolInput(name, this.parseToolArguments(payload.input)),
    };
  }

  private extractJavaScriptStringProperty(source: string, property: string): string | null {
    const pattern = new RegExp(`\\b${property}\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`);
    const match = source.match(pattern);
    if (!match) return null;
    try {
      return JSON.parse(match[1]) as string;
    } catch {
      return null;
    }
  }

  private extractJavaScriptStringAssignment(source: string, variable: string): string | null {
    const pattern = new RegExp(`\\b(?:const|let)\\s+${variable}\\s*=\\s*("(?:\\\\.|[^"\\\\])*")`);
    const match = source.match(pattern);
    if (!match) return null;
    try {
      return JSON.parse(match[1]) as string;
    } catch {
      return null;
    }
  }

  private shouldRecordTool(toolName: string): boolean {
    const name = toolName.toLowerCase();
    if (name === 'shell_command' || name === 'exec_command' || name === 'bash' || name === 'shell') return true;
    if (name === 'exec') return true;
    if (name === 'apply_patch' || name === 'write' || name === 'edit' || name === 'multiedit') return true;
    if (name.startsWith('mcp__')) return true;
    return false;
  }

  private parseToolArguments(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
    if (typeof raw !== 'string' || !raw.trim()) return {};
    const parsed = this.parseJson(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { raw };
  }

  private normalizeToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
    if (toolName.toLowerCase() !== 'apply_patch') return input;
    const raw = typeof input.raw === 'string' ? input.raw : '';
    if (!raw) return input;
    const match = raw.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m);
    return {
      ...input,
      file_path: typeof input.file_path === 'string' ? input.file_path : match?.[1]?.trim(),
      content: raw,
    };
  }

  private parseToolOutput(raw: unknown): Record<string, unknown> {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
    const parsed = this.parseJson(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return { output: text };
  }

  private parseMcpToolCallEnd(payload: Record<string, unknown>): Record<string, unknown> {
    const result = payload.result as Record<string, unknown> | undefined;
    const ok = result && Object.prototype.hasOwnProperty.call(result, 'Ok');
    const err = result && Object.prototype.hasOwnProperty.call(result, 'Err');
    const duration = payload.duration as Record<string, unknown> | undefined;
    const secs = typeof duration?.secs === 'number' ? duration.secs : undefined;
    const nanos = typeof duration?.nanos === 'number' ? duration.nanos : undefined;
    const durationMs = secs !== undefined || nanos !== undefined
      ? (secs ?? 0) * 1000 + (nanos ?? 0) / 1_000_000
      : undefined;

    return {
      data: ok ? result.Ok : result,
      success: ok ? true : (err ? false : undefined),
      error: err ? this.stringifyForOutput(result.Err) : undefined,
      duration_ms: durationMs,
    };
  }

  private mergeToolOutput(
    existing: Record<string, unknown> | undefined,
    next: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!existing) return next;
    return { ...next, ...existing, output: existing.output ?? next.output };
  }

  private stringifyForOutput(value: unknown): string | undefined {
    if (value == null) return undefined;
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private contentToText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .map((block) => {
        if (!block || typeof block !== 'object') return '';
        const b = block as Record<string, unknown>;
        return typeof b.text === 'string' ? b.text : '';
      })
      .filter(Boolean)
      .join('\n');
  }

  private readFromOffset(file: string, startOffset: number): string {
    try {
      const stat = fs.statSync(file);
      const start = Math.max(0, Math.min(startOffset, stat.size));
      const fd = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buffer, 0, buffer.length, start);
        return buffer.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return '';
    }
  }

  private parseJson(text: string): any | null {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  private sessionIdFromTranscript(transcriptPath: string): string {
    const stem = path.basename(transcriptPath, '.jsonl');
    const match = stem.match(/rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    return match?.[1] ?? stem;
  }

  private projectPathForSession(sessionId: string, transcriptPath?: string): string | null {
    if (transcriptPath) {
      const fromTranscript = this.projectPathFromTranscript(transcriptPath);
      if (fromTranscript) return fromTranscript;
    }
    try {
      const statePath = path.join(this.codexHome, '.codex-global-state.json');
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
        'thread-workspace-root-hints'?: Record<string, string>;
        'active-workspace-roots'?: string[];
      };
      const hinted = raw['thread-workspace-root-hints']?.[sessionId];
      if (this.isUsableProjectPath(hinted)) return path.normalize(hinted);
      const active = raw['active-workspace-roots'];
      if (Array.isArray(active) && this.isUsableProjectPath(active[0])) {
        return path.normalize(active[0]);
      }
    } catch {
      /* optional metadata */
    }
    return null;
  }

  private projectPathFromTranscript(transcriptPath: string): string | null {
    if (this.transcriptProjectCache.has(transcriptPath)) {
      return this.transcriptProjectCache.get(transcriptPath) ?? null;
    }

    let project: string | null = null;
    try {
      const stat = fs.statSync(transcriptPath);
      const length = Math.min(stat.size, 2 * 1024 * 1024);
      const fd = fs.openSync(transcriptPath, 'r');
      let text: string;
      try {
        const buffer = Buffer.alloc(length);
        const bytesRead = fs.readSync(fd, buffer, 0, length, 0);
        text = buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }

      for (const line of text.split(/\r?\n/)) {
        const obj = this.parseJson(line);
        if (obj?.type !== 'session_meta' && obj?.type !== 'turn_context') continue;
        const cwd = obj?.payload?.cwd;
        if (this.isUsableProjectPath(cwd)) {
          project = path.normalize(cwd.trim());
          break;
        }
      }
    } catch {
      /* transcript metadata is best effort */
    }

    this.transcriptProjectCache.set(transcriptPath, project);
    return project;
  }

  private isUsableProjectPath(value: unknown): value is string {
    if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value.trim())) return false;
    const normalized = path.normalize(value.trim());
    return normalized !== path.parse(normalized).root;
  }

  private readState(): WatcherState {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as WatcherState;
      if (parsed && typeof parsed === 'object' && parsed.files && typeof parsed.files === 'object') {
        return parsed;
      }
    } catch {
      /* no prior state */
    }
    return { files: {} };
  }

  private writeState(): void {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), 'utf8');
    } catch {
      /* watcher state is advisory */
    }
  }

}
