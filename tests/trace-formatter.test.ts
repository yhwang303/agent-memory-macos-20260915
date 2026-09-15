import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTrace } from '../src/sdk/traceFormatter.js';
import type { NormalizedEvent } from '../src/sdk/observationClassifier.js';

// 套话黑名单：trace 产出绝不应包含这些
const BOILERPLATE = ['本次操作属于典型', '具有参考价值', '对后续', '记录此类操作'];

function assertNoBoilerplate(text: string): void {
  for (const b of BOILERPLATE) {
    assert.ok(!text.includes(b), `不应包含套话「${b}」: ${text}`);
  }
}

test('shell: title/facts/type 确定性产出', () => {
  const e: NormalizedEvent = {
    observationType: 'shell', toolName: 'shell',
    toolInput: { command: 'git status' },
    toolOutput: { exitCode: 0, stdout: 'clean', stderr: '' },
  };
  const t = formatTrace(e);
  assert.equal(t.type, 'shell');
  assert.match(t.title, /git status/);
  assert.match(t.facts, /命令: git status/);
  assert.match(t.facts, /退出码: 0/);
  assertNoBoilerplate(t.title + t.facts);
});

test('file_edit: 相对路径 + 操作类型', () => {
  const e: NormalizedEvent = {
    observationType: 'file_edit', toolName: 'file_edit',
    toolInput: { filePath: 'src\\foo\\bar.ts', editType: 'modify' },
    toolOutput: { diff: '+x' },
  };
  const t = formatTrace(e);
  assert.equal(t.type, 'file_edit');
  assert.match(t.title, /src\/foo\/bar\.ts/);
  assert.match(t.facts, /文件: src\/foo\/bar\.ts/);
  assert.match(t.facts, /操作: modify/);
  assertNoBoilerplate(t.title + t.facts);
});

test('mcp: 记录工具名，type 为原始类型', () => {
  const e: NormalizedEvent = {
    observationType: 'mcp', toolName: 'linear:list_issues',
    toolInput: { teamId: 't' },
    toolOutput: { results: [{ id: 1 }] },
  };
  const t = formatTrace(e);
  assert.equal(t.type, 'mcp');
  assert.match(t.title, /linear:list_issues/);
  assertNoBoilerplate(t.title + t.facts);
});

test('formatTrace 只产出 title/facts/type（无 narrative 字段）', () => {
  const e: NormalizedEvent = {
    observationType: 'shell', toolName: 'shell',
    toolInput: { command: 'ls' },
    toolOutput: { exitCode: 0 },
  };
  const t = formatTrace(e);
  assert.deepEqual(Object.keys(t).sort(), ['facts', 'title', 'type']);
});

test('确定性：同一事件多次产出一致', () => {
  const e: NormalizedEvent = {
    observationType: 'shell', toolName: 'shell',
    toolInput: { command: 'npm run build' },
    toolOutput: { exitCode: 0 },
  };
  assert.deepEqual(formatTrace(e), formatTrace(e));
});
