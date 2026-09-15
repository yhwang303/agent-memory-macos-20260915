/**
 * SQLite Database initialization and management
 * Adapted from claude-mem for CodeBuddy Agent
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { getDataDir } from '../../shared/paths.js';

let db: Database.Database | null = null;

/**
 * Get or create the SQLite database instance
 */
export function getDatabase(): Database.Database {
  if (db) return db;
  
  const dataDir = getDataDir();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  const dbPath = path.join(dataDir, 'agent-memory.db');
  
  try {
    // 设置 timeout 以处理数据库被锁定的情况
    db = new Database(dbPath, { timeout: 10000 }); // 10秒超时
    
    // Enable WAL mode for better concurrency (allows multiple readers)
    db.pragma('journal_mode = WAL');
    
    // 设置 busy_timeout 处理并发写入
    db.pragma('busy_timeout = 10000'); // 10秒
    
    // 启用外键约束
    db.pragma('foreign_keys = ON');
    
    // 同步模式设为 NORMAL（平衡性能和安全）
    db.pragma('synchronous = NORMAL');
    
    console.error(`[DATABASE] Opened database at ${dbPath}`);
    
    // Initialize tables
    initializeTables(db);
    
    return db;
  } catch (error) {
    console.error(`[DATABASE] !!! FAILED TO OPEN DATABASE !!!`, {
      path: dbPath,
      error: String(error),
      stack: (error as Error).stack
    });
    throw error;
  }
}

/**
 * 期望的表列定义（仅需列出可能在旧版本中缺失的列）
 * 格式: { 表名: { 列名: "列类型 + 约束" } }
 * 新增字段时只需在此处添加一行即可。
 */
const EXPECTED_COLUMNS: Record<string, Record<string, string>> = {
  sdk_sessions: {
    last_assistant_message: 'TEXT',
    transcript_path: 'TEXT',
    device_id: 'TEXT',
    source_ide: 'TEXT',
    synced_at: 'INTEGER',
  },
  observations: {
    meta_intent: 'TEXT',
    facts: 'TEXT',
    narrative: 'TEXT',
    concepts: 'TEXT',
    discovery_tokens: 'INTEGER DEFAULT 0',
    device_id: 'TEXT',
    source_ide: 'TEXT',
    synced_at: 'INTEGER',
    // 分档蒸馏：旧库自动补列，历史行默认 tier=2（召回零影响）
    tier: 'INTEGER DEFAULT 2',
    // 事件签名，用于会话内去重（非文本检索列，不进 FTS）
    signature: 'TEXT',
    // 原始证据全文（仅 MCP），用于事后溯源；非文本检索列，不进 FTS、不进默认召回注入
    evidence: 'TEXT',
  },
  session_summaries: {
    media_context: 'TEXT',
    meta_intent: 'TEXT',
    discovery_tokens: 'INTEGER DEFAULT 0',
    device_id: 'TEXT',
    source_ide: 'TEXT',
    synced_at: 'INTEGER',
  },
  sync_queue: {
    priority: 'INTEGER NOT NULL DEFAULT 10',
  },
};

/**
 * 自动检测并补全数据库中缺失的列。
 * 如果有列被添加，还会重建对应的 FTS 虚拟表以保持同步。
 */
