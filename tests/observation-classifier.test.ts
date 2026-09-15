import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, computeSignature, extractMcpEvidence, isMcpEvent, MAX_EVIDENCE_CHARS, type NormalizedEvent } from '../src/sdk/observationClassifier.js';

function ev(partial: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    observationType: partial.observationType,
    toolName: partial.toolName ?? 'shell',
    toolInput: partial.toolInput ?? {},
    toolOutput: partial.toolOutput ?? {},
  };
}

// ---------------------------------------------------------------------------
// Tier 0 - 丢弃
// ---------------------------------------------------------------------------

test('Tier0: 空命令 shell（只有耗时、无命令文本）', () => {
  const r = classify(ev({
    observationType: 'shell', toolName: 'shell',
    toolInput: { command: '', args: [] },
    toolOutput: { exitCode: 0, stdout: '', stderr: '' },
  }), []);
  assert.equal(r.tier, 0);
  assert.equal(r.dropReason, 'empty command');
});

test('Tier0: file_edit 无 file_path', () => {
  const r = classify(ev({
    observationType: 'file_edit', toolName: 'file_edit',
    toolInput: { filePath: '', editType: 'modify' },
    toolOutput: { diff: '+something added here' },
  }), []);
  assert.equal(r.tier, 0);
});

test('Tier0: file_edit 空 diff', () => {
  const r = classify(ev({
    observationType: 'file_edit', toolName: 'file_edit',
    toolInput: { filePath: 'src/foo.ts', editType: 'modify' },
    toolOutput: { diff: '' },
  }), []);
  assert.equal(r.tier, 0);
});

test('Tier0: 图片/二进制后缀 file_edit', () => {
  for (const f of ['assets/logo.png', 'bin/app.exe', 'icon.svg', 'lib/native.dll']) {
    const r = classify(ev({
      observationType: 'file_edit', toolName: 'file_edit',
      toolInput: { filePath: f, editType: 'modify' },
      toolOutput: { diff: 'binary data changed substantially here' },
    }), []);
    assert.equal(r.tier, 0, `${f} should be Tier0`);
  }
});

test('Tier0: Cursor workspaceStorage 截图', () => {
  const r = classify(ev({
    observationType: 'file_edit', toolName: 'file_edit',
    toolInput: { filePath: 'C:/Users/x/AppData/Roaming/Cursor/User/workspaceStorage/abc/images/123.png', editType: 'create' },
    toolOutput: { diff: 'some pasted screenshot content blob' },
  }), []);
  assert.equal(r.tier, 0);
});

test('Tier0: 临时文件（COMMIT_EDITMSG / *.tmp）', () => {
  for (const f of ['.git/COMMIT_EDITMSG', 'build/output.tmp']) {
    const r = classify(ev({
      observationType: 'file_edit', toolName: 'file_edit',
      toolInput: { filePath: f, editType: 'modify' },
      toolOutput: { diff: 'fix: did something meaningful in the commit' },
    }), []);
    assert.equal(r.tier, 0, `${f} should be Tier0`);
  }
});

test('Tier0: 空/空 JSON agent_response', () => {
  assert.equal(classify(ev({ toolName: 'agent_response', toolOutput: '' }), []).tier, 0);
  assert.equal(classify(ev({ toolName: 'agent_response', toolOutput: {} }), []).tier, 0);
  assert.equal(classify(ev({ toolName: 'agent_response', toolOutput: { response: '{}' } }), []).tier, 0);
});

test('Tier0: MCP 只读查询返回空结果', () => {
  const r = classify(ev({
    observationType: 'mcp', toolName: 'linear:list_issues',
    toolInput: { teamId: 't1' },
    toolOutput: { results: [] },
  }), []);
  assert.equal(r.tier, 0);
});

test('Tier0: 会话内完全重复', () => {
  const e = ev({
    observationType: 'file_edit', toolName: 'file_edit',
    toolInput: { filePath: 'src/a.ts', editType: 'modify' },
    toolOutput: { diff: '+ const x = 1;\n- const x = 0;\n more lines here for substance' },
  });
  const first = classify(e, []);
  assert.notEqual(first.tier, 0);
  const dup = classify(e, [first.signature]);
  assert.equal(dup.tier, 0);
  assert.equal(dup.dropReason, 'duplicate');
});

// ---------------------------------------------------------------------------
// Tier 1 - 模板留痕
// ---------------------------------------------------------------------------

test('Tier1: 只读检查命令 exit=0', () => {
  for (const c of ['git status', 'git log --oneline', 'ls -la', 'cat package.json', 'grep -r foo src']) {
    const r = classify(ev({
      observationType: 'shell', toolName: 'shell',
      toolInput: { command: c },
      toolOutput: { exitCode: 0, stdout: 'output', stderr: '' },
    }), []);
    assert.equal(r.tier, 1, `${c} should be Tier1`);
  }
});

