import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiffFromFileEdits } from '../src/hooks-cli.js';
import { classify } from '../src/sdk/observationClassifier.js';

test('Cursor afterFileEdit edits array is converted to a non-empty diff', () => {
  const diff = buildDiffFromFileEdits([
    { old_string: '', new_string: 'export const value = 1;\n' },
  ]);

  assert.equal(diff, '- \n+ export const value = 1;\n');

  const result = classify({
    observationType: 'file_edit',
    toolName: 'file_edit',
    toolInput: { file_path: 'src/example.ts' },
    toolOutput: { diff },
  }, []);

  assert.notEqual(result.tier, 0);
  assert.notEqual(result.dropReason, 'empty diff');
});
