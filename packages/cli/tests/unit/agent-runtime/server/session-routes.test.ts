import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  InputTurnPreparation,
  SteeringEnqueueResult,
} from '../../../../src/agent/runtime/ActiveTurnMailbox.js';
import {
  SessionRuntime,
  type SessionRuntimeOptions,
} from '../../../../src/agent/runtime/SessionRuntime.js';
import type { Message } from '../../../../src/services/ChatServiceInterface.js';
import type { SessionMetadata } from '../../../../src/services/SessionService.js';
import { SessionService } from '../../../../src/services/SessionService.js';

const DEFAULT_PROJECT_PATH =
  '/Users/bytedance/Documents/GitHub/Blade/.worktrees/session-discovery-fork/packages/cli';

const makePreparedInputTurn = (): InputTurnPreparation => ({
  accepted: true,
  handle: { id: 'prepared-turn' },
  messageId: 'prepared-input',
  queued: 1,
  mode: 'direct',
});

const makeSteeringEnqueueResult = (): SteeringEnqueueResult => ({
  accepted: true,
  messageId: 'steering-input',
  turnId: 'turn-1',
  queued: 1,
  delivery: 'current_turn',
});

const makeMessages = (...messages: Message[]): Message[] => messages;

const waitForGateOrAbort = (
  gate: Promise<void>,
  signal: AbortSignal
): Promise<void> => {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    gate.then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
};

const makeSessionMetadata = (
  overrides: Pick<SessionMetadata, 'sessionId' | 'projectPath'> &
    Partial<
      Omit<SessionMetadata, 'sessionId' | 'projectPath' | 'rootId'> & {
        rootId: string;
      }
    >
): SessionMetadata => ({
  sessionId: overrides.sessionId,
  projectPath: overrides.projectPath,
  rootId: overrides.rootId ?? overrides.sessionId,
  title: overrides.title ?? `Session ${overrides.sessionId}`,
  messageCount: overrides.messageCount ?? 0,
  firstMessageTime: overrides.firstMessageTime ?? new Date(0).toISOString(),
  lastMessageTime: overrides.lastMessageTime ?? new Date(1).toISOString(),
  hasErrors: overrides.hasErrors ?? false,
  ...(overrides.parentId ? { parentId: overrides.parentId } : {}),
  ...(overrides.relationType ? { relationType: overrides.relationType } : {}),
});

const runtimeState = vi.hoisted(() => ({
  runtime: {
    sessionId: 'session-1',
    dispose: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    getConfig: vi.fn(() => ({})),
    createToolExecutor: vi.fn(() => ({})),
    getChatService: vi.fn(),
    getExecutionEngine: vi.fn(),
    getAttachmentCollector: vi.fn(),
    getCurrentModelId: vi.fn(() => 'model-1'),
    getCurrentModelMaxContextTokens: vi.fn(() => 128000),
    prepareInputTurn: vi.fn(
      async (): Promise<InputTurnPreparation> => makePreparedInputTurn()
    ),
    enqueueSteering: vi.fn(
      async (): Promise<SteeringEnqueueResult> => makeSteeringEnqueueResult()
    ),
    finishTurn: vi.fn().mockResolvedValue(undefined),
    getPendingSteeringCount: vi.fn(() => 0),
    hasTurnOwner: vi.fn(() => false),
    getGoal: vi.fn().mockResolvedValue(null),
    createGoal: vi.fn(),
    editGoal: vi.fn(),
    pauseGoal: vi.fn(),
    resumeGoal: vi.fn(),
    clearGoal: vi.fn().mockResolvedValue(false),
  },
}));

const agentState = vi.hoisted(() => ({
  chatStream: vi.fn(),
}));

const busState = vi.hoisted(() => ({
  subscribers: new Set<
    (event: {
      sessionId: string;
      projectPath: string;
      type: string;
      properties: Record<string, unknown>;
    }) => void
  >(),
  publish: vi.fn(
    (
      ref: { sessionId: string; projectPath: string },
      type: string,
      properties: Record<string, unknown>
    ) => {
      const event = {
        sessionId: ref.sessionId,
        projectPath: ref.projectPath,
        type,
        properties,
      };
      for (const subscriber of busState.subscribers) {
        subscriber(event);
      }
    }
  ),
  subscribe: vi.fn(
    (
      callback: (event: {
        sessionId: string;
        projectPath: string;
        type: string;
        properties: Record<string, unknown>;
      }) => void
    ) => {
      busState.subscribers.add(callback);
      return vi.fn(() => {
        busState.subscribers.delete(callback);
      });
    }
  ),
}));

vi.mock('../../../../src/agent/runtime/SessionRuntime.js', () => ({
  SessionRuntime: {
    create: vi.fn(async () => runtimeState.runtime),
    hasPendingInbox: vi.fn(async () => false),
  },
}));

vi.mock('../../../../src/agent/Agent.js', () => ({
  Agent: {
    createWithRuntime: vi.fn(async () => ({
      chatStream: agentState.chatStream,
    })),
  },
}));

vi.mock('../../../../src/server/bus.js', () => ({
  Bus: {
    publish: busState.publish,
    subscribe: busState.subscribe,
  },
}));

vi.mock('../../../../src/services/SessionService.js', () => ({
  SessionService: {
    listSessions: vi.fn(async () => []),
    findSessionMetadata: vi.fn(async () => undefined),
    loadSession: vi.fn(async () => []),
    createSessionMetadata: vi.fn(
      async (sessionId: string, projectPath: string, initial?: { title?: string }) =>
        makeSessionMetadata({
          sessionId,
          projectPath,
          title: initial?.title,
          lastMessageTime: new Date(0).toISOString(),
        })
    ),
    updateSessionMetadata: vi.fn(
      async (sessionId: string, projectPath: string, update: { title?: string }) =>
        makeSessionMetadata({
          sessionId,
          projectPath,
          title: update.title,
        })
    ),
    forkSession: vi.fn(
      async (
        sessionId: string,
        options: { sourceProjectPath: string; targetProjectPath: string }
      ) => ({
        sessionId: 'forked-session',
        parentSessionId: sessionId,
        projectPath: options.targetProjectPath,
        messages: makeMessages(),
        metadata: makeSessionMetadata({
          sessionId: 'forked-session',
          projectPath: options.targetProjectPath,
          parentId: sessionId,
          relationType: 'fork',
          rootId: sessionId,
          lastMessageTime: new Date(0).toISOString(),
        }),
      })
    ),
    deleteSession: vi.fn(async () => {
      /* noop */
    }),
  },
}));

vi.mock('../../../../src/logging/Logger.js', () => ({
  LogCategory: {
    SERVICE: 'service',
  },
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

function createSseCollector(response: Response) {
  if (!response.body) {
    throw new Error('Expected SSE response body');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  return {
    async next() {
      while (true) {
        const readResult = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error('Timed out waiting for SSE event')),
              2000
            );
          }),
        ]);
        if (readResult.done) {
          throw new Error('SSE stream ended before the next event was received');
        }
        buffer += decoder.decode(readResult.value, { stream: true });
        const delimiterIndex = buffer.indexOf('\n\n');
        if (delimiterIndex === -1) {
          continue;
        }
        const rawEvent = buffer.slice(0, delimiterIndex);
        buffer = buffer.slice(delimiterIndex + 2);
        const data = rawEvent
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data) {
          continue;
        }
        return JSON.parse(data) as {
          type: string;
          properties: Record<string, unknown>;
        };
      }
    },
    async cancel() {
      await reader.cancel().catch(() => undefined);
    },
  };
}

