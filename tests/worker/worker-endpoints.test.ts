/**
 * Tests for M4 new Worker endpoints: /api/session/complete, /api/readiness, /stream
 * and the EventEmitter eventBus.
 *
 * Uses the same mock req/res pattern as sync-endpoints.test.ts — no real HTTP listen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WorkerService } from '../../src/services/worker/WorkerService.js';
import type { AgentMemorySettings } from '../../src/config/settings.js';

function disabledSettings(): AgentMemorySettings {
  return {
    rag: {
      enabled: false,
      embedding_model: 'bge-m3',
      fallback_mode: 'sqlite-only',
      hybrid_weights: { sqlite: 0.4, chroma: 0.6 },
      rrf_k: 60,
    },
  };
}

function makeWorker(): WorkerService {
  return new WorkerService({
    port: 0,
    host: '127.0.0.1',
    loadSettings: disabledSettings,
  });
}

function makeReq(overrides: Record<string, any> = {}): any {
  const emitter = new EventEmitter() as any;
  emitter.method = overrides.method ?? 'GET';
  emitter.url = overrides.url ?? '/';
  emitter.headers = overrides.headers ?? {};
  return emitter;
}

function makeRes(): { res: any; captured: { status?: number; body?: string; headers: Record<string, string>; writes: string[] } } {
  const captured: { status?: number; body?: string; headers: Record<string, string>; writes: string[] } = { headers: {}, writes: [] };
  const res: any = {
    set statusCode(v: number) { captured.status = v; },
    get statusCode() { return captured.status ?? 200; },
    end(data?: string) { captured.body = data; },
    setHeader(k: string, v: string) { captured.headers[k] = v; },
    write(data: string) { captured.writes.push(data); return true; },
    writeHead(status: number) { captured.status = status; },
  };
  return { res, captured };
}

// ────────────── eventBus ──────────────

test('WorkerService exposes an EventEmitter via getEventBus()', () => {
  const worker = makeWorker();
  const bus = worker.getEventBus();
  assert.ok(bus instanceof EventEmitter, 'getEventBus() should return an EventEmitter');
});

// ────────────── /api/readiness ──────────────

test('GET /api/readiness returns 200 with ready field', async () => {
  const worker = makeWorker();
  const req = makeReq();
  const { res, captured } = makeRes();

  await (worker as any).handleReadiness(req, res);

  assert.equal(captured.status, 200);
  const body = JSON.parse(captured.body!);
  assert.equal(body.ready, true);
  assert.equal(typeof body.uptime, 'number');
  assert.equal(body.chroma, false);
});

// ────────────── /api/session/complete ──────────────

test('POST /api/session/complete returns 400 without session id', async () => {
  const worker = makeWorker();
  const req = makeReq({ method: 'POST' });
  const { res, captured } = makeRes();

  const parsePromise = (worker as any).handleSessionComplete(req, res);

  req.emit('data', Buffer.from(JSON.stringify({})));
  req.emit('end');

  await parsePromise;

  assert.equal(captured.status, 400);
  const body = JSON.parse(captured.body!);
  assert.ok(body.error.toLowerCase().includes('sessionid'));
});

test('POST /api/session/complete accepts camelCase sessionId', async () => {
  const worker = makeWorker();
  const req = makeReq({ method: 'POST' });
  const { res, captured } = makeRes();

  const parsePromise = (worker as any).handleSessionComplete(req, res);
  req.emit('data', Buffer.from(JSON.stringify({ sessionId: 'sess-cc' })));
  req.emit('end');
  await parsePromise;

  // 200 if updateSessionStatus succeeds; 500 if not (no row). Both prove
  // that the handler accepted the camelCase field instead of returning 400.
  assert.notEqual(captured.status, 400);
});

test('POST /api/session/complete accepts snake_case session_id', async () => {
  const worker = makeWorker();
  const req = makeReq({ method: 'POST' });
  const { res, captured } = makeRes();

  const parsePromise = (worker as any).handleSessionComplete(req, res);
  req.emit('data', Buffer.from(JSON.stringify({ session_id: 'sess-sc' })));
  req.emit('end');
  await parsePromise;

  assert.notEqual(captured.status, 400);
});

test('POST /api/shadowfolk/workspaces/validate uses the memory-aware production validator', async () => {
  const worker = makeWorker();
  let validatedWorkspace = '';
  (worker as any).createShadowFolkWorkspaceValidator = () => ({
    validateWorkspace: async (workspace: string) => {
      validatedWorkspace = workspace;
      return {
        input: workspace,
        valid: true,
        gitRoot: 'd:/mem-distillation',
        error: null,
        mode: 'memory',
      };
    },
  });
  const req = makeReq({
    method: 'POST',
    url: '/api/shadowfolk/workspaces/validate',
  });
  const { res, captured } = makeRes();

  const requestPromise = (worker as any).handleRequest(req, res);
  req.emit('data', Buffer.from(JSON.stringify({ workspace: 'd:/mem-distillation' })));
  req.emit('end');
  await requestPromise;

  assert.equal(validatedWorkspace, 'd:/mem-distillation');
  assert.equal(captured.status, 200);
  assert.deepEqual(JSON.parse(captured.body!), {
    success: true,
    input: 'd:/mem-distillation',
    valid: true,
    gitRoot: 'd:/mem-distillation',
    error: null,
    mode: 'memory',
  });
});

// ────────────── ShadowFolk history / replay ──────────────

test('GET /api/shadowfolk/history returns full option plus workspace history', async () => {
  let calledWorkspace: any;
  const worker = new WorkerService({
    port: 0,
    host: '127.0.0.1',
    loadSettings: disabledSettings,
    shadowfolk: {
      enabled: true,
      dailyTime: '23:30',
      workspaces: ['D:/GitHub/shadow-folk'],
      createUploader: () => ({
        validateWorkspace: async () => ({ valid: true, gitRoot: 'D:/GitHub/shadow-folk' }),
        listPushHistory: async (workspace: any) => {
          calledWorkspace = workspace;
          return [{
            id: 'hist-1',
            createdAt: '2026-05-11T11:29:55.605Z',
            counts: { commits: 2, observations: 62, summaries: 7 },
          }];
        },
        pushWorkspaces: async () => ({ pushed: false, workspaces: 0, observations: 0, summaries: 0, commits: 0, results: [], failures: [] }),
      }),
    },
  } as any);
  const req = makeReq({
    method: 'GET',
    url: '/api/shadowfolk/history?workspace=D%3A%2FGitHub%2Fshadow-folk',
  });
  const { res, captured } = makeRes();

  await (worker as any).handleRequest(req, res);

  assert.equal(captured.status, 200);
  assert.deepEqual(calledWorkspace, { workspace: 'D:/GitHub/shadow-folk', memoryRoots: [] });
  const body = JSON.parse(captured.body!);
  assert.equal(body.success, true);
  assert.equal(body.options[0].kind, 'full');
  assert.equal(body.options[1].kind, 'history');
  assert.equal(body.options[1].historyId, 'hist-1');
});

test('GET /api/shadowfolk/history scrubs memoryRoots from response', async () => {
  const worker = new WorkerService({
    port: 0,
    host: '127.0.0.1',
    loadSettings: disabledSettings,
    shadowfolk: {
      enabled: true,
      dailyTime: '23:30',
      workspaces: ['D:/GitHub/foo'],
      createUploader: () => ({
        listPushHistory: async () => [{
          id: 'hist-secret-root',
          createdAt: '2026-05-11T11:29:55.605Z',
          counts: { commits: 2, observations: 62, summaries: 7 },
          memoryRoots: ['E:/GitHub/foo'],
        }],
        pushWorkspaces: async () => ({ pushed: false, workspaces: 0, observations: 0, summaries: 0, commits: 0, results: [], failures: [] }),
      }),
    },
  } as any);
  const req = makeReq({
    method: 'GET',
    url: '/api/shadowfolk/history?workspace=D%3A%2FGitHub%2Ffoo',
  });
  const { res, captured } = makeRes();

  await (worker as any).handleRequest(req, res);

  assert.equal(captured.status, 200);
  const responseText = captured.body!;
  assert.equal(responseText.includes('memoryRoots'), false);
  assert.equal(responseText.includes('E:/GitHub/foo'), false);
  const body = JSON.parse(responseText);
  assert.equal(body.options[1].historyId, 'hist-secret-root');
  assert.ok(body.options[1].label.includes('2026-05-11 11:29'));
});

test('GET /api/shadowfolk/history matches workspace aliases with equivalent path formats', async () => {
  let calledWorkspace: any;
  const worker = new WorkerService({
    port: 0,
    host: '127.0.0.1',
    loadSettings: disabledSettings,
    shadowfolk: {
      enabled: true,
      dailyTime: '23:30',
      workspaces: ['D:/GitHub/shadow-folk'],
      workspaceAliases: [{ workspace: 'D:/GitHub/shadow-folk', memoryRoots: ['E:/GitHub/shadow-folk'] }],
      createUploader: () => ({
        listPushHistory: async (workspace: any) => {
          calledWorkspace = workspace;
          return [];
        },
        pushWorkspaces: async () => ({ pushed: false, workspaces: 0, observations: 0, summaries: 0, commits: 0, results: [], failures: [] }),
      }),
    },
  } as any);
  const req = makeReq({
    method: 'GET',
    url: '/api/shadowfolk/history?workspace=D%3A%5CGitHub%5Cshadow-folk%5C',
  });
  const { res, captured } = makeRes();

  await (worker as any).handleRequest(req, res);

  assert.equal(captured.status, 200);
  assert.deepEqual(calledWorkspace, {
    workspace: 'D:/GitHub/shadow-folk',
    memoryRoots: ['E:/GitHub/shadow-folk'],
  });
});

test('POST /api/shadowfolk/replay routes full repush to uploader', async () => {
  let calledWorkspace: any;
  const worker = new WorkerService({
    port: 0,
    host: '127.0.0.1',
    loadSettings: disabledSettings,
    shadowfolk: {
      enabled: true,
      dailyTime: '23:30',
      workspaces: ['D:/GitHub/shadow-folk'],
      createUploader: () => ({
        repushWorkspaceFull: async (workspace: any) => {
          calledWorkspace = workspace;
          const workspacePath = typeof workspace === 'string' ? workspace : workspace.workspace;
          return { workspace: workspacePath, gitRoot: workspacePath, pushed: true, observations: 1, summaries: 1, commits: 1, batchId: 'full-batch' };
        },
        pushWorkspaces: async () => ({ pushed: false, workspaces: 0, observations: 0, summaries: 0, commits: 0, results: [], failures: [] }),
      }),
    },
  } as any);
  const req = makeReq({ method: 'POST', url: '/api/shadowfolk/replay' });
  const { res, captured } = makeRes();

  const promise = (worker as any).handleRequest(req, res);
  req.emit('data', Buffer.from(JSON.stringify({ workspace: 'D:/GitHub/shadow-folk', kind: 'full' })));
  req.emit('end');
  await promise;

  assert.deepEqual(calledWorkspace, { workspace: 'D:/GitHub/shadow-folk', memoryRoots: [] });
  assert.equal(captured.status, 200);
  assert.equal(JSON.parse(captured.body!).mode, 'full');
});

test('POST /api/shadowfolk/replay routes history replay to uploader', async () => {
  let calledWorkspace: any;
  let calledHistoryId = '';
  const worker = new WorkerService({
    port: 0,
    host: '127.0.0.1',
    loadSettings: disabledSettings,
    shadowfolk: {
      enabled: true,
      dailyTime: '23:30',
      workspaces: ['D:/GitHub/shadow-folk'],
      createUploader: () => ({
        replayHistoryEntry: async (workspace: any, historyId: string) => {
          calledWorkspace = workspace;
          calledHistoryId = historyId;
          const workspacePath = typeof workspace === 'string' ? workspace : workspace.workspace;
          return { workspace: workspacePath, gitRoot: workspacePath, pushed: true, observations: 62, summaries: 7, commits: 2, batchId: 'replay-batch' };
        },
        pushWorkspaces: async () => ({ pushed: false, workspaces: 0, observations: 0, summaries: 0, commits: 0, results: [], failures: [] }),
      }),
    },
  } as any);
  const req = makeReq({ method: 'POST', url: '/api/shadowfolk/replay' });
  const { res, captured } = makeRes();

  const promise = (worker as any).handleRequest(req, res);
  req.emit('data', Buffer.from(JSON.stringify({
    workspace: 'D:/GitHub/shadow-folk',
    kind: 'history',
    historyId: 'hist-1',
  })));
  req.emit('end');
  await promise;

  assert.deepEqual(calledWorkspace, { workspace: 'D:/GitHub/shadow-folk', memoryRoots: [] });
  assert.equal(calledHistoryId, 'hist-1');
  assert.equal(captured.status, 200);
  assert.equal(JSON.parse(captured.body!).mode, 'history');
});

test('POST /api/shadowfolk/replay matches workspace aliases with equivalent path formats', async () => {
  let calledWorkspace: any;
  const worker = new WorkerService({
    port: 0,
    host: '127.0.0.1',
    loadSettings: disabledSettings,
    shadowfolk: {
      enabled: true,
      dailyTime: '23:30',
      workspaces: ['D:/GitHub/shadow-folk'],
      workspaceAliases: [{ workspace: 'D:/GitHub/shadow-folk', memoryRoots: ['E:/GitHub/shadow-folk'] }],
      createUploader: () => ({
        replayHistoryEntry: async (workspace: any) => {
          calledWorkspace = workspace;
          const workspacePath = typeof workspace === 'string' ? workspace : workspace.workspace;
          return { workspace: workspacePath, gitRoot: workspacePath, pushed: true, observations: 1, summaries: 1, commits: 1, batchId: 'replay-batch' };
        },
        pushWorkspaces: async () => ({ pushed: false, workspaces: 0, observations: 0, summaries: 0, commits: 0, results: [], failures: [] }),
      }),
    },
  } as any);
  const req = makeReq({ method: 'POST', url: '/api/shadowfolk/replay' });
  const { res, captured } = makeRes();

  const promise = (worker as any).handleRequest(req, res);
  req.emit('data', Buffer.from(JSON.stringify({
    workspace: '/d:/github/shadow-folk/',
    kind: 'history',
    historyId: 'hist-1',
  })));
  req.emit('end');
  await promise;

  assert.equal(captured.status, 200);
  assert.deepEqual(calledWorkspace, {
    workspace: 'D:/GitHub/shadow-folk',
    memoryRoots: ['E:/GitHub/shadow-folk'],
  });
});

test('POST /api/shadowfolk/push passes workspace aliases to uploader', async () => {
  let receivedWorkspaces: any[] = [];
  const worker = new WorkerService({
    port: 0,
    host: '127.0.0.1',
    loadSettings: disabledSettings,
    shadowfolk: {
      enabled: true,
      dailyTime: '23:30',
      workspaces: ['D:/GitHub/foo'],
      workspaceAliases: [{ workspace: 'D:/GitHub/foo', memoryRoots: ['E:/GitHub/foo'] }],
      createUploader: () => ({
        pushWorkspaces: async (workspaces: any[]) => {
          receivedWorkspaces = workspaces;
          return { pushed: true, workspaces: 1, observations: 2, summaries: 2, commits: 1, results: [], failures: [] };
        },
      }),
    },
  } as any);
  const req = makeReq({ method: 'POST', url: '/api/shadowfolk/push' });
  const { res, captured } = makeRes();

  await (worker as any).handleRequest(req, res);

  assert.equal(captured.status, 200);
  assert.deepEqual(receivedWorkspaces, [{
    workspace: 'D:/GitHub/foo',
    memoryRoots: ['E:/GitHub/foo'],
  }]);
});

test('POST /api/shadowfolk/push merges duplicate workspace aliases and dedupes workspaces', async () => {
  let receivedWorkspaces: any[] = [];
  const worker = new WorkerService({
    port: 0,
    host: '127.0.0.1',
    loadSettings: disabledSettings,
    shadowfolk: {
      enabled: true,
      dailyTime: '23:30',
      workspaces: ['D:\\GitHub\\Foo\\', '/d:/github/foo', 'D:/GitHub/bar/', 'D:/GitHub/bar'],
      workspaceAliases: [
        { workspace: 'D:/GitHub/foo', memoryRoots: ['E:/GitHub/foo', 'E:\\GitHub\\foo\\', 'F:/Other/root'] },
        { workspace: '/d:/github/foo/', memoryRoots: ['F:/Other/root/', 'G:/Third'] },
        { workspace: 'D:/GitHub/bar/', memoryRoots: ['E:/GitHub/bar'] },
      ],
      createUploader: () => ({
        pushWorkspaces: async (workspaces: any[]) => {
          receivedWorkspaces = workspaces;
          return { pushed: true, workspaces: workspaces.length, observations: 2, summaries: 2, commits: 1, results: [], failures: [] };
        },
      }),
    },
  } as any);
  const req = makeReq({ method: 'POST', url: '/api/shadowfolk/push' });
  const { res, captured } = makeRes();

  await (worker as any).handleRequest(req, res);

  assert.equal(captured.status, 200);
  assert.deepEqual(receivedWorkspaces, [
    {
      workspace: 'D:\\GitHub\\Foo\\',
      memoryRoots: ['E:/GitHub/foo', 'F:/Other/root', 'G:/Third'],
    },
    {
      workspace: 'D:/GitHub/bar/',
      memoryRoots: ['E:/GitHub/bar'],
    },
  ]);
});

test('workspace aliases normalize drive-letter paths independent of host platform', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(descriptor?.configurable, 'process.platform must be configurable for this regression test');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    const worker = makeWorker();
    assert.equal((worker as any).shadowFolkPathKey('D:/GitHub/Foo'), 'd:/github/foo');
    assert.equal((worker as any).shadowFolkPathKey('/D:/GitHub/Foo/'), 'd:/github/foo');
    assert.equal((worker as any).shadowFolkPathKey('/Users/Alice/Foo'), '/Users/Alice/Foo');
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
});

test('GET /api/shadowfolk/status returns workspace alias counts only', async () => {
  const worker = new WorkerService({
    port: 0,
    host: '127.0.0.1',
    loadSettings: disabledSettings,
    shadowfolk: {
      enabled: true,
      dailyTime: '23:30',
      workspaces: ['D:/GitHub/foo', 'D:/GitHub/bar'],
      workspaceAliases: [
        { workspace: 'D:/GitHub/foo', memoryRoots: ['E:/GitHub/foo', 'F:/Other/root'] },
      ],
      createUploader: () => ({
        pushWorkspaces: async () => ({ pushed: false, workspaces: 0, observations: 0, summaries: 0, commits: 0, results: [], failures: [] }),
      }),
    },
  } as any);
  const req = makeReq({ method: 'GET', url: '/api/shadowfolk/status' });
  const { res, captured } = makeRes();

  await (worker as any).handleRequest(req, res);

  assert.equal(captured.status, 200);
  const body = JSON.parse(captured.body!);
  assert.deepEqual(body.workspaceList, ['D:/GitHub/foo', 'D:/GitHub/bar']);
  assert.deepEqual(body.workspaceAliasCounts, [
    { workspace: 'D:/GitHub/foo', count: 2 },
    { workspace: 'D:/GitHub/bar', count: 0 },
  ]);
  assert.equal(Object.hasOwn(body, 'workspaceAliases'), false);
  assert.equal(Object.hasOwn(body, 'workspaceConfigs'), false);
});

test('GET /api/shadowfolk/status restores last success time from push history after restart', async () => {
  const worker = new WorkerService({
    port: 0,
    host: '127.0.0.1',
    loadSettings: disabledSettings,
    shadowfolk: {
      enabled: true,
      dailyTime: '23:30',
      workspaces: ['D:/GitHub/foo', 'D:/GitHub/bar'],
      createUploader: () => ({
        listPushHistory: async (workspace: any) => {
          const workspacePath = typeof workspace === 'string' ? workspace : workspace.workspace;
          if (workspacePath.endsWith('/foo')) {
            return [{
              id: 'hist-old',
              workspace: workspacePath,
              gitRoot: workspacePath,
              remote: 'origin',
              branch: 'main',
              mode: 'normal',
              startCursor: { commit: '', observationId: 0, summaryId: 0 },
              endCursor: { commit: 'a', observationId: 1, summaryId: 1 },
              batchId: 'batch-old',
              counts: { commits: 1, observations: 1, summaries: 1 },
              createdAt: '2026-05-13T10:00:00.000Z',
            }];
          }
          return [{
            id: 'hist-new',
            workspace: workspacePath,
            gitRoot: workspacePath,
            remote: 'origin',
            branch: 'main',
            mode: 'normal',
            startCursor: { commit: '', observationId: 0, summaryId: 0 },
            endCursor: { commit: 'b', observationId: 2, summaryId: 2 },
            batchId: 'batch-new',
            counts: { commits: 2, observations: 2, summaries: 2 },
            createdAt: '2026-05-14T12:30:00.000Z',
          }];
        },
        pushWorkspaces: async () => ({ pushed: false, workspaces: 0, observations: 0, summaries: 0, commits: 0, results: [], failures: [] }),
      }),
    },
  } as any);
  const req = makeReq({ method: 'GET', url: '/api/shadowfolk/status' });
  const { res, captured } = makeRes();

  await (worker as any).handleRequest(req, res);

  assert.equal(captured.status, 200);
  const body = JSON.parse(captured.body!);
  assert.equal(body.lastSuccessAt, '2026-05-14T12:30:00.000Z');
});

test('POST /api/shadowfolk/workspaces/suggest-aliases suggests recorded projects with same basename', async () => {
  const worker = makeWorker();
  const req = makeReq({ method: 'POST', url: '/api/shadowfolk/workspaces/suggest-aliases' });
  const { res, captured } = makeRes();

  (worker as any).listShadowFolkMemoryProjectsForAliasSuggestions = () => [
    'E:/Github/foo',
    'D:/Github/foo',
    'E:/Github/bar',
  ];

  const promise = (worker as any).handleRequest(req, res);
  req.emit('data', Buffer.from(JSON.stringify({ workspace: 'D:/Github/foo' })));
  req.emit('end');
  await promise;

  assert.equal(captured.status, 200);
  const body = JSON.parse(captured.body!);
  assert.equal(body.success, true);
  assert.deepEqual(body.suggestions, ['E:/Github/foo']);
});

// ────────────── /stream (SSE) ──────────────

test('/stream sets text/event-stream content type and writes retry header', () => {
  const worker = makeWorker();
  const req = makeReq();
  const { res, captured } = makeRes();

  (worker as any).handleStream(req, res);

  assert.equal(captured.headers['Content-Type'], 'text/event-stream');
  assert.equal(captured.headers['Cache-Control'], 'no-cache');
  assert.ok(captured.writes.some((w: string) => w.includes('retry: 3000')));

  // Clean up: simulate client disconnect
  req.emit('close');
});

test('/stream forwards eventBus events to SSE response', () => {
  const worker = makeWorker();
  const req = makeReq();
  const { res, captured } = makeRes();

  (worker as any).handleStream(req, res);

  const bus = worker.getEventBus();
  bus.emit('new_observation', { project: 'test', type: 'tool_use' });
  bus.emit('new_summary', { session_id: 's1', project: 'test' });

  const obsWrite = captured.writes.find((w: string) => w.includes('event: new_observation'));
  assert.ok(obsWrite, 'Should have written an observation SSE event');
  assert.ok(obsWrite!.includes('"project":"test"'));

  const sumWrite = captured.writes.find((w: string) => w.includes('event: new_summary'));
  assert.ok(sumWrite, 'Should have written a summary SSE event');

  req.emit('close');
});

test('/stream cleans up listeners on client disconnect', () => {
  const worker = makeWorker();
  const req = makeReq();
  const { res, captured } = makeRes();

  (worker as any).handleStream(req, res);

  const bus = worker.getEventBus();
  assert.ok(bus.listenerCount('new_observation') >= 1);

  req.emit('close');

  assert.equal(bus.listenerCount('new_observation'), 0, 'Listeners should be removed after disconnect');
  assert.equal(bus.listenerCount('new_summary'), 0);
});
