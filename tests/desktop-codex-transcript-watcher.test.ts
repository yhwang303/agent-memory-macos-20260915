import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { CodexTranscriptWatcher, writeHookPayload } from '../desktop/src/services/CodexTranscriptWatcher';

function writeJsonl(rows: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-watcher-'));
  const file = path.join(dir, 'rollout-2026-06-16T00-00-00-019ec9e6-3233-7e30-9dfb-b3916f23aad1.jsonl');
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  return file;
}

function makeWatcher(): any {
  return new CodexTranscriptWatcher({
    nodePath: process.execPath,
    hooksCliPath: 'hooks-cli.js',
    configPath: 'hooks.json',
  } as any) as any;
}

test('CodexTranscriptWatcher swallows an expected EPIPE from hook stdin', () => {
  const stdin = new EventEmitter() as EventEmitter & { end(payload: string): void };
  stdin.end = () => {
    stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  };

  assert.doesNotThrow(() => writeHookPayload(stdin as any, '{}'));
});

test('CodexTranscriptWatcher treats mid-turn assistant messages as not complete', () => {
  const file = writeJsonl([
    {
      timestamp: '2026-06-16T03:32:55.954Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'working update' }],
      },
    },
    {
      timestamp: '2026-06-16T03:33:03.365Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'shell_command',
        call_id: 'call_1',
        arguments: JSON.stringify({ command: 'npm run typecheck' }),
      },
    },
    {
      timestamp: '2026-06-16T03:33:04.724Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'Exit code: 0\n',
      },
    },
  ]);

  const delta = makeWatcher().readDelta(file, 0);
  assert.equal(delta.taskComplete, false);
  assert.equal(delta.toolEvents.length, 1);
  assert.equal(delta.toolEvents[0].toolInput.command, 'npm run typecheck');
});

test('CodexTranscriptWatcher marks a turn complete only on task_complete event', () => {
  const file = writeJsonl([
    {
      timestamp: '2026-06-16T03:39:26.288Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'please check summaries' }],
      },
    },
    {
      timestamp: '2026-06-16T03:40:02.673Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'done' }],
      },
    },
    {
      timestamp: '2026-06-16T03:40:02.700Z',
      type: 'event_msg',
      payload: { type: 'task_complete' },
    },
  ]);

  const delta = makeWatcher().readDelta(file, 0);
  assert.deepEqual(delta.userPrompts, ['please check summaries']);
  assert.equal(delta.taskComplete, true);
});

test('CodexTranscriptWatcher records namespaced MCP tool calls', () => {
  const file = writeJsonl([
    {
      timestamp: '2026-06-25T04:20:05.436Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'search',
        namespace: 'mcp__agentmem_hybrid',
        call_id: 'call_mcp_1',
        arguments: JSON.stringify({
          query: 'codex MCP tier1 observation missing',
          project: 'D:/agent-memory',
          limit: 5,
        }),
      },
    },
    {
      timestamp: '2026-06-25T04:20:05.539Z',
      type: 'event_msg',
      payload: {
        type: 'mcp_tool_call_end',
        call_id: 'call_mcp_1',
        result: {
          Ok: {
            content: [{ type: 'text', text: '{"success":true,"results":[{"id":1}]}' }],
          },
        },
        duration: { secs: 0, nanos: 92722900 },
      },
    },
    {
      timestamp: '2026-06-25T04:20:05.547Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_mcp_1',
        output: 'Wall time: 0.0936 seconds\nOutput:\n[]',
      },
    },
  ]);

  const delta = makeWatcher().readDelta(file, 0);
  assert.equal(delta.toolEvents.length, 1);
  assert.equal(delta.toolEvents[0].toolName, 'mcp__agentmem_hybrid__search');
  assert.equal(delta.toolEvents[0].toolInput.query, 'codex MCP tier1 observation missing');
  assert.equal(delta.toolEvents[0].toolOutput.success, true);
  assert.ok(delta.toolEvents[0].toolOutput.data);
  assert.equal(delta.toolEvents[0].toolOutput.output, 'Wall time: 0.0936 seconds\nOutput:\n[]');
});

test('CodexTranscriptWatcher records current Codex Desktop custom exec calls as Tier 1 inputs', () => {
  const file = writeJsonl([
    {
      timestamp: '2026-07-18T13:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'call_exec_1',
        input: 'const r = await tools.exec_command({ cmd: "rg -n safeStorage desktop/src", workdir: "/tmp/project" }); text(r.output);',
      },
    },
    {
      timestamp: '2026-07-18T13:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'call_exec_1',
        output: { output: 'desktop/src/config/store.ts:2', exit_code: 0 },
      },
    },
  ]);

  const delta = makeWatcher().readDelta(file, 0);
  assert.equal(delta.toolEvents.length, 1);
  assert.equal(delta.toolEvents[0].toolName, 'shell_command');
  assert.equal(delta.toolEvents[0].toolInput.command, 'rg -n safeStorage desktop/src');
  assert.equal(delta.toolEvents[0].toolInput.workdir, '/tmp/project');
  assert.equal(delta.toolEvents[0].toolOutput.exit_code, 0);
});