test('Tier1: 成功的打包/构建命令', () => {
  const r = classify(ev({
    observationType: 'shell', toolName: 'shell',
    toolInput: { command: 'npm run build' },
    toolOutput: { exitCode: 0, stdout: 'built', stderr: '' },
  }), []);
  assert.equal(r.tier, 1);
});

test('Tier1: 真实源码但 diff 极短', () => {
  const r = classify(ev({
    observationType: 'file_edit', toolName: 'file_edit',
    toolInput: { filePath: 'src/foo.ts', editType: 'modify' },
    toolOutput: { diff: '+a' },
  }), []);
  assert.equal(r.tier, 1);
});

test('Tier1: MCP 只读查询有结果', () => {
  const r = classify(ev({
    observationType: 'mcp', toolName: 'linear:list_issues',
    toolInput: { teamId: 't1' },
    toolOutput: { results: [{ id: 1, title: 'bug' }] },
  }), []);
  assert.equal(r.tier, 1);
});

test('Tier1: 极短 agent_response（无代码/结论）', () => {
  const r = classify(ev({ toolName: 'agent_response', toolOutput: '好的，已完成。' }), []);
  assert.equal(r.tier, 1);
});

// ---------------------------------------------------------------------------
// Tier 2 高级
// ---------------------------------------------------------------------------

test('Tier2 high: agent 回复（有实质内容）', () => {
  const r = classify(ev({
    toolName: 'agent_response',
    toolOutput: '我分析了登录失败的根因：token 过期后未刷新，导致 401。修复方式是在拦截器中增加自动刷新逻辑，并补充了对应的单元测试。',
  }), []);
  assert.equal(r.tier, 2);
  assert.equal(r.model, 'high');
});

test('Tier2 high: agent 思考（有实质内容）', () => {
  const r = classify(ev({
    toolName: 'agent_thought',
    toolOutput: { thought: '考虑把分类逻辑抽成纯函数，便于单测；先列出所有规则再编码。' },
  }), []);
  assert.equal(r.tier, 2);
  assert.equal(r.model, 'high');
});

test('Tier2 high: shell 报错 exit≠0（非打包/测试）', () => {
  const r = classify(ev({
    observationType: 'shell', toolName: 'shell',
    toolInput: { command: 'git push origin main' },
    toolOutput: { exitCode: 1, stdout: '', stderr: 'rejected: non-fast-forward' },
  }), []);
  assert.equal(r.tier, 2);
  assert.equal(r.model, 'high');
});

test('Tier2 high: 写文档/markdown 带实质 diff', () => {
  const r = classify(ev({
    observationType: 'file_edit', toolName: 'file_edit',
    toolInput: { filePath: 'docs/design.md', editType: 'modify' },
    toolOutput: { diff: '+## 架构设计\n+本节描述分档蒸馏的整体架构与数据流，包含三档判定逻辑。' },
  }), []);
  assert.equal(r.tier, 2);
  assert.equal(r.model, 'high');
});

test('Tier2 high: 内容多的新建文件', () => {
  const r = classify(ev({
    observationType: 'file_edit', toolName: 'file_edit',
    toolInput: { filePath: 'src/newModule.ts', editType: 'create' },
    toolOutput: { diff: '+'.repeat(700) },
  }), []);
  assert.equal(r.tier, 2);
  assert.equal(r.model, 'high');
});

// ---------------------------------------------------------------------------
// Tier 2 中级
// ---------------------------------------------------------------------------

test('Tier2 light: 普通源码编辑带 diff', () => {
  const r = classify(ev({
    observationType: 'file_edit', toolName: 'file_edit',
    toolInput: { filePath: 'src/service.ts', editType: 'modify' },
    toolOutput: { diff: '+ function handle() { return doWork(); }\n- function handle() { return null; }' },
  }), []);
  assert.equal(r.tier, 2);
  assert.equal(r.model, 'light');
});

test('Tier2 light: MCP 业务结果', () => {
  const r = classify(ev({
    observationType: 'mcp', toolName: 'linear:create_issue',
    toolInput: { title: 'bug' },
    toolOutput: { id: 'ISS-1', url: 'https://...' },
  }), []);
  assert.equal(r.tier, 2);
  assert.equal(r.model, 'light');
});

test('Tier2 light: 打包/测试失败', () => {
  const r = classify(ev({
    observationType: 'shell', toolName: 'shell',
    toolInput: { command: 'npm test' },
    toolOutput: { exitCode: 1, stdout: '', stderr: '3 failing' },
  }), []);
  assert.equal(r.tier, 2);
  assert.equal(r.model, 'light');
});

// ---------------------------------------------------------------------------
// 边界
// ---------------------------------------------------------------------------

test('边界: 处理图片的 shell 脚本不被误判为图片垃圾', () => {
  const r = classify(ev({
    observationType: 'shell', toolName: 'shell',
    toolInput: { command: 'node scripts/generate-icons.js --input logo.png --out icons/' },
    toolOutput: { exitCode: 0, stdout: 'generated 5 icons', stderr: '' },
  }), []);
  assert.notEqual(r.tier, 0);
  assert.equal(r.tier, 1);
});