describe('SessionRoutes runtime reuse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    busState.subscribers.clear();
    runtimeState.runtime.dispose.mockClear();
    runtimeState.runtime.refresh.mockClear();
    runtimeState.runtime.prepareInputTurn.mockReset();
    runtimeState.runtime.prepareInputTurn.mockImplementation(async () =>
      makePreparedInputTurn()
    );
    runtimeState.runtime.enqueueSteering.mockClear();
    runtimeState.runtime.enqueueSteering.mockResolvedValue(makeSteeringEnqueueResult());
    runtimeState.runtime.finishTurn.mockClear();
    runtimeState.runtime.getPendingSteeringCount.mockReturnValue(0);
    runtimeState.runtime.hasTurnOwner.mockReturnValue(false);
    vi.mocked(SessionRuntime.create).mockImplementation(
      async (options: SessionRuntimeOptions) =>
        createRuntimeDouble({
          sessionId: options.sessionId,
          workspaceRoot: options.workspaceRoot,
        })
    );
    vi.mocked(SessionRuntime.hasPendingInbox).mockResolvedValue(false);
    vi.mocked(SessionService.listSessions).mockResolvedValue([]);
    vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(undefined);
    vi.mocked(SessionService.loadSession).mockResolvedValue(makeMessages());
    vi.mocked(SessionService.createSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath: string, initial?: { title?: string }) =>
        makeSessionMetadata({
          sessionId,
          projectPath,
          title: initial?.title,
          lastMessageTime: new Date(0).toISOString(),
        })
    );
    vi.mocked(SessionService.updateSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath: string, update: { title?: string }) =>
        makeSessionMetadata({
          sessionId,
          projectPath,
          title: update.title,
        })
    );
    agentState.chatStream.mockImplementation(async function* () {
      if (Date.now() < 0) {
        yield undefined;
      }
      return {
        success: true,
        finalMessage: 'assistant reply',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const refFor = (sessionId: string) => ({
    sessionId,
    projectPath: DEFAULT_PROJECT_PATH,
  });

  const createPermissionsApp = async () => {
    const { BladeServerError } = await import('../../../../src/server/error.js');
    const { PermissionRoutes } = await import(
      '../../../../src/server/routes/permission.js'
    );

    const app = new Hono();
    app.onError((error, c) => {
      if (error instanceof BladeServerError) {
        return c.json(error.toObject(), error.statusCode as 400 | 404 | 409 | 500);
      }
      throw error;
    });
    app.route('/permissions', PermissionRoutes());
    return app;
  };

  const createSessionAndPermissionApp = async () => {
    const { BladeServerError } = await import('../../../../src/server/error.js');
    const { PermissionRoutes } = await import(
      '../../../../src/server/routes/permission.js'
    );
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');

    const app = new Hono();
    app.onError((error, c) => {
      if (error instanceof BladeServerError) {
        return c.json(error.toObject(), error.statusCode as 400 | 404 | 409 | 500);
      }
      throw error;
    });
    app.route('/sessions', SessionRoutes());
    app.route('/permissions', PermissionRoutes());
    return app;
  };

  const createRuntimeDouble = async (
    overrides: Partial<typeof runtimeState.runtime> & { workspaceRoot?: string } = {}
  ): Promise<SessionRuntime> => {
    const actualSessionRuntimeModule = await vi.importActual<
      typeof import('../../../../src/agent/runtime/SessionRuntime.js')
    >('../../../../src/agent/runtime/SessionRuntime.js');
    const runtime = Object.create(
      actualSessionRuntimeModule.SessionRuntime.prototype
    ) as SessionRuntime;
    const sessionId = overrides.sessionId ?? runtimeState.runtime.sessionId;
    const workspaceRoot = overrides.workspaceRoot ?? DEFAULT_PROJECT_PATH;
    const {
      sessionId: _ignoredSessionId,
      workspaceRoot: _ignoredWorkspaceRoot,
      ...methods
    } = {
      ...runtimeState.runtime,
      ...overrides,
    };

    Object.defineProperties(runtime, {
      sessionId: {
        configurable: true,
        get: () => sessionId,
      },
      workspaceRoot: {
        configurable: true,
        get: () => workspaceRoot,
      },
    });
    Object.assign(runtime, methods);
    return runtime;
  };

  const metadataFor = (
    sessionId: string,
    projectPath = refFor(sessionId).projectPath,
    overrides: Partial<{
      title: string;
      messageCount: number;
      firstMessageTime: string;
      lastMessageTime: string;
      hasErrors: boolean;
      rootId: string;
      parentId: string;
      relationType: 'subagent' | 'fork';
    }> = {}
  ): SessionMetadata =>
    makeSessionMetadata({
      sessionId,
      projectPath,
      ...overrides,
    });

  const mockResolvedSession = (
    sessionId: string,
    options: {
      projectPath?: string;
      messages?: Message[];
    } = {}
  ) => {
    const metadata = metadataFor(sessionId, options.projectPath);
    const messages = options.messages ?? makeMessages();
    vi.mocked(SessionService.listSessions).mockResolvedValue([metadata]);
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (requestedSessionId: string, requestedProjectPath?: string) => {
        if (requestedSessionId !== sessionId) {
          return undefined;
        }
        if (
          requestedProjectPath !== undefined &&
          requestedProjectPath !== metadata.projectPath
        ) {
          return undefined;
        }
        return metadata;
      }
    );
    vi.mocked(SessionService.loadSession).mockImplementation(
      async (requestedSessionId: string, requestedProjectPath?: string) => {
        if (
          requestedSessionId === sessionId &&
          requestedProjectPath === metadata.projectPath
        ) {
          return messages;
        }
        return makeMessages();
      }
    );
    return metadata;
  };

  it('reuses one SessionRuntime for repeated messages in the same session', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { SessionRuntime } = await import(
      '../../../../src/agent/runtime/SessionRuntime.js'
    );
    const { Agent } = await import('../../../../src/agent/Agent.js');
    mockResolvedSession('session-1');

    const app = SessionRoutes();

    const sendMessage = async (content: string) => {
      const response = await app.request('/session-1/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content }),
      });

      expect(response.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    await sendMessage('first');
    await sendMessage('second');

    expect(SessionRuntime.create).toHaveBeenCalledTimes(1);
    expect(SessionRuntime.create).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspaceRoot: expect.any(String),
    });
    expect(runtimeState.runtime.prepareInputTurn).toHaveBeenNthCalledWith(1, 'first');
    expect(runtimeState.runtime.prepareInputTurn).toHaveBeenNthCalledWith(2, 'second');
    expect(Agent.createWithRuntime).toHaveBeenCalledTimes(2);
    expect(vi.mocked(Agent.createWithRuntime).mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'session-1',
    });
    expect(vi.mocked(Agent.createWithRuntime).mock.calls[0]?.[1]).toEqual({
      sessionId: 'session-1',
    });
    expect(vi.mocked(Agent.createWithRuntime).mock.calls[1]?.[0]).toMatchObject({
      sessionId: 'session-1',
    });
    expect(vi.mocked(Agent.createWithRuntime).mock.calls[1]?.[1]).toEqual({
      sessionId: 'session-1',
    });
  });

  it('routes a second message into the active turn instead of starting a concurrent run', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { Agent } = await import('../../../../src/agent/Agent.js');
    const { Bus } = await import('../../../../src/server/bus.js');
    mockResolvedSession('steering-session');
    let releaseRun: () => void = () => undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    agentState.chatStream.mockImplementationOnce(async function* () {
      yield { kind: 'turn_start', turn: 1, maxTurns: 10 };
      await runGate;
      return {
        success: true,
        finalMessage: 'steered reply',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });

    const app = SessionRoutes();
    const first = await app.request('/steering-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'initial request' }),
    });
    expect(first.status).toBe(202);
    await vi.waitFor(() => {
      expect(Bus.publish).toHaveBeenCalledWith(
        refFor('steering-session'),
        'turn.started',
        expect.any(Object)
      );
    });

    const second = await app.request('/steering-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'updated requirement' }),
    });

    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({
      status: 'steering_queued',
      queued: 1,
    });
    expect(runtimeState.runtime.enqueueSteering).toHaveBeenCalledWith(
      'updated requirement',
      { allowBeforeTurn: true }
    );
    expect(Agent.createWithRuntime).toHaveBeenCalledTimes(1);
    expect(Bus.publish).toHaveBeenCalledWith(
      refFor('steering-session'),
      'steering.queued',
      expect.objectContaining({ queued: 1 })
    );

    releaseRun();
    await vi.waitFor(() => {
      expect(Bus.publish).toHaveBeenCalledWith(
        refFor('steering-session'),
        'session.completed',
        expect.any(Object)
      );
    });
  });

  it('defers input submitted after the active turn seals', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { Bus } = await import('../../../../src/server/bus.js');
    mockResolvedSession('follow-up-session');
    let releaseRun: () => void = () => undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    agentState.chatStream.mockImplementationOnce(async function* () {
      yield { kind: 'turn_start', turn: 1, maxTurns: 10 };
      await runGate;
      return {
        success: true,
        finalMessage: 'first reply',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });

    const app = SessionRoutes();
    await app.request('/follow-up-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'initial request' }),
    });
    await vi.waitFor(() => {
      expect(Bus.publish).toHaveBeenCalledWith(
        refFor('follow-up-session'),
        'turn.started',
        expect.any(Object)
      );
    });
    runtimeState.runtime.enqueueSteering.mockResolvedValueOnce({
      accepted: true,
      turnId: 'turn-1',
      queued: 1,
      delivery: 'next_turn',
    });

    const response = await app.request('/follow-up-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'run after this answer' }),
    });

    expect(await response.json()).toMatchObject({
      status: 'follow_up_queued',
      queued: 1,
    });
    expect(Bus.publish).toHaveBeenCalledWith(
      refFor('follow-up-session'),
      'follow_up.queued',
      expect.objectContaining({ queued: 1 })
    );
    runtimeState.runtime.getPendingSteeringCount
      .mockReturnValueOnce(1)
      .mockReturnValue(0);
    releaseRun();
    await vi.waitFor(() => {
      expect(agentState.chatStream).toHaveBeenCalledTimes(2);
      expect(agentState.chatStream).toHaveBeenLastCalledWith(
        '',
        expect.any(Object),
        expect.objectContaining({ pendingInputOnly: true })
      );
    });
  });

  it('serializes concurrent startup input behind one durable runtime preparation', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { SessionRuntime } = await import(
      '../../../../src/agent/runtime/SessionRuntime.js'
    );
    mockResolvedSession('startup-steering');
    let releaseRuntime: () => void = () => undefined;
    vi.mocked(SessionRuntime.create).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRuntime = async () => resolve(await createRuntimeDouble());
        })
    );
    let releaseRun: () => void = () => undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    agentState.chatStream.mockImplementationOnce(async function* () {
      yield { kind: 'turn_start', turn: 1, maxTurns: 10 };
      await runGate;
      return {
        success: true,
        finalMessage: 'started',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });

    const app = SessionRoutes();
    let firstSettled = false;
    const firstPromise = Promise.resolve(
      app.request('/startup-steering/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'initial request' }),
      })
    ).then((response) => {
      firstSettled = true;
      return response;
    });

    let secondSettled = false;
    const secondPromise = Promise.resolve(
      app.request('/startup-steering/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'guidance during startup' }),
      })
    ).then((response) => {
      secondSettled = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);

    releaseRuntime();
    const first = await firstPromise;
    const second = await secondPromise;
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({
      status: 'running',
      messageId: 'prepared-input',
    });
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({
      status: 'steering_queued',
      queued: 1,
    });
    expect(SessionRuntime.create).toHaveBeenCalledTimes(1);
    expect(runtimeState.runtime.enqueueSteering).toHaveBeenCalledWith(
      'guidance during startup',
      { allowBeforeTurn: true }
    );
    releaseRun();
  });

  it('does not return 202 until the initial input has been durably prepared', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { SessionRuntime } = await import(
      '../../../../src/agent/runtime/SessionRuntime.js'
    );
    mockResolvedSession('durable-accept');
    vi.mocked(SessionRuntime.create).mockResolvedValueOnce(
      await createRuntimeDouble({ sessionId: 'durable-accept' })
    );
    let releasePreparation: () => void = () => undefined;
    runtimeState.runtime.prepareInputTurn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePreparation = () =>
            resolve({
              accepted: true,
              handle: { id: 'fsynced-turn' },
              messageId: 'fsynced-input',
              queued: 1,
              mode: 'direct',
            } satisfies InputTurnPreparation);
        })
    );

    const app = SessionRoutes();
    let settled = false;
    const responsePromise = Promise.resolve(
      app.request('/durable-accept/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'persist before accepting' }),
      })
    ).then((response) => {
      settled = true;
      return response;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(agentState.chatStream).not.toHaveBeenCalled();

    releasePreparation();
    const response = await responsePromise;
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: 'running',
      messageId: 'fsynced-input',
    });
  });

  it('wakes a persisted durable follow-up when Web SSE reconnects', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { Agent } = await import('../../../../src/agent/Agent.js');
    const { SessionService } = await import(
      '../../../../src/services/SessionService.js'
    );
    const recoveredMetadata = metadataFor(
      'recovered-web-session',
      '/persisted-workspace'
    );
    vi.mocked(SessionService.listSessions).mockResolvedValue([recoveredMetadata]);
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (
          sessionId === 'recovered-web-session' &&
          projectPath === '/persisted-workspace'
        ) {
          return recoveredMetadata;
        }
        return undefined;
      }
    );
    vi.mocked(SessionRuntime.hasPendingInbox).mockResolvedValue(true);
    runtimeState.runtime.getPendingSteeringCount.mockReturnValue(1);
    let releaseRun: () => void = () => undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    agentState.chatStream.mockImplementationOnce(async function* () {
      yield { kind: 'turn_start', turn: 1, maxTurns: 10 };
      await runGate;
      return {
        success: true,
        finalMessage: 'recovered',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });

    const firstController = new AbortController();
    const secondController = new AbortController();
    const app = SessionRoutes();
    const [firstResponse, secondResponse] = await Promise.all([
      app.request('/recovered-web-session/events', {
        signal: firstController.signal,
      }),
      app.request('/recovered-web-session/events', {
        signal: secondController.signal,
      }),
    ]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);

    await vi.waitFor(() => {
      expect(agentState.chatStream).toHaveBeenCalledWith(
        '',
        expect.objectContaining({
          sessionId: 'recovered-web-session',
          workspaceRoot: '/persisted-workspace',
        }),
        expect.objectContaining({ pendingInputOnly: true })
      );
    });
    expect(Agent.createWithRuntime).toHaveBeenCalledTimes(1);

    releaseRun();
    firstController.abort();
    secondController.abort();
    await Promise.all([
      firstResponse.body?.cancel().catch(() => undefined),
      secondResponse.body?.cancel().catch(() => undefined),
    ]);
  });

  it('builds multimodal user content from image attachments', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('session-2');

    const app = SessionRoutes();

    const response = await app.request('/session-2/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'describe this image',
        attachments: [{ type: 'image', content: 'data:image/png;base64,abc' }],
      }),
    });

    expect(response.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(agentState.chatStream).toHaveBeenCalledWith(
      [
        { type: 'text', text: 'describe this image' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
      ],
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('builds image-only user content when the request only contains image attachments', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('session-3');

    const app = SessionRoutes();

    const response = await app.request('/session-3/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: '',
        attachments: [{ type: 'image', content: 'data:image/png;base64,image-only' }],
      }),
    });

    expect(response.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(agentState.chatStream).toHaveBeenCalledWith(
      [{ type: 'image_url', image_url: { url: 'data:image/png;base64,image-only' } }],
      expect.any(Object),
      expect.any(Object)
    );
  });

  it('hydrates persisted session history before sending a follow-up message', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('persisted-session', {
      projectPath: '/persisted-workspace',
      messages: makeMessages(
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' }
      ),
    });
    vi.mocked(SessionService.loadSession).mockResolvedValue(
      makeMessages(
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' }
      )
    );

    const app = SessionRoutes();

    const response = await app.request('/persisted-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'follow up' }),
    });

    expect(response.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(SessionService.loadSession).toHaveBeenCalledWith(
      'persisted-session',
      '/persisted-workspace'
    );
    expect(agentState.chatStream.mock.calls[0]?.[1]).toMatchObject({
      messages: [
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
      ],
    });
  });

  it('publishes a run error and releases a prepared owner on loop failure', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { Bus } = await import('../../../../src/server/bus.js');
    mockResolvedSession('failed-prepared-run');
    agentState.chatStream.mockImplementationOnce(async function* () {
      if (Date.now() < 0) yield undefined;
      return {
        success: false,
        error: { type: 'api_error', message: 'upstream unavailable' },
        metadata: { turnsCount: 0, toolCallsCount: 0, duration: 0 },
      };
    });

    const app = SessionRoutes();
    const response = await app.request('/failed-prepared-run/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'durable request' }),
    });

    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(Bus.publish).toHaveBeenCalledWith(
        refFor('failed-prepared-run'),
        'session.error',
        {
          error: 'upstream unavailable',
        }
      );
    });
    expect(runtimeState.runtime.finishTurn).toHaveBeenCalledWith({
      id: 'prepared-turn',
    });
    expect(Bus.publish).not.toHaveBeenCalledWith(
      refFor('failed-prepared-run'),
      'session.completed',
      expect.any(Object)
    );
  });

  it('publishes loop lifecycle events and preserves canonical tool failure state', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { Bus } = await import('../../../../src/server/bus.js');
    mockResolvedSession('surface-events');

    agentState.chatStream.mockImplementationOnce(async function* () {
      yield { kind: 'turn_start', turn: 2, maxTurns: 8 };
      yield { kind: 'compaction', phase: 'start' };
      yield { kind: 'compaction', phase: 'end' };
      yield { kind: 'model_fallback' };
      yield {
        kind: 'follow_up_started',
        queued: 2,
        recovered: 2,
        messages: [
          {
            id: 'already-persisted',
            content: 'persisted',
            queuedAt: Date.now(),
            recovered: true,
            persisted: true,
          },
          {
            id: 'not-yet-persisted',
            content: 'not persisted',
            queuedAt: Date.now(),
            recovered: true,
            persisted: false,
          },
        ],
      };
      yield {
        kind: 'steering_applied',
        messageIds: ['recovered-steer'],
        count: 1,
        recovered: 1,
        delivery: 'next_turn',
      };
      yield {
        kind: 'tool_result',
        toolCall: {
          id: 'tool-failed-without-error-payload',
          type: 'function',
          function: { name: 'Bash', arguments: '{"command":"false"}' },
        },
        result: {
          success: false,
          llmContent: 'Command exited with code 1',
          metadata: { summary: 'Command failed' },
        },
      };
      return {
        success: true,
        finalMessage: 'recovered',
        metadata: { turnsCount: 2, toolCallsCount: 1, duration: 0 },
      };
    });

    const app = SessionRoutes();
    const response = await app.request('/surface-events/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'recover from the failed command' }),
    });

    expect(response.status).toBe(202);
    await vi.waitFor(() => {
      expect(Bus.publish).toHaveBeenCalledWith(
        refFor('surface-events'),
        'session.completed',
        expect.any(Object)
      );
    });

    expect(Bus.publish).toHaveBeenCalledWith(refFor('surface-events'), 'turn.started', {
      turn: 2,
      maxTurns: 8,
    });
    expect(Bus.publish).toHaveBeenCalledWith(
      refFor('surface-events'),
      'compaction.started',
      {}
    );
    expect(Bus.publish).toHaveBeenCalledWith(
      refFor('surface-events'),
      'compaction.completed',
      {}
    );
    expect(Bus.publish).toHaveBeenCalledWith(
      refFor('surface-events'),
      'model.fallback',
      {}
    );
    expect(Bus.publish).not.toHaveBeenCalledWith(
      refFor('surface-events'),
      'message.created',
      expect.objectContaining({ messageId: 'already-persisted' })
    );
    expect(Bus.publish).toHaveBeenCalledWith(
      refFor('surface-events'),
      'message.created',
      expect.objectContaining({
        messageId: 'not-yet-persisted',
        recovered: true,
      })
    );
    expect(Bus.publish).toHaveBeenCalledWith(
      refFor('surface-events'),
      'steering.applied',
      expect.objectContaining({
        messageIds: ['recovered-steer'],
        count: 1,
        recovered: 1,
      })
    );
    expect(Bus.publish).toHaveBeenCalledWith(
      refFor('surface-events'),
      'tool.result',
      expect.objectContaining({
        toolCallId: 'tool-failed-without-error-payload',
        success: false,
      })
    );
  });

  it('creates durable metadata before inserting an active session', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { SessionService } = await import(
      '../../../../src/services/SessionService.js'
    );

    const app = SessionRoutes();
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Created from web',
        projectPath: '/tmp/task4-create-workspace',
      }),
    });

    expect(response.status).toBe(200);
    expect(SessionService.createSessionMetadata).toHaveBeenCalledTimes(1);
    expect(SessionService.createSessionMetadata).toHaveBeenCalledWith(
      expect.any(String),
      '/tmp/task4-create-workspace',
      { title: 'Created from web' }
    );
    const body = await response.json();
    expect(body).toMatchObject({
      sessionId: expect.any(String),
      projectPath: '/tmp/task4-create-workspace',
      rootId: expect.any(String),
    });
  });

  it('keeps an active session visible when another workspace persists the same id as a subagent', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');

    const app = SessionRoutes();
    const createResponse = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Workspace B active session',
        projectPath: '/tmp/workspace-b',
      }),
    });
    const activeSession = await createResponse.json();
    vi.mocked(SessionService.listSessions).mockResolvedValue([
      makeSessionMetadata({
        sessionId: activeSession.sessionId,
        projectPath: '/tmp/workspace-a',
        relationType: 'subagent',
      }),
    ]);

    const listResponse = await app.request('/');

    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual([
      expect.objectContaining({
        sessionId: activeSession.sessionId,
        projectPath: '/tmp/workspace-b',
        isActive: true,
      }),
    ]);
  });

  it('isolates module-global session state between SessionRoutes instances and aborts ghost runs', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');

    const metadata = metadataFor('ghost-session', '/tmp/ghost-workspace', {
      title: 'Ghost session',
    });
    let observedSignal: AbortSignal | undefined;
    let releaseRun: () => void = () => undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });

    vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(metadata);
    vi.mocked(SessionService.listSessions).mockResolvedValue([metadata]);
    agentState.chatStream.mockImplementationOnce(async function* (
      _content,
      chatContext: { signal: AbortSignal }
    ) {
      observedSignal = chatContext.signal;
      yield { kind: 'turn_start', turn: 1, maxTurns: 10 };
      await runGate;
      return {
        success: true,
        finalMessage: 'ghost session reply',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });

    const app1 = SessionRoutes();
    const startResponse = await app1.request(
      `/ghost-session/message?projectPath=${encodeURIComponent('/tmp/ghost-workspace')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'leave a ghost run behind' }),
      }
    );
    expect(startResponse.status).toBe(202);
    expect(observedSignal?.aborted).toBe(false);

    vi.clearAllMocks();
    busState.subscribers.clear();
    vi.mocked(SessionService.listSessions).mockResolvedValue([]);
    vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(undefined);

    const app2 = SessionRoutes();
    expect(observedSignal?.aborted).toBe(true);

    const listResponse = await app2.request('/');
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual([]);

    const getResponse = await app2.request(
      `/ghost-session?projectPath=${encodeURIComponent('/tmp/ghost-workspace')}`
    );
    expect(getResponse.status).toBe(404);

    releaseRun();
  });

  it('does not keep an in-memory session when durable creation fails', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { SessionService } = await import(
      '../../../../src/services/SessionService.js'
    );
    vi.mocked(SessionService.createSessionMetadata).mockRejectedValueOnce(
      new Error('disk full')
    );

    const app = SessionRoutes();
    const createResponse = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Unpersisted',
        projectPath: '/tmp/task4-create-fail',
      }),
    });

    expect(createResponse.status).toBe(500);

    const listResponse = await app.request('/');
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual([]);
  });

  it('updates durable metadata before mutating the active session title', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { SessionService } = await import(
      '../../../../src/services/SessionService.js'
    );

    const app = SessionRoutes();
    const createResponse = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Before rename',
        projectPath: '/tmp/task4-rename-workspace',
      }),
    });
    const created = await createResponse.json();

    vi.mocked(SessionService.updateSessionMetadata).mockResolvedValueOnce(
      makeSessionMetadata({
        sessionId: created.sessionId,
        projectPath: '/tmp/task4-rename-workspace',
        title: 'Renamed durably',
        lastMessageTime: new Date(2).toISOString(),
      })
    );

    const patchResponse = await app.request(`/${created.sessionId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Renamed durably',
        projectPath: '/tmp/task4-rename-workspace',
      }),
    });

    expect(patchResponse.status).toBe(200);
    expect(SessionService.updateSessionMetadata).toHaveBeenCalledWith(
      created.sessionId,
      '/tmp/task4-rename-workspace',
      { title: 'Renamed durably' }
    );
    expect(await patchResponse.json()).toMatchObject({
      success: true,
      title: 'Renamed durably',
    });
  });

  it('does not mutate the active title when durable rename fails', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { SessionService } = await import(
      '../../../../src/services/SessionService.js'
    );
    const metadata = metadataFor('stable-title-session', '/tmp/task4-stable-title', {
      title: 'Stable title',
    });
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (
          sessionId === 'stable-title-session' &&
          projectPath === '/tmp/task4-stable-title'
        ) {
          return metadata;
        }
        return undefined;
      }
    );

    const app = SessionRoutes();
    vi.mocked(SessionService.updateSessionMetadata).mockRejectedValueOnce(
      new Error('rename failed')
    );
    const patchResponse = await app.request('/stable-title-session', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Should not stick',
        projectPath: '/tmp/task4-stable-title',
      }),
    });

    expect(patchResponse.status).toBe(500);

    const getResponse = await app.request(
      `/stable-title-session?projectPath=${encodeURIComponent('/tmp/task4-stable-title')}`
    );
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toMatchObject({
      title: 'Stable title',
    });
  });

  it('requires projectPath when duplicate session ids exist across workspaces', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { SessionService } = await import(
      '../../../../src/services/SessionService.js'
    );

    vi.mocked(SessionService.listSessions).mockResolvedValue([
      makeSessionMetadata({
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-a',
        title: 'Workspace A',
        messageCount: 1,
      }),
      makeSessionMetadata({
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-b',
        title: 'Workspace B',
        messageCount: 2,
        lastMessageTime: new Date(2).toISOString(),
      }),
    ]);

    const app = SessionRoutes();
    const response = await app.request('/shared-session');

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'AMBIGUOUS_SESSION' },
    });
  });

  it('resolves duplicate ids to the exact workspace for get and message history', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { SessionService } = await import(
      '../../../../src/services/SessionService.js'
    );

    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (sessionId === 'shared-session' && projectPath === '/tmp/workspace-b') {
          return makeSessionMetadata({
            sessionId,
            projectPath,
            title: 'Workspace B',
            messageCount: 2,
            lastMessageTime: new Date(2).toISOString(),
          });
        }
        return undefined;
      }
    );
    vi.mocked(SessionService.loadSession).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (sessionId === 'shared-session' && projectPath === '/tmp/workspace-b') {
          return makeMessages({ role: 'assistant', content: 'workspace-b-history' });
        }
        return makeMessages();
      }
    );

    const app = SessionRoutes();
    const getResponse = await app.request(
      `/shared-session?projectPath=${encodeURIComponent('/tmp/workspace-b')}`
    );
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toMatchObject({
      sessionId: 'shared-session',
      projectPath: '/tmp/workspace-b',
      title: 'Workspace B',
    });

    const messagesResponse = await app.request(
      `/shared-session/message?projectPath=${encodeURIComponent('/tmp/workspace-b')}`
    );
    expect(messagesResponse.status).toBe(200);
    expect(await messagesResponse.json()).toEqual([
      { role: 'assistant', content: 'workspace-b-history' },
    ]);
    expect(SessionService.loadSession).toHaveBeenCalledWith(
      'shared-session',
      '/tmp/workspace-b'
    );
  });

  it('returns exact lookup errors for SSE instead of falling back to the request directory', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');

    const app = SessionRoutes();

    const explicitMissing = await app.request(
      `/missing-session/events?projectPath=${encodeURIComponent('/tmp/workspace-a')}`
    );
    expect(explicitMissing.status).toBe(404);
    await expect(explicitMissing.json()).resolves.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });

    const missingWithoutPath = await app.request('/missing-session/events');
    expect(missingWithoutPath.status).toBe(404);
    await expect(missingWithoutPath.json()).resolves.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });

    vi.mocked(SessionService.listSessions).mockResolvedValue([
      makeSessionMetadata({
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-a',
        title: 'Workspace A',
        messageCount: 1,
      }),
      makeSessionMetadata({
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-b',
        title: 'Workspace B',
        messageCount: 1,
      }),
    ]);

    const ambiguous = await app.request('/shared-session/events');
    expect(ambiguous.status).toBe(409);
    await expect(ambiguous.json()).resolves.toMatchObject({
      error: { code: 'AMBIGUOUS_SESSION' },
    });
  });

  it('delivers SSE events only to the collector for the exact session workspace', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { Bus } = await import('../../../../src/server/bus.js');
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (
          sessionId === 'shared-session' &&
          (projectPath === '/tmp/workspace-a' || projectPath === '/tmp/workspace-b')
        ) {
          return makeSessionMetadata({
            sessionId,
            projectPath,
            title: `Session ${projectPath?.slice(-1)}`,
          });
        }
        return undefined;
      }
    );

    const app = SessionRoutes();
    const firstAbortController = new AbortController();
    const secondAbortController = new AbortController();

    const [firstResponse, secondResponse] = await Promise.all([
      app.request(
        `/shared-session/events?projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
        {
          signal: firstAbortController.signal,
        }
      ),
      app.request(
        `/shared-session/events?projectPath=${encodeURIComponent('/tmp/workspace-b')}`,
        {
          signal: secondAbortController.signal,
        }
      ),
    ]);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);

    const firstCollector = createSseCollector(firstResponse);
    const secondCollector = createSseCollector(secondResponse);

    expect(await firstCollector.next()).toMatchObject({
      type: 'connected',
      properties: {
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-a',
      },
    });
    expect(await secondCollector.next()).toMatchObject({
      type: 'connected',
      properties: {
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-b',
      },
    });

    Bus.publish(
      { sessionId: 'shared-session', projectPath: '/tmp/workspace-a' },
      'session.status',
      { status: 'running' }
    );
    Bus.publish(
      { sessionId: 'shared-session', projectPath: '/tmp/workspace-b' },
      'session.status',
      { status: 'idle' }
    );

    expect(await firstCollector.next()).toMatchObject({
      type: 'session.status',
      properties: {
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-a',
        status: 'running',
      },
    });
    expect(await secondCollector.next()).toMatchObject({
      type: 'session.status',
      properties: {
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-b',
        status: 'idle',
      },
    });

    firstAbortController.abort();
    secondAbortController.abort();
    await Promise.all([firstCollector.cancel(), secondCollector.cancel()]);
  });

  it('subscribes before connected is consumable and cleans up when that write is aborted', async () => {
    const NativeTransformStream = globalThis.TransformStream;
    let releaseConnectedWrite: () => void = () => undefined;
    vi.stubGlobal(
      'TransformStream',
      class extends NativeTransformStream<Uint8Array, Uint8Array> {
        constructor() {
          super({
            transform: () =>
              new Promise<void>((resolve) => {
                releaseConnectedWrite = resolve;
              }),
          });
        }
      }
    );
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('readiness-session', { projectPath: '/tmp/workspace-a' });

    const controller = new AbortController();
    const response = await SessionRoutes().request(
      `/readiness-session/events?projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      { signal: controller.signal }
    );

    expect(response.status).toBe(200);
    expect(busState.subscribers.size).toBe(1);
    const unsubscribe = busState.subscribe.mock.results.at(-1)?.value;

    controller.abort();
    await response.body?.cancel().catch(() => undefined);
    releaseConnectedWrite();
    await vi.waitFor(() => {
      expect(busState.subscribers.size).toBe(0);
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('cleans up the listener when the connected write rejects', async () => {
    const { SSEStreamingApi } = await import('hono/streaming');
    const writeSse = vi
      .spyOn(SSEStreamingApi.prototype, 'writeSSE')
      .mockRejectedValueOnce(new Error('connected write failed'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('write-failure-session', {
      projectPath: '/tmp/workspace-a',
    });

    const response = await SessionRoutes().request(
      `/write-failure-session/events?projectPath=${encodeURIComponent('/tmp/workspace-a')}`
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(busState.subscribers.size).toBe(0);
    expect(busState.subscribe.mock.results.at(-1)?.value).toHaveBeenCalledTimes(1);

    writeSse.mockRestore();
    consoleError.mockRestore();
  });

  it('terminates without abort when a post-connected Bus event write rejects', async () => {
    vi.useFakeTimers();
    const { SSEStreamingApi } = await import('hono/streaming');
    const originalWriteSse = SSEStreamingApi.prototype.writeSSE;
    const writeSse = vi.spyOn(SSEStreamingApi.prototype, 'writeSSE');
    writeSse
      .mockImplementationOnce(function (message) {
        return originalWriteSse.call(this, message);
      })
      .mockRejectedValueOnce(new Error('Bus event write failed'));
    const { Bus } = await import('../../../../src/server/bus.js');
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('bus-write-failure', { projectPath: '/tmp/workspace-a' });

    let readSettled = false;
    let observed:
      | {
          subscribers: number;
          unsubscribeCalls: number;
          timers: number;
          ended: boolean;
        }
      | undefined;
    const response = await SessionRoutes().request(
      `/bus-write-failure/events?projectPath=${encodeURIComponent('/tmp/workspace-a')}`
    );
    if (!response.body) {
      throw new Error('Expected SSE response body');
    }
    const reader = response.body.getReader();

    try {
      const connected = await reader.read();
      expect(new TextDecoder().decode(connected.value)).toContain('connected');
      const unsubscribe = busState.subscribe.mock.results.at(-1)?.value;

      Bus.publish(
        { sessionId: 'bus-write-failure', projectPath: '/tmp/workspace-a' },
        'message.created',
        { messageId: 'failed-write' }
      );
      const completion = reader.read().then((result) => {
        readSettled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(1000);

      observed = {
        subscribers: busState.subscribers.size,
        unsubscribeCalls: unsubscribe.mock.calls.length,
        timers: vi.getTimerCount(),
        ended: readSettled && (await completion).done,
      };
    } finally {
      if (!readSettled) {
        await reader.cancel();
        await vi.advanceTimersByTimeAsync(1000);
      }
      writeSse.mockRestore();
      vi.useRealTimers();
    }

    expect(observed).toEqual({
      subscribers: 0,
      unsubscribeCalls: 1,
      timers: 0,
      ended: true,
    });
  });

  it('terminates without abort when a heartbeat write rejects', async () => {
    vi.useFakeTimers();
    const { SSEStreamingApi } = await import('hono/streaming');
    const originalWriteSse = SSEStreamingApi.prototype.writeSSE;
    const writeSse = vi.spyOn(SSEStreamingApi.prototype, 'writeSSE');
    writeSse
      .mockImplementationOnce(function (message) {
        return originalWriteSse.call(this, message);
      })
      .mockRejectedValueOnce(new Error('heartbeat write failed'));
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('heartbeat-write-failure', {
      projectPath: '/tmp/workspace-a',
    });

    let readSettled = false;
    let observed:
      | {
          subscribers: number;
          unsubscribeCalls: number;
          timers: number;
          ended: boolean;
        }
      | undefined;
    const response = await SessionRoutes().request(
      `/heartbeat-write-failure/events?projectPath=${encodeURIComponent('/tmp/workspace-a')}`
    );
    if (!response.body) {
      throw new Error('Expected SSE response body');
    }
    const reader = response.body.getReader();

    try {
      const connected = await reader.read();
      expect(new TextDecoder().decode(connected.value)).toContain('connected');
      const unsubscribe = busState.subscribe.mock.results.at(-1)?.value;
      const completion = reader.read().then((result) => {
        readSettled = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(15000);

      observed = {
        subscribers: busState.subscribers.size,
        unsubscribeCalls: unsubscribe.mock.calls.length,
        timers: vi.getTimerCount(),
        ended: readSettled && (await completion).done,
      };
    } finally {
      if (!readSettled) {
        await reader.cancel();
        await vi.advanceTimersByTimeAsync(1000);
      }
      writeSse.mockRestore();
      vi.useRealTimers();
    }

    expect(observed).toEqual({
      subscribers: 0,
      unsubscribeCalls: 1,
      timers: 0,
      ended: true,
    });
  });

  it('does not lose an exact Bus event published as soon as connected is consumed', async () => {
    const { Bus } = await import('../../../../src/server/bus.js');
    const NativeTransformStream = globalThis.TransformStream;
    let publishedAtConnectedWrite = false;
    vi.stubGlobal(
      'TransformStream',
      class extends NativeTransformStream<Uint8Array, Uint8Array> {
        constructor() {
          super({
            transform(chunk, streamController) {
              const payload = new TextDecoder().decode(chunk);
              if (!publishedAtConnectedWrite && payload.includes('connected')) {
                publishedAtConnectedWrite = true;
                Bus.publish(
                  {
                    sessionId: 'readiness-session',
                    projectPath: '/tmp/workspace-a',
                  },
                  'message.created',
                  { messageId: 'first-after-connected' }
                );
              }
              streamController.enqueue(chunk);
            },
          });
        }
      }
    );
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    mockResolvedSession('readiness-session', { projectPath: '/tmp/workspace-a' });

    const controller = new AbortController();
    const response = await SessionRoutes().request(
      `/readiness-session/events?projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      { signal: controller.signal }
    );
    const collector = createSseCollector(response);
    await expect(collector.next()).resolves.toMatchObject({ type: 'connected' });

    await vi.waitFor(() => {
      expect(busState.subscribers.size).toBe(1);
    });
    Bus.publish(
      { sessionId: 'readiness-session', projectPath: '/tmp/workspace-a' },
      'test.sentinel',
      {}
    );

    await expect(collector.next()).resolves.toMatchObject({
      type: 'message.created',
      properties: { messageId: 'first-after-connected' },
    });

    controller.abort();
    await collector.cancel();
  });

  it('rejects message posts for an explicit missing workspace without creating runtime state', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { Bus } = await import('../../../../src/server/bus.js');

    const app = SessionRoutes();
    const response = await app.request(
      `/missing-session/message?projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'hello from nowhere' }),
      }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
    expect(SessionRuntime.create).not.toHaveBeenCalled();
    expect(runtimeState.runtime.prepareInputTurn).not.toHaveBeenCalled();
    expect(Bus.publish).not.toHaveBeenCalled();
  });

  it('requires projectPath for duplicate session ids before accepting a message', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    vi.mocked(SessionService.listSessions).mockResolvedValue([
      makeSessionMetadata({
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-a',
        title: 'Workspace A',
        messageCount: 1,
      }),
      makeSessionMetadata({
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-b',
        title: 'Workspace B',
        messageCount: 1,
      }),
    ]);

    const app = SessionRoutes();
    const response = await app.request('/shared-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'ambiguous' }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'AMBIGUOUS_SESSION' },
    });
  });

  it('creates isolated runtimes for the same session id in different explicit workspaces', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (
          sessionId === 'shared-session' &&
          (projectPath === '/tmp/workspace-a' || projectPath === '/tmp/workspace-b')
        ) {
          return makeSessionMetadata({
            sessionId,
            projectPath,
            title: `Session ${projectPath?.slice(-1)}`,
          });
        }
        return undefined;
      }
    );

    const app = SessionRoutes();
    const firstResponse = await app.request(
      `/shared-session/message?projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'workspace a' }),
      }
    );
    const secondResponse = await app.request(
      `/shared-session/message?projectPath=${encodeURIComponent('/tmp/workspace-b')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'workspace b' }),
      }
    );

    expect(firstResponse.status).toBe(202);
    expect(secondResponse.status).toBe(202);
    expect(SessionRuntime.create).toHaveBeenCalledTimes(2);
    expect(SessionRuntime.create).toHaveBeenNthCalledWith(1, {
      sessionId: 'shared-session',
      workspaceRoot: '/tmp/workspace-a',
    });
    expect(SessionRuntime.create).toHaveBeenNthCalledWith(2, {
      sessionId: 'shared-session',
      workspaceRoot: '/tmp/workspace-b',
    });
  });

  it('routes a same-id message by projectPath in the shared request payload', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (sessionId === 'shared-session' && projectPath === '/tmp/workspace-b') {
          return makeSessionMetadata({ sessionId, projectPath });
        }
        return undefined;
      }
    );

    const response = await SessionRoutes().request('/shared-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'workspace b',
        projectPath: '/tmp/workspace-b',
      }),
    });

    expect(response.status).toBe(202);
    expect(SessionRuntime.create).toHaveBeenCalledWith({
      sessionId: 'shared-session',
      workspaceRoot: '/tmp/workspace-b',
    });
  });

  it('patches only the exact same-id workspace and rejects duplicate no-path patch requests', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');

    const metadataA = metadataFor('shared-session', '/tmp/workspace-a', {
      title: 'Workspace A',
    });
    const metadataB = metadataFor('shared-session', '/tmp/workspace-b', {
      title: 'Workspace B',
    });

    vi.mocked(SessionService.listSessions).mockResolvedValue([metadataA, metadataB]);
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (sessionId !== 'shared-session') {
          return undefined;
        }
        if (projectPath === '/tmp/workspace-a') {
          return metadataA;
        }
        if (projectPath === '/tmp/workspace-b') {
          return metadataB;
        }
        return undefined;
      }
    );

    vi.mocked(SessionService.updateSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath: string, update: { title?: string }) => {
        if (sessionId === 'shared-session' && projectPath === '/tmp/workspace-a') {
          return {
            ...metadataA,
            title: update.title,
            lastMessageTime: new Date(2).toISOString(),
          };
        }
        if (sessionId === 'shared-session' && projectPath === '/tmp/workspace-b') {
          return {
            ...metadataB,
            title: update.title,
            lastMessageTime: new Date(2).toISOString(),
          };
        }
        throw new Error(`Unexpected update target: ${sessionId} ${projectPath}`);
      }
    );

    const app = SessionRoutes();
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const responseA = await app.request(
      `/shared-session/events?projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      {
        signal: controllerA.signal,
      }
    );
    const responseB = await app.request(
      `/shared-session/events?projectPath=${encodeURIComponent('/tmp/workspace-b')}`,
      {
        signal: controllerB.signal,
      }
    );
    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(200);
    const collectorA = createSseCollector(responseA);
    const collectorB = createSseCollector(responseB);
    await expect(collectorA.next()).resolves.toMatchObject({
      type: 'connected',
      properties: {
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-a',
      },
    });
    await expect(collectorB.next()).resolves.toMatchObject({
      type: 'connected',
      properties: {
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-b',
      },
    });
    controllerA.abort();
    controllerB.abort();
    await Promise.all([collectorA.cancel(), collectorB.cancel()]);

    const patchA = await app.request(
      `/shared-session?projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectPath: '/tmp/workspace-a',
          title: 'Workspace A2',
        }),
      }
    );

    expect(patchA.status).toBe(200);
    expect(SessionService.updateSessionMetadata).toHaveBeenCalledTimes(1);
    expect(SessionService.updateSessionMetadata).toHaveBeenCalledWith(
      'shared-session',
      '/tmp/workspace-a',
      { title: 'Workspace A2' }
    );

    const getA = await app.request(
      `/shared-session?projectPath=${encodeURIComponent('/tmp/workspace-a')}`
    );
    const getB = await app.request(
      `/shared-session?projectPath=${encodeURIComponent('/tmp/workspace-b')}`
    );

    expect(getA.status).toBe(200);
    expect(await getA.json()).toMatchObject({
      sessionId: 'shared-session',
      projectPath: '/tmp/workspace-a',
      title: 'Workspace A2',
    });
    expect(getB.status).toBe(200);
    expect(await getB.json()).toMatchObject({
      sessionId: 'shared-session',
      projectPath: '/tmp/workspace-b',
      title: 'Workspace B',
    });

    vi.clearAllMocks();
    busState.subscribers.clear();
    vi.mocked(SessionService.listSessions).mockResolvedValue([metadataA, metadataB]);

    const ambiguousPatch = await app.request('/shared-session', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Should fail without path' }),
    });

    expect(ambiguousPatch.status).toBe(409);
    await expect(ambiguousPatch.json()).resolves.toMatchObject({
      error: { code: 'AMBIGUOUS_SESSION' },
    });
    expect(SessionService.updateSessionMetadata).not.toHaveBeenCalled();
  });

  it('deletes only the exact same-id workspace and rejects duplicate no-path delete requests', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');

    const metadataA = metadataFor('shared-session', '/tmp/workspace-a', {
      title: 'Workspace A',
    });
    const metadataB = metadataFor('shared-session', '/tmp/workspace-b', {
      title: 'Workspace B',
    });
    const historyB: Message[] = [{ role: 'assistant', content: 'workspace-b-history' }];
    const deletedProjectPaths = new Set<string>();
    const disposeA = vi.fn().mockResolvedValue(undefined);
    const disposeB = vi.fn().mockResolvedValue(undefined);
    const runtimeA = await createRuntimeDouble({ dispose: disposeA });
    const runtimeB = await createRuntimeDouble({ dispose: disposeB });

    vi.mocked(SessionService.listSessions).mockResolvedValue([metadataA, metadataB]);
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (sessionId !== 'shared-session') {
          return undefined;
        }
        if (projectPath && deletedProjectPaths.has(projectPath)) {
          return undefined;
        }
        if (projectPath === '/tmp/workspace-a') {
          return metadataA;
        }
        if (projectPath === '/tmp/workspace-b') {
          return metadataB;
        }
        return undefined;
      }
    );
    vi.mocked(SessionService.loadSession).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (sessionId === 'shared-session' && projectPath === '/tmp/workspace-b') {
          return historyB;
        }
        return [];
      }
    );

    vi.mocked(SessionRuntime.create).mockImplementation(
      async ({ workspaceRoot }: SessionRuntimeOptions) => {
        if (workspaceRoot === '/tmp/workspace-a') {
          return runtimeA;
        }
        if (workspaceRoot === '/tmp/workspace-b') {
          return runtimeB;
        }
        return createRuntimeDouble();
      }
    );

    let releaseRunA: () => void = () => undefined;
    let releaseRunB: () => void = () => undefined;
    let signalA: AbortSignal | undefined;
    let signalB: AbortSignal | undefined;
    const runGateA = new Promise<void>((resolve) => {
      releaseRunA = resolve;
    });
    const runGateB = new Promise<void>((resolve) => {
      releaseRunB = resolve;
    });
    agentState.chatStream
      .mockImplementationOnce(async function* (
        _content,
        chatContext: { signal: AbortSignal }
      ) {
        signalA = chatContext.signal;
        yield { kind: 'turn_start', turn: 1, maxTurns: 10 };
        await waitForGateOrAbort(runGateA, chatContext.signal);
        return {
          success: true,
          finalMessage: 'workspace-a',
          metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
        };
      })
      .mockImplementationOnce(async function* (
        _content,
        chatContext: { signal: AbortSignal }
      ) {
        signalB = chatContext.signal;
        yield { kind: 'turn_start', turn: 1, maxTurns: 10 };
        await runGateB;
        return {
          success: true,
          finalMessage: 'workspace-b',
          metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
        };
      });

    const app = SessionRoutes();
    const sendMessage = (projectPath: string, content: string) =>
      app.request(
        `/shared-session/message?projectPath=${encodeURIComponent(projectPath)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content }),
        }
      );

    const [messageA, messageB] = await Promise.all([
      sendMessage('/tmp/workspace-a', 'run a'),
      sendMessage('/tmp/workspace-b', 'run b'),
    ]);
    expect(messageA.status).toBe(202);
    expect(messageB.status).toBe(202);

    const deleteA = await app.request(
      `/shared-session?projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      {
        method: 'DELETE',
      }
    );

    expect(deleteA.status).toBe(200);
    deletedProjectPaths.add('/tmp/workspace-a');
    expect(SessionService.deleteSession).toHaveBeenCalledWith(
      'shared-session',
      '/tmp/workspace-a'
    );
    expect(signalA?.aborted).toBe(true);
    expect(signalB?.aborted).toBe(false);
    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(disposeB).not.toHaveBeenCalled();

    const getA = await app.request(
      `/shared-session?projectPath=${encodeURIComponent('/tmp/workspace-a')}`
    );
    const getB = await app.request(
      `/shared-session?projectPath=${encodeURIComponent('/tmp/workspace-b')}`
    );
    const historyAfterDeleteB = await app.request(
      `/shared-session/message?projectPath=${encodeURIComponent('/tmp/workspace-b')}`
    );

    expect(getA.status).toBe(404);
    expect(getB.status).toBe(200);
    expect(await getB.json()).toMatchObject({
      sessionId: 'shared-session',
      projectPath: '/tmp/workspace-b',
      title: 'Workspace B',
    });
    expect(historyAfterDeleteB.status).toBe(200);
    expect(await historyAfterDeleteB.json()).toEqual(historyB);

    releaseRunA();
    releaseRunB();

    vi.clearAllMocks();
    busState.subscribers.clear();
    vi.mocked(SessionService.listSessions).mockResolvedValue([metadataA, metadataB]);

    const ambiguousDelete = await app.request('/shared-session', {
      method: 'DELETE',
    });

    expect(ambiguousDelete.status).toBe(409);
    await expect(ambiguousDelete.json()).resolves.toMatchObject({
      error: { code: 'AMBIGUOUS_SESSION' },
    });
    expect(SessionService.deleteSession).not.toHaveBeenCalled();
  });

  it('keeps volatile session state after durable delete failure while marking the run cancelled', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');

    const metadata = metadataFor(
      'delete-failure-session',
      '/tmp/delete-failure-workspace',
      {
        title: 'Delete failure session',
      }
    );
    let deleted = false;
    const dispose = vi.fn().mockResolvedValue(undefined);
    const runtime = await createRuntimeDouble({ dispose });
    let observedSignal: AbortSignal | undefined;
    let releaseRun: () => void = () => undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });

    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (
          deleted ||
          sessionId !== 'delete-failure-session' ||
          projectPath !== '/tmp/delete-failure-workspace'
        ) {
          return undefined;
        }
        return metadata;
      }
    );
    vi.mocked(SessionService.listSessions).mockResolvedValue([metadata]);
    vi.mocked(SessionRuntime.create).mockResolvedValue(runtime);
    agentState.chatStream.mockImplementationOnce(async function* (
      _content,
      chatContext: { signal: AbortSignal }
    ) {
      observedSignal = chatContext.signal;
      yield { kind: 'turn_start', turn: 1, maxTurns: 10 };
      await waitForGateOrAbort(runGate, chatContext.signal);
      return {
        success: true,
        finalMessage: 'delete failure reply',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });

    const app = SessionRoutes();
    const startResponse = await app.request(
      `/delete-failure-session/message?projectPath=${encodeURIComponent('/tmp/delete-failure-workspace')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'start delete failure run' }),
      }
    );
    expect(startResponse.status).toBe(202);

    vi.mocked(SessionService.deleteSession).mockRejectedValueOnce(
      new Error('failed to delete /tmp/delete-failure-workspace/secret.jsonl')
    );

    const deleteResponse = await app.request(
      `/delete-failure-session?projectPath=${encodeURIComponent('/tmp/delete-failure-workspace')}`,
      {
        method: 'DELETE',
      }
    );
    expect(deleteResponse.status).toBe(500);
    expect(observedSignal?.aborted).toBe(true);
    expect(dispose).not.toHaveBeenCalled();

    const statusAfterFailure = await app.request(
      `/delete-failure-session/status?projectPath=${encodeURIComponent('/tmp/delete-failure-workspace')}`
    );
    expect(statusAfterFailure.status).toBe(200);
    expect(await statusAfterFailure.json()).toMatchObject({
      sessionId: 'delete-failure-session',
      projectPath: '/tmp/delete-failure-workspace',
      status: 'cancelled',
    });

    const getAfterFailure = await app.request(
      `/delete-failure-session?projectPath=${encodeURIComponent('/tmp/delete-failure-workspace')}`
    );
    expect(getAfterFailure.status).toBe(200);
    expect(await getAfterFailure.json()).toMatchObject({
      sessionId: 'delete-failure-session',
      projectPath: '/tmp/delete-failure-workspace',
      title: 'Delete failure session',
    });

    vi.mocked(SessionService.deleteSession).mockResolvedValueOnce(1);
    const retryDelete = await app.request(
      `/delete-failure-session?projectPath=${encodeURIComponent('/tmp/delete-failure-workspace')}`,
      {
        method: 'DELETE',
      }
    );
    expect(retryDelete.status).toBe(200);
    deleted = true;
    expect(dispose).toHaveBeenCalledTimes(1);

    const statusAfterSuccess = await app.request(
      `/delete-failure-session/status?projectPath=${encodeURIComponent('/tmp/delete-failure-workspace')}`
    );
    expect(statusAfterSuccess.status).toBe(404);

    releaseRun();
  });

  it('aborts only the exact same-id workspace run and rejects duplicate no-path abort requests', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');

    const metadataA = metadataFor('shared-session', '/tmp/workspace-a');
    const metadataB = metadataFor('shared-session', '/tmp/workspace-b');

    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (sessionId !== 'shared-session') {
          return undefined;
        }
        if (projectPath === '/tmp/workspace-a') {
          return metadataA;
        }
        if (projectPath === '/tmp/workspace-b') {
          return metadataB;
        }
        return undefined;
      }
    );
    vi.mocked(SessionService.listSessions).mockResolvedValue([metadataA, metadataB]);

    let signalA: AbortSignal | undefined;
    let signalB: AbortSignal | undefined;
    let releaseRunA: () => void = () => undefined;
    let releaseRunB: () => void = () => undefined;
    const runGateA = new Promise<void>((resolve) => {
      releaseRunA = resolve;
    });
    const runGateB = new Promise<void>((resolve) => {
      releaseRunB = resolve;
    });

    agentState.chatStream
      .mockImplementationOnce(async function* (
        _content,
        chatContext: { signal: AbortSignal }
      ) {
        if (Date.now() < 0) {
          yield undefined;
        }
        signalA = chatContext.signal;
        await waitForGateOrAbort(runGateA, chatContext.signal);
        return {
          success: true,
          finalMessage: 'workspace-a',
          metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
        };
      })
      .mockImplementationOnce(async function* (
        _content,
        chatContext: { signal: AbortSignal }
      ) {
        if (Date.now() < 0) {
          yield undefined;
        }
        signalB = chatContext.signal;
        await runGateB;
        return {
          success: true,
          finalMessage: 'workspace-b',
          metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
        };
      });

    const app = SessionRoutes();
    const startRun = (projectPath: string) =>
      app.request(
        `/shared-session/message?projectPath=${encodeURIComponent(projectPath)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: `start ${projectPath}` }),
        }
      );

    const [runA, runB] = await Promise.all([
      startRun('/tmp/workspace-a'),
      startRun('/tmp/workspace-b'),
    ]);
    expect(runA.status).toBe(202);
    expect(runB.status).toBe(202);

    const abortA = await app.request(
      `/shared-session/abort?projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      {
        method: 'POST',
      }
    );

    expect(abortA.status).toBe(200);

    const statusA = await app.request(
      `/shared-session/status?projectPath=${encodeURIComponent('/tmp/workspace-a')}`
    );
    const statusB = await app.request(
      `/shared-session/status?projectPath=${encodeURIComponent('/tmp/workspace-b')}`
    );

    expect(statusA.status).toBe(200);
    expect(await statusA.json()).toMatchObject({
      sessionId: 'shared-session',
      projectPath: '/tmp/workspace-a',
      status: 'cancelled',
    });
    expect(statusB.status).toBe(200);
    expect(await statusB.json()).toMatchObject({
      sessionId: 'shared-session',
      projectPath: '/tmp/workspace-b',
      status: 'running',
    });

    expect(signalA?.aborted).toBe(true);
    expect(signalB?.aborted).toBe(false);

    const ambiguousAbort = await app.request('/shared-session/abort', {
      method: 'POST',
    });

    expect(ambiguousAbort.status).toBe(409);
    await expect(ambiguousAbort.json()).resolves.toMatchObject({
      error: { code: 'AMBIGUOUS_SESSION' },
    });

    releaseRunA();
    releaseRunB();
  });

  it('returns exact same-id workspace status and rejects duplicate no-path status requests', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');

    const metadataA = metadataFor('shared-session', '/tmp/workspace-a');
    const metadataB = metadataFor('shared-session', '/tmp/workspace-b');

    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (sessionId !== 'shared-session') {
          return undefined;
        }
        if (projectPath === '/tmp/workspace-a') {
          return metadataA;
        }
        if (projectPath === '/tmp/workspace-b') {
          return metadataB;
        }
        return undefined;
      }
    );
    vi.mocked(SessionService.listSessions).mockResolvedValue([metadataA, metadataB]);

    let releaseRunA: () => void = () => undefined;
    let releaseRunB: () => void = () => undefined;
    const runGateA = new Promise<void>((resolve) => {
      releaseRunA = resolve;
    });
    const runGateB = new Promise<void>((resolve) => {
      releaseRunB = resolve;
    });
    const runtimeA = await createRuntimeDouble();
    const runtimeB = await createRuntimeDouble();
    vi.mocked(SessionRuntime.create).mockImplementation(
      async ({ workspaceRoot }: SessionRuntimeOptions) => {
        if (workspaceRoot === '/tmp/workspace-a') {
          return runtimeA;
        }
        if (workspaceRoot === '/tmp/workspace-b') {
          return runtimeB;
        }
        return createRuntimeDouble();
      }
    );

    agentState.chatStream
      .mockImplementationOnce(async function* () {
        yield { kind: 'turn_start', turn: 1, maxTurns: 10 };
        await runGateA;
        return {
          success: true,
          finalMessage: 'workspace-a',
          metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
        };
      })
      .mockImplementationOnce(async function* () {
        yield { kind: 'turn_start', turn: 1, maxTurns: 10 };
        await runGateB;
        return {
          success: true,
          finalMessage: 'workspace-b',
          metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
        };
      });

    const app = SessionRoutes();
    const runA = await app.request(
      `/shared-session/message?projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'start a' }),
      }
    );
    expect(runA.status).toBe(202);

    const runB = await app.request(
      `/shared-session/message?projectPath=${encodeURIComponent('/tmp/workspace-b')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'start b' }),
      }
    );
    expect(runB.status).toBe(202);

    const statusA = await app.request(
      `/shared-session/status?projectPath=${encodeURIComponent('/tmp/workspace-a')}`
    );
    const statusB = await app.request(
      `/shared-session/status?projectPath=${encodeURIComponent('/tmp/workspace-b')}`
    );

    expect(statusA.status).toBe(200);
    expect(await statusA.json()).toMatchObject({
      sessionId: 'shared-session',
      projectPath: '/tmp/workspace-a',
      runId: expect.any(String),
      status: 'running',
    });
    expect(statusB.status).toBe(200);
    expect(await statusB.json()).toMatchObject({
      sessionId: 'shared-session',
      projectPath: '/tmp/workspace-b',
      runId: expect.any(String),
      status: 'running',
    });

    const ambiguousStatus = await app.request('/shared-session/status');
    expect(ambiguousStatus.status).toBe(409);
    await expect(ambiguousStatus.json()).resolves.toMatchObject({
      error: { code: 'AMBIGUOUS_SESSION' },
    });

    releaseRunA();
    releaseRunB();
  });

  it('routes permission responses through the unified exact session resolver', async () => {
    const permissionApp = await createPermissionsApp();

    const relativeProjectPath = await permissionApp.request(
      '/permissions/perm-1?sessionId=shared-session&projectPath=relative-path',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      }
    );
    expect(relativeProjectPath.status).toBe(400);
    await expect(relativeProjectPath.json()).resolves.toMatchObject({
      error: { code: 'BAD_REQUEST' },
    });

    const explicitMissing = await permissionApp.request(
      `/permissions/perm-1?sessionId=shared-session&projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      }
    );
    expect(explicitMissing.status).toBe(404);
    expect(SessionService.findSessionMetadata).toHaveBeenCalledWith(
      'shared-session',
      '/tmp/workspace-a'
    );

    vi.mocked(SessionService.listSessions).mockResolvedValue([
      makeSessionMetadata({
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-a',
        title: 'Workspace A',
        messageCount: 1,
      }),
      makeSessionMetadata({
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-b',
        title: 'Workspace B',
        messageCount: 1,
      }),
    ]);

    const ambiguous = await permissionApp.request(
      '/permissions/perm-1?sessionId=shared-session',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      }
    );
    expect(ambiguous.status).toBe(409);
    await expect(ambiguous.json()).resolves.toMatchObject({
      error: { code: 'AMBIGUOUS_SESSION' },
    });
  });

  it('applies permission responses only to the exact matching same-id workspace run', async () => {
    const app = await createSessionAndPermissionApp();
    const resolvedPermissions: string[] = [];

    agentState.chatStream.mockImplementation(async function* (
      _content,
      chatContext: {
        workspaceRoot: string;
        confirmationHandler: {
          requestConfirmation: (details: {
            toolName: string;
            message: string;
            args?: Record<string, unknown>;
          }) => Promise<{ approved: boolean }>;
        };
      }
    ) {
      await chatContext.confirmationHandler.requestConfirmation({
        toolName: 'Read',
        message: `Need approval for ${chatContext.workspaceRoot}`,
        args: {},
      });
      if (Date.now() < 0) {
        yield undefined;
      }
      resolvedPermissions.push(chatContext.workspaceRoot);
      return {
        success: true,
        finalMessage: `approved ${chatContext.workspaceRoot}`,
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });

    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (
          sessionId === 'shared-session' &&
          (projectPath === '/tmp/workspace-a' || projectPath === '/tmp/workspace-b')
        ) {
          return makeSessionMetadata({
            sessionId,
            projectPath,
            title: `Session ${projectPath?.slice(-1)}`,
          });
        }
        return undefined;
      }
    );

    const messageRequest = (projectPath: string) =>
      app.request(
        `/sessions/shared-session/message?projectPath=${encodeURIComponent(projectPath)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: `run in ${projectPath}` }),
        }
      );

    const [firstMessageResponse, secondMessageResponse] = await Promise.all([
      messageRequest('/tmp/workspace-a'),
      messageRequest('/tmp/workspace-b'),
    ]);
    expect(firstMessageResponse.status).toBe(202);
    expect(secondMessageResponse.status).toBe(202);

    await vi.waitFor(() => {
      const permissionCalls = vi
        .mocked(busState.publish)
        .mock.calls.filter(([, type]) => type === 'permission.asked');
      expect(permissionCalls).toHaveLength(2);
    });

    const permissionCalls = vi
      .mocked(busState.publish)
      .mock.calls.filter(([, type]) => type === 'permission.asked');
    const firstPermissionCall = permissionCalls.find(
      ([ref]) => ref.projectPath === '/tmp/workspace-a'
    );
    const secondPermissionCall = permissionCalls.find(
      ([ref]) => ref.projectPath === '/tmp/workspace-b'
    );
    expect(firstPermissionCall).toBeDefined();
    expect(secondPermissionCall).toBeDefined();

    const firstPermissionId = String(firstPermissionCall?.[2].requestId);
    const secondPermissionId = String(secondPermissionCall?.[2].requestId);

    const firstPermissionResponse = await app.request(
      `/permissions/${firstPermissionId}?sessionId=shared-session&projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      }
    );
    expect(firstPermissionResponse.status).toBe(200);

    await vi.waitFor(() => {
      expect(resolvedPermissions).toEqual(['/tmp/workspace-a']);
    });

    const secondPermissionResponse = await app.request(
      `/permissions/${secondPermissionId}?sessionId=shared-session&projectPath=${encodeURIComponent('/tmp/workspace-b')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      }
    );
    expect(secondPermissionResponse.status).toBe(200);

    await vi.waitFor(() => {
      expect(resolvedPermissions).toEqual(['/tmp/workspace-a', '/tmp/workspace-b']);
    });
  });

  it('routes goal creation and continuation to the exact session workspace', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const metadataA = metadataFor('shared-goal', '/tmp/workspace-a');
    const metadataB = metadataFor('shared-goal', '/tmp/workspace-b');
    const goal = {
      version: 1 as const,
      sessionId: 'shared-goal',
      goalId: 'goal-a',
      objective: 'finish workspace A',
      status: 'active' as const,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      continuationCount: 0,
      createdAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z',
    };
    const createGoalA = vi.fn().mockResolvedValue(goal);
    const createGoalB = vi.fn();
    const runtimeA = await createRuntimeDouble({
      workspaceRoot: '/tmp/workspace-a',
      createGoal: createGoalA,
    });
    const runtimeB = await createRuntimeDouble({
      workspaceRoot: '/tmp/workspace-b',
      createGoal: createGoalB,
    });

    vi.mocked(SessionService.listSessions).mockResolvedValue([metadataA, metadataB]);
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (sessionId !== 'shared-goal') return undefined;
        if (projectPath === '/tmp/workspace-a') return metadataA;
        if (projectPath === '/tmp/workspace-b') return metadataB;
        return undefined;
      }
    );
    vi.mocked(SessionRuntime.create).mockImplementation(
      async ({ workspaceRoot }: SessionRuntimeOptions) =>
        workspaceRoot === '/tmp/workspace-a' ? runtimeA : runtimeB
    );

    const app = SessionRoutes();
    const response = await app.request(
      `/shared-goal/goal?projectPath=${encodeURIComponent('/tmp/workspace-a')}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ objective: 'finish workspace A' }),
      }
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: 'running',
      goal,
    });
    expect(createGoalA).toHaveBeenCalledWith({
      objective: 'finish workspace A',
    });
    expect(createGoalB).not.toHaveBeenCalled();
    expect(busState.publish).toHaveBeenCalledWith(
      { sessionId: 'shared-goal', projectPath: '/tmp/workspace-a' },
      'goal.updated',
      { goal }
    );
    await vi.waitFor(() => {
      expect(agentState.chatStream).toHaveBeenCalledWith(
        '',
        expect.objectContaining({
          sessionId: 'shared-goal',
          workspaceRoot: '/tmp/workspace-a',
        }),
        expect.objectContaining({ goalContinuationOnly: true })
      );
    });

    const ambiguous = await app.request('/shared-goal/goal', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objective: 'must not guess a workspace' }),
    });
    expect(ambiguous.status).toBe(409);
    expect(createGoalB).not.toHaveBeenCalled();
  });

  it('returns a generic internal error body when an unexpected session route error occurs', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');

    vi.mocked(SessionService.findSessionMetadata).mockRejectedValueOnce(
      new Error('failed to parse /secret/path.jsonl')
    );

    const app = SessionRoutes();
    const response = await app.request(
      `/secretive/events?projectPath=${encodeURIComponent('/tmp/workspace-a')}`
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    });
  });

  it('returns a generic internal error when listing sessions fails instead of leaking paths or returning []', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');

    vi.mocked(SessionService.listSessions).mockRejectedValueOnce(
      new Error('scan failed for /secret/workspaces/project/.blade/sessions')
    );

    const app = SessionRoutes();
    const response = await app.request('/');
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      error: {
        code: 'INTERNAL_ERROR',
      },
    });
    expect(body.error.message).not.toContain(
      '/secret/workspaces/project/.blade/sessions'
    );
  });
});
