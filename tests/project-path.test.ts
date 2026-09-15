import test from 'node:test';
import assert from 'node:assert/strict';
import { isLowConfidenceProjectPath, resolveHookProjectPath } from '../src/utils/projectPath.js';

test('workspace metadata wins over environment and cwd fallbacks', () => {
  const project = resolveHookProjectPath(
    { workspace: ['/Users/test/Projects/workspace'], cwd: '/Users/test/Projects/subdir' },
    { CURSOR_PROJECT_DIR: '/Users/test/Projects/env' },
    '/Applications/AgentMemory.app',
  );
  assert.equal(project, '/Users/test/Projects/workspace');
});

test('CodeBuddy IDE project environment variable is supported', () => {
  const project = resolveHookProjectPath(
    {},
    { CODEBUDDY_IDE_PROJECT_DIR: 'D:\\agent-memory' },
    'C:\\Windows\\System32',
  );
  assert.equal(project, 'D:\\agent-memory');
});

test('event cwd is used by lifecycle and tool events when no workspace root exists', () => {
  assert.equal(
    resolveHookProjectPath({ cwd: '/Users/test/Projects/agent-memory' }, {}, '/'),
    '/Users/test/Projects/agent-memory',
  );
});

test('confirmed macOS root fallback is rejected', () => {
  assert.equal(isLowConfidenceProjectPath('/'), true);
  assert.equal(resolveHookProjectPath({ cwd: '/' }, {}, '/'), '');
});

test('Windows system and drive-root directories remain valid when explicitly supplied', () => {
  for (const candidate of ['D:/', 'C:\\Windows\\System32']) {
    assert.equal(isLowConfidenceProjectPath(candidate), false, candidate);
    assert.equal(resolveHookProjectPath({ cwd: candidate }, {}, '/'), candidate);
  }
});

test('a valid process cwd remains the final fallback', () => {
  assert.equal(
    resolveHookProjectPath({}, {}, '/Users/test/Projects/agent-memory'),
    '/Users/test/Projects/agent-memory',
  );
});

test('explicit hook paths do not read an inaccessible process cwd', (t) => {
  const cwd = t.mock.method(process, 'cwd', () => {
    throw Object.assign(new Error('EPERM: operation not permitted, uv_cwd'), { code: 'EPERM' });
  });
  for (const input of [
    { workspace: ['/Users/test/project'] },
    { workspace_roots: ['/Users/test/project'] },
    { projectPath: '/Users/test/project' },
    { project_path: '/Users/test/project' },
    { cwd: '/Users/test/project' },
  ]) {
    assert.equal(resolveHookProjectPath(input, {}), '/Users/test/project');
  }
  assert.equal(resolveHookProjectPath({}, { CLAUDE_PROJECT_DIR: '/Users/test/project' }), '/Users/test/project');
  assert.equal(cwd.mock.callCount(), 0);
});

test('an unavailable process cwd leaves the project unknown without aborting capture', (t) => {
  t.mock.method(process, 'cwd', () => {
    throw Object.assign(new Error('ENOENT: no such file or directory, uv_cwd'), { code: 'ENOENT' });
  });
  assert.equal(resolveHookProjectPath({}, {}), '');
});

test('process cwd is read lazily when no hook path is available', (t) => {
  const cwd = t.mock.method(process, 'cwd', () => '/Users/test/runtime-project');
  assert.equal(resolveHookProjectPath({}, {}), '/Users/test/runtime-project');
  assert.equal(cwd.mock.callCount(), 1);
});
