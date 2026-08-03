import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRuntime } from '../../../../src/agent/runtime/SessionRuntime.js';
import { SessionService } from '../../../../src/services/SessionService.js';

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
    prepareInputTurn: vi.fn((): any => ({
      accepted: true,
      handle: { id: 'prepared-turn' },
      messageId: 'prepared-input',
      queued: 1,
      mode: 'direct',
    })),
    enqueueSteering: vi.fn((): any => ({
      accepted: true,
      messageId: 'steering-input',
      turnId: 'turn-1',
      queued: 1,
      delivery: 'current_turn',
    })),
    finishTurn: vi.fn().mockResolvedValue(undefined),
    getPendingSteeringCount: vi.fn(() => 0),
    hasTurnOwner: vi.fn(() => false),
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
      return () => {
        busState.subscribers.delete(callback);
      };
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
      async (sessionId: string, projectPath: string, initial?: { title?: string }) => ({
        sessionId,
        projectPath,
        rootId: sessionId,
        title: initial?.title,
        messageCount: 0,
        firstMessageTime: new Date(0).toISOString(),
        lastMessageTime: new Date(0).toISOString(),
        hasErrors: false,
      })
    ),
    updateSessionMetadata: vi.fn(
      async (sessionId: string, projectPath: string, update: { title?: string }) => ({
        sessionId,
        projectPath,
        rootId: sessionId,
        title: update.title,
        messageCount: 0,
        firstMessageTime: new Date(0).toISOString(),
        lastMessageTime: new Date(1).toISOString(),
        hasErrors: false,
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
        messages: [],
        metadata: {
          sessionId: 'forked-session',
          projectPath: options.targetProjectPath,
          rootId: sessionId,
          parentId: sessionId,
          relationType: 'fork',
          messageCount: 0,
          firstMessageTime: new Date(0).toISOString(),
          lastMessageTime: new Date(0).toISOString(),
          hasErrors: false,
        },
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
    runtimeState.runtime.prepareInputTurn.mockImplementation(async () => ({
      accepted: true,
      handle: { id: 'prepared-turn' },
      messageId: 'prepared-input',
      queued: 1,
      mode: 'direct',
    }));
    runtimeState.runtime.enqueueSteering.mockClear();
    runtimeState.runtime.enqueueSteering.mockResolvedValue({
      accepted: true,
      messageId: 'steering-input',
      turnId: 'turn-1',
      queued: 1,
      delivery: 'current_turn',
    });
    runtimeState.runtime.finishTurn.mockClear();
    runtimeState.runtime.getPendingSteeringCount.mockReturnValue(0);
    runtimeState.runtime.hasTurnOwner.mockReturnValue(false);
    vi.mocked(SessionRuntime.create).mockImplementation(
      async () => runtimeState.runtime as never
    );
    vi.mocked(SessionRuntime.hasPendingInbox).mockResolvedValue(false);
    vi.mocked(SessionService.listSessions).mockResolvedValue([]);
    vi.mocked(SessionService.findSessionMetadata).mockResolvedValue(undefined);
    vi.mocked(SessionService.loadSession).mockResolvedValue([]);
    vi.mocked(SessionService.createSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath: string, initial?: { title?: string }) =>
        ({
          sessionId,
          projectPath,
          rootId: sessionId,
          title: initial?.title,
          messageCount: 0,
          firstMessageTime: new Date(0).toISOString(),
          lastMessageTime: new Date(0).toISOString(),
          hasErrors: false,
        }) as never
    );
    vi.mocked(SessionService.updateSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath: string, update: { title?: string }) =>
        ({
          sessionId,
          projectPath,
          rootId: sessionId,
          title: update.title,
          messageCount: 0,
          firstMessageTime: new Date(0).toISOString(),
          lastMessageTime: new Date(1).toISOString(),
          hasErrors: false,
        }) as never
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
    vi.resetModules();
  });

  const refFor = (sessionId: string) => ({
    sessionId,
    projectPath:
      '/Users/bytedance/Documents/GitHub/Blade/.worktrees/session-discovery-fork/packages/cli',
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
  ) => ({
    sessionId,
    projectPath,
    rootId: overrides.rootId ?? sessionId,
    title: overrides.title ?? `Session ${sessionId}`,
    messageCount: overrides.messageCount ?? 0,
    firstMessageTime: overrides.firstMessageTime ?? new Date(0).toISOString(),
    lastMessageTime: overrides.lastMessageTime ?? new Date(1).toISOString(),
    hasErrors: overrides.hasErrors ?? false,
    ...(overrides.parentId ? { parentId: overrides.parentId } : {}),
    ...(overrides.relationType ? { relationType: overrides.relationType } : {}),
  });

  const mockResolvedSession = (
    sessionId: string,
    options: {
      projectPath?: string;
      messages?: Array<{ role: string; content: string }>;
    } = {}
  ) => {
    const metadata = metadataFor(sessionId, options.projectPath);
    const messages = options.messages ?? [];
    vi.mocked(SessionService.listSessions).mockResolvedValue([metadata] as never);
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
        return metadata as never;
      }
    );
    vi.mocked(SessionService.loadSession).mockImplementation(
      async (requestedSessionId: string, requestedProjectPath?: string) => {
        if (
          requestedSessionId === sessionId &&
          requestedProjectPath === metadata.projectPath
        ) {
          return messages as never;
        }
        return [] as never;
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
    expect(Agent.createWithRuntime).toHaveBeenNthCalledWith(1, runtimeState.runtime, {
      sessionId: 'session-1',
    });
    expect(Agent.createWithRuntime).toHaveBeenNthCalledWith(2, runtimeState.runtime, {
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
          releaseRuntime = () => resolve(runtimeState.runtime as never);
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
    mockResolvedSession('durable-accept');
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
            });
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
    vi.mocked(SessionService.listSessions).mockResolvedValue([
      recoveredMetadata,
    ] as never);
    vi.mocked(SessionService.findSessionMetadata).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (
          sessionId === 'recovered-web-session' &&
          projectPath === '/persisted-workspace'
        ) {
          return recoveredMetadata as never;
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
      messages: [
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
      ],
    });
    vi.mocked(SessionService.loadSession).mockResolvedValue([
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
    ] as never);

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

    vi.mocked(SessionService.updateSessionMetadata).mockResolvedValueOnce({
      sessionId: created.sessionId,
      projectPath: '/tmp/task4-rename-workspace',
      rootId: created.sessionId,
      title: 'Renamed durably',
      messageCount: 0,
      firstMessageTime: new Date(0).toISOString(),
      lastMessageTime: new Date(2).toISOString(),
      hasErrors: false,
    } as never);

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

    const app = SessionRoutes();
    const createResponse = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Stable title',
        projectPath: '/tmp/task4-stable-title',
      }),
    });
    const created = await createResponse.json();

    vi.mocked(SessionService.updateSessionMetadata).mockRejectedValueOnce(
      new Error('rename failed')
    );
    const patchResponse = await app.request(`/${created.sessionId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Should not stick',
        projectPath: '/tmp/task4-stable-title',
      }),
    });

    expect(patchResponse.status).toBe(500);

    const getResponse = await app.request(
      `/${created.sessionId}?projectPath=${encodeURIComponent('/tmp/task4-stable-title')}`
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
      {
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-a',
        rootId: 'shared-session',
        title: 'Workspace A',
        messageCount: 1,
        firstMessageTime: new Date(0).toISOString(),
        lastMessageTime: new Date(1).toISOString(),
        hasErrors: false,
      },
      {
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-b',
        rootId: 'shared-session',
        title: 'Workspace B',
        messageCount: 2,
        firstMessageTime: new Date(0).toISOString(),
        lastMessageTime: new Date(2).toISOString(),
        hasErrors: false,
      },
    ] as never);

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
          return {
            sessionId,
            projectPath,
            rootId: sessionId,
            title: 'Workspace B',
            messageCount: 2,
            firstMessageTime: new Date(0).toISOString(),
            lastMessageTime: new Date(2).toISOString(),
            hasErrors: false,
          } as never;
        }
        return undefined;
      }
    );
    vi.mocked(SessionService.loadSession).mockImplementation(
      async (sessionId: string, projectPath?: string) => {
        if (sessionId === 'shared-session' && projectPath === '/tmp/workspace-b') {
          return [{ role: 'assistant', content: 'workspace-b-history' }] as never;
        }
        return [] as never;
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
      {
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-a',
        rootId: 'shared-session',
        title: 'Workspace A',
        messageCount: 1,
        firstMessageTime: new Date(0).toISOString(),
        lastMessageTime: new Date(1).toISOString(),
        hasErrors: false,
      },
      {
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-b',
        rootId: 'shared-session',
        title: 'Workspace B',
        messageCount: 1,
        firstMessageTime: new Date(0).toISOString(),
        lastMessageTime: new Date(1).toISOString(),
        hasErrors: false,
      },
    ] as never);

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
          return {
            sessionId,
            projectPath,
            rootId: sessionId,
            title: `Session ${projectPath?.slice(-1)}`,
            messageCount: 0,
            firstMessageTime: new Date(0).toISOString(),
            lastMessageTime: new Date(1).toISOString(),
            hasErrors: false,
          } as never;
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
      {
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-a',
        rootId: 'shared-session',
        title: 'Workspace A',
        messageCount: 1,
        firstMessageTime: new Date(0).toISOString(),
        lastMessageTime: new Date(1).toISOString(),
        hasErrors: false,
      },
      {
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-b',
        rootId: 'shared-session',
        title: 'Workspace B',
        messageCount: 1,
        firstMessageTime: new Date(0).toISOString(),
        lastMessageTime: new Date(1).toISOString(),
        hasErrors: false,
      },
    ] as never);

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
          return {
            sessionId,
            projectPath,
            rootId: sessionId,
            title: `Session ${projectPath?.slice(-1)}`,
            messageCount: 0,
            firstMessageTime: new Date(0).toISOString(),
            lastMessageTime: new Date(1).toISOString(),
            hasErrors: false,
          } as never;
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
      {
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-a',
        rootId: 'shared-session',
        title: 'Workspace A',
        messageCount: 1,
        firstMessageTime: new Date(0).toISOString(),
        lastMessageTime: new Date(1).toISOString(),
        hasErrors: false,
      },
      {
        sessionId: 'shared-session',
        projectPath: '/tmp/workspace-b',
        rootId: 'shared-session',
        title: 'Workspace B',
        messageCount: 1,
        firstMessageTime: new Date(0).toISOString(),
        lastMessageTime: new Date(1).toISOString(),
        hasErrors: false,
      },
    ] as never);

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
          return {
            sessionId,
            projectPath,
            rootId: sessionId,
            title: `Session ${projectPath?.slice(-1)}`,
            messageCount: 0,
            firstMessageTime: new Date(0).toISOString(),
            lastMessageTime: new Date(1).toISOString(),
            hasErrors: false,
          } as never;
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
});
