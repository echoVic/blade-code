import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../../../../src/agent/Agent.js';
import { taskRunScheduler } from '../../../../src/agent/runtime/TaskRunScheduler.js';
import { type BladeConfig, PermissionMode } from '../../../../src/config/types.js';

function createConfig(overrides: Partial<BladeConfig> = {}): BladeConfig {
  return {
    currentModelId: '',
    models: [],
    temperature: 0,
    maxContextTokens: 200000,
    stream: true,
    topP: 0.9,
    topK: 50,
    timeout: 30000,
    theme: 'dracula',
    uiTheme: 'system',
    language: 'zh-CN',
    fontSize: 14,
    autoSaveSessions: true,
    notifyBuild: false,
    notifyErrors: false,
    notifySounds: false,
    privacyTelemetry: false,
    privacyCrash: true,
    debug: false,
    mcpEnabled: false,
    mcpServers: {},
    permissions: {
      allow: [],
      ask: [],
      deny: [],
    },
    permissionMode: PermissionMode.DEFAULT,
    hooks: {} as BladeConfig['hooks'],
    env: {},
    disableAllHooks: false,
    maxTurns: 20,
    ...overrides,
    maxConcurrentTasks: overrides.maxConcurrentTasks ?? 3,
    maxQueuedTasks: overrides.maxQueuedTasks ?? 100,
  };
}

function createGoalRuntimeMocks() {
  return {
    setTaskStatus: vi.fn().mockResolvedValue(undefined),
    recordGoalProgress: vi.fn().mockResolvedValue(null),
    getGoal: vi.fn().mockResolvedValue(null),
    pauseActiveGoal: vi.fn().mockResolvedValue(null),
  };
}

describe('Agent.create', () => {
  it('rejects session-scoped creation and requires an explicit runtime owner', async () => {
    await expect(Agent.create({ sessionId: 'session-1' })).rejects.toThrow(
      'Agent.create() does not accept sessionId'
    );
  });
});

