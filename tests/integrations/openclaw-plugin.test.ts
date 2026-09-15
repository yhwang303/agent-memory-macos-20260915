import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlugin } from '../../src/integrations/openclaw-plugin/index.js';
import { resolveConfig, DEFAULT_CONFIG } from '../../src/integrations/openclaw-plugin/config.js';
import { EmojiAssigner } from '../../src/integrations/openclaw-plugin/feed/EmojiAssigner.js';
import { ObservationFeed } from '../../src/integrations/openclaw-plugin/feed/ObservationFeed.js';
import { feedCommand } from '../../src/integrations/openclaw-plugin/commands/feed.js';

test('resolveConfig merges partial config', () => {
  const config = resolveConfig({ project: 'test-project' });
  assert.equal(config.project, 'test-project');
  assert.equal(config.workerPort, DEFAULT_CONFIG.workerPort);
  assert.equal(config.observationFeed.enabled, false);
});

test('resolveConfig deep merges observationFeed', () => {
  const config = resolveConfig({ observationFeed: { enabled: true, channel: 'discord', to: 'webhook-url' } });
  assert.equal(config.observationFeed.enabled, true);
  assert.equal(config.observationFeed.channel, 'discord');
});

test('createPlugin returns valid plugin structure', () => {
  const plugin = createPlugin();
  assert.equal(plugin.name, 'agent-memory');
  assert.ok(plugin.hooks.before_agent_start);
  assert.ok(plugin.hooks.before_prompt_build);
  assert.ok(plugin.hooks.tool_result_persist);
  assert.ok(plugin.hooks.agent_end);
  assert.ok(plugin.hooks.gateway_start);
  assert.ok(plugin.hooks.message_received, 'message_received hook should be registered');
  assert.ok(plugin.hooks.message_sent, 'message_sent hook should be registered');
  assert.equal(typeof plugin.start, 'function');
  assert.equal(typeof plugin.stop, 'function');
});

test('tool_result_persist hook returns void (sync), not a Promise', () => {
  const plugin = createPlugin();
  const result = plugin.hooks.tool_result_persist(
    { tool_name: 'echo', result: 'hi', session_id: 's1' },
    {}
  );
  assert.equal(result, undefined, 'sync hook must not return a Promise');
});

test('message_received calls /api/session/start and /api/observation', async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response('{}', { status: 200 });
  }) as any;

  try {
    const plugin = createPlugin();
    await plugin.hooks.message_received(
      { session_id: 'chan-1', text: 'hello', channel: 'control-ui', from: 'lanyi' },
      {}
    );
    const start = calls.find(c => c.url.endsWith('/api/session/start'));
    const obs = calls.find(c => c.url.endsWith('/api/observation'));
    assert.ok(start, 'session/start should be invoked');
    assert.equal(start!.body.sessionId, 'chan-1');
    assert.ok(obs, 'observation should be invoked');
    assert.equal(obs!.body.observationType, 'channel_inbound');
    assert.equal(obs!.body.toolOutput, 'hello');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('message_sent posts a channel_outbound observation only', async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response('{}', { status: 200 });
  }) as any;

  try {
    const plugin = createPlugin();
    await plugin.hooks.message_sent(
      { session_id: 'chan-1', text: 'world', channel: 'control-ui', to: 'lanyi' },
      {}
    );
    assert.equal(calls.length, 1, 'should only post observation, not session/start');
    assert.ok(calls[0].url.endsWith('/api/observation'));
    assert.equal(calls[0].body.observationType, 'channel_outbound');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('agent_end posts agent_response observation then /api/session/end (no /api/summary or /api/session/complete)', async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response('{}', { status: 200 });
  }) as any;

  try {
    const plugin = createPlugin();
    await plugin.hooks.agent_end(
      { session_id: 'agent:main:main', response: 'final reply text' },
      {}
    );

    const obs = calls.find(c => c.url.endsWith('/api/observation'));
    const end = calls.find(c => c.url.endsWith('/api/session/end'));
    const summary = calls.find(c => c.url.endsWith('/api/summary'));
    const complete = calls.find(c => c.url.endsWith('/api/session/complete'));

    assert.ok(obs, 'agent_response observation should be posted');
    assert.equal(obs!.body.observationType, 'agent_response');
    assert.ok(end, '/api/session/end should be invoked');
    assert.equal(end!.body.sessionId, 'agent:main:main');
    assert.equal(end!.body.reason, 'openclaw_agent_end');
    assert.equal(summary, undefined, 'must not call deprecated /api/summary endpoint');
    assert.equal(complete, undefined, 'must not call deprecated /api/session/complete endpoint');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('captureChannel=false disables message hooks', async () => {
  const calls: any[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls.push(1);
    return new Response('{}', { status: 200 });
  }) as any;

  try {
    const plugin = createPlugin({ captureChannel: false });
    await plugin.hooks.message_received({ session_id: 's', text: 'x' }, {});
    await plugin.hooks.message_sent({ session_id: 's', text: 'y' }, {});
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('EmojiAssigner returns consistent emoji for same agent', () => {
  const assigner = new EmojiAssigner();
  const emoji1 = assigner.assign('agent-1');
  const emoji2 = assigner.assign('agent-1');
  assert.equal(emoji1, emoji2);
});

test('EmojiAssigner returns different emojis for different agents', () => {
  const assigner = new EmojiAssigner();
  const results = new Set<string>();
  for (let i = 0; i < 10; i++) {
    results.add(assigner.assign(`agent-${i}`));
  }
  assert.ok(results.size > 1, 'Should produce diverse emoji assignments');
});

test('EmojiAssigner.reset clears assignments', () => {
  const assigner = new EmojiAssigner();
  assigner.assign('agent-1');
  assigner.reset();
  const emoji = assigner.assign('agent-1');
  assert.ok(emoji);
});

test('ObservationFeed initial state is disconnected', () => {
  const feed = new ObservationFeed('http://localhost:0', { enabled: true, channel: 'telegram', to: '123' });
  assert.equal(feed.isConnected(), false);
});

test('ObservationFeed.disconnect sets connected to false', () => {
  const feed = new ObservationFeed('http://localhost:0', { enabled: true, channel: 'telegram', to: '123' });
  feed.disconnect();
  assert.equal(feed.isConnected(), false);
});

test('feedCommand reports DISABLED when feed is null', () => {
  const result = feedCommand(null);
  assert.ok(result.includes('DISABLED'));
});

test('feedCommand reports DISCONNECTED when feed exists but not connected', () => {
  const feed = new ObservationFeed('http://localhost:0', { enabled: true, channel: 'telegram', to: '123' });
  const result = feedCommand(feed);
  assert.ok(result.includes('DISCONNECTED'));
});
