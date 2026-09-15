import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerMcp } from '../desktop/src/services/MCPConfigRegistrar.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function withTempHome(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'agentmemory-mcp-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    fn(home);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
}

test('Cursor MCP registration uses runtime paths and refreshes them when the app moves', () => {
  withTempHome((home) => {
    const first = registerMcp('cursor', {
      nodePath: '/Volumes/AgentMemory/AgentMemory.app/Contents/Resources/node',
      hybridMcpServerPath: '/Volumes/AgentMemory/AgentMemory.app/Contents/Resources/hybrid-mcp/dist/server.js',
    });
    assert.equal(first.success, true);
    assert.equal(first.action, 'created');

    const configPath = join(home, '.cursor', 'mcp.json');
    let cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.deepEqual(cfg.mcpServers['agentmem-hybrid'], {
      command: '/Volumes/AgentMemory/AgentMemory.app/Contents/Resources/node',
      args: ['/Volumes/AgentMemory/AgentMemory.app/Contents/Resources/hybrid-mcp/dist/server.js'],
    });

    const moved = registerMcp('cursor', {
      nodePath: '/Applications/AgentMemory.app/Contents/Resources/node',
      hybridMcpServerPath: '/Applications/AgentMemory.app/Contents/Resources/hybrid-mcp/dist/server.js',
    });
    assert.equal(moved.success, true);
    assert.equal(moved.action, 'updated');
    cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(
      cfg.mcpServers['agentmem-hybrid'].command,
      '/Applications/AgentMemory.app/Contents/Resources/node',
    );
  });
});
