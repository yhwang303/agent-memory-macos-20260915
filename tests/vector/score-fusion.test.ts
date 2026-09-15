/**
 * ScoreFusion 单元测试 — 锁定 basic-memory 风格 score-based fusion 的关键不变式。
 *
 * 这些断言对齐 basic-memory/src/basic_memory/repository/search_repository_base.py
 * 中 _search_hybrid 的实现:
 *   - FUSION_BONUS = 0.3
 *   - FTS_GATE_THRESHOLD = 0.0
 *   - FTS 取 abs 后归一到 [0, 1]
 *   - L2 → cos: 1 - L2² / 2
 *   - 融合: max(v, f) + FUSION_BONUS * min(v, f)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreFuse,
  distanceToSimilarity,
  FUSION_BONUS,
  FTS_GATE_THRESHOLD,
} from '../../src/services/vector/ScoreFusion.js';

describe('ScoreFusion', () => {
  it('basic-memory 默认常量保持与上游对齐', () => {
    assert.equal(FUSION_BONUS, 0.3);
    assert.equal(FTS_GATE_THRESHOLD, 0.0);
  });

  it('distanceToSimilarity 在单位向量距离边界处行为正确', () => {
    // 完全相同的归一化向量 distance=0 → cos_sim=1
    assert.equal(distanceToSimilarity(0), 1);
    // 正交归一化向量 distance=√2 → cos_sim=0
    assert.equal(distanceToSimilarity(Math.SQRT2), 0);
    // 反向归一化向量 distance=2 → cos_sim 截断到 0 (不为 -1)
    assert.equal(distanceToSimilarity(2), 0);
  });

  it('FTS-only 命中: 归一化 + 融合公式简化为 max(0, f)', () => {
    // bm25 通常返回负数,越小(绝对值越大)越好
    const fts = [
      { key: 1, score: -10 }, // abs=10, max=10 → norm=1.0
      { key: 2, score: -5 },  // norm=0.5
      { key: 3, score: -1 },  // norm=0.1
    ];
    const out = scoreFuse(fts, []);
    assert.equal(out.length, 3);
    assert.equal(out[0].key, 1);
    assert.equal(out[0].score, 1.0); // max(0, 1) + 0.3*min(0, 1) = 1.0
    assert.equal(out[1].score, 0.5);
    assert.equal(out[2].score, 0.1);
  });

  it('Vector-only 命中: 距离正确转为余弦相似度', () => {
    const vec = [
      { key: 'a', distance: 0 },          // sim=1.0
      { key: 'b', distance: Math.SQRT2 }, // sim=0.0 (orthogonal)
    ];
    const out = scoreFuse([], vec);
    assert.equal(out.length, 2);
    assert.equal(out[0].key, 'a');
    assert.equal(out[0].score, 1.0);
    // sim=0 命中也保留:max(0, 0) + 0.3 * min(0, 0) = 0
    assert.equal(out[1].score, 0);
  });

  it('双路命中: max(v, f) + 0.3 * min(v, f), 输出范围最高 1.3', () => {
    // FTS top-1 (norm=1.0), Vector 完全匹配 (sim=1.0)
    const out = scoreFuse(
      [{ key: 42, score: -10 }],
      [{ key: 42, distance: 0 }]
    );
    assert.equal(out.length, 1);
    // max(1, 1) + 0.3 * min(1, 1) = 1.3
    assert.equal(out[0].score, 1.3);
    assert.deepEqual(
      out[0].perSource.sort((a, b) => a.source.localeCompare(b.source)),
      [
        { source: 'sqlite', score: 1.0 },
        { source: 'vector', score: 1.0 },
      ]
    );
  });

  it('双路命中对单路命中的优先级: bonus 自然奖励一致性', () => {
    // 条目 A: FTS 强命中(1.0),Vector 不命中
    // 条目 B: FTS 中命中(0.5),Vector 也中等命中(0.5)
    // A score = max(1, 0) + 0.3 * min(1, 0) = 1.0
    // B score = max(0.5, 0.5) + 0.3 * min(0.5, 0.5) = 0.5 + 0.15 = 0.65
    // → A 仍然在前(强单路 > 弱双路);如果 B 是 (0.9, 0.9) 则 0.9+0.27=1.17 > 1.0
    const orthogonalVec = Math.SQRT2;
    // 0.5 sim 对应距离: cos=0.5 ⇒ L2² = 2(1-0.5) = 1 ⇒ L2=1
    const halfSimDist = 1;
    const out = scoreFuse(
      [
        { key: 'A', score: -10 }, // abs=10 max=10 → 1.0
        { key: 'B', score: -5 },  // 0.5
      ],
      [
        // Vector 只命中 B
        { key: 'B', distance: halfSimDist }, // sim=0.5
        // 假装一条 vector-only 命中,确保 vector 列表 max 不影响 (ScoreFusion 不重归一 vector)
        { key: 'C', distance: orthogonalVec },
      ]
    );
    const a = out.find((r) => r.key === 'A')!;
    const b = out.find((r) => r.key === 'B')!;
    assert.equal(a.score, 1.0);
    assert.ok(Math.abs(b.score - 0.65) < 1e-9);
    assert.equal(a.rank, 0);
    assert.equal(b.rank, 1);
  });

  it('mode=sqlite 排除 vector 分支', () => {
    const out = scoreFuse(
      [{ key: 1, score: -1 }],
      [{ key: 2, distance: 0 }],
      { includeVector: false }
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].key, 1);
  });

  it('mode=vector 排除 sqlite 分支', () => {
    const out = scoreFuse(
      [{ key: 1, score: -1 }],
      [{ key: 2, distance: 0 }],
      { includeFts: false }
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].key, 2);
  });

  it('limit 截断保留 top-K', () => {
    const fts = [
      { key: 1, score: -10 },
      { key: 2, score: -5 },
      { key: 3, score: -1 },
    ];
    const out = scoreFuse(fts, [], { limit: 2 });
    assert.equal(out.length, 2);
    assert.equal(out[0].key, 1);
    assert.equal(out[1].key, 2);
  });

  it('FTS gate 阈值: 归一化分数低于阈值视为 0', () => {
    const fts = [
      { key: 1, score: -10 }, // 1.0
      { key: 2, score: -1 },  // 0.1 — 会被 0.5 阈值压成 0
    ];
    const out = scoreFuse(fts, [], { ftsGateThreshold: 0.5 });
    const r2 = out.find((r) => r.key === 2)!;
    assert.equal(r2.score, 0);
  });

  it('稳定 tie-break: 同分按 key 字符串升序', () => {
    const out = scoreFuse(
      [
        { key: 9, score: -1 }, // 1.0
        { key: 1, score: -1 }, // 1.0
        { key: 5, score: -1 }, // 1.0
      ],
      []
    );
    assert.deepEqual(
      out.map((r) => r.key),
      [1, 5, 9]
    );
  });

  it('空输入返回空数组', () => {
    assert.deepEqual(scoreFuse<number>([], []), []);
  });
});
