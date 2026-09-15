import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

test('failed AI extraction still stores Claude replies and deduplicates a replay', async (t) => {
  const dir = mkdtempSync(join(os.tmpdir(), 'agentmemory-api-failure-'));
  const homeMock = t.mock.method(os, 'homedir', () => dir);
  syncBuiltinESMExports();
  const { SDKAgent } = await import('../src/services/worker/SDKAgent.js');
  const { getDatabase, closeDatabase } = await import('../src/services/sqlite/Database.js');
  try {
    const agent = new SDKAgent();
    t.mock.method(agent as any, 'callAI', async () => { throw new Error('401 invalid_api_key'); });
    const input = {
      memorySessionId: 'test-claude-missing-key', project: '/test/project',
      toolName: 'agent_response', toolInput: { source: 'transcript' },
      toolOutput: { response: 'The original assistant reply must survive an API outage.' },
      observationType: 'agent_response', sourceIde: 'claude-code',
    };
    const row = await agent.processObservation(input);
    assert.ok(row?.id);
    const stored = getDatabase().prepare('SELECT * FROM observations WHERE id = ?').get(row.id) as any;
    assert.equal(stored.source_ide, 'claude-code');
    assert.equal(stored.narrative, input.toolOutput.response);
    assert.match(stored.subtitle, /AI.*失败/);
    await agent.processObservation(input);
    assert.equal((getDatabase().prepare('SELECT count(*) AS n FROM observations').get() as any).n, 1);
    const prompt = 'Preserve the user question even when the model is unavailable.';
    const promptRow = await agent.processObservation({ ...input, toolName: 'user_prompt',
      toolInput: { prompt }, toolOutput: { recorded: true } });
    assert.ok(promptRow?.id);
    const storedPrompt = getDatabase().prepare('SELECT text FROM observations WHERE id = ?').get(promptRow.id) as any;
    assert.ok(storedPrompt.text.includes(prompt));
  } finally {
    closeDatabase();
    homeMock.mock.restore();
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing provider key never falls back to credentials from another provider', async () => {
  const names = ['TIMIAI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
    'CODEBUDDY_MEM_API_ENDPOINT', 'CODEBUDDY_MEM_LIGHT_API_KEY'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = '';
    process.env.CODEBUDDY_MEM_API_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
    const { SDKAgent } = await import('../src/services/worker/SDKAgent.js');
    const agent = new SDKAgent() as any;
    assert.equal(agent.highTarget().apiKey, undefined);
    assert.equal(agent.lightTarget().apiKey, '');
    process.env.OPENAI_API_KEY = 'test-provider-key';
    const configured = new SDKAgent() as any;
    assert.equal(configured.highTarget().apiKey, 'test-provider-key');
    assert.equal(configured.lightTarget().apiKey, '');
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
