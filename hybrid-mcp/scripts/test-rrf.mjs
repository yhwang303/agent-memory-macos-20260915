#!/usr/bin/env node
/**
 * RRF unit test (M3.1 acceptance, doesn't touch vec.db).
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const { rrfFuse } = await import(pathToFileURL(path.join(ROOT, 'dist', 'rrf.js')).href);

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

console.log('━━━ T1: single-source identity ━━━');
{
  const out = rrfFuse([
    { items: [{ key: 'a', rank: 0 }, { key: 'b', rank: 1 }, { key: 'c', rank: 2 }],
      weight: 1, source: 's1' },
  ]);
  assert(out.length === 3, 'returns all 3');
  assert(out[0].key === 'a' && out[1].key === 'b' && out[2].key === 'c', 'preserves order');
  assert(out[0].score > out[1].score && out[1].score > out[2].score, 'monotonic decreasing scores');
}

console.log('\n━━━ T2: two sources, intersection at top ━━━');
{
  const out = rrfFuse([
    { items: [{ key: 'a', rank: 0 }, { key: 'b', rank: 1 }, { key: 'c', rank: 2 }],
      weight: 0.4, source: 'sqlite' },
    { items: [{ key: 'a', rank: 0 }, { key: 'd', rank: 1 }, { key: 'e', rank: 2 }],
      weight: 0.6, source: 'vector' },
  ], { k: 60 });
  // 'a' should be #1 because it appears at rank 0 in both
  assert(out[0].key === 'a', 'shared top-1 wins');
  // 'a' score = 0.4/60 + 0.6/60 = 1/60 ≈ 0.01667
  assert(Math.abs(out[0].score - 1/60) < 1e-6, 'a score = 1/60');
  // perSource on 'a' should show both
  const aSources = out[0].perSource;
  assert(aSources.find(s => s.source === 'sqlite')?.rank === 0, 'a in sqlite at rank 0');
  assert(aSources.find(s => s.source === 'vector')?.rank === 0, 'a in vector at rank 0');
  // total unique = 5 (a, b, c, d, e)
  assert(out.length === 5, '5 unique items');
}

console.log('\n━━━ T3: weight zero disables a branch ━━━');
{
  const out = rrfFuse([
    { items: [{ key: 'a', rank: 0 }], weight: 0, source: 'sqlite' },
    { items: [{ key: 'b', rank: 0 }], weight: 1, source: 'vector' },
  ]);
  assert(out.length === 1 && out[0].key === 'b', 'weight=0 branch ignored');
}

console.log('\n━━━ T4: paraphrase scenario — vector finds it, sqlite misses ━━━');
{
  // Paraphrase query: sqlite returns nothing, vector finds the right doc.
  const out = rrfFuse([
    { items: [], weight: 0.4, source: 'sqlite' },
    { items: [{ key: 42, rank: 0 }, { key: 17, rank: 1 }], weight: 0.6, source: 'vector' },
  ]);
  assert(out[0].key === 42, 'vector finds the right doc');
  assert(out[0].perSource.find(s => s.source === 'sqlite').rank === -1, 'sqlite shows rank=-1');
}

console.log('\n━━━ T5: limit truncates ━━━');
{
  const items = Array.from({ length: 100 }, (_, i) => ({ key: i, rank: i }));
  const out = rrfFuse([{ items, weight: 1, source: 's' }], { limit: 5 });
  assert(out.length === 5, 'limit=5 truncates');
}

console.log('\n━━━ T6: tie-break on score uses bestRank ━━━');
{
  // Two items both at rank 0 in their respective single source — same score.
  // Tie-break: lower bestRank wins (both rank 0, so order should be stable).
  const out = rrfFuse([
    { items: [{ key: 'a', rank: 1 }], weight: 0.5, source: 's1' },
    { items: [{ key: 'b', rank: 0 }], weight: 0.5, source: 's2' },
  ]);
  assert(out[0].key === 'b', 'b (rank 0) beats a (rank 1) at equal weight');
}

console.log(`\n━━━ ${pass}/${pass+fail} passed ━━━`);
process.exit(fail === 0 ? 0 : 1);
