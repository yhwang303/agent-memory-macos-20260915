import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { MCP_PLATFORMS, McpIntegrations } from '../../src/services/integrations/McpIntegrations.js';

test('MCP_PLATFORMS contains exactly 6 entries', () => {
  assert.equal(MCP_PLATFORMS.length, 6);
});

test('each platform has id, displayName, configRelPath, configFormat', () => {
  for (const p of MCP_PLATFORMS) {
    assert.ok(p.id, `missing id`);
    assert.ok(p.displayName, `missing displayName for ${p.id}`);
    assert.ok(p.configRelPath, `missing configRelPath for ${p.id}`);
    assert.ok(p.configFormat, `missing configFormat for ${p.id}`);
  }
});

test('MCP platform IDs match expected set', () => {
  const ids = MCP_PLATFORMS.map((p) => p.id);
  assert.deepEqual(ids, ['copilot-cli', 'antigravity', 'goose', 'crush', 'roo-code', 'warp']);
});

test('buildMcpEntry generates correct structure', () => {
  const entry = McpIntegrations.buildMcpEntry('/path/to/mcp-server.js');
  assert.ok(entry['agent-memory']);
  assert.equal(entry['agent-memory'].command, 'node');
  assert.deepEqual(entry['agent-memory'].args, ['/path/to/mcp-server.js']);
  assert.deepEqual(entry['agent-memory'].env, {});
});

test('buildConfigPatch for json format wraps in mcpServers', () => {
  const patch = McpIntegrations.buildConfigPatch('/path/to/mcp.js', 'json');
  assert.ok(patch.mcpServers);
  assert.ok(patch.mcpServers['agent-memory']);
  assert.equal(patch.mcp_servers, undefined);
});

test('buildConfigPatch for yaml format wraps in mcp_servers', () => {
  const patch = McpIntegrations.buildConfigPatch('/path/to/mcp.js', 'yaml');
  assert.ok(patch.mcp_servers);
  assert.ok(patch.mcp_servers['agent-memory']);
  assert.equal(patch.mcpServers, undefined);
});

test('getConfigAbsPath returns absolute path under home', () => {
  const platform = MCP_PLATFORMS[0]; // copilot-cli
  const abs = McpIntegrations.getConfigAbsPath(platform);
  assert.equal(abs, path.join(os.homedir(), platform.configRelPath));
  assert.ok(path.isAbsolute(abs));
});
