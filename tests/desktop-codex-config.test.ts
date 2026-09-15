import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isCodexMcpRegistered,
  registerCodexMcp,
  unregisterCodexMcp,
} from '../desktop/src/shared/codex-config.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function withTempHome(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'codex-mcp-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    fn(home);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test('codex mcp registration writes only core agent-memory server', () => {
  withTempHome((home) => {
    const mcpPath = join(home, '.codex', 'mcp.json');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      mcpPath,
      JSON.stringify({ mcpServers: { existing: { command: 'keep' }, 'cbm-hybrid': { command: 'old' } } }),
      'utf8',
    );

    const result = registerCodexMcp('C:\\agentmemory\\node.exe', 'C:\\agentmemory\\worker\\mcp-server.js');
    assert.equal(result.success, true);

    const cfg = JSON.parse(readFileSync(mcpPath, 'utf8'));
    assert.equal(cfg.mcpServers.existing.command, 'keep');
    assert.equal(cfg.mcpServers['agent-memory'].command, 'C:\\agentmemory\\node.exe');
    assert.deepEqual(cfg.mcpServers['agent-memory'].args, ['C:\\agentmemory\\worker\\mcp-server.js']);
    assert.equal(cfg.mcpServers['agentmem-hybrid'], undefined);
    assert.equal(cfg.mcpServers['cbm-hybrid'], undefined);
    assert.equal(isCodexMcpRegistered(mcpPath), true);
  });
});

test('codex mcp unregister removes only AgentMemory-managed entries', () => {
  withTempHome((home) => {
    const mcpPath = join(home, '.codex', 'mcp.json');
    const result = registerCodexMcp('C:\\agentmemory\\node.exe', 'C:\\agentmemory\\worker\\mcp-server.js');
    assert.equal(result.success, true);

    const before = JSON.parse(readFileSync(mcpPath, 'utf8'));
    before.mcpServers.existing = { command: 'keep' };
    writeFileSync(mcpPath, JSON.stringify(before, null, 2), 'utf8');

    const removed = unregisterCodexMcp();
    assert.equal(removed.success, true);

    const cfg = JSON.parse(readFileSync(mcpPath, 'utf8'));
    assert.deepEqual(cfg.mcpServers, { existing: { command: 'keep' } });
    assert.equal(isCodexMcpRegistered(mcpPath), false);
  });
});
