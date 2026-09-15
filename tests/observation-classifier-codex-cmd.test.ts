import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, type NormalizedEvent } from '../src/sdk/observationClassifier.js';

function ev(partial: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    observationType: partial.observationType,
    toolName: partial.toolName ?? 'shell_execution',
    toolInput: partial.toolInput ?? {},
    toolOutput: partial.toolOutput ?? {},
  };
}

test('shell classification accepts Codex exec_command tool_input.cmd', () => {
  const r = classify(ev({
    observationType: 'shell',
    toolInput: { cmd: 'rg -n "foo" src' },
    toolOutput: { exitCode: 0, stdout: 'src/a.ts:1:foo', stderr: '' },
  }), []);

  assert.equal(r.tier, 1);
});
