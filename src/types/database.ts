/**
 * Database entity types for SQLite storage
 * Adapted from claude-mem for CodeBuddy Agent
 */

/**
 * Helper function to normalize timestamps from various formats
 */
export function normalizeTimestamp(timestamp: string | Date | number | undefined): { isoString: string; epoch: number } {
  let date: Date;
  
  if (!timestamp) {
    date = new Date();
  } else if (timestamp instanceof Date) {
    date = timestamp;
  } else if (typeof timestamp === 'number') {
    date = new Date(timestamp);
  } else if (typeof timestamp === 'string') {
    if (!timestamp.trim()) {
      date = new Date();
    } else {
      date = new Date(timestamp);
      if (isNaN(date.getTime())) {
        const cleaned = timestamp.replace(/\s+/g, 'T').replace(/T+/g, 'T');
        date = new Date(cleaned);
        if (isNaN(date.getTime())) {
          date = new Date();
        }
      }
    }
  } else {
    date = new Date();
  }
  
  return {
    isoString: date.toISOString(),
    epoch: date.getTime()
  };
}

/**
 * Helper function to normalize project paths for consistent storage and querying.
 * On Windows, drive letters can vary in case (D:/ vs d:/) which causes SQL mismatches.
 * This function normalizes the path to lowercase for consistency.
 */
export function normalizeProjectPath(projectPath: string | undefined | null): string {
  if (!projectPath) {
    return '';
  }
  // Normalize path separators to forward slashes and convert to lowercase
  let normalized = projectPath.replace(/\\/g, '/').toLowerCase();
  
  // Cursor sometimes passes workspace roots with a leading slash on Windows (e.g., "/d:/github/...")
  // We need to strip the leading slash if it's followed by a drive letter to match CodeBuddy's format
  if (normalized.match(/^\/[a-z]:\//)) {
    normalized = normalized.substring(1);
  }
  
  return normalized;
}

/**
 * SDK Session Row - tracks CodeBuddy sessions
 */
export interface SDKSessionRow {
  id: number;
  content_session_id: string;
  memory_session_id: string | null;
  project: string;
  user_prompt: string | null;
  started_at: string;
  started_at_epoch: number;
  completed_at: string | null;
  completed_at_epoch: number | null;
  status: 'active' | 'completed' | 'failed';
  worker_port?: number;
  prompt_counter?: number;
  last_assistant_message?: string | null;
  transcript_path?: string | null;
  // 来源 IDE（原始 adapter id，如 cursor / codex-cli / claude-code）；未知时为 null
  source_ide?: string | null;
}

/**
 * Observation Row - stores structured observations from tool usage
 */
export interface ObservationRow {
  id: number;
  memory_session_id: string;
  project: string;
  text: string | null;
  type: string;  // observation type
  title: string | null;
  subtitle: string | null;
  meta_intent: string | null;
  facts: string | null;
  narrative: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number | null;
  discovery_tokens: number;
  // 分档蒸馏档位：0=丢弃(不入库) / 1=模板留痕 / 2=模型精写；历史行默认 2
  tier?: number;
  // 事件签名（toolName + 归一化 toolInput 哈希），用于会话内去重
  signature?: string | null;
  // 原始证据全文（仅 MCP，最长 100KB），用于事后溯源；不进 FTS、不进默认召回注入
  evidence?: string | null;
  // 来源 IDE（原始 adapter id，如 cursor / codex-cli / claude-code）；未知时为 null
  source_ide?: string | null;
  created_at: string;
  created_at_epoch: number;
}

/**
 * Session Summary Row - stores session summaries
 */
export interface SessionSummaryRow {
  id: number;
  display_rank?: number;
  memory_session_id: string;
  project: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  media_context: string | null;
  meta_intent: string | null;
  completed: string | null;
  next_steps: string | null;
  files_read: string | null;
  files_edited: string | null;
  notes: string | null;
  prompt_number: number | null;
  discovery_tokens: number;
  // 来源 IDE（原始 adapter id，如 cursor / codex-cli / claude-code）；未知时为 null
  source_ide?: string | null;
  created_at: string;
  created_at_epoch: number;
}

/**
 * User Prompt Row - stores user prompts
 */
export interface UserPromptRow {
  id: number;
  content_session_id: string;
  prompt_number: number;
  prompt_text: string;
  created_at: string;
  created_at_epoch: number;
}

/**
 * Pending Message Row - queue for messages waiting to be processed
 */
export interface PendingMessageRow {
  id: number;
  content_session_id: string;
  message_type: 'observation' | 'summary' | 'file_edit';
  payload: string;
  created_at: string;
  created_at_epoch: number;
  processed_at: string | null;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error_message: string | null;
}

/**
 * Search and Filter Types
 */
export interface DateRange {
  start?: string | number;
  end?: string | number;
}

export interface SearchFilters {
  project?: string;
  type?: ObservationRow['type'] | ObservationRow['type'][];
  concepts?: string | string[];
  files?: string | string[];
  dateRange?: DateRange;
}

export interface SearchOptions extends SearchFilters {
  limit?: number;
  offset?: number;
  orderBy?: 'relevance' | 'date_desc' | 'date_asc';
  isFolder?: boolean;
}

export interface ObservationSearchResult extends ObservationRow {
  rank?: number;
  score?: number;
}

export interface SessionSummarySearchResult extends SessionSummaryRow {
  rank?: number;
  score?: number;
}