test('边界: 无法判断时 fail-open 到 Tier2 高级', () => {
  const r = classify(ev({
    observationType: undefined, toolName: 'some_unknown_tool',
    toolInput: { foo: 'bar' },
    toolOutput: { baz: 'qux' },
  }), []);
  assert.equal(r.tier, 2);
  assert.equal(r.model, 'high');
});

test('computeSignature 确定性且随输入变化', () => {
  const a = ev({ toolName: 'shell', toolInput: { command: 'git status' } });
  const b = ev({ toolName: 'shell', toolInput: { command: 'git status' } });
  const c = ev({ toolName: 'shell', toolInput: { command: 'git log' } });
  assert.equal(computeSignature(a), computeSignature(b));
  assert.notEqual(computeSignature(a), computeSignature(c));
});

test('computeSignature: agent_response/agent_thought 用 toolOutput 区分（避免同会话误判 duplicate）', () => {
  // recordResponse 固定发送 toolInput:{}，内容只在 toolOutput；不同回复必须有不同签名
  const r1 = ev({ toolName: 'agent_response', toolInput: {}, toolOutput: { response: '回复一' } });
  const r2 = ev({ toolName: 'agent_response', toolInput: {}, toolOutput: { response: '回复二' } });
  assert.notEqual(computeSignature(r1), computeSignature(r2));

  const t1 = ev({ toolName: 'agent_thought', toolInput: {}, toolOutput: { thought: '想法一' } });
  const t2 = ev({ toolName: 'agent_thought', toolInput: {}, toolOutput: { thought: '想法二' } });
  assert.notEqual(computeSignature(t1), computeSignature(t2));
});

test('Tier0 duplicate: 同会话内不同 agent_response 不应被误判为 duplicate', () => {
  const first = ev({ toolName: 'agent_response', toolInput: {}, toolOutput: { response: '这是第一轮的详细回答，包含足够多的内容用于走 Tier2 通道。'.repeat(5) } });
  const second = ev({ toolName: 'agent_response', toolInput: {}, toolOutput: { response: '这是第二轮完全不同的回答，内容也足够长，应当独立入库。'.repeat(5) } });
  const c1 = classify(first, []);
  const c2 = classify(second, [c1.signature]);
  assert.notEqual(c2.tier, 0);
  assert.notEqual(c2.dropReason, 'duplicate');
});

test('支持 toolInput/toolOutput 为 JSON 字符串', () => {
  const r = classify(ev({
    observationType: 'shell', toolName: 'shell',
    toolInput: JSON.stringify({ command: 'git status' }),
    toolOutput: JSON.stringify({ exitCode: 0, stdout: 'clean' }),
  }), []);
  assert.equal(r.tier, 1);
});

// ---------------------------------------------------------------------------
// extractMcpEvidence - 仅 MCP 存原始证据
// ---------------------------------------------------------------------------

test('isMcpEvent: type=mcp 或 toolName 含冒号', () => {
  assert.equal(isMcpEvent(ev({ observationType: 'mcp', toolName: 'foo' })), true);
  assert.equal(isMcpEvent(ev({ toolName: 'server:search' })), true);
  assert.equal(isMcpEvent(ev({ observationType: 'shell', toolName: 'shell' })), false);
});

test('evidence: 非 MCP 事件返回 null', () => {
  assert.equal(extractMcpEvidence(ev({
    observationType: 'file_edit', toolName: 'file_edit',
    toolOutput: { diff: '+a lot of content here' },
  })), null);
});

test('evidence: MCP 空结果返回 null', () => {
  assert.equal(extractMcpEvidence(ev({
    observationType: 'mcp', toolName: 'kb:search', toolOutput: { results: [] },
  })), null);
});

test('evidence: MCP 有结果存完整原文', () => {
  const out = { results: [{ id: 1, content: 'wiki 内容证据' }] };
  const e = extractMcpEvidence(ev({ observationType: 'mcp', toolName: 'kb:search', toolOutput: out }));
  assert.equal(e, JSON.stringify(out));
});

test('evidence: 字符串结果原样保留', () => {
  const e = extractMcpEvidence(ev({ toolName: 'kb:get', toolOutput: '查询结果纯文本' }));
  assert.equal(e, '查询结果纯文本');
});

test('evidence: 超过上限被截断并标记', () => {
  const big = 'x'.repeat(MAX_EVIDENCE_CHARS + 5000);
  const e = extractMcpEvidence(ev({ toolName: 'kb:fetch', toolOutput: big }));
  assert.ok(e);
  assert.ok(e!.endsWith('…[truncated]'));
  assert.equal(e!.length, MAX_EVIDENCE_CHARS + '\n…[truncated]'.length);
});
