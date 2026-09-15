import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, isMcpEvent, type NormalizedEvent } from '../src/sdk/observationClassifier.js';

function ev(partial: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    observationType: partial.observationType,
    toolName: partial.toolName ?? 'shell',
    toolInput: partial.toolInput ?? {},
    toolOutput: partial.toolOutput ?? {},
  };
}

test('isMcpEvent recognizes mcp__server__tool names', () => {
  assert.equal(isMcpEvent(ev({ toolName: 'mcp__server__search' })), true);
});

test('mcp__server__search readonly query with result is Tier1', () => {
  const r = classify(ev({
    toolName: 'mcp__iwiki__search_pages',
    toolInput: { query: 'AgentMemory' },
    toolOutput: { results: [{ title: 'AgentMemory' }] },
  }), []);
  assert.equal(r.tier, 1);
});
