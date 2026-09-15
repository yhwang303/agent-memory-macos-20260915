#!/usr/bin/env node
/**
 * Background full reindex — kick off, log progress to file, exit when done.
 * Designed to run in `run_in_background` while we write M3 code.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { writeFileSync, appendFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LOG = path.join(ROOT, 'reindex-progress.log');

writeFileSync(LOG, `=== full reindex started at ${new Date().toISOString()} ===\n`);

const { loadConfig } = await import(pathToFileURL(path.join(ROOT, 'dist', 'config.js')).href);
const { configureLogger } = await import(pathToFileURL(path.join(ROOT, 'dist', 'logger.js')).href);
const { ModelStore } = await import(pathToFileURL(path.join(ROOT, 'dist', 'modelStore.js')).href);
const { VectorStore } = await import(pathToFileURL(path.join(ROOT, 'dist', 'vectorStore.js')).href);
const { AgentMemoryDb } = await import(pathToFileURL(path.join(ROOT, 'dist', 'agentMemoryDb.js')).href);
const { Indexer } = await import(pathToFileURL(path.join(ROOT, 'dist', 'indexer.js')).href);

configureLogger({ logFile: LOG });
const cfg = loadConfig();

const agentMemory = new AgentMemoryDb(cfg.agentMemoryDbPath);
const stats = agentMemory.stats();
appendFileSync(LOG, `AgentMemory main: obs=${stats.observations} sum=${stats.summaries}\n`);

const model = new ModelStore(cfg);
const vec = new VectorStore({ dbPath: cfg.paths.vecDbPath, dim: cfg.embedder.dim });
const indexer = new Indexer(model, vec, agentMemory);

await model.ensureReady();
appendFileSync(LOG, `model ready at ${new Date().toISOString()}\n`);

// Kick off full reindex (force=true to ensure clean rebuild)
const t0 = Date.now();
const final = await indexer.reindexAll({ force: false });
const elapsed = ((Date.now() - t0) / 1000 / 60).toFixed(1);

const finalStats = vec.stats();
appendFileSync(LOG, `\n=== DONE in ${elapsed} min ===\n`);
appendFileSync(LOG, `vec: obs=${finalStats.observations} sum=${finalStats.summaries} total=${finalStats.totalDocs}\n`);
appendFileSync(LOG, `progress: ${JSON.stringify(final, null, 2)}\n`);

vec.close();
agentMemory.close();
process.exit(0);