test('CodexTranscriptWatcher routes custom apply_patch calls with their file path and diff', () => {
  const file = writeJsonl([
    {
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'call_patch_1',
        input: 'const patch = "*** Begin Patch\\n*** Update File: /tmp/project/src/a.ts\\n@@\\n-old\\n+new\\n*** End Patch"; text(await tools.apply_patch(patch));',
      },
    },
  ]);

  const delta = makeWatcher().readDelta(file, 0);
  assert.equal(delta.toolEvents[0].toolName, 'apply_patch');
  assert.equal(delta.toolEvents[0].toolInput.file_path, '/tmp/project/src/a.ts');
  assert.match(String(delta.toolEvents[0].toolInput.content), /\+new/);
});

test('CodexTranscriptWatcher reads the project from transcript metadata before app cwd', () => {
  const file = writeJsonl([
    {
      type: 'session_meta',
      payload: {
        id: '019ec9e6-3233-7e30-9dfb-b3916f23aad1',
        cwd: '/Users/test/Projects/agent-memory',
      },
    },
  ]);

  const project = makeWatcher().projectPathForSession(
    '019ec9e6-3233-7e30-9dfb-b3916f23aad1',
    file,
  );
  assert.equal(project, '/Users/test/Projects/agent-memory');
});

test('CodexTranscriptWatcher rejects a root cwd from transcript metadata', () => {
  const file = writeJsonl([
    {
      type: 'session_meta',
      payload: {
        id: '019ec9e6-3233-7e30-9dfb-b3916f23aad1',
        cwd: '/',
      },
    },
  ]);

  const project = makeWatcher().projectPathForSession(
    '019ec9e6-3233-7e30-9dfb-b3916f23aad1',
    file,
  );
  assert.equal(project, null);
});

test('CodexTranscriptWatcher does not backfill transcript changes made while AgentMemory was offline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-watcher-offline-'));
  const file = path.join(dir, 'rollout-2026-06-16T00-00-00-019ec9e6-3233-7e30-9dfb-b3916f23aad1.jsonl');
  const firstLine = JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old prompt' }] },
  }) + '\n';
  fs.writeFileSync(file, firstLine, 'utf8');
  const prev = fs.statSync(file);
  fs.appendFileSync(file, JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'offline prompt' }] },
  }) + '\n', 'utf8');
  fs.appendFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n', 'utf8');
  const offlineTime = new Date(Date.now() - 10_000);
  fs.utimesSync(file, offlineTime, offlineTime);

  const watcher = makeWatcher();
  const calls: unknown[] = [];
  watcher.state = { files: { [file]: { size: prev.size, mtimeMs: prev.mtimeMs } } };
  watcher.findRecentTranscripts = () => [file];
  watcher.writeState = () => {};
  watcher.invokeHook = async (...args: unknown[]) => {
    calls.push(args);
  };

  await watcher.scanOnce();

  assert.deepEqual(calls, []);
  assert.equal(watcher.state.files[file].size, fs.statSync(file).size);
});

test('CodexTranscriptWatcher keeps transcript fallback active for live changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-watcher-official-'));
  const file = path.join(dir, 'rollout-2026-06-16T00-00-00-019ec9e6-3233-7e30-9dfb-b3916f23aad1.jsonl');
  const firstLine = JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old prompt' }] },
  }) + '\n';
  fs.writeFileSync(file, firstLine, 'utf8');
  const prev = fs.statSync(file);
  await new Promise((resolve) => setTimeout(resolve, 5));
  fs.appendFileSync(file, JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'shell_command',
      call_id: 'call_1',
      arguments: JSON.stringify({ command: 'git status' }),
    },
  }) + '\n', 'utf8');

  const watcher = makeWatcher();
  watcher.startedAtMs = Date.now() - 20_000;
  const liveTime = new Date(Date.now() - 9_000);
  fs.utimesSync(file, liveTime, liveTime);
  const calls: unknown[] = [];
  watcher.state = { files: { [file]: { size: prev.size, mtimeMs: prev.mtimeMs } } };
  watcher.findRecentTranscripts = () => [file];
  watcher.writeState = () => {};
  watcher.invokeHook = async (...args: unknown[]) => {
    calls.push(args);
  };

  await watcher.scanOnce();

  assert.equal(calls.length, 1);
  assert.equal((calls[0] as unknown[])[0], 'post_tool_use');
  assert.equal(watcher.state.files[file].size, fs.statSync(file).size);
});
