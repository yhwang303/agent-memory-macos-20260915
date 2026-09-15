import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodeBuddyIDEAdapter } from '../../src/adapters/codebuddy-ide.js';

const adapter = new CodeBuddyIDEAdapter();

test('codebuddy-ide: normalizeInput routes nested Bash command to afterShellExecution', () => {
  const out = adapter.normalizeInput('afterToolUse', { tool_name: 'Bash', tool_input: { command: 'pwd' } });
  assert.equal(out._routeTo, 'afterShellExecution');
});

test('codebuddy-ide: normalizeInput routes nested MCP payload to afterMCPExecution', () => {
  const out = adapter.normalizeInput('afterToolUse', {
    tool_name: 'mcp_call_tool',
    tool_input: { serverName: 'iwiki', toolName: 'search_pages' },
  });
  assert.equal(out._routeTo, 'afterMCPExecution');
});

test('codebuddy-ide: normalizeInput routes MultiEdit to afterFileEdit', () => {
  const out = adapter.normalizeInput('afterToolUse', { tool_name: 'MultiEdit' });
  assert.equal(out._routeTo, 'afterFileEdit');
});

test('codebuddy-ide: normalizeInput keeps Read out of AgentMemory observation routes', () => {
  const out = adapter.normalizeInput('afterToolUse', { tool_name: 'Read', tool_input: { filePath: 'src/a.ts' } });
  assert.equal(out._routeTo, 'afterShellExecution');
});
