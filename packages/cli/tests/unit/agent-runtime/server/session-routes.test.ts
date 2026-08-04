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
    getGoal: vi.fn().mockResolvedValue(null),
    createGoal: vi.fn(),
    editGoal: vi.fn(),
    pauseGoal: vi.fn(),
    resumeGoal: vi.fn(),
    clearGoal: vi.fn(),
  },
}));

const agentState = vi.hoisted(() => ({
  chatStream: vi.fn(),
}));

vi.mock('../../../../src/agent/runtime/SessionRuntime.js', () => ({
  SessionRuntime: {
    create: vi.fn(async () => runtimeState.runtime),
    hasPendingInbox: vi.fn(async () => false),
    hasActiveGoal: vi.fn(async () => false),
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
    publish: vi.fn(),
    subscribe: vi.fn(() => () => {
      /* noop */
    }),
  },
}));

vi.mock('../../../../src/services/SessionService.js', () => ({
  SessionService: {
    listSessions: vi.fn(async () => []),
    loadSession: vi.fn(async () => []),
    deleteSession: vi.fn(async () => {
      /* noop */
    }),
    forkSession: vi.fn(),
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

describe('SessionRoutes runtime reuse', () => {
  const activeGoal = {
    version: 1 as const,
    sessionId: 'goal-session',
    goalId: 'goal-1',
    objective: 'finish the migration',
    status: 'active' as const,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    continuationCount: 0,
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
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
    runtimeState.runtime.getGoal.mockResolvedValue(null);
    runtimeState.runtime.createGoal.mockReset();
    runtimeState.runtime.editGoal.mockReset();
    runtimeState.runtime.pauseGoal.mockReset();
    runtimeState.runtime.resumeGoal.mockReset();
    runtimeState.runtime.clearGoal.mockReset();
    vi.mocked(SessionRuntime.create).mockImplementation(
      async () => runtimeState.runtime as never
    );
    vi.mocked(SessionRuntime.hasPendingInbox).mockResolvedValue(false);
    vi.mocked(SessionRuntime.hasActiveGoal).mockResolvedValue(false);
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

  it('creates storage-safe session IDs', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const app = SessionRoutes();

    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: '/tmp/session-id-test' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sessionId: expect.stringMatching(/^session-[A-Za-z0-9_-]+$/),
    });
  });

  it('reuses one SessionRuntime for repeated messages in the same session', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { SessionRuntime } = await import(
      '../../../../src/agent/runtime/SessionRuntime.js'
    );
    const { Agent } = await import('../../../../src/agent/Agent.js');

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

  it('forks an idle session and exposes durable lineage to Web clients', async () => {
    vi.mocked(SessionService.forkSession).mockResolvedValue({
      sessionId: 'child-session',
      parentSessionId: 'parent-session',
      projectPath: '/workspace',
      messages: [{ role: 'user', content: 'inherited context' }],
    });
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const app = SessionRoutes();

    const response = await app.request('/parent-session/fork', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      sessionId: 'child-session',
      parentId: 'parent-session',
      relationType: 'fork',
      messageCount: 1,
    });
    expect(SessionService.forkSession).toHaveBeenCalledWith(
      'parent-session',
      expect.objectContaining({
        sourceProjectPath: expect.any(String),
        targetProjectPath: expect.any(String),
      })
    );

    const child = await app.request('/child-session');
    expect(await child.json()).toMatchObject({
      sessionId: 'child-session',
      parentId: 'parent-session',
      relationType: 'fork',
    });
  });

  it('refuses to fork a session while its turn is active', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { Bus } = await import('../../../../src/server/bus.js');
    let releaseRun: () => void = () => undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    agentState.chatStream.mockImplementationOnce(async function* () {
      yield { kind: 'turn_start', turn: 1, maxTurns: 10 };
      await runGate;
      return {
        success: true,
        finalMessage: 'done',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });
    const app = SessionRoutes();

    const started = await app.request('/active-parent/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'keep running' }),
    });
    expect(started.status).toBe(202);
    await vi.waitFor(() => {
      expect(Bus.publish).toHaveBeenCalledWith(
        'active-parent',
        'turn.started',
        expect.any(Object)
      );
    });

    const response = await app.request('/active-parent/fork', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(409);
    expect(SessionService.forkSession).not.toHaveBeenCalled();
    releaseRun();
  });

  it('serializes a fork behind startup input preparation', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    let releasePreparation: () => void = () => undefined;
    runtimeState.runtime.prepareInputTurn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePreparation = () =>
            resolve({
              accepted: true,
              handle: { id: 'prepared-turn' },
              messageId: 'prepared-input',
              queued: 1,
              mode: 'direct',
            });
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
        finalMessage: 'done',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });
    const app = SessionRoutes();

    const messagePromise = app.request('/starting-parent/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'start a durable turn' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    let forkSettled = false;
    const forkPromise = Promise.resolve(
      app.request('/starting-parent/fork', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
    ).then((response) => {
      forkSettled = true;
      return response;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(forkSettled).toBe(false);
    releasePreparation();
    expect((await messagePromise).status).toBe(202);
    expect((await forkPromise).status).toBe(409);
    expect(SessionService.forkSession).not.toHaveBeenCalled();
    releaseRun();
  });

  it('routes a second message into the active turn instead of starting a concurrent run', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { Agent } = await import('../../../../src/agent/Agent.js');
    const { Bus } = await import('../../../../src/server/bus.js');
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
        'steering-session',
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
      'steering-session',
      'steering.queued',
      expect.objectContaining({ queued: 1 })
    );

    releaseRun();
    await vi.waitFor(() => {
      expect(Bus.publish).toHaveBeenCalledWith(
        'steering-session',
        'session.completed',
        expect.any(Object)
      );
    });
  });

  it('defers input submitted after the active turn seals', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { Bus } = await import('../../../../src/server/bus.js');
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
        'follow-up-session',
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
      'follow-up-session',
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
    vi.mocked(SessionService.listSessions).mockResolvedValue([
      {
        sessionId: 'recovered-web-session',
        projectPath: '/persisted-workspace',
        firstMessageTime: new Date(0).toISOString(),
      },
    ] as never);
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

  it('publishes structured questions and replays the unresolved prompt on SSE reconnect', async () => {
    const { SessionRoutes, respondToPermission } = await import(
      '../../../../src/server/routes/session.js'
    );
    const { Bus } = await import('../../../../src/server/bus.js');
    const questions = [
      {
        header: 'Channel',
        question: 'Which release channel should be used?',
        multiSelect: false,
        options: [
          { label: 'Stable', description: 'Use stable' },
          { label: 'Canary', description: 'Use canary' },
        ],
      },
    ];
    agentState.chatStream.mockImplementationOnce(async function* (_message, context) {
      yield { kind: 'turn_start', turn: 1, maxTurns: 10 };
      await context.confirmationHandler.requestConfirmation({
        type: 'askUserQuestion',
        kind: 'readonly',
        message: 'Choose a channel',
        questions,
      });
      return {
        success: true,
        finalMessage: 'answered',
        metadata: { turnsCount: 1, toolCallsCount: 1, duration: 0 },
      };
    });

    const app = SessionRoutes();
    const messageResponse = await app.request('/question-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'Ask before changing code',
        permissionMode: 'yolo',
      }),
    });
    expect(messageResponse.status).toBe(202);

    await vi.waitFor(() => {
      expect(Bus.publish).toHaveBeenCalledWith(
        'question-session',
        'question.required',
        expect.objectContaining({
          requestId: expect.any(String),
          questions,
        })
      );
    });
    const questionCall = vi
      .mocked(Bus.publish)
      .mock.calls.find((call) => call[1] === 'question.required');
    const requestId = questionCall?.[2].requestId as string;
    expect(requestId).toBeTruthy();

    const controller = new AbortController();
    const eventResponse = await app.request('/question-session/events', {
      signal: controller.signal,
    });
    expect(eventResponse.status).toBe(200);
    const reader = eventResponse.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let output = '';
    try {
      await Promise.race([
        (async () => {
          while (!output.includes('question.required')) {
            const { done, value } = await reader!.read();
            if (done) break;
            output += decoder.decode(value, { stream: true });
          }
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Timed out waiting for question replay')),
            1000
          )
        ),
      ]);
      expect(output).toContain('question.required');
      expect(output).toContain('"replayed":true');
    } finally {
      respondToPermission('question-session', requestId, {
        approved: true,
        answers: { Channel: 'Canary' },
      });
      controller.abort();
      await reader?.cancel().catch(() => undefined);
    }
  });

  it('settles a pending interaction when the Web run is aborted', async () => {
    const { SessionRoutes, respondToPermission } = await import(
      '../../../../src/server/routes/session.js'
    );
    const { Bus } = await import('../../../../src/server/bus.js');
    let releaseCancelledRun: (() => void) | undefined;
    const cancelledRunCleanup = new Promise<void>((resolve) => {
      releaseCancelledRun = resolve;
    });
    agentState.chatStream.mockImplementationOnce(async function* (_message, context) {
      yield { kind: 'turn_start', turn: 1, maxTurns: 10 };
      const response = await context.confirmationHandler.requestConfirmation({
        type: 'askUserQuestion',
        kind: 'readonly',
        message: 'Choose a channel',
        questions: [
          {
            header: 'Channel',
            question: 'Which release channel should be used?',
            multiSelect: false,
            options: [
              { label: 'Stable', description: 'Use stable' },
              { label: 'Canary', description: 'Use canary' },
            ],
          },
        ],
      });
      expect(response).toEqual({ approved: false, reason: '__aborted__' });
      await cancelledRunCleanup;
      return {
        success: true,
        finalMessage: 'cancelled',
        metadata: { turnsCount: 1, toolCallsCount: 1, duration: 0 },
      };
    });

    const app = SessionRoutes();
    const messageResponse = await app.request('/abort-question-session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'Ask before changing code',
        permissionMode: 'yolo',
      }),
    });
    expect(messageResponse.status).toBe(202);

    await vi.waitFor(() => {
      expect(Bus.publish).toHaveBeenCalledWith(
        'abort-question-session',
        'question.required',
        expect.objectContaining({ requestId: expect.any(String) })
      );
    });
    const questionCall = vi
      .mocked(Bus.publish)
      .mock.calls.find((call) => call[1] === 'question.required');
    const requestId = questionCall?.[2].requestId as string;

    let abortSettled = false;
    const abortResponsePromise = Promise.resolve(
      app.request('/abort-question-session/abort', { method: 'POST' })
    ).then((response) => {
      abortSettled = true;
      return response;
    });
    await vi.waitFor(() => {
      expect(Bus.publish).toHaveBeenCalledWith(
        'abort-question-session',
        'run.cancelled',
        expect.any(Object)
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(abortSettled).toBe(false);
    expect(
      respondToPermission('abort-question-session', requestId, {
        approved: true,
        answers: { Channel: 'Canary' },
      })
    ).toBe(false);

    releaseCancelledRun?.();
    const abortResponse = await abortResponsePromise;
    expect(abortResponse.status).toBe(200);
    await vi.waitFor(() => {
      expect(Bus.publish).toHaveBeenCalledWith(
        'abort-question-session',
        'session.status',
        { status: 'idle' }
      );
    });

    expect(
      vi
        .mocked(Bus.publish)
        .mock.calls.filter(
          (call) => call[0] === 'abort-question-session' && call[1] === 'run.cancelled'
        )
    ).toHaveLength(1);
    expect(Bus.publish).not.toHaveBeenCalledWith(
      'abort-question-session',
      'session.completed',
      expect.any(Object)
    );
    expect(Bus.publish).not.toHaveBeenCalledWith(
      'abort-question-session',
      'session.error',
      expect.any(Object)
    );
  });

  it('builds multimodal user content from image attachments', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');

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
    const { SessionService } = await import(
      '../../../../src/services/SessionService.js'
    );

    vi.mocked(SessionService.loadSession).mockResolvedValue([
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
    ] as never);
    vi.mocked(SessionService.listSessions).mockResolvedValue([
      {
        sessionId: 'persisted-session',
        projectPath: '/persisted-workspace',
        firstMessageTime: new Date(0).toISOString(),
      },
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
      expect(Bus.publish).toHaveBeenCalledWith('failed-prepared-run', 'session.error', {
        error: 'upstream unavailable',
      });
    });
    expect(runtimeState.runtime.finishTurn).toHaveBeenCalledWith({
      id: 'prepared-turn',
    });
    expect(Bus.publish).not.toHaveBeenCalledWith(
      'failed-prepared-run',
      'session.completed',
      expect.any(Object)
    );
  });

  it('publishes loop lifecycle events and preserves canonical tool failure state', async () => {
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { Bus } = await import('../../../../src/server/bus.js');

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
        'surface-events',
        'session.completed',
        expect.any(Object)
      );
    });

    expect(Bus.publish).toHaveBeenCalledWith('surface-events', 'turn.started', {
      turn: 2,
      maxTurns: 8,
    });
    expect(Bus.publish).toHaveBeenCalledWith(
      'surface-events',
      'compaction.started',
      {}
    );
    expect(Bus.publish).toHaveBeenCalledWith(
      'surface-events',
      'compaction.completed',
      {}
    );
    expect(Bus.publish).toHaveBeenCalledWith('surface-events', 'model.fallback', {});
    expect(Bus.publish).not.toHaveBeenCalledWith(
      'surface-events',
      'message.created',
      expect.objectContaining({ messageId: 'already-persisted' })
    );
    expect(Bus.publish).toHaveBeenCalledWith(
      'surface-events',
      'message.created',
      expect.objectContaining({
        messageId: 'not-yet-persisted',
        recovered: true,
      })
    );
    expect(Bus.publish).toHaveBeenCalledWith(
      'surface-events',
      'steering.applied',
      expect.objectContaining({
        messageIds: ['recovered-steer'],
        count: 1,
        recovered: 1,
      })
    );
    expect(Bus.publish).toHaveBeenCalledWith(
      'surface-events',
      'tool.result',
      expect.objectContaining({
        toolCallId: 'tool-failed-without-error-payload',
        success: false,
      })
    );
  });

  it('durably creates a goal before starting a transient goal run', async () => {
    runtimeState.runtime.createGoal.mockResolvedValue(activeGoal);
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const { Bus } = await import('../../../../src/server/bus.js');
    const app = SessionRoutes();

    const response = await app.request('/goal-session/goal', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        objective: 'finish the migration',
        tokenBudget: 1200,
      }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: 'running',
      runId: expect.any(String),
      goal: activeGoal,
    });
    expect(runtimeState.runtime.createGoal).toHaveBeenCalledWith({
      objective: 'finish the migration',
      tokenBudget: 1200,
    });
    await vi.waitFor(() => {
      expect(agentState.chatStream).toHaveBeenCalledWith(
        '',
        expect.objectContaining({ sessionId: 'goal-session' }),
        expect.objectContaining({ goalContinuationOnly: true })
      );
    });
    expect(runtimeState.runtime.prepareInputTurn).not.toHaveBeenCalled();
    expect(Bus.publish).toHaveBeenCalledWith('goal-session', 'goal.updated', {
      goal: activeGoal,
    });
    expect(Bus.publish).not.toHaveBeenCalledWith(
      'goal-session',
      'message.created',
      expect.objectContaining({ role: 'user' })
    );
  });

  it('wakes an active persisted goal when Web SSE reconnects', async () => {
    vi.mocked(SessionRuntime.hasActiveGoal).mockResolvedValue(true);
    runtimeState.runtime.getGoal.mockResolvedValue(activeGoal);
    const { SessionRoutes } = await import('../../../../src/server/routes/session.js');
    const app = SessionRoutes();
    const controller = new AbortController();

    void app.request('/goal-session/events', {
      signal: controller.signal,
    });

    await vi.waitFor(() => {
      expect(agentState.chatStream).toHaveBeenCalledWith(
        '',
        expect.objectContaining({ sessionId: 'goal-session' }),
        expect.objectContaining({
          goalContinuationOnly: true,
          pendingInputOnly: false,
        })
      );
    });
    controller.abort();
  });
});
