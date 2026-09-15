import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { OpenCodeAdapter } from '../../src/adapters/opencode.js';

const adapter = new OpenCodeAdapter();

test('opencode: id is "opencode"', () => {
  assert.equal(adapter.id, 'opencode');
});

test('opencode: configDir points to ~/.opencode', () => {
  assert.equal(adapter.configDir, path.join(os.homedir(), '.opencode'));
});

test('opencode: mapEventName maps PascalCase to internal names', () => {
  assert.equal(adapter.mapEventName('UserPromptSubmit'), 'beforeSubmitPrompt');
  assert.equal(adapter.mapEventName('SessionStart'), 'sessionStart');
  assert.equal(adapter.mapEventName('SessionEnd'), 'sessionEnd');
  assert.equal(adapter.mapEventName('PreToolUse'), 'beforeShellExecution');
  assert.equal(adapter.mapEventName('PostToolUse'), 'afterToolUse');
  assert.equal(adapter.mapEventName('Stop'), 'stop');
});

test('opencode: mapEventName returns null for unknown events', () => {
  assert.equal(adapter.mapEventName('UnknownEvent'), null);
  assert.equal(adapter.mapEventName('beforeSubmitPrompt'), null);
});

test('opencode: normalizeInput coalesces transcript_path on stop', () => {
  const out = adapter.normalizeInput('stop', { session_id: 's1', transcript_path: '/tmp/t.jsonl' });
  assert.equal(out.transcript_path, '/tmp/t.jsonl');
});

test('opencode: normalizeInput accepts transcriptPath alias on stop', () => {
  const out = adapter.normalizeInput('stop', { session_id: 's1', transcriptPath: '/tmp/t.jsonl' });
  assert.equal(out.transcript_path, '/tmp/t.jsonl');
});

test('opencode: normalizeInput routes afterToolUse Bash to afterShellExecution', () => {
  const out = adapter.normalizeInput('afterToolUse', { tool_name: 'Bash', command: 'ls' });
  assert.equal(out._routeTo, 'afterShellExecution');
});

test('opencode: normalizeInput routes nested Bash command to afterShellExecution', () => {
  const out = adapter.normalizeInput('afterToolUse', { tool_name: 'Bash', tool_input: { command: 'pwd' } });
  assert.equal(out._routeTo, 'afterShellExecution');
});

test('opencode: normalizeInput routes afterToolUse MCP to afterMCPExecution', () => {
  const out = adapter.normalizeInput('afterToolUse', { tool_name: 'mcp__github__search' });
  assert.equal(out._routeTo, 'afterMCPExecution');
});

test('opencode: normalizeInput routes nested MCP payload to afterMCPExecution', () => {
  const out = adapter.normalizeInput('afterToolUse', {
    tool_name: 'mcp_call_tool',
    tool_input: { serverName: 'iwiki', toolName: 'search_pages' },
  });
  assert.equal(out._routeTo, 'afterMCPExecution');
});

test('opencode: normalizeInput routes afterToolUse Write to afterFileEdit', () => {
  const out = adapter.normalizeInput('afterToolUse', { tool_name: 'Write', file_path: '/tmp/f.ts' });
  assert.equal(out._routeTo, 'afterFileEdit');
});

test('opencode: normalizeInput routes afterToolUse Edit to afterFileEdit', () => {
  const out = adapter.normalizeInput('afterToolUse', { tool_name: 'Edit' });
  assert.equal(out._routeTo, 'afterFileEdit');
});

test('opencode: normalizeInput routes afterToolUse FileWrite to afterFileEdit', () => {
  const out = adapter.normalizeInput('afterToolUse', { tool_name: 'FileWrite' });
  assert.equal(out._routeTo, 'afterFileEdit');
});

test('opencode: normalizeInput routes afterToolUse FileEdit to afterFileEdit', () => {
  const out = adapter.normalizeInput('afterToolUse', { tool_name: 'FileEdit' });
  assert.equal(out._routeTo, 'afterFileEdit');
});

test('opencode: normalizeInput routes afterToolUse MultiEdit to afterFileEdit', () => {
  const out = adapter.normalizeInput('afterToolUse', { tool_name: 'MultiEdit' });
  assert.equal(out._routeTo, 'afterFileEdit');
});

test('opencode: normalizeInput defaults unknown tool to afterShellExecution', () => {
  const out = adapter.normalizeInput('afterToolUse', { tool_name: 'Read' });
  assert.equal(out._routeTo, 'afterShellExecution');
});

test('opencode: normalizeInput pass-through for other events', () => {
  const raw = { session_id: 's1' };
  const out = adapter.normalizeInput('sessionStart', raw);
  assert.deepEqual(out, raw);
});

test('opencode: generateHooksConfig produces nested format with matcher', () => {
  const cfg = adapter.generateHooksConfig('/path/to/hooks-cli.js', 'linux') as any;
  assert.ok(cfg.hooks);

  const userPrompt = cfg.hooks['UserPromptSubmit'];
  assert.ok(userPrompt);
  assert.equal(userPrompt[0].matcher, '');
  assert.equal(userPrompt[0].hooks[0].type, 'command');
  assert.equal(userPrompt[0].hooks[0].timeout, 10000);

  const preToolUse = cfg.hooks['PreToolUse'];
  assert.equal(preToolUse[0].matcher, 'Bash');
  assert.equal(preToolUse[0].hooks[0].timeout, 10000);

  const stop = cfg.hooks['Stop'];
  assert.equal(stop[0].hooks[0].timeout, 30000);
});

test('opencode: generateHooksConfig uses cmd.exe on win32', () => {
  const cfg = adapter.generateHooksConfig('/path/to/hooks-cli.js', 'win32') as any;
  assert.match(cfg.hooks['UserPromptSubmit'][0].hooks[0].command, /^cmd\.exe \/c chcp 65001/);
});

test('opencode: generateMcpConfig produces standard MCP structure', () => {
  const cfg = adapter.generateMcpConfig('/path/to/mcp-server.js') as any;
  assert.ok(cfg.mcpServers['agent-memory']);
  assert.equal(cfg.mcpServers['agent-memory'].command, 'node');
  assert.deepEqual(cfg.mcpServers['agent-memory'].args, ['/path/to/mcp-server.js']);
});