export function ensureMissingColumns(database: Database.Database): Set<string> {
  let totalAdded = 0;
  const tablesWithChanges = new Set<string>();

  try {
    for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
      // 获取现有列名
      const existingCols = database
        .prepare(`PRAGMA table_info(${table})`)
        .all() as { name: string }[];
      // 若表不存在则跳过（PRAGMA table_info 对不存在的表返回空数组）
      if (existingCols.length === 0) continue;
      const existingColNames = new Set(existingCols.map((c) => c.name));

      for (const [colName, colDef] of Object.entries(columns)) {
        if (!existingColNames.has(colName)) {
          console.log(`[Migration] Adding missing column '${colName}' to table '${table}'`);
          database.exec(`ALTER TABLE ${table} ADD COLUMN ${colName} ${colDef}`);
          totalAdded++;
          tablesWithChanges.add(table);
        }
      }
    }

    if (totalAdded === 0) {
      console.log('[Migration] All tables are up to date');
      return tablesWithChanges;
    }

    console.log(`[Migration] Added ${totalAdded} missing column(s)`);

    // 如果 observations 表有变更，重建 observations_fts
    if (tablesWithChanges.has('observations')) {
      console.log('[Migration] Rebuilding observations_fts...');
      database.exec('DROP TABLE IF EXISTS observations_fts');
      database.exec('DROP TRIGGER IF EXISTS observations_ai');
    }

    // 如果 session_summaries 表有变更，重建 summaries_fts
    if (tablesWithChanges.has('session_summaries')) {
      console.log('[Migration] Rebuilding summaries_fts...');
      database.exec('DROP TABLE IF EXISTS summaries_fts');
      database.exec('DROP TRIGGER IF EXISTS summaries_ai');
    }
    // FTS 表和触发器会在后续的 CREATE VIRTUAL TABLE / CREATE TRIGGER 语句中重新创建
  } catch (err) {
    console.error('[Migration] Schema migration failed (non-fatal):', err);
    // 不抛异常，不阻止数据库初始化
  }

  return tablesWithChanges;
}

/**
 * Initialize Injector plugin tables.
 * Plugin-owned ledger: records what was injected, where, version, and a backup
 * descriptor enabling reversible uninstall. Idempotent.
 */
function initializeInjectorTables(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS injector_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT NOT NULL,
      ide TEXT NOT NULL,
      injectable_id TEXT NOT NULL,
      version TEXT NOT NULL,
      target_path TEXT NOT NULL,
      mode TEXT NOT NULL,
      backup TEXT,
      injected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    )
  `);
  database.exec(
    'CREATE INDEX IF NOT EXISTS idx_injector_ledger_ws ON injector_ledger(workspace)'
  );
}

/**
 * Initialize Self-Evolve plugin tables.
 * Idempotent; safe to call on every database init.
 */
function initializeSelfEvolveTables(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS evolved_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      slug TEXT,
      paths_glob TEXT,
      source_session_id TEXT,
      evidence TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      rule_type TEXT NOT NULL DEFAULT 'user_evolved',
      quality_score INTEGER,
      feedback TEXT,
      audit_status TEXT NOT NULL DEFAULT 'pending',
      review_status TEXT NOT NULL DEFAULT 'auto',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      UNIQUE(workspace, title)
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS evolved_skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace TEXT NOT NULL,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      trigger_scene TEXT,
      description TEXT,
      skill_kind TEXT NOT NULL DEFAULT 'markdown',
      skill_md TEXT,
      manifest_json TEXT,
      source_session_id TEXT,
      evidence TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      quality_score INTEGER,
      audit_status TEXT NOT NULL DEFAULT 'pending',
      review_status TEXT NOT NULL DEFAULT 'auto',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      UNIQUE(workspace, slug)
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS evolution_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      workspace TEXT NOT NULL,
      rules_added INTEGER NOT NULL DEFAULT 0,
      rules_updated INTEGER NOT NULL DEFAULT 0,
      skills_added INTEGER NOT NULL DEFAULT 0,
      rejected_rules INTEGER NOT NULL DEFAULT 0,
      rejected_skills INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      error_message TEXT,
      raw_output TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS natural_selection (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'all',
      type TEXT NOT NULL DEFAULT 'append',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    )
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_evolved_rules_workspace ON evolved_rules(workspace);
    CREATE INDEX IF NOT EXISTS idx_evolved_rules_status ON evolved_rules(workspace, status);
    CREATE INDEX IF NOT EXISTS idx_evolved_rules_audit ON evolved_rules(audit_status);
    CREATE INDEX IF NOT EXISTS idx_evolved_skills_workspace ON evolved_skills(workspace);
    CREATE INDEX IF NOT EXISTS idx_evolved_skills_status ON evolved_skills(workspace, status);
    CREATE INDEX IF NOT EXISTS idx_evolved_skills_audit ON evolved_skills(audit_status);
    CREATE INDEX IF NOT EXISTS idx_evolution_log_session ON evolution_log(memory_session_id);
    CREATE INDEX IF NOT EXISTS idx_evolution_log_workspace ON evolution_log(workspace);
  `);
}

