import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../../../../src/agent/Agent.js';
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
  });

  it('leaves failed durable input pending without immediate retry', async () => {
    const turnHandle = { id: 'failed-turn' };
    const runtime = {
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
        error: { type: 'api_error', message: 'temporary outage' },
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
  });

  it('starts a durable follow-up turn without a synthetic user message', async () => {
    const firstTurn = { id: 'turn-1' };
    const secondTurn = { id: 'turn-2' };
    const runtime = {
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
});
