const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

const dbPath = path.join(os.homedir(), '.agent-memory', 'agent-memory.db');
console.log('Database path:', dbPath);

const db = new Database(dbPath);

// Insert a test summary
const stmt = db.prepare(`
  INSERT INTO session_summaries (
    memory_session_id, project, request, investigated, learned,
    completed, next_steps, files_read, files_edited, notes,
    prompt_number, discovery_tokens, created_at, created_at_epoch
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

stmt.run(
  'test-mem-001',
  'D:/GitHub/agent-memory',
  'User asked about memory system setup and configuration',
  'Checked database tables, hooks configuration, and API endpoints',
  'Learned how to configure CodeBuddy hooks for memory persistence, hook format requirements',
  'Successfully configured all 10 hooks: beforeSubmitPrompt, afterAgentResponse, afterShellExecution etc',
  'Test the memory injection in new session, verify context is properly injected',
  'WorkerService.ts, hooks-cli.ts, sessions.ts',
  'hooks.json, common_codebuddy_config.json',
  'Memory system is ready to use. Unicode display issue in terminal is cosmetic only.',
  1,
  500,
  '2025-02-09T19:00:00.000Z',
  1739127600000
);

console.log('Test summary inserted!');

// Verify
const summaries = db.prepare('SELECT * FROM session_summaries').all();
console.log('Summaries in database:', summaries.length);

db.close();