/**
 * Create the chroma_sync_state table for tracking SQLite→Chroma sync status.
 * Idempotent; safe to call on every database init.
 */
export function ensureChromaSyncState(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chroma_sync_state (
      doc_id TEXT PRIMARY KEY,
      synced_at INTEGER,
      embedding_hash TEXT,
      status TEXT
    )
  `);
  database.exec(`CREATE INDEX IF NOT EXISTS idx_chroma_sync_status ON chroma_sync_state(status)`);
}

/**
 * Initialize database tables
 */
function initializeTables(database: Database.Database): void {
  // SDK Sessions table
  database.exec(`
    CREATE TABLE IF NOT EXISTS sdk_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT NOT NULL UNIQUE,
      memory_session_id TEXT,
      project TEXT NOT NULL,
      user_prompt TEXT,
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL,
      completed_at TEXT,
      completed_at_epoch INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      worker_port INTEGER,
      prompt_counter INTEGER DEFAULT 0
    )
  `);
  
  // Observations table
  database.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      text TEXT,
      type TEXT NOT NULL,
      title TEXT,
      subtitle TEXT,
      meta_intent TEXT,
      facts TEXT,
      narrative TEXT,
      concepts TEXT,
      files_read TEXT,
      files_modified TEXT,
      prompt_number INTEGER,
      discovery_tokens INTEGER DEFAULT 0,
      tier INTEGER DEFAULT 2,
      signature TEXT,
      evidence TEXT,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    )
  `);
  
  // Session summaries table
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      request TEXT,
      investigated TEXT,
      learned TEXT,
      meta_intent TEXT,
      completed TEXT,
      next_steps TEXT,
      files_read TEXT,
      files_edited TEXT,
      notes TEXT,
      prompt_number INTEGER,
      discovery_tokens INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    )
  `);
  
  // User prompts table
  database.exec(`
    CREATE TABLE IF NOT EXISTS user_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT NOT NULL,
      prompt_number INTEGER NOT NULL,
      prompt_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    )
  `);
  
  // Pending messages queue
  database.exec(`
    CREATE TABLE IF NOT EXISTS pending_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      processed_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT
    )
  `);

  // Sync queue table for cross-device sync
  // priority: 10 = realtime (high), 0 = backfill (low). Consumer ORDER BY priority DESC, created_at ASC.
  database.exec(`
    CREATE TABLE IF NOT EXISTS sync_queue (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      kind          TEXT NOT NULL,
      client_uuid   TEXT NOT NULL UNIQUE,
      payload_json  TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      attempts      INTEGER NOT NULL DEFAULT 0,
      last_error    TEXT,
      next_retry_at INTEGER,
      created_at    INTEGER NOT NULL,
      synced_at     INTEGER,
      priority      INTEGER NOT NULL DEFAULT 10
    )
  `);

  // Idempotency table for the retroactive history import feature.
  // Each row marks one (adapter, file, turnIndex) pair as already imported,
  // so re-running import-history is naturally incremental and never duplicates
  // AI calls or summary rows. summary_id back-links to the inserted summary.
  database.exec(`
    CREATE TABLE IF NOT EXISTS import_history_fingerprints (
      fingerprint TEXT PRIMARY KEY,
      adapter_id  TEXT NOT NULL,
      file_path   TEXT NOT NULL,
      turn_index  INTEGER NOT NULL,
      summary_id  INTEGER,
      imported_at INTEGER NOT NULL
    )
  `);

  // 自动检测并补全缺失列（处理旧数据库升级场景）
  // 必须在 CREATE INDEX 之前执行，否则引用新列（如 sync_queue.priority）的索引会因列不存在而报错。
  const tablesWithChanges = ensureMissingColumns(database);

  // Create indexes for better query performance
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project);
    CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(memory_session_id);
    CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
    CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch);
    CREATE INDEX IF NOT EXISTS idx_observations_tier ON observations(tier);
    CREATE INDEX IF NOT EXISTS idx_summaries_project ON session_summaries(project);
    CREATE INDEX IF NOT EXISTS idx_summaries_session ON session_summaries(memory_session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_content ON sdk_sessions(content_session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sdk_sessions(project);
    CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_messages(status);
    CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status, next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_sync_queue_priority ON sync_queue(status, priority DESC, next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_imp_fp_adapter ON import_history_fingerprints(adapter_id);
    CREATE INDEX IF NOT EXISTS idx_imp_fp_file ON import_history_fingerprints(file_path);
  `);

  // 重复写入兜底:同一 sid + 同 signature 在 DB 层强制唯一。
  // - observations:configurer 计算的 signature 已经包含 toolName + 归一化 payload,
  //   同一会话内同一动作的二次写入会撞这个索引,配合 INSERT OR IGNORE 静默落地。
  // - session_summaries:Stop hook 重复触发会反复调用 generateSummary;以
  //   memory_session_id + 取整到分钟的 epoch 作为复合键,等价"同会话每分钟最多一条"。
  //   (实际去重主要靠 SDKAgent 层的 inflight 锁与 no-new-obs guard,DB 索引只是兜底。)
  // 历史 DB 中已经存在的重复行不会被自动删除,但新插入会被这里拦住。
  // 历史已有重复行可能让 CREATE UNIQUE INDEX 失败,这里失败时降级为普通 index,
  // 应用层(SDKAgent inflight + no-new-obs)依然能堵住绝大多数重复路径。
  try {
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_observations_unique_sig
        ON observations(memory_session_id, signature)
        WHERE signature IS NOT NULL;
    `);
  } catch (err) {
    console.warn('[Migration] Could not create UNIQUE INDEX on observations(memory_session_id, signature) — pre-existing duplicates likely; falling back to non-unique index. Application-layer dedup remains active.', err);
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_observations_unique_sig
        ON observations(memory_session_id, signature);
    `);
  }
  try {
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_unique_minute
        ON session_summaries(memory_session_id, (created_at_epoch / 60000));
    `);
  } catch (err) {
    console.warn('[Migration] Could not create UNIQUE INDEX on session_summaries(memory_session_id, minute) — pre-existing duplicates likely; falling back to non-unique index.', err);
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_summaries_unique_minute
        ON session_summaries(memory_session_id, created_at_epoch);
    `);
  }
  
  // Create FTS5 virtual tables for full-text search
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
      text, title, subtitle, meta_intent, facts, narrative, concepts,
      content='observations',
      content_rowid='id'
    )
  `);
  
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
      request, investigated, learned, media_context, meta_intent, completed, next_steps, notes,
      content='session_summaries',
      content_rowid='id'
    )
  `);
  
  // Create triggers to keep FTS in sync
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, text, title, subtitle, meta_intent, facts, narrative, concepts)
      VALUES (new.id, new.text, new.title, new.subtitle, new.meta_intent, new.facts, new.narrative, new.concepts);
    END
  `);
  
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS summaries_ai AFTER INSERT ON session_summaries BEGIN
      INSERT INTO summaries_fts(rowid, request, investigated, learned, media_context, meta_intent, completed, next_steps, notes)
      VALUES (new.id, new.request, new.investigated, new.learned, new.media_context, new.meta_intent, new.completed, new.next_steps, new.notes);
    END
  `);

  // FTS 表重建后，将主表历史数据回填到 FTS 索引中
  if (tablesWithChanges.has('observations')) {
    console.log('[Migration] Backfilling observations_fts with existing data...');
    database.exec(`
      INSERT INTO observations_fts(rowid, text, title, subtitle, meta_intent, facts, narrative, concepts)
      SELECT id, text, title, subtitle, meta_intent, facts, narrative, concepts FROM observations
    `);
  }
  if (tablesWithChanges.has('session_summaries')) {
    console.log('[Migration] Backfilling summaries_fts with existing data...');
    database.exec(`
      INSERT INTO summaries_fts(rowid, request, investigated, learned, media_context, meta_intent, completed, next_steps, notes)
      SELECT id, request, investigated, learned, media_context, meta_intent, completed, next_steps, notes FROM session_summaries
    `);
  }

  // Self-Evolve plugin tables
  initializeSelfEvolveTables(database);

  // Injector plugin tables
  initializeInjectorTables(database);

  // Chroma sync state table (M2)
  ensureChromaSyncState(database);

  // 一次性脏数据迁移:① imported:cursor-agent → imported:cursor;
  //                  ② 同 memory_session_id 多 source_ide → 统一为最早一条。
  // 幂等:每次启动跑一次,只对仍然脏的行 UPDATE,无脏行即 no-op。
  runSourceIdeDataMigration(database);
}

