/**
 * Type definitions for the retroactive history import feature.
 *
 * Goal: backfill AgentMemory `session_summaries` from on-disk IDE transcripts
 * (Claude / claude-internal, Cursor Agent, CodeBuddy IDE, Codex App) so users who
 * just installed AgentMemory can immediately search their old conversations.
 *
 * Architecture: one ImportAdapter per IDE. Each adapter knows how to
 * locate transcript files on disk, walk them, and emit per-turn data
 * in a uniform shape for the orchestrator to summarize via AI.
 */

/**
 * Stable identifier for an import adapter.
 *
 * Mirrors AgentMemory's actual hook-integrated IDE list (the 5 you see in the setup
 * wizard's "IDE 关联" panel): Claude Code, Claude Internal, Cursor, CodeBuddy
 * IDE, CodeBuddy 插件版. Note that the import side groups Claude Code +
 * Claude Internal under a single `claude` adapter (they share the exact same
 * jsonl format, two roots).
 *
 * NOT the speculative ide-detection.ts list — codex-cli / gemini-cli / opencode
 * / windsurf / copilot-cli / antigravity / goose / crush / roo-code / warp are
 * "auto-detect candidates" but AgentMemory doesn't actually install hooks for them;
 * import adapters for those would be misleading.
 */
export type ImportAdapterId =
  | 'claude'           // ~/.claude-internal/projects/ (Tencent) and ~/.claude/projects/ (official CLI)
  | 'cursor-agent'     // ~/.cursor/projects/<ws>/agent-transcripts/
  | 'codebuddy-ide'    // %LOCALAPPDATA%/CodeBuddyExtension/Data/.../history/
  | 'codex-cli';       // ~/.codex/sessions/**/rollout-*.jsonl (official Codex App / CLI)
//
// codebuddy-plugin (`gongfeng.gongfeng-copilot` VSCode-family extension) is
// the 5th IDE in the wizard but its on-disk schema needs to be reverse-
// engineered from a real chat session — added in a follow-up patch once a
// non-empty `chat_history_list.json` sample is available.

/**
 * One transcript file on disk = one IDE conversation/session.
 * The adapter's discoverSessions() emits these; iterateTurns() consumes them.
 */
export interface TranscriptFile {
  adapterId: ImportAdapterId;
  /** Absolute path to the primary transcript file (jsonl or index.json). */
  filePath: string;
  /** IDE-native session id, when extractable from path or content. */
  sessionId: string | null;
  /** Best-effort project / cwd reconstruction at discovery time. May be refined per-turn. */
  cwd: string | null;
  /** Approximate transcript modification time (epoch ms), for sorting / filtering. */
  mtimeMs: number;
  /** Adapter-specific extra context (e.g. workspace folder name). */
  extra?: Record<string, unknown>;
}

/**
 * One user→assistant turn extracted from a transcript file.
 * The orchestrator turns each Turn into a single AgentMemory session_summaries row.
 */
export interface Turn {
  adapterId: ImportAdapterId;
  /** sha256(adapterId|fileAbsPath|turnIndex|userText[0..512]) — used for idempotency. */
  fingerprint: string;
  /** Source transcript file path (absolute). */
  filePath: string;
  /** IDE-native session id propagated from the parent transcript when available. */
  sessionId: string | null;
  /** 0-based index of this turn within the transcript. */
  turnIndex: number;
  /** The user's prompt text for this turn. May be truncated by adapter. */
  userText: string;
  /** The assistant's reply for this turn. May be truncated by adapter. */
  assistantText: string;
  /** Tool calls observed inside the assistant message blocks of this turn. */
  toolUses: Array<{ name: string; inputSummary: string }>;
  /** Best-effort cwd / project root for this specific turn. */
  cwd: string | null;
  /** Turn start timestamp in epoch ms (from transcript line). */
  startedAt: number;
}

/**
 * Per-adapter discovery result, used both for dry-run reporting and as input
 * to the orchestrator's turn iteration phase.
 */
