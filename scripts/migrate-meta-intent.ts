/**
 * Migration script to add meta_intent column to observations table
 * 
 * Run this script to update existing databases without losing data.
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Default path used in the app (matches src/shared/paths.ts getDataDir)
import os from 'os';

const getDataDir = () => {
  return path.join(os.homedir(), '.agent-memory');
};

const dataDir = process.env.CODEBUDDY_MEM_DIR || getDataDir();
const dbPath = path.join(dataDir, 'agent-memory.db');

console.log(`Checking database at: ${dbPath}`);

if (!fs.existsSync(dbPath)) {
  console.log('Database does not exist. No migration needed.');
  console.log('The app will create the database with the new schema automatically.');
  process.exit(0);
}

const db = new Database(dbPath);

try {
  // Check if meta_intent column already exists in both tables
  const obsTableInfo = db.prepare("PRAGMA table_info(observations)").all() as any[];
  const obsHasMetaIntent = obsTableInfo.some(col => col.name === 'meta_intent');

  const sumTableInfo = db.prepare("PRAGMA table_info(session_summaries)").all() as any[];
  const sumHasMetaIntent = sumTableInfo.some(col => col.name === 'meta_intent');

  if (obsHasMetaIntent && sumHasMetaIntent) {
    console.log('Migration already applied: meta_intent column exists in both tables.');
    process.exit(0);
  }

  console.log('Observations has meta_intent:', obsHasMetaIntent);
  console.log('Session_summaries has meta_intent:', sumHasMetaIntent);

  console.log('Starting migration to add meta_intent column...');
  
  // Begin transaction
  db.exec('BEGIN TRANSACTION');

  // 1. Add meta_intent column to observations table (if not exists)
  if (!obsHasMetaIntent) {
    console.log('Adding meta_intent column to observations table...');
    db.exec('ALTER TABLE observations ADD COLUMN meta_intent TEXT');
  } else {
    console.log('observations table already has meta_intent column, skipping.');
  }

  // 1.5 Add meta_intent column to session_summaries table (if not exists)
  if (!sumHasMetaIntent) {
    console.log('Adding meta_intent column to session_summaries table...');
    db.exec('ALTER TABLE session_summaries ADD COLUMN meta_intent TEXT');
  } else {
    console.log('session_summaries table already has meta_intent column, skipping.');
  }

  // 2. Drop and recreate FTS table
  console.log('Recreating FTS virtual table to include meta_intent...');
  db.exec('DROP TABLE IF EXISTS observations_fts');
  db.exec(`
    CREATE VIRTUAL TABLE observations_fts USING fts5(
      text, title, subtitle, meta_intent, facts, narrative, concepts,
      content='observations',
      content_rowid='id'
    )
  `);

  db.exec('DROP TABLE IF EXISTS summaries_fts');
  db.exec(`
    CREATE VIRTUAL TABLE summaries_fts USING fts5(
      request, investigated, learned, meta_intent, completed, next_steps, notes,
      content='session_summaries',
      content_rowid='id'
    )
  `);

  // 3. Drop and recreate trigger
  console.log('Updating FTS sync trigger...');
  db.exec('DROP TRIGGER IF EXISTS observations_ai');
  db.exec(`
    CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, text, title, subtitle, meta_intent, facts, narrative, concepts)
      VALUES (new.id, new.text, new.title, new.subtitle, new.meta_intent, new.facts, new.narrative, new.concepts);
    END
  `);

  db.exec('DROP TRIGGER IF EXISTS summaries_ai');
  db.exec(`
    CREATE TRIGGER summaries_ai AFTER INSERT ON session_summaries BEGIN
      INSERT INTO summaries_fts(rowid, request, investigated, learned, meta_intent, completed, next_steps, notes)
      VALUES (new.id, new.request, new.investigated, new.learned, new.meta_intent, new.completed, new.next_steps, new.notes);
    END
  `);

  // 4. Rebuild FTS index from existing data
  console.log('Rebuilding FTS index with existing data...');
  db.exec(`
    INSERT INTO observations_fts(observations_fts, rowid, text, title, subtitle, meta_intent, facts, narrative, concepts) 
    SELECT 'delete', id, text, title, subtitle, meta_intent, facts, narrative, concepts FROM observations
  `);

  db.exec(`
    INSERT INTO summaries_fts(summaries_fts, rowid, request, investigated, learned, meta_intent, completed, next_steps, notes) 
    SELECT 'delete', id, request, investigated, learned, meta_intent, completed, next_steps, notes FROM session_summaries
  `);
  
  // Note: Since meta_intent is new, it will be NULL for existing records, 
  // but existing narrative might contain "【元意图】..." which is fine.

  // Commit transaction
  db.exec('COMMIT');
  console.log('Migration completed successfully!');

} catch (error) {
  // Rollback on error
  if (db.inTransaction) {
    db.exec('ROLLBACK');
  }
  console.error('Migration failed:', error);
  process.exit(1);
} finally {
  db.close();
}