/**
 * 启动迁移:把历史脏数据修干净。
 *
 * 触发场景:
 *  - imported:cursor-agent 是早期适配器命名,06-10 之后展示层已统一为
 *    imported:cursor;但旧 import 写入的行没动过。
 *  - 同一会话被两路 hook 并发写入(典型:claude-internal session 里混进
 *    cursor 标签),导致同 sid 出现 ≥2 种 source_ide。
 *
 * 策略:
 *  ① 全表 UPDATE imported:cursor-agent → imported:cursor (observations + summaries)
 *  ② 找出 ≥2 种 source_ide 的 sid,以最早一条 source_ide(created_at_epoch ASC)
 *     为准,UPDATE 该 sid 下所有行。
 */
function runSourceIdeDataMigration(database: Database.Database): void {
  try {
    // ── ① 名称别名 ──
    const r1 = database.prepare(
      "UPDATE observations SET source_ide = 'imported:cursor' WHERE source_ide = 'imported:cursor-agent'"
    ).run();
    const r2 = database.prepare(
      "UPDATE session_summaries SET source_ide = 'imported:cursor' WHERE source_ide = 'imported:cursor-agent'"
    ).run();

    // ── ①.b imported:claude → imported:claude-internal / imported:claude-code ──
    // 旧版 ClaudeAdapter 把腾讯内网 .claude-internal 与 Anthropic 官方 .claude 都
    // 标成 imported:claude;现在按 notes 里持久化的 original_path 拆开。
    // notes 模板:`...; original_path=<abs-path>` (db-write.ts L82),用 LIKE 兜
    // 着取(SQLite 没有 regex builtin),命中 .claude-internal/ 的优先,其余落到
    // .claude/ 视为 claude-code。
    const ci1 = database.prepare(
      `UPDATE observations
          SET source_ide = 'imported:claude-internal'
        WHERE source_ide = 'imported:claude'
          AND (notes LIKE '%.claude-internal' || char(92) || '%'
            OR notes LIKE '%.claude-internal/%')`,
    ).run();
    const ci2 = database.prepare(
      `UPDATE session_summaries
          SET source_ide = 'imported:claude-internal'
        WHERE source_ide = 'imported:claude'
          AND (notes LIKE '%.claude-internal' || char(92) || '%'
            OR notes LIKE '%.claude-internal/%')`,
    ).run();
    const cc1 = database.prepare(
      `UPDATE observations
          SET source_ide = 'imported:claude-code'
        WHERE source_ide = 'imported:claude'
          AND (notes LIKE '%.claude' || char(92) || '%'
            OR notes LIKE '%.claude/%')`,
    ).run();
    const cc2 = database.prepare(
      `UPDATE session_summaries
          SET source_ide = 'imported:claude-code'
        WHERE source_ide = 'imported:claude'
          AND (notes LIKE '%.claude' || char(92) || '%'
            OR notes LIKE '%.claude/%')`,
    ).run();

    // ── ② 同 sid 多 source_ide 统一为最早一条(覆盖 NULL 与不一致两种情况) ──
    // 触发场景:
    //   a) 多 IDE 并发命中同 sid(典型:claude-internal session 里混入 cursor 标签)
    //   b) 部分 obs 由非 hook 写入(没有 source_ide)+ 部分有 hook 标记
    // 修复策略:取该 sid 下最早一条非空 source_ide,UPDATE 整个 sid 的所有行。
    const dirtySids = database.prepare(`
      SELECT memory_session_id AS sid
        FROM observations
       GROUP BY memory_session_id
      HAVING COUNT(source_ide) > 0
         AND (
              COUNT(DISTINCT source_ide) > 1
              OR COUNT(source_ide) < COUNT(*)
            )
    `).all() as Array<{ sid: string }>;

    let unifiedRows = 0;
    for (const { sid } of dirtySids) {
      const earliest = database.prepare(`
        SELECT source_ide FROM observations
         WHERE memory_session_id = ? AND source_ide IS NOT NULL AND source_ide != ''
         ORDER BY created_at_epoch ASC, id ASC LIMIT 1
      `).get(sid) as { source_ide: string } | undefined;
      if (!earliest) continue;
      const u1 = database.prepare(
        `UPDATE observations SET source_ide = ? WHERE memory_session_id = ? AND (source_ide IS NULL OR source_ide != ?)`
      ).run(earliest.source_ide, sid, earliest.source_ide);
      const u2 = database.prepare(
        `UPDATE session_summaries SET source_ide = ? WHERE memory_session_id = ? AND (source_ide IS NULL OR source_ide != ?)`
      ).run(earliest.source_ide, sid, earliest.source_ide);
      unifiedRows += (u1.changes ?? 0) + (u2.changes ?? 0);
    }

    const totalChanges =
      (r1.changes ?? 0) + (r2.changes ?? 0) +
      (ci1.changes ?? 0) + (ci2.changes ?? 0) +
      (cc1.changes ?? 0) + (cc2.changes ?? 0) +
      unifiedRows;
    if (totalChanges > 0) {
      console.error('[DATABASE] source_ide migration:',
        `cursor-agent→cursor obs=${r1.changes} sums=${r2.changes};`,
        `claude→claude-internal obs=${ci1.changes} sums=${ci2.changes};`,
        `claude→claude-code obs=${cc1.changes} sums=${cc2.changes};`,
        `unified-multi-ide sids=${dirtySids.length} rows=${unifiedRows}`);
    }
  } catch (error) {
    // 迁移失败不能阻塞启动 — 记日志兜底
    console.error('[DATABASE] source_ide migration failed (non-fatal):', error);
  }
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    try {
      // 执行 checkpoint 确保 WAL 日志写入主数据库
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
      console.error('[DATABASE] Database closed gracefully');
    } catch (error) {
      console.error('[DATABASE] Error closing database:', error);
    }
    db = null;
  }
}

