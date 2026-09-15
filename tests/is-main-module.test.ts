import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMainModule } from '../src/utils/isMainModule.js';

test('isMainModule: identical path is main', () => {
  const orig = process.argv[1];
  process.argv[1] = '/tmp/x.js';
  try {
    assert.equal(isMainModule('file:///tmp/x.js'), true);
  } finally {
    process.argv[1] = orig;
  }
});

test('isMainModule: .ts vs .js extension treated equal', () => {
  const orig = process.argv[1];
  process.argv[1] = '/tmp/x.js';
  try {
    assert.equal(isMainModule('file:///tmp/x.ts'), true);
  } finally {
    process.argv[1] = orig;
  }
});

test('isMainModule: different path returns false', () => {
  const orig = process.argv[1];
  process.argv[1] = '/tmp/runner.js';
  try {
    assert.equal(isMainModule('file:///tmp/lib.js'), false);
  } finally {
    process.argv[1] = orig;
  }
});

test('isMainModule: Windows drive letter handled', () => {
  const orig = process.argv[1];
  process.argv[1] = 'C:\\project\\x.ts';
  try {
    assert.equal(isMainModule('file:///C:/project/x.ts'), true);
  } finally {
    process.argv[1] = orig;
  }
});

test('isMainModule: returns false on parse error', () => {
  const orig = process.argv[1];
  process.argv[1] = '/tmp/x.js';
  try {
    assert.equal(isMainModule('not a url'), false);
  } finally {
    process.argv[1] = orig;
  }
});