export interface AdapterDiscoveryResult {
  adapterId: ImportAdapterId;
  /** Roots that were probed (used for diagnostic output). */
  probedRoots: Array<{ path: string; exists: boolean }>;
  /** Transcript files found across all existing roots. */
  files: TranscriptFile[];
}

/**
 * Aggregate discovery result for all enabled adapters.
 * Cheap to compute (file IO only, no AI calls) — safe to call on desktop first-launch.
 */
export interface DiscoveryReport {
  adapters: AdapterDiscoveryResult[];
  totalFiles: number;
  /**
   * Approximate total turn count. Approximate because counting exactly requires
   * parsing each file; adapters may estimate by line count for performance.
   */
  estimatedTurns: number;
}

/**
 * Adapter contract — three implementations live under ./adapters/.
 *
 * Adapters are stateless: all I/O happens lazily inside discoverSessions /
 * iterateTurns so the orchestrator can stream and apply concurrency limits.
 */
export interface ImportAdapter {
  readonly id: ImportAdapterId;
  /** Human-readable display name for CLI / UI. */
  readonly displayName: string;
  /**
   * Roots to probe, in priority order. Returning [] (or returning roots that
   * none exist) is fine — callers must treat "no transcripts" as a non-error.
   */
  roots(): string[];
  /**
   * Walk the existing roots and return one entry per transcript file found.
   * Implementations should be cheap (stat + dirent only); leave parse work to iterateTurns.
   */
  discoverSessions(): Promise<AdapterDiscoveryResult>;
  /**
   * Stream Turns from a single transcript file in order. Implementations must
   * skip non-conversational metadata lines (e.g. {type:"last-prompt"}) and only
   * yield real user→assistant pairs.
   *
   * NOTE: orchestrator now operates at session granularity (one transcript
   * file = one AgentMemory summary). The per-turn iterator is kept here because it's
   * the cleanest way to reuse adapter parsing logic — `collectSession()`
   * consumes it and rolls all turns into a single SessionData.
   */
  iterateTurns(file: TranscriptFile): AsyncIterable<Turn>;
}

/**
 * One whole IDE session = one AgentMemory summary (per-session granularity).
 * Built by `collectSession()` from the per-turn stream of an adapter.
 *
 * The session-level summary mirrors what the online Stop hook produces
 * (1 summary per IDE session), so import and online captures share the
 * same row shape and search semantics.
 */
export interface SessionData {
  adapterId: ImportAdapterId;
  /** Absolute path of the source transcript file. */
  filePath: string;
  /**
   * Stable session identifier extracted from the IDE itself (UUID for
   * Claude/Cursor jsonl files, conversation hash for CodeBuddy IDE).
   * Falls back to file basename if missing.
   */
  sessionId: string;
  /** Best-effort cwd / project root, taken from the most authoritative turn. */
  cwd: string | null;
  /** First-turn timestamp (epoch ms). Used for hook-overlap window check. */
  firstTurnAtMs: number;
  /** Last-turn timestamp (epoch ms). The decisive boundary for hook-overlap. */
  lastTurnAtMs: number;
  /** All turns in chronological order. May be sliced by the orchestrator if too long. */
  turns: Turn[];
  /**
   * sha256(adapterId + '|' + sessionId) — primary key for idempotency.
   * No filePath dependency means moving / renaming the file doesn't break dedup.
   */
  fingerprint: string;
}

