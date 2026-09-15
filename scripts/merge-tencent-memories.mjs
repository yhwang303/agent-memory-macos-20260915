/**
 * One-shot merge of the Tencent-internship memory store (the two DB files on
 * the Desktop, captured from the office Windows machine) into this Mac's
 * live store at ~/.agent-memory.
 *
 * A previous merge already landed everything up to 2026-07-17T12:01:12Z, so
 * this script must NOT re-import those rows. Dedup is by content identity,
 * not by date:
 *   observations      (memory_session_id, created_at_epoch, signature, title)
 *   session_summaries (memory_session_id, created_at_epoch)
 *   sdk_sessions      (content_session_id)
 * Each of those keys is verified unique in both DBs, so a join on them is a
 * safe "already have it" test and is immune to a wrong guess about the cutoff.
 *
 * IDs are renumbered from 1 in chronological order across the merged set
 * (the union is interleaved in time, and the local summaries table is already
 * 59 rows out of ID order, so keeping old IDs would leave the UI unsorted).
 * Renumbering means vec.db must be rebuilt too: its docs.sqlite_id points at
 * main-DB row IDs. Existing embeddings are transplanted from both source
 * vec.db files rather than re-embedded — 12095 of 12122 new rows already have
 * a vector; the worker backfills the remaining 27 on its next pass.
 *
 * Usage (from the repo root, with "AgentMemory" quit):
 *   node scripts/merge-tencent-memories.mjs           # dry-run, prints the plan
 *   node scripts/merge-tencent-memories.mjs --apply   # writes (backs up first)
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, copyFileSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

const apply = process.argv.includes('--apply');

const dataDir = join(homedir(), '.agent-memory');
const dbPath = join(dataDir, 'agent-memory.db');
const vecPath = join(dataDir, 'vec.db');
const srcDbPath = join(homedir(), 'Desktop', 'agent-memory.db');
const srcVecPath = join(homedir(), 'Desktop', 'vec.db');

for (const p of [dbPath, srcDbPath]) {
  if (!existsSync(p)) {
    console.error(`missing required DB: ${p}`);
    process.exit(1);
  }
}

const q = (p) => p.replace(/\\/g, '/').replace(/'/g, "''");

// ─── "row is not already in the local store" predicates ───────────────
// `x` is the incoming (Tencent) row. The local store's alias differs per
// connection: it is `main` on the read connection, but the output connection
// must attach it as `loc` because `main` is reserved for its own primary db.
const obsNew = (L) => `NOT EXISTS (SELECT 1 FROM ${L}.observations o
   WHERE o.memory_session_id = x.memory_session_id
     AND o.created_at_epoch  = x.created_at_epoch
     AND COALESCE(o.signature,'') = COALESCE(x.signature,'')
     AND COALESCE(o.title,'')     = COALESCE(x.title,''))`;
const sumNew = (L) => `NOT EXISTS (SELECT 1 FROM ${L}.session_summaries s
   WHERE s.memory_session_id = x.memory_session_id
     AND s.created_at_epoch  = x.created_at_epoch)`;
const sesNew = (L) => `NOT EXISTS (SELECT 1 FROM ${L}.sdk_sessions t
   WHERE t.content_session_id = x.content_session_id)`;

const OBS_NEW = obsNew('main');
const SUM_NEW = sumNew('main');
const SES_NEW = sesNew('main');

const db = new Database(dbPath, { readonly: !apply });
db.exec(`ATTACH DATABASE '${q(srcDbPath)}' AS src`);

// ─── Plan ─────────────────────────────────────────────────────────────
const plan = {
  obsLocal: db.prepare('SELECT COUNT(*) c FROM main.observations').get().c,
  sumLocal: db.prepare('SELECT COUNT(*) c FROM main.session_summaries').get().c,
  sesLocal: db.prepare('SELECT COUNT(*) c FROM main.sdk_sessions').get().c,
  obsNew: db.prepare(`SELECT COUNT(*) c FROM src.observations x WHERE ${OBS_NEW}`).get().c,
  sumNew: db.prepare(`SELECT COUNT(*) c FROM src.session_summaries x WHERE ${SUM_NEW}`).get().c,
  sesNew: db.prepare(`SELECT COUNT(*) c FROM src.sdk_sessions x WHERE ${SES_NEW}`).get().c,
};
const lastMerged = db
  .prepare(
    `SELECT MAX(x.created_at) t FROM src.observations x WHERE NOT (${OBS_NEW})`,
  )
  .get().t;
const firstIncoming = db
  .prepare(`SELECT MIN(x.created_at) t FROM src.observations x WHERE ${OBS_NEW}`)
  .get().t;
const strays = db
  .prepare(
    `SELECT COUNT(*) c FROM src.observations x
      WHERE ${OBS_NEW} AND x.created_at <= '${lastMerged}'`,
  )
  .get().c;

console.log('── merge plan ──────────────────────────────────────────────');
console.log(`local now:      ${plan.obsLocal} obs, ${plan.sumLocal} summaries, ${plan.sesLocal} sessions`);
console.log(`to import:      ${plan.obsNew} obs, ${plan.sumNew} summaries, ${plan.sesNew} sessions`);
console.log(`prior merge reached: ${lastMerged}`);
console.log(`incoming starts at:  ${firstIncoming}`);
console.log(`new rows older than the prior cutoff: ${strays}  (0 = clean boundary)`);
console.log(`merged totals:  ${plan.obsLocal + plan.obsNew} obs, ${plan.sumLocal + plan.sumNew} summaries, ${plan.sesLocal + plan.sesNew} sessions`);

if (!apply) {
  console.log('\nDry-run only. To write: node scripts/merge-tencent-memories.mjs --apply');
  process.exit(0);
}
// ─── Backup ───────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
for (const p of [dbPath, vecPath]) {
  if (existsSync(p)) {
    copyFileSync(p, `${p}.bak-${stamp}`);
    console.log(`backed up ${p} -> ${p}.bak-${stamp}`);
  }
}

// ─── Build the merged main DB ─────────────────────────────────────────
// Strategy: create a fresh DB with the live schema, then INSERT the union of
// local + new-Tencent rows ordered by created_at_epoch so that the implicit
// rowid/id sequence *is* chronological order. Old IDs are discarded; we keep
// an old->new map per table to rewrite vec.db afterwards.
const outPath = join(dataDir, `merged-${stamp}.db`);
if (existsSync(outPath)) rmSync(outPath);

const schema = db
  .prepare(`SELECT type, name, sql FROM main.sqlite_master WHERE sql IS NOT NULL`)
  .all();

const out = new Database(outPath);
out.pragma('journal_mode = WAL');
// Tables first, then indexes/triggers/views once the data is in — FTS
// triggers must not fire during the bulk insert or they would double-index.
// sqlite_* tables (e.g. sqlite_sequence) are managed by SQLite itself and
// cannot be created explicitly.
// Shadow tables backing an fts5 virtual table: SQLite creates and fills these
// itself, so they must be neither declared nor copied. The virtual table
// (`observations_fts`, `summaries_fts`) IS declared, then rebuilt from content.
const isFtsShadow = (n) => /_fts_(data|idx|docsize|config|content)$/.test(n);
const isFtsVirtual = (n) => /_fts$/.test(n);
const creatable = (s) => !s.name.startsWith('sqlite_') && !isFtsShadow(s.name);
// Plain tables now; FTS virtual tables + indexes/triggers come after the bulk
// insert so the AFTER INSERT triggers don't double-index every row.
for (const o of schema.filter(
  (s) => s.type === 'table' && creatable(s) && !isFtsVirtual(s.name),
))
  out.exec(o.sql);
out.exec(`ATTACH DATABASE '${q(dbPath)}' AS loc`);
out.exec(`ATTACH DATABASE '${q(srcDbPath)}' AS src`);

const OBS_NEW_L = obsNew('loc');
const SUM_NEW_L = sumNew('loc');
const SES_NEW_L = sesNew('loc');

const cols = (t) =>
  out
    .prepare(`SELECT name FROM pragma_table_info('${t}')`)
    .all()
    .map((r) => r.name);

const dataTables = schema
  .filter((s) => s.type === 'table' && !isFtsShadow(s.name) && !s.name.startsWith('sqlite_'))
  .map((s) => s.name);

const renumbered = { observations: OBS_NEW_L, session_summaries: SUM_NEW_L };
const idMaps = { observations: new Map(), session_summaries: new Map() };

const tx = out.transaction(() => {
  for (const t of dataTables) {
    const c = cols(t);
    const list = c.map((n) => `"${n}"`).join(', ');

    if (t in renumbered) {
      // Chronological union. `src_id`/`is_src` ride along only for the map.
      const sel = c.map((n) => `"${n}"`).join(', ');
      const rows = out
        .prepare(
          `SELECT ${sel}, id AS old_id, 0 AS is_src, created_at_epoch AS k FROM loc.${t}
           UNION ALL
           SELECT ${sel}, id AS old_id, 1 AS is_src, created_at_epoch AS k
             FROM src.${t} x WHERE ${renumbered[t]}
           ORDER BY k ASC, is_src ASC, old_id ASC`,
        )
        .all();
      const ins = out.prepare(
        `INSERT INTO ${t} (${list}) VALUES (${c.map((n) => `@${n}`).join(', ')})`,
      );
      let nextId = 1;
      for (const r of rows) {
        const oldId = r.old_id;
        const isSrc = r.is_src;
        const newId = nextId++;
        r.id = newId;
        const payload = {};
        for (const n of c) payload[n] = r[n];
        ins.run(payload);
        idMaps[t].set(`${isSrc}:${oldId}`, newId);
      }
      console.log(`${t}: wrote ${rows.length} rows, ids 1..${nextId - 1}`);
    } else if (t === 'sdk_sessions') {
      // Local and Tencent ids overlap. Nothing in the schema references
      // sdk_sessions.id (every cross-table link is by content/memory session
      // TEXT id), so omit it and let AUTOINCREMENT reassign in time order.
      const noId = c.filter((n) => n !== 'id');
      const nl = noId.map((n) => `"${n}"`).join(', ');
      out.exec(
        `INSERT INTO ${t} (${nl})
           SELECT ${nl} FROM (
             SELECT ${nl}, started_at_epoch AS k FROM loc.${t}
             UNION ALL
             SELECT ${nl}, started_at_epoch AS k FROM src.${t} x WHERE ${SES_NEW_L}
           ) ORDER BY k ASC`,
      );
      console.log(`${t}: ${out.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c} rows`);
    } else if (t === 'import_history_fingerprints') {
      // summary_id must follow the renumbering; drop rows whose summary
      // didn't survive (it was a dup, so the content is already present).
      const rows = out.prepare(`SELECT ${list} FROM loc.${t}`).all();
      const ins = out.prepare(
        `INSERT OR IGNORE INTO ${t} (${list}) VALUES (${c.map((n) => `@${n}`).join(', ')})`,
      );
      let kept = 0;
      for (const r of rows) {
        const mapped = idMaps.session_summaries.get(`0:${r.summary_id}`);
        if (mapped === undefined) continue;
        ins.run({ ...r, summary_id: mapped });
        kept++;
      }
      console.log(`${t}: kept ${kept}/${rows.length} (summary_id remapped)`);
    } else {
      out.exec(`INSERT INTO ${t} (${list}) SELECT ${list} FROM loc.${t}`);
    }
  }
});
tx();

// FTS virtual tables now that the data is in, then indexes/triggers/views.
// Declaring these after the bulk insert is what keeps the AFTER INSERT
// triggers from double-indexing; 'rebuild' below fills them from content.
for (const o of schema.filter(
  (s) => s.type === 'table' && creatable(s) && isFtsVirtual(s.name),
))
  out.exec(o.sql);
for (const o of schema.filter((s) => s.type !== 'table' && creatable(s))) {
  try {
    out.exec(o.sql);
  } catch (e) {
    console.log(`  skip ${o.type} ${o.name}: ${e.message}`);
  }
}
for (const fts of ['observations_fts', 'summaries_fts']) {
  const exists = out
    .prepare(`SELECT COUNT(*) c FROM sqlite_master WHERE name = ?`)
    .get(fts).c;
  if (exists) {
    out.exec(`INSERT INTO ${fts}(${fts}) VALUES('rebuild')`);
    console.log(`${fts}: rebuilt`);
  }
}

out.exec('DETACH DATABASE src');
out.exec('DETACH DATABASE loc');
const check = out.pragma('integrity_check')[0];
console.log(`integrity_check: ${JSON.stringify(check)}`);
out.close();
db.close();
// ─── Rebuild vec.db against the new IDs ───────────────────────────────
// docs.sqlite_id references main-DB row IDs, which we just renumbered, so the
// old vec.db is now meaningless. Rebuild it by walking the old->new map and
// carrying each existing embedding across from whichever source held it.
const outVecPath = join(dataDir, `merged-vec-${stamp}.db`);
if (existsSync(outVecPath)) rmSync(outVecPath);

const vecSchemaSrc = existsSync(vecPath) ? vecPath : srcVecPath;
const vsrc = new Database(vecSchemaSrc, { readonly: true });
sqliteVec.load(vsrc);
const vecSchema = vsrc
  .prepare(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL`)
  .all()
  .filter((s) => !/^vec_docs($|_)/.test(s.name) || s.name === 'vec_docs');
const docCols = vsrc
  .prepare(`SELECT name FROM pragma_table_info('docs')`)
  .all()
  .map((r) => r.name);
vsrc.close();

const ov = new Database(outVecPath);
sqliteVec.load(ov);
for (const s of vecSchema) {
  try {
    ov.exec(s.sql);
  } catch (e) {
    console.log(`  vec skip ${s.type} ${s.name}: ${e.message}`);
  }
}

const readers = {};
if (existsSync(vecPath)) {
  readers['0'] = new Database(vecPath, { readonly: true });
  sqliteVec.load(readers['0']);
}
if (existsSync(srcVecPath)) {
  readers['1'] = new Database(srcVecPath, { readonly: true });
  sqliteVec.load(readers['1']);
}

const getDoc = {};
for (const [k, r] of Object.entries(readers)) {
  getDoc[k] = r.prepare(
    `SELECT d.*, v.vec AS _vec FROM docs d JOIN vec_docs v ON v.rowid = d.rowid
      WHERE d.kind = ? AND d.sqlite_id = ?`,
  );
}

const insDoc = ov.prepare(
  `INSERT INTO docs (${docCols.map((n) => `"${n}"`).join(', ')})
   VALUES (${docCols.map((n) => `@${n}`).join(', ')})`,
);
const insVec = ov.prepare('INSERT INTO vec_docs (rowid, vec) VALUES (?, ?)');

const kindOf = { observations: 'observation', session_summaries: 'session_summary' };
let carried = 0;
let missing = 0;
const vtx = ov.transaction(() => {
  let rowid = 1;
  for (const [table, kind] of Object.entries(kindOf)) {
    for (const [key, newId] of idMaps[table]) {
      const [isSrc, oldId] = key.split(':');
      const reader = getDoc[isSrc];
      if (!reader) {
        missing++;
        continue;
      }
      const doc = reader.get(kind, Number(oldId));
      if (!doc) {
        missing++;
        continue;
      }
      const vecBlob = doc._vec;
      delete doc._vec;
      const payload = {};
      for (const n of docCols) payload[n] = n === 'sqlite_id' ? newId : n === 'rowid' ? rowid : doc[n];
      if (docCols.includes('rowid')) payload.rowid = rowid;
      insDoc.run(payload);
      const assigned = docCols.includes('rowid')
        ? rowid
        : Number(ov.prepare('SELECT last_insert_rowid() r').get().r);
      insVec.run(BigInt(assigned), vecBlob);
      rowid = assigned + 1;
      carried++;
    }
  }
});
vtx();
for (const r of Object.values(readers)) r.close();
console.log(`vec.db: carried ${carried} embeddings, ${missing} rows left for the worker to backfill`);
ov.close();

// ─── Swap in ──────────────────────────────────────────────────────────
// The backups above are the rollback path.
for (const suffix of ['-wal', '-shm']) {
  for (const p of [dbPath, vecPath]) {
    if (existsSync(p + suffix)) rmSync(p + suffix);
  }
}
renameSync(outPath, dbPath);
renameSync(outVecPath, vecPath);
console.log(`\nmerged store is live at ${dbPath}`);
console.log(`rollback: mv "${dbPath}.bak-${stamp}" "${dbPath}" && mv "${vecPath}.bak-${stamp}" "${vecPath}"`);