describe('Agent runLoop system prompt injection', () => {
  it('uses the builder result directly instead of hand-prepending environment', async () => {
    const agent = new Agent(createConfig(), {}, {
      getRegistry: () => ({ getAll: () => [] }),
    } as any);

    const context = {
      messages: [],
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: process.cwd(),
      permissionMode: PermissionMode.DEFAULT,
    };

    (agent as any).buildSystemPromptOnDemand = vi.fn().mockResolvedValue('BASE_PROMPT');

    let receivedSystemPrompt: string | undefined;
    (agent as any).executeLoop = vi.fn(async function* (
      _message: string,
      _context: typeof context,
      _options: unknown,
      systemPrompt?: string
    ) {
      if (Date.now() < 0) {
        yield undefined;
      }
      receivedSystemPrompt = systemPrompt;
      return {
        success: true,
        finalMessage: '',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });

    const result = await (agent as any).runLoop('hello', context).next();

    expect(result.done).toBe(true);
    expect((agent as any).buildSystemPromptOnDemand).toHaveBeenCalledOnce();
    expect(receivedSystemPrompt).toBe('BASE_PROMPT');
  });

  it('owns the SessionRuntime turn mailbox for the full streamed run', async () => {
    const turnHandle = { id: 'turn-1' };
    const runtime = {
      ...createGoalRuntimeMocks(),
      prepareInputTurn: vi.fn(async () => ({
        accepted: true,
        handle: turnHandle,
        messageId: 'input-1',
        queued: 1,
        mode: 'direct',
      })),
      drainSteering: vi.fn(async () => []),
      drainSteeringOrSeal: vi.fn(async () => ({
        messages: [],
        sealed: true,
      })),
      acknowledgeTurn: vi.fn().mockResolvedValue(undefined),
      finishTurn: vi.fn().mockResolvedValue(undefined),
    };
    const agent = new Agent(
      createConfig(),
      {},
      {
        getRegistry: () => ({ getAll: () => [] }),
      } as any,
      runtime as any
    );
    (agent as any).isInitialized = true;
    (agent as any).processAtMentionsForContent = vi.fn().mockResolvedValue('hello');
    (agent as any).runLoop = vi.fn(async function* () {
      if (Date.now() < 0) yield undefined;
      return {
        success: true,
        finalMessage: 'done',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });

    const iterator = agent.chatStream('hello', {
      messages: [],
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: process.cwd(),
    });
    expect(await iterator.next()).toMatchObject({
      done: true,
      value: { success: true, finalMessage: 'done' },
    });

    expect(runtime.prepareInputTurn).toHaveBeenCalledWith('hello');
    expect(runtime.finishTurn).toHaveBeenCalledWith(turnHandle, {
      continuePending: true,
    });
    expect(runtime.acknowledgeTurn).toHaveBeenCalledWith(turnHandle);
    expect(runtime.setTaskStatus).toHaveBeenNthCalledWith(1, 'running');
    expect(runtime.setTaskStatus).toHaveBeenNthCalledWith(2, 'completed', undefined);
  });

  it('serializes task sessions through the shared admission gate', async () => {
    taskRunScheduler.resetForTests();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    const createTaskAgent = (sessionId: string) => {
      const turnHandle = { id: `turn-${sessionId}` };
      const runtime = {
        ...createGoalRuntimeMocks(),
        sessionId,
        workspaceRoot: process.cwd(),
        isTaskSession: vi.fn(() => true),
        getTaskAdmissionLimits: vi.fn(() => ({
          maxConcurrent: 1,
          maxQueued: 10,
        })),
        setTaskAdmission: vi.fn().mockResolvedValue(undefined),
        publishTaskAdmissionCapacity: vi.fn(),
        prepareInputTurn: vi.fn(async () => ({
          accepted: true,
          handle: turnHandle,
          messageId: `input-${sessionId}`,
          queued: 1,
          mode: 'direct',
        })),
        drainSteering: vi.fn(async () => []),
        drainSteeringOrSeal: vi.fn(async () => ({
          messages: [],
          sealed: true,
        })),
        acknowledgeTurn: vi.fn().mockResolvedValue(undefined),
        finishTurn: vi.fn().mockResolvedValue(undefined),
      };
      const agent = new Agent(
        createConfig(),
        {},
        { getRegistry: () => ({ getAll: () => [] }) } as any,
        runtime as any
      );
      (agent as any).isInitialized = true;
      (agent as any).processAtMentionsForContent = vi.fn().mockResolvedValue('run');
      (agent as any).runLoop = vi.fn(async function* () {
        if (Date.now() < 0) yield undefined;
        started.push(sessionId);
        if (sessionId === 'task-first') await firstGate;
        return {
          success: true,
          finalMessage: 'done',
          metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
        };
      });
      return { agent, runtime };
    };
    const first = createTaskAgent('task-first');
    const second = createTaskAgent('task-second');

    try {
      const firstResult = first.agent
        .chatStream('run', {
          messages: [],
          userId: 'user-1',
          sessionId: 'task-first',
          workspaceRoot: process.cwd(),
        })
        .next();
      await vi.waitFor(() => expect(started).toEqual(['task-first']));

      const secondResult = second.agent
        .chatStream('run', {
          messages: [],
          userId: 'user-1',
          sessionId: 'task-second',
          workspaceRoot: process.cwd(),
        })
        .next();
      await vi.waitFor(() =>
        expect(second.runtime.setTaskAdmission).toHaveBeenCalledWith(
          expect.objectContaining({
            state: 'queued',
            queuePosition: 1,
          })
        )
      );
      expect(started).toEqual(['task-first']);

      releaseFirst();
      await expect(firstResult).resolves.toMatchObject({
        done: true,
        value: { success: true },
      });
      await expect(secondResult).resolves.toMatchObject({
        done: true,
        value: { success: true },
      });
      expect(started).toEqual(['task-first', 'task-second']);
      expect(first.runtime.publishTaskAdmissionCapacity).toHaveBeenCalledWith(
        'completed'
      );
      expect(second.runtime.publishTaskAdmissionCapacity).toHaveBeenCalledWith(
        'completed'
      );
      expect(taskRunScheduler.getStats()).toMatchObject({
        inFlight: 0,
        queued: 0,
      });
    } finally {
      releaseFirst();
      taskRunScheduler.resetForTests();
    }
  });

  it('uses a caller-prepared durable input without enqueueing it twice', async () => {
    const turnHandle = { id: 'prepared-turn' };
    const preparedInputTurn = {
      handle: turnHandle,
      messageId: 'prepared-input',
      queued: 1,
      mode: 'direct' as const,
    };
    const runtime = {
      ...createGoalRuntimeMocks(),
      prepareInputTurn: vi.fn(),
      drainSteering: vi.fn(async () => []),
      drainSteeringOrSeal: vi.fn(async () => ({
        messages: [],
        sealed: true,
      })),
      acknowledgeTurn: vi.fn().mockResolvedValue(undefined),
      finishTurn: vi.fn().mockResolvedValue(undefined),
    };
    const agent = new Agent(
      createConfig(),
      {},
      {
        getRegistry: () => ({ getAll: () => [] }),
      } as any,
      runtime as any
    );
    (agent as any).isInitialized = true;
    (agent as any).processAtMentionsForContent = vi.fn().mockResolvedValue('hello');
    let receivedOptions: { inputMessageId?: string } | undefined;
    (agent as any).runLoop = vi.fn(async function* (
      _message: string,
      _context: unknown,
      options: { inputMessageId?: string }
    ) {
      if (Date.now() < 0) yield undefined;
      receivedOptions = options;
      return {
        success: true,
        finalMessage: 'done',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });

    const result = await agent
      .chatStream(
        'hello',
        {
          messages: [],
          userId: 'user-1',
          sessionId: 'session-1',
          workspaceRoot: process.cwd(),
        },
        { preparedInputTurn }
      )
      .next();

    expect(result.done).toBe(true);
    expect(runtime.prepareInputTurn).not.toHaveBeenCalled();
    expect(receivedOptions?.inputMessageId).toBe('prepared-input');
    expect(runtime.acknowledgeTurn).toHaveBeenCalledWith(turnHandle);
  });

  it('prepares input before async prompt expansion and releases ownership on failure', async () => {
    const turnHandle = { id: 'expansion-turn' };
    const order: string[] = [];
    const runtime = {
      prepareInputTurn: vi.fn(async () => {
        order.push('prepare');
        return {
          accepted: true,
          handle: turnHandle,
          messageId: 'expansion-input',
          queued: 1,
          mode: 'direct',
        };
      }),
      setTaskStatus: vi.fn().mockResolvedValue(undefined),
      finishTurn: vi.fn().mockResolvedValue(undefined),
    };
    const agent = new Agent(
      createConfig(),
      {},
      {
        getRegistry: () => ({ getAll: () => [] }),
      } as any,
      runtime as any
    );
    (agent as any).isInitialized = true;
    (agent as any).processAtMentionsForContent = vi.fn(async () => {
      order.push('expand');
      throw new Error('attachment unavailable');
    });
    (agent as any).runLoop = vi.fn();

    const next = agent
      .chatStream('@missing.txt', {
        messages: [],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: process.cwd(),
      })
      .next();

    await expect(next).rejects.toThrow('attachment unavailable');
    expect(order).toEqual(['prepare', 'expand']);
    expect(runtime.finishTurn).toHaveBeenCalledWith(turnHandle);
    expect((agent as any).runLoop).not.toHaveBeenCalled();
    expect(runtime.setTaskStatus).toHaveBeenNthCalledWith(1, 'running');
    expect(runtime.setTaskStatus).toHaveBeenNthCalledWith(
      2,
      'failed',
      'attachment unavailable'
    );
  });

  it('leaves failed durable input pending without immediate retry', async () => {
    const turnHandle = { id: 'failed-turn' };
    const runtime = {
      ...createGoalRuntimeMocks(),
      prepareInputTurn: vi.fn(async () => ({
        accepted: true,
        handle: turnHandle,
        messageId: 'failed-input',
        queued: 1,
        mode: 'direct',
      })),
      drainSteering: vi.fn(async () => []),
      drainSteeringOrSeal: vi.fn(async () => ({
        messages: [],
        sealed: true,
      })),
      acknowledgeTurn: vi.fn().mockResolvedValue(undefined),
      finishTurn: vi.fn().mockResolvedValue(undefined),
    };
    const agent = new Agent(
      createConfig(),
      {},
      {
        getRegistry: () => ({ getAll: () => [] }),
      } as any,
      runtime as any
    );
    (agent as any).isInitialized = true;
    (agent as any).processAtMentionsForContent = vi.fn().mockResolvedValue('hello');
    (agent as any).runLoop = vi.fn(async function* () {
      if (Date.now() < 0) yield undefined;
      return {
        success: false,
        error: {
          type: 'api_error',
          message: 'temporary outage apiKey=supersecretvalue123',
        },
        metadata: { turnsCount: 0, toolCallsCount: 0, duration: 0 },
      };
    });

    const result = await agent
      .chatStream('hello', {
        messages: [],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: process.cwd(),
      })
      .next();

    expect(result.done).toBe(true);
    expect((agent as any).runLoop).toHaveBeenCalledOnce();
    expect(runtime.acknowledgeTurn).not.toHaveBeenCalled();
    expect(runtime.finishTurn).toHaveBeenCalledWith(turnHandle, {
      continuePending: false,
    });
    expect(runtime.setTaskStatus).toHaveBeenNthCalledWith(1, 'running');
    expect(runtime.setTaskStatus).toHaveBeenNthCalledWith(
      2,
      'failed',
      'temporary outage apiKey=[REDACTED]'
    );
  });

  it('persists cancellation when the active signal is aborted', async () => {
    const turnHandle = { id: 'cancelled-turn' };
    const runtime = {
      ...createGoalRuntimeMocks(),
      prepareInputTurn: vi.fn(async () => ({
        accepted: true,
        handle: turnHandle,
        messageId: 'cancelled-input',
        queued: 1,
        mode: 'direct',
      })),
      drainSteering: vi.fn(async () => []),
      drainSteeringOrSeal: vi.fn(async () => ({
        messages: [],
        sealed: true,
      })),
      acknowledgeTurn: vi.fn().mockResolvedValue(undefined),
      finishTurn: vi.fn().mockResolvedValue(undefined),
    };
    const agent = new Agent(
      createConfig(),
      {},
      { getRegistry: () => ({ getAll: () => [] }) } as any,
      runtime as any
    );
    (agent as any).isInitialized = true;
    (agent as any).processAtMentionsForContent = vi.fn().mockResolvedValue('stop');
    (agent as any).runLoop = vi.fn(async function* () {
      if (Date.now() < 0) yield undefined;
      return {
        success: true,
        finalMessage: '',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });
    const controller = new AbortController();
    controller.abort();

    await agent
      .chatStream('stop', {
        messages: [],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: process.cwd(),
        signal: controller.signal,
      })
      .next();

    expect(runtime.setTaskStatus).toHaveBeenNthCalledWith(1, 'running');
    expect(runtime.setTaskStatus).toHaveBeenNthCalledWith(2, 'cancelled', undefined);
  });

  it('persists interruption when a stream consumer closes before completion', async () => {
    const turnHandle = { id: 'interrupted-turn' };
    const runtime = {
      ...createGoalRuntimeMocks(),
      prepareInputTurn: vi.fn(async () => ({
        accepted: true,
        handle: turnHandle,
        messageId: 'interrupted-input',
        queued: 1,
        mode: 'direct',
      })),
      drainSteering: vi.fn(async () => []),
      drainSteeringOrSeal: vi.fn(async () => ({
        messages: [],
        sealed: true,
      })),
      acknowledgeTurn: vi.fn().mockResolvedValue(undefined),
      finishTurn: vi.fn().mockResolvedValue(undefined),
    };
    const agent = new Agent(
      createConfig(),
      {},
      { getRegistry: () => ({ getAll: () => [] }) } as any,
      runtime as any
    );
    (agent as any).isInitialized = true;
    (agent as any).processAtMentionsForContent = vi.fn().mockResolvedValue('partial');
    (agent as any).runLoop = vi.fn(async function* () {
      yield { kind: 'content_delta' as const, delta: 'partial' };
      return {
        success: true,
        finalMessage: 'done',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });
    const stream = agent.chatStream('partial', {
      messages: [],
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: process.cwd(),
    });

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { kind: 'content_delta', delta: 'partial' },
    });
    await stream.return({
      success: true,
      finalMessage: '',
      metadata: { turnsCount: 0, toolCallsCount: 0, duration: 0 },
    });

    expect(runtime.setTaskStatus).toHaveBeenNthCalledWith(1, 'running');
    expect(runtime.setTaskStatus).toHaveBeenNthCalledWith(
      2,
      'interrupted',
      'Task stream closed before completion'
    );
  });

  it('starts a durable follow-up turn without a synthetic user message', async () => {
    const firstTurn = { id: 'turn-1' };
    const secondTurn = { id: 'turn-2' };
    const runtime = {
      ...createGoalRuntimeMocks(),
      prepareInputTurn: vi.fn(async () => ({
        accepted: true,
        handle: firstTurn,
        messageId: 'input-1',
        queued: 1,
        mode: 'direct',
      })),
      drainSteering: vi.fn(async () => []),
      drainSteeringOrSeal: vi.fn(async () => ({
        messages: [],
        sealed: true,
      })),
      acknowledgeTurn: vi.fn().mockResolvedValue(undefined),
      finishTurn: vi
        .fn()
        .mockResolvedValueOnce(secondTurn)
        .mockResolvedValueOnce(undefined),
      getPendingSteeringCount: vi.fn(() => 1),
      getRecoveredSteeringCount: vi.fn(() => 1),
      getPendingSteeringMessages: vi.fn(() => []),
    };
    const agent = new Agent(
      createConfig(),
      {},
      {
        getRegistry: () => ({ getAll: () => [] }),
      } as any,
      runtime as any
    );
    (agent as any).isInitialized = true;
    (agent as any).processAtMentionsForContent = vi.fn().mockResolvedValue('hello');
    const calls: Array<{ message: string; pendingInputOnly: boolean }> = [];
    (agent as any).runLoop = vi.fn(async function* (
      message: string,
      _context: unknown,
      options: { pendingInputOnly?: boolean }
    ) {
      if (Date.now() < 0) yield undefined;
      calls.push({
        message,
        pendingInputOnly: options.pendingInputOnly === true,
      });
      return {
        success: true,
        finalMessage: options.pendingInputOnly ? 'follow-up' : 'initial',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });

    const events = [];
    const iterator = agent.chatStream('hello', {
      messages: [],
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: process.cwd(),
    });
    let step = await iterator.next();
    while (!step.done) {
      events.push(step.value);
      step = await iterator.next();
    }

    expect(calls).toEqual([
      { message: 'hello', pendingInputOnly: false },
      { message: '', pendingInputOnly: true },
    ]);
    expect(events).toContainEqual({
      kind: 'follow_up_started',
      queued: 1,
      recovered: 1,
      messages: [],
    });
    expect(step.value).toMatchObject({
      success: true,
      finalMessage: 'follow-up',
    });
    expect(runtime.acknowledgeTurn).toHaveBeenNthCalledWith(1, firstTurn);
    expect(runtime.acknowledgeTurn).toHaveBeenNthCalledWith(2, secondTurn);
  });

  it('queues a new prompt behind durable input before starting an idle turn', async () => {
    const pendingTurn = { id: 'pending-turn' };
    const runtime = {
      ...createGoalRuntimeMocks(),
      prepareInputTurn: vi.fn().mockResolvedValue({
        accepted: true,
        handle: pendingTurn,
        messageId: 'newer-durable',
        queued: 2,
        mode: 'pending',
      }),
      drainSteering: vi.fn(async () => []),
      drainSteeringOrSeal: vi.fn(async () => ({
        messages: [],
        sealed: true,
      })),
      acknowledgeTurn: vi.fn().mockResolvedValue(undefined),
      finishTurn: vi.fn().mockResolvedValue(undefined),
      getPendingSteeringCount: vi.fn(() => 2),
      getRecoveredSteeringCount: vi.fn(() => 1),
      getPendingSteeringMessages: vi.fn(() => [
        {
          id: 'older-durable',
          content: 'older',
          queuedAt: Date.now(),
          recovered: true,
        },
        {
          id: 'newer-durable',
          content: 'newer',
          queuedAt: Date.now(),
          recovered: false,
        },
      ]),
    };
    const agent = new Agent(
      createConfig(),
      {},
      {
        getRegistry: () => ({ getAll: () => [] }),
      } as any,
      runtime as any
    );
    (agent as any).isInitialized = true;
    (agent as any).processAtMentionsForContent = vi.fn().mockResolvedValue('newer');
    (agent as any).runLoop = vi.fn(async function* (
      message: string,
      _context: unknown,
      options: { pendingInputOnly?: boolean }
    ) {
      if (Date.now() < 0) yield undefined;
      expect(message).toBe('');
      expect(options.pendingInputOnly).toBe(true);
      return {
        success: true,
        finalMessage: 'ordered',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });

    const iterator = agent.chatStream('newer', {
      messages: [
        {
          role: 'user',
          content: 'older',
          metadata: { inboxMessageId: 'older-durable' },
        },
      ],
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: process.cwd(),
    });
    const events = [];
    let step = await iterator.next();
    while (!step.done) {
      events.push(step.value);
      step = await iterator.next();
    }

    expect(runtime.prepareInputTurn).toHaveBeenCalledWith('newer');
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'follow_up_started',
        messages: expect.arrayContaining([
          expect.objectContaining({
            id: 'older-durable',
            persisted: true,
          }),
        ]),
      })
    );
  });

  it('lets the model continue an active goal beyond 20 turns until it reaches a terminal state', async () => {
    const totalContinuations = 21;
    const makeGoal = (status: 'active' | 'complete', continuationCount: number) => ({
      version: 1 as const,
      sessionId: 'session-1',
      goalId: 'goal-1',
      objective: 'finish the migration',
      status,
      tokensUsed: continuationCount * 100,
      timeUsedSeconds: continuationCount,
      continuationCount,
      createdAt: '2026-08-04T00:00:00.000Z',
      updatedAt: '2026-08-04T00:00:00.000Z',
    });
    let claimedContinuations = 0;
    let completedContinuations = 0;
    const runtime = {
      beginTurn: vi.fn(() => ({
        id: `goal-turn-${claimedContinuations + 1}`,
      })),
      setTaskStatus: vi.fn().mockResolvedValue(undefined),
      beginGoalContinuation: vi.fn(async () => {
        claimedContinuations++;
        return makeGoal('active', claimedContinuations);
      }),
      getGoal: vi.fn(async () =>
        makeGoal(
          completedContinuations === totalContinuations ? 'complete' : 'active',
          completedContinuations
        )
      ),
      recordGoalProgress: vi.fn(async () => {
        completedContinuations++;
        return makeGoal(
          completedContinuations === totalContinuations ? 'complete' : 'active',
          completedContinuations
        );
      }),
      pauseActiveGoal: vi.fn().mockResolvedValue(null),
      acknowledgeTurn: vi.fn().mockResolvedValue(undefined),
      finishTurn: vi.fn().mockResolvedValue(undefined),
      drainSteering: vi.fn().mockResolvedValue([]),
      drainSteeringOrSeal: vi.fn().mockResolvedValue({
        messages: [],
        sealed: true,
      }),
      prepareInputTurn: vi.fn(),
    };
    const agent = new Agent(
      createConfig(),
      {},
      { getRegistry: () => ({ getAll: () => [] }) } as any,
      runtime as any
    );
    (agent as any).isInitialized = true;
    const optionsSeen: Array<Record<string, unknown>> = [];
    (agent as any).runLoop = vi.fn(async function* (
      message: string,
      _context: unknown,
      options: Record<string, unknown>
    ) {
      optionsSeen.push(options);
      expect(message).toContain('finish the migration');
      if (Date.now() < 0) yield undefined;
      return {
        success: true,
        finalMessage: 'progress',
        metadata: {
          turnsCount: 1,
          toolCallsCount: 0,
          duration: 1_000,
          tokensUsed: 100,
        },
      };
    });

    const events = [];
    const stream = agent.chatStream(
      '',
      {
        messages: [],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: process.cwd(),
      },
      { goalContinuationOnly: true }
    );
    let next;
    while (!(next = await stream.next()).done) {
      events.push(next.value);
    }

    expect(runtime.prepareInputTurn).not.toHaveBeenCalled();
    expect(runtime.beginGoalContinuation).toHaveBeenCalledTimes(totalContinuations);
    expect(optionsSeen).toHaveLength(totalContinuations);
    expect(
      optionsSeen.every((options) => options.transientInput === 'goal_continuation')
    ).toBe(true);
    expect(
      events.filter((event) => event.kind === 'goal_continuation_started')
    ).toHaveLength(totalContinuations);
    expect(next.value).toMatchObject({ success: true });
  });
});