/**
 * 执行带错误处理的数据库操作
 * 用于包装可能因并发访问而失败的操作
 */
export function withRetry<T>(operation: () => T, maxRetries = 3): T {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return operation();
    } catch (error) {
      lastError = error as Error;
      const errorMsg = String(error);
      
      // 如果是数据库锁定错误，等待后重试
      if (errorMsg.includes('SQLITE_BUSY') || errorMsg.includes('database is locked')) {
        console.error(`[DATABASE] Database locked, retrying (${attempt + 1}/${maxRetries})...`);
        // 使用同步等待（better-sqlite3 是同步的）
        const waitMs = 100 * (attempt + 1);
        const end = Date.now() + waitMs;
        while (Date.now() < end) { /* busy wait */ }
        continue;
      }
      
      // 其他错误直接抛出
      throw error;
    }
  }
  
  throw lastError;
}

/**
 * Get database statistics
 */
export function getDatabaseStats(): {
  observations: number;
  summaries: number;
  sessions: number;
  pendingMessages: number;
} {
  const database = getDatabase();
  
  const observations = database.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
  const summaries = database.prepare('SELECT COUNT(*) as count FROM session_summaries').get() as { count: number };
  const sessions = database.prepare('SELECT COUNT(*) as count FROM sdk_sessions').get() as { count: number };
  const pendingMessages = database.prepare("SELECT COUNT(*) as count FROM pending_messages WHERE status = 'pending'").get() as { count: number };
  
  return {
    observations: observations.count,
    summaries: summaries.count,
    sessions: sessions.count,
    pendingMessages: pendingMessages.count
  };
}

export { Database };
