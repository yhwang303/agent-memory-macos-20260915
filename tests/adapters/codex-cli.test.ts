import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { CodexCliAdapter, isCodexHookInput } from '../../src/adapters/codex-cli.js';
import { detectAdapterByEvent } from '../../src/adapters/registry.js';

const adapter = new CodexCliAdapter();

test('codex-cli: id is "codex-cli"', () => {
  assert.equal(adapter.id, 'codex-cli');
});

test('codex-cli: configDir points to ~/.codex', () => {
  assert.equal(adapter.configDir, path.join(os.homedir(), '.codex'));
});

test('codex-cli: sessionsDir points to ~/.codex/sessions', () => {
  assert.equal(adapter.sessionsDir, path.join(os.homedir(), '.codex', 'sessions'));
});

test('codex-cli: hooksConfigFile is hooks.json', () => {
  assert.equal(adapter.hooksConfigFile, 'hooks.json');
});

test('codex-cli: mapEventName maps Codex App snake_case events to AgentMemory internal events', () => {
  assert.equal(adapter.mapEventName('user_prompt_submit'), 'beforeSubmitPrompt');
  assert.equal(adapter.mapEventName('stop'), 'stop');
  assert.equal(adapter.mapEventName('session_start'), 'sessionStart');
  assert.equal(adapter.mapEventName('session_end'), 'sessionEnd');
  assert.equal(adapter.mapEventName('pre_tool_use'), 'beforeShellExecution');
  assert.equal(adapter.mapEventName('post_tool_use'), 'afterToolUse');
  assert.equal(adapter.mapEventName('pre_compact'), 'beforePreCompact');
});

test('codex-cli: mapEventName keeps PascalCase aliases for compatibility', () => {
  assert.equal(adapter.mapEventName('UserPromptSubmit'), 'beforeSubmitPrompt');
  assert.equal(adapter.mapEventName('PostToolUse'), 'afterToolUse');
});

test('codex-cli: mapEventName returns null for unsupported events', () => {
  assert.equal(adapter.mapEventName('beforeSubmitPrompt'), null);
  assert.equal(adapter.mapEventName('afterAgentThought'), null);
});

test('codex-cli: normalizeInput coalesces transcript_path on stop', () => {
  const out = adapter.normalizeInput('stop', { session_id: 's1', transcript_path: '/tmp/t.jsonl' });
  assert.equal(out.transcript_path, '/tmp/t.jsonl');
});

test('codex-cli: normalizeInput accepts transcriptPath alias on stop', () => {
  const out = adapter.normalizeInput('stop', { session_id: 's1', transcriptPath: '/tmp/t.jsonl' });
  assert.equal(out.transcript_path, '/tmp/t.jsonl');
});

test('codex-cli: normalizeInput routes PostToolUse shell tools', () => {
  const out = adapter.normalizeInput('afterToolUse', {
    hook_event_name: 'PostToolUse',
    tool_name: 'shell_command',
    tool_input: { command: 'npm test' },
  });
  assert.equal(out._routeTo, 'afterShellExecution');
});

test('codex-cli: normalizeInput routes exec_command payloads with cmd', () => {
  const out = adapter.normalizeInput('afterToolUse', {
    hook_event_name: 'PostToolUse',
    tool_name: 'exec_command',
    tool_input: { cmd: 'npm test' },
  });
  assert.equal(out._routeTo, 'afterShellExecution');
});

test('codex-cli: normalizeInput routes PostToolUse file edit tools', () => {
  const out = adapter.normalizeInput('afterToolUse', {
    hook_event_name: 'PostToolUse',
    tool_name: 'apply_patch',
    tool_input: { file_path: 'src/a.ts' },
  });
  assert.equal(out._routeTo, 'afterFileEdit');
});

test('codex-cli: normalizeInput routes PostToolUse MCP tools', () => {
  const out = adapter.normalizeInput('afterToolUse', {
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__agentmem-hybrid__search',
    tool_input: { query: 'codex' },
  });
  assert.equal(out._routeTo, 'afterMCPExecution');
});

test('codex-cli: generateHooksConfig writes Codex App PascalCase AgentMemory memory hooks', () => {
  const cfg = adapter.generateHooksConfig('/path/to/hooks-cli.js', 'linux') as { hooks: Record<string, unknown[]> };
  for (const eventName of ['UserPromptSubmit', 'SessionStart', 'PostToolUse', 'PreToolUse', 'PreCompact', 'Stop', 'SessionEnd']) {
    assert.ok(Array.isArray(cfg.hooks[eventName]), `${eventName} should be registered`);
  }
  assert.equal(cfg.hooks.stop, undefined);
  const group = cfg.hooks.Stop[0] as { hooks: Array<{ command: string; timeout: number }> };
  assert.equal(group.hooks[0].timeout, 30);
  assert.match(group.hooks[0].command, /hooks-cli\.js/);
  assert.match(group.hooks[0].command, /Stop/);
});

test('codex-cli: generateMcpConfig produces core MCP structure only', () => {
  const cfg = adapter.generateMcpConfig('/path/to/mcp-server.js') as any;
  assert.ok(cfg.mcpServers['agent-memory']);
  assert.equal(cfg.mcpServers['agent-memory'].command, 'node');
  assert.deepEqual(cfg.mcpServers['agent-memory'].args, ['/path/to/mcp-server.js']);
  assert.equal(cfg.mcpServers['agentmem-hybrid'], undefined);
});

test('isCodexHookInput: true for Codex Stop payload shape', () => {
  assert.equal(
    isCodexHookInput({
      hook_event_name: 'stop',
      session_id: 'thread-1',
      turn_id: 'turn-1',
      permission_mode: 'default',
      stop_hook_active: false,
      transcript_path: '/tmp/t.jsonl',
      cwd: '/proj',
      model: 'gpt-5',
      last_assistant_message: 'done',
    }),
    true,
  );
});

test('isCodexHookInput: false without turn_id', () => {
  assert.equal(
    isCodexHookInput({
      hook_event_name: 'Stop',
      session_id: 's1',
      permission_mode: 'default',
    }),
    false,
  );
});

test('detectAdapterByEvent: prefers codex-cli when stdin is Codex Stop', () => {
  const codexStop = {
    hook_event_name: 'stop',
    session_id: 'thread-1',
    turn_id: 'turn-1',
    permission_mode: 'default',
    stop_hook_active: false,
    transcript_path: '/tmp/t.jsonl',
    cwd: '/proj',
    model: 'gpt-5',
    last_assistant_message: null,
  };
  const matched = detectAdapterByEvent('stop', codexStop);
  assert.equal(matched?.id, 'codex-cli');
});

test('detectAdapterByEvent: prefers codex-cli for Codex PostToolUse payload', () => {
  const codexPostToolUse = {
    hook_event_name: 'post_tool_use',
    session_id: 'thread-1',
    turn_id: 'turn-1',
    cwd: '/proj',
    tool_name: 'shell_command',
    tool_input: { command: 'pwd' },
  };
  const matched = detectAdapterByEvent('post_tool_use', codexPostToolUse);
  assert.equal(matched?.id, 'codex-cli');
});