/** Options accepted by runImport(). */
export interface ImportOptions {
  /** If set, only run these adapter ids; otherwise run every detected adapter. */
  adapterIds?: ImportAdapterId[];
  /** Optional adapter-specific override of roots()[0] for non-standard installs. */
  rootOverrides?: Partial<Record<ImportAdapterId, string>>;
  /** Filter sessions by cwd (after normalizeProjectPath). */
  projectFilter?: string;
  /** Skip turns whose timestamp is before this (epoch ms). */
  sinceMs?: number;
  /** Skip turns whose timestamp is after this (epoch ms). */
  untilMs?: number;
  /** Max concurrent AI calls. Default 2. */
  concurrency?: number;
  /** Max AI requests per minute. Default 30. */
  ratePerMinute?: number;
  /**
   * Hard cap on TURNS processed in this run (the AI-budget ceiling, since
   * each turn = 1 AI call = 1 summary row, mirroring online hook). Default
   * 1000. Was `maxSessions` in the per-session era — at v1.1 we count turns
   * directly so the cap maps cleanly to "max AI calls".
   */
  maxTurns?: number;
  /**
   * Deprecated alias for backward compatibility — old callers pass
   * `maxSessions` and we treat it as `maxTurns`. New callers should use
   * `maxTurns`.
   */
  maxSessions?: number;
  /** If true, only discover + count, do not call AI or write DB. */
  dryRun?: boolean;
  /** If true, skip turns whose fingerprint is already in import_history_fingerprints. Default true. */
  skipFingerprinted?: boolean;
  /**
   * If true, skip a turn when an online hook summary already exists for the
   * same project within a turn-boundary range. The range is asymmetric:
   * `[turn.startedAt - 60s, nextTurn.startedAt + 60s]` (or +12h for the last
   * turn). This matches the fact that hook fires AFTER the assistant finishes
   * responding (so its created_at ≈ end-of-turn) while imports use
   * start-of-turn — a symmetric ±5min window would miss duplicates whose
   * separation is just agent processing time. Default true.
   */
  skipHookOverlap?: boolean;
}

/** Snapshot of import progress, emitted on every state change. */
export interface ImportProgressSnapshot {
  phase: 'discovering' | 'running' | 'done' | 'cancelled' | 'failed';
  /**
   * Total turns identified in this run (after all pre-filters). Each turn
   * = 1 AI call = 1 summary row. Renamed from totalSessions in v1.1.
   */
  totalSessions: number;       // legacy alias = totalTurns; kept for IPC compat
  totalTurns: number;
  /** Turns whose AI call has completed (success or fail). */
  processedSessions: number;   // legacy alias = processedTurns
  processedTurns: number;
  /** Turns successfully imported as a session_summaries row. */
  importedSummaries: number;
  /**
   * Turns skipped — combined number for the FINAL report. Includes both
   * pre-filter drops (zero-cost: fingerprint dedup, hook-overlap dedup,
   * empty turns) AND mid-run drops (AI returned unparseable result).
   *
   * For per-step UI rendering prefer the split fields below — `skippedTurns`
   * matches users' mental model of "skipped during AI work" while
   * `preFilteredTurns` shows the dedup'd-away pile separately so users
   * don't see a scary "跳过 2000" next to "成功 50".
   */
  skippedSessions: number;     // legacy alias = skippedTurns + preFilteredTurns
  skippedTurns: number;        // mid-run skip only (parser failures)
  /**
   * Pre-filter drops (NOT counted in totalTurns; surfaced separately).
   * Mostly hook-overlap matches and already-imported fingerprint matches.
   * Zero AI cost, zero work — informational only.
   */
  preFilteredTurns: number;
  /** Turns that failed (AI call threw or parser returned null). */
  failedSessions: number;      // legacy alias = failedTurns
  failedTurns: number;
  currentAdapterId?: ImportAdapterId;
  currentFilePath?: string;
  /** Estimated seconds remaining (null when not enough samples yet). */
  etaSec: number | null;
  /** Last error message when phase=failed. */
  errorMessage?: string;
}

/** Final outcome returned by runImport(). */
export interface ImportResult {
  /** Total turns processed (legacy field name kept for IPC compat). */
  totalSessions: number;
  totalTurns: number;
  importedSummaries: number;
  skippedSessions: number;
  skippedTurns: number;
  failedSessions: number;
  failedTurns: number;
  durationMs: number;
  perAdapter: Array<{
    adapterId: ImportAdapterId;
    imported: number;
    skipped: number;
    failed: number;
  }>;
}

/** Optional progress callback shape. */
export type ImportProgressListener = (snapshot: ImportProgressSnapshot) => void;
