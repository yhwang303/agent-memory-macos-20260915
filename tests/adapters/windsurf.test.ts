import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { WindsurfAdapter } from '../../src/adapters/windsurf.js';

const adapter = new WindsurfAdapter();

test('windsurf: id is "windsurf"', () => {
  assert.equal(adapter.id, 'windsurf');
});

test('windsurf: configDir points to ~/.windsurf', () => {
  assert.equal(adapter.configDir, path.join(os.homedir(), '.windsurf'));
});

test('windsurf: mapEventName returns identity for known events', () => {
  assert.equal(adapter.mapEventName('beforeSubmitPrompt'), 'beforeSubmitPrompt');
  assert.equal(adapter.mapEventName('afterShellExecution'), 'afterShellExecution');
  assert.equal(adapter.mapEventName('stop'), 'stop');
  assert.equal(adapter.mapEventName('sessionStart'), 'sessionStart');
  assert.equal(adapter.mapEventName('afterFileEdit'), 'afterFileEdit');
});

test('windsurf: mapEventName returns null for unknown events', () => {
  assert.equal(adapter.mapEventName('UnknownEvent'), null);
  assert.equal(adapter.mapEventName('PostToolUse'), null);
});

test('windsurf: normalizeInput is pass-through', () => {
  const raw = { foo: 'bar', nested: { x: 1 } };
  const result = adapter.normalizeInput('afterShellExecution', raw);
  assert.deepEqual(result, raw);
  assert.equal(result, raw); // same reference
});

test('windsurf: generateHooksConfig produces flat hooks.json structure', () => {
  const cfg = adapter.generateHooksConfig('/path/to/hooks-cli.js', 'linux') as any;
  assert.equal(cfg.version, 1);
  assert.ok(cfg.hooks);
  assert.ok(cfg.hooks.beforeSubmitPrompt);
  assert.equal(cfg.hooks.beforeSubmitPrompt.length, 1);
  assert.match(cfg.hooks.beforeSubmitPrompt[0].command, /node "\/path\/to\/hooks-cli\.js" beforeSubmitPrompt/);
  assert.equal(cfg.hooks.beforeSubmitPrompt[0].timeout, 10);
  assert.equal(cfg.hooks.stop[0].timeout, 30);
});

test('windsurf: generateHooksConfig uses cmd.exe on win32', () => {
  const cfg = adapter.generateHooksConfig('/path/to/hooks-cli.js', 'win32') as any;
  assert.match(cfg.hooks.beforeSubmitPrompt[0].command, /^cmd\.exe \/c chcp 65001/);
});

test('windsurf: generateMcpConfig produces standard MCP structure', () => {
  const cfg = adapter.generateMcpConfig('/path/to/mcp-server.js') as any;
  assert.ok(cfg.mcpServers['agent-memory']);
  assert.equal(cfg.mcpServers['agent-memory'].command, 'node');
  assert.deepEqual(cfg.mcpServers['agent-memory'].args, ['/path/to/mcp-server.js']);
});
