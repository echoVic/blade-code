import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../../../../src/agent/Agent.js';
import type { SessionRuntime } from '../../../../src/agent/runtime/SessionRuntime.js';
import { taskRunScheduler } from '../../../../src/agent/runtime/TaskRunScheduler.js';
import type { UserMessageContent } from '../../../../src/agent/types.js';
import { type BladeConfig, PermissionMode } from '../../../../src/config/types.js';
import type { MessagePersistenceMetadata } from '../../../../src/context/types.js';
import * as promptBuilder from '../../../../src/prompts/index.js';
import { SessionService } from '../../../../src/services/SessionService.js';
import type { ToolExecutor } from '../../../../src/tools/execution/ToolExecutor.js';

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
    codeTheme: 'dracula',
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
    lspServers: overrides.lspServers ?? {},
    modelProviders: overrides.modelProviders ?? {},
    enabledPlugins: overrides.enabledPlugins ?? {},
    pluginSourcePolicy: overrides.pluginSourcePolicy ?? {
      restrictToAllowedSources: false,
      requireGitCommitSha: false,
      allowedGitHosts: [],
      allowedMarketplaces: [],
      allowedLocalRoots: [],
    },
    maxConcurrentTasks: overrides.maxConcurrentTasks ?? 3,
    maxQueuedTasks: overrides.maxQueuedTasks ?? 100,
    maxQueuedTaskBytes: overrides.maxQueuedTaskBytes ?? 64 * 1024 * 1024,
    maxResidentSessionRuntimes: overrides.maxResidentSessionRuntimes ?? 32,
    sessionRuntimeIdleMs: overrides.sessionRuntimeIdleMs ?? 5 * 60 * 1000,
  };
}

function createGoalRuntimeMocks() {
  return {
    getAgentResources: vi.fn(() => ({
      projectRoot: process.cwd(),
      subagents: {},
      skills: {
        generateAvailableSkillsList: () => '',
      },
      commands: {},
    })),
    setTaskStatus: vi.fn().mockResolvedValue(undefined),
    recordGoalProgress: vi.fn().mockResolvedValue(null),
    getGoal: vi.fn().mockResolvedValue(null),
    pauseActiveGoal: vi.fn().mockResolvedValue(null),
    loadModelContext: vi.fn().mockResolvedValue([]),
    materializeUserMessage: vi.fn(
      async (content: UserMessageContent, metadata?: MessagePersistenceMetadata) => ({
        content,
        metadata,
        offloaded: false,
      })
    ),
    restoreUserMessage: vi.fn(async (content: UserMessageContent) => content),
    getPendingSteeringMessages: vi.fn(() => []),
    getTurnRecoveryAssessment: vi.fn(() => ({ state: 'none' as const })),
    takeStartupTurnRecoveryAssessment: vi.fn(() => ({ state: 'none' as const })),
    takeStartupAdoptedToolResults: vi.fn(() => []),
    waitForBackgroundSubagentFollowUp: vi.fn().mockResolvedValue(false),
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

  it('keeps dynamic git and directory snapshots out of root prompt variants', async () => {
    const buildSystemPrompt = vi
      .spyOn(promptBuilder, 'buildSystemPrompt')
      .mockResolvedValue({ prompt: 'CACHE_STABLE_PROMPT', sources: [] });
    const agent = new Agent(createConfig(), {}, {
      getRegistry: () => ({ getAll: () => [] }),
    } as any);
    const context = {
      messages: [],
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: '/workspace',
      permissionMode: PermissionMode.PLAN,
    };
    (agent as any).executeLoop = vi.fn(async function* () {
      if (Date.now() < 0) yield undefined;
      return {
        success: true,
        finalMessage: '',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });

    try {
      await (agent as any).buildSystemPromptOnDemand('/workspace');
      await (agent as any).runPlanLoop('plan this', context).next();
      expect(buildSystemPrompt).toHaveBeenCalledTimes(2);
      for (const [options] of buildSystemPrompt.mock.calls) {
        expect(options).toMatchObject({
          includeEnvironment: true,
          environmentOptions: {
            includeGitSnapshot: false,
            includeDirectoryListing: false,
          },
        });
      }
    } finally {
      buildSystemPrompt.mockRestore();
    }
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
      outcome: {
        status: 'completed',
        turnsCount: 1,
        toolCallsCount: 0,
        durationMs: 0,
      },
    });
    expect(runtime.acknowledgeTurn).not.toHaveBeenCalled();
    expect(runtime.setTaskStatus).toHaveBeenNthCalledWith(1, 'running');
    expect(runtime.setTaskStatus).toHaveBeenNthCalledWith(2, 'completed', undefined);
  });

  it('aborts and settles an active stream before destroy disposes tools', async () => {
    const turnHandle = { id: 'shutdown-turn' };
    let releaseTurn!: () => void;
    const turnBarrier = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let observedAbortReason: unknown;
    const runtime = {
      ...createGoalRuntimeMocks(),
      prepareInputTurn: vi.fn(async () => ({
        accepted: true,
        handle: turnHandle,
        messageId: 'shutdown-input',
        queued: 1,
        mode: 'direct',
      })),
      drainSteering: vi.fn(async () => []),
      drainSteeringOrSeal: vi.fn(async () => ({
        messages: [],
        sealed: true,
      })),
      finishTurn: vi.fn(async () => {
        await turnBarrier;
        return undefined;
      }),
    };
    const toolExecutor = {
      getRegistry: () => ({ getAll: () => [] }),
      dispose: vi.fn(),
    };
    const agent = new Agent(
      createConfig(),
      {},
      toolExecutor as unknown as ToolExecutor,
      runtime as unknown as SessionRuntime
    );
    (agent as any).isInitialized = true;
    (agent as any).processAtMentionsForContent = vi.fn().mockResolvedValue('shutdown');
    (agent as any).runLoop = vi.fn(async function* (
      _message: string,
      context: { signal?: AbortSignal }
    ) {
      yield { kind: 'content_delta' as const, delta: 'started' };
      await new Promise<void>((resolve) => {
        const finish = () => {
          observedAbortReason = context.signal?.reason;
          resolve();
        };
        context.signal?.addEventListener('abort', finish, { once: true });
        if (context.signal?.aborted) finish();
      });
      return {
        success: false,
        error: { type: 'aborted' as const, message: 'shutdown' },
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });
    const caller = new AbortController();
    const stream = agent.chatStream('shutdown', {
      messages: [],
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: process.cwd(),
      signal: caller.signal,
    });

    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { kind: 'content_delta', delta: 'started' },
    });
    const completion = stream.next();
    let destroySettled = false;
    const destroy = agent.destroy().then(() => {
      destroySettled = true;
    });

    await Promise.resolve();
    expect(observedAbortReason).toBe('agent-destroy');
    expect(destroySettled).toBe(false);
    expect(toolExecutor.dispose).not.toHaveBeenCalled();

    releaseTurn();
    await expect(completion).resolves.toMatchObject({
      done: true,
      value: { success: false, error: { type: 'aborted' } },
    });
    await expect(destroy).resolves.toBeUndefined();
    expect(runtime.finishTurn).toHaveBeenCalledWith(turnHandle, {
      continuePending: false,
      outcome: {
        status: 'aborted',
        cause: 'cancelled',
        turnsCount: 1,
        toolCallsCount: 0,
        durationMs: 0,
      },
    });
    expect(toolExecutor.dispose).toHaveBeenCalledOnce();

    await expect(
      agent
        .chatStream('late', {
          messages: [],
          userId: 'user-1',
          sessionId: 'session-1',
          workspaceRoot: process.cwd(),
        })
        .next()
    ).rejects.toThrow('Active operation gate is closed');
  });

  it('waits for a background subagent completion and chains its durable follow-up', async () => {
    const firstTurn = { id: 'background-parent-turn' };
    const completionTurn = { id: 'background-completion-turn' };
    const completionMessage = {
      id: 'background-subagent-completion:agent-background-child',
      content:
        '<background-subagent-completion>{"result":"BACKGROUND_CHILD_MARKER"}</background-subagent-completion>',
      queuedAt: 2,
      recovered: false,
      persisted: true,
      origin: 'background_subagent' as const,
      metadata: {
        clientVisible: false,
        backgroundSubagentCompletion: {
          childSessionId: 'agent-background-child',
        },
      },
    };
    const runtime = {
      ...createGoalRuntimeMocks(),
      prepareInputTurn: vi.fn(async () => ({
        accepted: true,
        handle: firstTurn,
        messageId: 'background-parent-input',
        queued: 1,
        mode: 'direct',
      })),
      drainSteering: vi.fn(async (handle: { id: string }) =>
        handle.id === completionTurn.id ? [completionMessage] : []
      ),
      drainSteeringOrSeal: vi.fn(async () => ({
        messages: [],
        sealed: true,
      })),
      finishTurn: vi
        .fn()
        .mockResolvedValueOnce(completionTurn)
        .mockResolvedValueOnce(undefined),
      waitForBackgroundSubagentFollowUp: vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      getPendingSteeringCount: vi.fn(() => 1),
      getRecoveredSteeringCount: vi.fn(() => 0),
      getPendingSteeringMessages: vi.fn(() => [completionMessage]),
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
    (agent as any).processAtMentionsForContent = vi.fn(
      async (content: unknown) => content
    );
    (agent as any).runLoop = vi
      .fn()
      .mockImplementationOnce(async function* () {
        if (Date.now() < 0) yield undefined;
        return {
          success: true,
          finalMessage: 'Parent work is complete; waiting for the child.',
          metadata: { turnsCount: 1, toolCallsCount: 1, duration: 10 },
        };
      })
      .mockImplementationOnce(async function* (_message: string) {
        if (Date.now() < 0) yield undefined;
        return {
          success: true,
          finalMessage: 'Integrated BACKGROUND_CHILD_MARKER.',
          metadata: { turnsCount: 1, toolCallsCount: 0, duration: 5 },
        };
      });

    const events = [];
    const stream = agent.chatStream('Launch the background child.', {
      messages: [],
      userId: 'user-1',
      sessionId: 'background-parent-session',
      workspaceRoot: process.cwd(),
    });
    let step = await stream.next();
    while (!step.done) {
      events.push(step.value);
      step = await stream.next();
    }

    expect(step.value).toMatchObject({
      success: true,
      finalMessage: 'Integrated BACKGROUND_CHILD_MARKER.',
    });
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'follow_up_started',
        messages: [expect.objectContaining({ id: completionMessage.id })],
      }),
    ]);
    expect(runtime.waitForBackgroundSubagentFollowUp).toHaveBeenCalledTimes(2);
    expect(
      runtime.waitForBackgroundSubagentFollowUp.mock.invocationCallOrder[0]
    ).toBeLessThan(runtime.finishTurn.mock.invocationCallOrder[0]!);
    expect((agent as any).runLoop).toHaveBeenCalledTimes(2);
  });

  it('persists an approved Plan mode transition before notifying or executing', async () => {
    const turnHandle = { id: 'plan-turn' };
    const order: string[] = [];
    const runtime = {
      ...createGoalRuntimeMocks(),
      workspaceRoot: '/workspace',
      prepareInputTurn: vi.fn(async () => ({
        accepted: true,
        handle: turnHandle,
        messageId: 'plan-input',
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
    const persist = vi
      .spyOn(SessionService, 'setSessionPermissionMode')
      .mockImplementation(async (_sessionId, _workspaceRoot, permissionMode) => {
        order.push(`persist:${permissionMode}`);
        return {} as never;
      });
    const agent = new Agent(
      createConfig({ permissionMode: PermissionMode.PLAN }),
      {},
      {
        getRegistry: () => ({ getAll: () => [] }),
      } as any,
      runtime as any
    );
    (agent as any).isInitialized = true;
    (agent as any).processAtMentionsForContent = vi.fn().mockResolvedValue('execute');
    (agent as any).runPlanLoop = vi.fn(async function* () {
      if (Date.now() < 0) yield undefined;
      return {
        success: true,
        finalMessage: '',
        metadata: {
          turnsCount: 1,
          toolCallsCount: 1,
          duration: 0,
          targetMode: PermissionMode.AUTO_EDIT,
          planContent: 'Apply the approved change.',
        },
      };
    });
    (agent as any).runLoop = vi.fn(async function* () {
      order.push('execute');
      if (Date.now() < 0) yield undefined;
      return {
        success: true,
        finalMessage: 'done',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });

    const result = await agent
      .chatStream('execute', {
        messages: [],
        userId: 'user-1',
        sessionId: 'session-1',
        workspaceRoot: '/workspace',
        permissionMode: PermissionMode.PLAN,
        onPermissionModeChange: async (permissionMode) => {
          order.push(`surface:${permissionMode}`);
        },
      })
      .next();

    expect(result).toMatchObject({
      done: true,
      value: { success: true, finalMessage: 'done' },
    });
    expect(order).toEqual(['persist:autoEdit', 'surface:autoEdit', 'execute']);
    expect(persist).toHaveBeenCalledWith(
      'session-1',
      '/workspace',
      PermissionMode.AUTO_EDIT
    );
    persist.mockRestore();
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
          maxQueuedBytes: 64 * 1024 * 1024,
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
      expect(taskRunScheduler.getStats().pendingBytes).toBeGreaterThan(0);

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
        pendingBytes: 0,
      });
    } finally {
      releaseFirst();
      taskRunScheduler.resetForTests();
    }
  });

  it('weights recovered task inbox content instead of the empty resume message', async () => {
    taskRunScheduler.resetForTests();
    const held = taskRunScheduler.admit({
      key: 'held-task',
      maxConcurrent: 1,
      maxQueued: 10,
      maxQueuedBytes: 64 * 1024,
      pendingBytes: 1,
    });
    const runtime = {
      ...createGoalRuntimeMocks(),
      sessionId: 'recovered-task',
      workspaceRoot: process.cwd(),
      isTaskSession: vi.fn(() => true),
      getTaskAdmissionLimits: vi.fn(() => ({
        maxConcurrent: 1,
        maxQueued: 10,
        maxQueuedBytes: 64 * 1024,
      })),
      getPendingSteeringMessages: vi.fn(() => [
        {
          id: 'recovered-input',
          content: '界'.repeat(30_000),
          queuedAt: 1,
          recovered: true,
        },
      ]),
      setTaskAdmission: vi.fn().mockResolvedValue(undefined),
      publishTaskAdmissionCapacity: vi.fn(),
    };
    const agent = new Agent(
      createConfig(),
      {},
      { getRegistry: () => ({ getAll: () => [] }) } as any,
      runtime as any
    );
    (agent as any).isInitialized = true;
    (agent as any).runLoop = vi.fn();

    try {
      await expect(
        agent
          .chatStream(
            '',
            {
              messages: [],
              userId: 'user-1',
              sessionId: 'recovered-task',
              workspaceRoot: process.cwd(),
            },
            { pendingInputOnly: true }
          )
          .next()
      ).rejects.toMatchObject({
        name: 'TaskAdmissionQueueFullError',
        resource: 'pending_bytes',
      });
      expect(runtime.getPendingSteeringMessages).toHaveBeenCalled();
      expect(runtime.setTaskStatus).toHaveBeenCalledWith(
        'failed',
        expect.objectContaining({
          resource: 'pending_bytes',
        })
      );
      expect((agent as any).runLoop).not.toHaveBeenCalled();
      expect(taskRunScheduler.getStats().pendingBytes).toBe(0);
    } finally {
      (await held.ready).release();
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
    expect(runtime.acknowledgeTurn).not.toHaveBeenCalled();
  });

  it('prepares input before async prompt expansion and releases ownership on failure', async () => {
    const turnHandle = { id: 'expansion-turn' };
    const order: string[] = [];
    const runtime = {
      ...createGoalRuntimeMocks(),
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
    expect(runtime.finishTurn).toHaveBeenCalledWith(turnHandle, {
      outcome: {
        status: 'aborted',
        cause: 'failed',
        turnsCount: 0,
        toolCallsCount: 0,
        durationMs: 0,
      },
    });
    expect((agent as any).runLoop).not.toHaveBeenCalled();
    expect(runtime.setTaskStatus).toHaveBeenNthCalledWith(1, 'running');
    expect(runtime.setTaskStatus).toHaveBeenNthCalledWith(
      2,
      'failed',
      expect.objectContaining({ message: 'attachment unavailable' })
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
      outcome: {
        status: 'aborted',
        cause: 'failed',
        turnsCount: 0,
        toolCallsCount: 0,
        durationMs: 0,
      },
    });
    expect(runtime.setTaskStatus).toHaveBeenNthCalledWith(1, 'running');
    expect(runtime.setTaskStatus).toHaveBeenNthCalledWith(
      2,
      'failed',
      expect.objectContaining({
        type: 'api_error',
        message: 'temporary outage apiKey=supersecretvalue123',
      })
    );
  });

  it('acknowledges terminal Provider queue rejection instead of replaying it', async () => {
    const turnHandle = { id: 'provider-rejected-turn' };
    const runtime = {
      ...createGoalRuntimeMocks(),
      prepareInputTurn: vi.fn(async () => ({
        accepted: true,
        handle: turnHandle,
        messageId: 'provider-rejected-input',
        queued: 1,
        mode: 'direct',
      })),
      drainSteering: vi.fn(async () => []),
      drainSteeringOrSeal: vi.fn(async () => ({
        messages: [],
        sealed: true,
      })),
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
    const { ProviderAdmissionError } = await import(
      '../../../../src/services/pi/providerRequestAdmission.js'
    );
    const rejection = new ProviderAdmissionError(
      'queue_full',
      'global',
      'foreground',
      'pending_bytes',
      1,
      1,
      0,
      120_000
    );
    (agent as any).runLoop = vi.fn(async function* () {
      if (Date.now() < 0) yield undefined;
      return {
        success: false,
        error: {
          type: 'api_error',
          message: rejection.message,
          details: rejection,
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
    expect(runtime.finishTurn).toHaveBeenCalledWith(turnHandle, {
      continuePending: false,
      acknowledgeInput: true,
      outcome: {
        status: 'aborted',
        cause: 'failed',
        turnsCount: 0,
        toolCallsCount: 0,
        durationMs: 0,
      },
    });
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
    expect(runtime.acknowledgeTurn).not.toHaveBeenCalled();
    expect(runtime.finishTurn).toHaveBeenNthCalledWith(1, firstTurn, {
      continuePending: true,
      outcome: {
        status: 'completed',
        turnsCount: 1,
        toolCallsCount: 0,
        durationMs: 0,
      },
    });
    expect(runtime.finishTurn).toHaveBeenNthCalledWith(2, secondTurn, {
      continuePending: true,
      outcome: {
        status: 'completed',
        turnsCount: 1,
        toolCallsCount: 0,
        durationMs: 0,
      },
    });
  });

  it('replaces stale caller context after runtime recovery before pending input', async () => {
    const turn = { id: 'recovered-turn' };
    const runtime = {
      ...createGoalRuntimeMocks(),
      sessionId: 'recovered-session',
      workspaceRoot: '/workspace/recovered',
      beginPendingTurn: vi.fn().mockResolvedValue(turn),
      drainSteering: vi.fn(async () => []),
      drainSteeringOrSeal: vi.fn(async () => ({
        messages: [],
        sealed: true,
      })),
      finishTurn: vi.fn().mockResolvedValue(undefined),
      getPendingSteeringCount: vi.fn(() => 1),
      getRecoveredSteeringCount: vi.fn(() => 1),
      getPendingSteeringMessages: vi.fn(() => []),
    };
    const agent = new Agent(
      createConfig(),
      {},
      {
        getRegistry: () => ({ getAll: () => [] }),
      } as unknown as ToolExecutor,
      runtime as unknown as SessionRuntime
    );
    const durableContext = [
      {
        role: 'assistant' as const,
        content: 'Process restart receipt',
        metadata: {
          processRestartRecovery: true,
          sideEffectsUncertain: true,
        },
      },
    ];
    runtime.loadModelContext.mockResolvedValue(durableContext);
    const context = {
      messages: [{ role: 'assistant' as const, content: 'stale snapshot' }],
      userId: 'user-1',
      sessionId: 'recovered-session',
      workspaceRoot: '/workspace/recovered',
    };
    const runLoop = vi.fn(async function* (
      message: string,
      loopContext: typeof context,
      options: { pendingInputOnly?: boolean }
    ) {
      if (Date.now() < 0) yield undefined;
      expect(message).toBe('');
      expect(options.pendingInputOnly).toBe(true);
      expect(loopContext.messages).toEqual(durableContext);
      return {
        success: true,
        finalMessage: 'recovered',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });
    Object.assign(agent, { isInitialized: true, runLoop });

    const iterator = agent.chatStream('', context, { pendingInputOnly: true });
    let step = await iterator.next();
    while (!step.done) step = await iterator.next();

    expect(runtime.loadModelContext).toHaveBeenCalledOnce();
    expect(context.messages).toEqual(durableContext);
    expect(step.value).toMatchObject({
      success: true,
      finalMessage: 'recovered',
    });
  });

  it('projects startup-adopted Task results once before the resumed model loop', async () => {
    const turn = { id: 'adopted-result-turn' };
    const marker = 'STARTUP_ADOPTED_CHILD_MARKER';
    const adoptedResults = [
      {
        call: {
          toolCallId: 'task-success',
          messageId: 'assistant-orphaned',
          toolName: 'Task',
          input: {
            description: 'Recover successful child',
            prompt: 'Return the marker.',
            subagent_type: 'Explore',
            subagent_session_id: 'agent-success',
          },
        },
        result: {
          toolCallId: 'task-success',
          toolName: 'Task',
          output: marker,
          metadata: {
            summary: 'Explore 任务完成',
            subagentSessionId: 'agent-success',
            subagentType: 'Explore',
            subagentStatus: 'completed',
            subagentSummary: marker,
            subagentRootId: 'agent-success',
            subagentResumeDepth: 0,
            processRestartRecovery: true,
            subagentResultAdopted: true,
            sideEffectsUncertain: false,
          },
        },
      },
      {
        call: {
          toolCallId: 'task-failed',
          messageId: 'assistant-orphaned',
          toolName: 'Task',
          input: {
            description: 'Recover failed child',
            prompt: 'Report the failure.',
            subagent_type: 'Explore',
            subagent_session_id: 'agent-failed',
          },
        },
        result: {
          toolCallId: 'task-failed',
          toolName: 'Task',
          output: null,
          error: 'durable child failure',
          metadata: {
            summary: 'Explore 任务失败',
            subagentSessionId: 'agent-failed',
            subagentType: 'Explore',
            subagentStatus: 'failed',
            subagentSummary: 'durable child failure',
            subagentRootId: 'agent-failed',
            subagentResumeDepth: 0,
            processRestartRecovery: true,
            subagentResultAdopted: true,
            sideEffectsUncertain: false,
          },
        },
      },
    ];
    const durableContext = [
      {
        role: 'assistant' as const,
        content: marker,
        metadata: {
          processRestartRecovery: true,
          subagentResultAdopted: true,
        },
      },
    ];
    const runtime = {
      ...createGoalRuntimeMocks(),
      sessionId: 'adopted-result-session',
      workspaceRoot: '/workspace/adopted-result',
      beginPendingTurn: vi.fn().mockResolvedValue(turn),
      drainSteering: vi.fn(async () => []),
      drainSteeringOrSeal: vi.fn(async () => ({
        messages: [],
        sealed: true,
      })),
      finishTurn: vi.fn().mockResolvedValue(undefined),
      getPendingSteeringCount: vi.fn(() => 1),
      getRecoveredSteeringCount: vi.fn(() => 1),
      getPendingSteeringMessages: vi.fn(() => []),
      loadModelContext: vi.fn().mockResolvedValue(durableContext),
      getTurnRecoveryAssessment: vi.fn(() => ({
        state: 'requires_attention',
        turnId: 'turn-before-restart',
        inputMessageCount: 1,
        reason: 'interrupted_tool_call',
      })),
      takeStartupTurnRecoveryAssessment: vi
        .fn()
        .mockReturnValueOnce({
          state: 'requires_attention',
          turnId: 'turn-before-restart',
          inputMessageCount: 1,
          reason: 'interrupted_tool_call',
        })
        .mockReturnValue({ state: 'none' }),
      takeStartupAdoptedToolResults: vi
        .fn()
        .mockReturnValueOnce(adoptedResults)
        .mockReturnValue([]),
    };
    const agent = new Agent(
      createConfig(),
      {},
      {
        getRegistry: () => ({ getAll: () => [] }),
      } as unknown as ToolExecutor,
      runtime as unknown as SessionRuntime
    );
    const context = {
      messages: [{ role: 'assistant' as const, content: 'stale running child' }],
      userId: 'user-1',
      sessionId: 'adopted-result-session',
      workspaceRoot: '/workspace/adopted-result',
    };
    const runLoop = vi.fn(async function* (
      _message: string,
      loopContext: typeof context
    ) {
      expect(loopContext.messages).toEqual(durableContext);
      yield { kind: 'turn_start' as const, turn: 1, maxTurns: 20 };
      return {
        success: true,
        finalMessage: 'resumed',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 0 },
      };
    });
    Object.assign(agent, { isInitialized: true, runLoop });

    const collectEvents = async () => {
      const events = [];
      const stream = agent.chatStream('', context, { pendingInputOnly: true });
      let step = await stream.next();
      while (!step.done) {
        events.push(step.value);
        step = await stream.next();
      }
      return { events, result: step.value };
    };
    const first = await collectEvents();
    const second = await collectEvents();
    const firstEvents = first.events;
    const secondEvents = second.events;

    expect(firstEvents.map((event) => event.kind)).toEqual([
      'turn_recovery',
      'tool_result',
      'subagent_completed',
      'tool_result',
      'subagent_completed',
    ]);
    expect(firstEvents[0]).toMatchObject({
      kind: 'turn_recovery',
      assessment: {
        state: 'requires_attention',
        turnId: 'turn-before-restart',
        inputMessageCount: 1,
        reason: 'interrupted_tool_call',
      },
    });
    expect(firstEvents[1]).toMatchObject({
      kind: 'tool_result',
      toolCall: { id: 'task-success', function: { name: 'Task' } },
      result: {
        success: true,
        llmContent: marker,
        metadata: {
          subagentResultAdopted: true,
          sideEffectsUncertain: false,
        },
      },
    });
    expect(firstEvents[2]).toMatchObject({
      kind: 'subagent_completed',
      sessionId: 'agent-success',
      success: true,
      summary: marker,
    });
    expect(firstEvents[3]).toMatchObject({
      kind: 'tool_result',
      toolCall: { id: 'task-failed', function: { name: 'Task' } },
      result: {
        success: false,
        llmContent: 'Subagent execution failed: durable child failure.',
        error: {
          type: 'execution_error',
          message: 'durable child failure',
        },
      },
    });
    expect(firstEvents[4]).toMatchObject({
      kind: 'subagent_completed',
      sessionId: 'agent-failed',
      success: false,
      summary: 'durable child failure',
    });
    expect(secondEvents).toEqual([
      {
        kind: 'turn_recovery',
        assessment: {
          state: 'requires_attention',
          turnId: 'turn-before-restart',
          inputMessageCount: 1,
          reason: 'interrupted_tool_call',
        },
      },
    ]);
    expect(runtime.takeStartupAdoptedToolResults).toHaveBeenCalledTimes(2);
    expect(runtime.getTurnRecoveryAssessment).toHaveBeenCalledTimes(4);
    expect(runtime.takeStartupTurnRecoveryAssessment).not.toHaveBeenCalled();
    expect(runLoop).not.toHaveBeenCalled();
    expect(runtime.beginPendingTurn).not.toHaveBeenCalled();
    expect(first.result.metadata?.recoveryAttention).toEqual({
      state: 'requires_attention',
      turnId: 'turn-before-restart',
      inputMessageCount: 1,
      reason: 'interrupted_tool_call',
    });
    expect(second.result.metadata?.recoveryAttention).toEqual(
      first.result.metadata?.recoveryAttention
    );
    expect(
      runtime.setTaskStatus.mock.calls.some(([status]) => status === 'completed')
    ).toBe(false);
    expect(runtime.setTaskStatus).toHaveBeenCalledWith(
      'interrupted',
      'Turn recovery requires attention: interrupted_tool_call'
    );
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
      loadModelContext: vi.fn().mockResolvedValue([
        {
          role: 'user',
          content: 'older',
          metadata: { inboxMessageId: 'older-durable' },
        },
      ]),
      getTurnRecoveryAssessment: vi.fn(() => ({
        state: 'requires_attention',
        turnId: 'interrupted-older-turn',
        inputMessageCount: 1,
        reason: 'interrupted_tool_call',
      })),
      takeStartupTurnRecoveryAssessment: vi.fn(() => ({
        state: 'requires_attention',
        turnId: 'interrupted-older-turn',
        inputMessageCount: 1,
        reason: 'interrupted_tool_call',
      })),
      acknowledgeStartupTurnRecovery: vi.fn(),
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
    expect(runtime.loadModelContext).toHaveBeenCalledOnce();
    expect(events).toContainEqual({
      kind: 'turn_recovery',
      assessment: {
        state: 'requires_attention',
        turnId: 'interrupted-older-turn',
        inputMessageCount: 1,
        reason: 'interrupted_tool_call',
      },
    });
    expect((agent as any).runLoop).toHaveBeenCalledOnce();
    expect(runtime.acknowledgeStartupTurnRecovery).toHaveBeenCalledOnce();
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

  it('aborts a prepared turn without dropping recovery when acknowledgement fails', async () => {
    const preparedTurn = { id: 'prepared-before-ack-failure' };
    const runtime = {
      ...createGoalRuntimeMocks(),
      prepareInputTurn: vi.fn().mockResolvedValue({
        accepted: true,
        handle: preparedTurn,
        messageId: 'new-input',
        queued: 1,
        mode: 'direct',
      }),
      getTurnRecoveryAssessment: vi.fn(() => ({
        state: 'requires_attention',
        turnId: 'interrupted-turn',
        inputMessageCount: 0,
        reason: 'successful_tool_result',
      })),
      takeStartupTurnRecoveryAssessment: vi.fn(() => ({ state: 'none' })),
      acknowledgeStartupTurnRecovery: vi
        .fn()
        .mockRejectedValue(new Error('recovery acknowledgement fsync failed')),
      finishTurn: vi.fn().mockResolvedValue(undefined),
    };
    const agent = new Agent(
      createConfig(),
      {},
      { getRegistry: () => ({ getAll: () => [] }) } as any,
      runtime as any
    );
    (agent as any).isInitialized = true;
    (agent as any).runLoop = vi.fn();

    const stream = agent.chatStream('continue after inspection', {
      messages: [],
      userId: 'user-1',
      sessionId: 'session-1',
      workspaceRoot: process.cwd(),
    });
    await expect(async () => {
      for await (const _event of stream) {
        // Consume until the acknowledgement failure is surfaced.
      }
    }).rejects.toThrow('recovery acknowledgement fsync failed');
    expect(runtime.finishTurn).toHaveBeenCalledWith(preparedTurn, {
      acknowledgeInput: true,
      preserveStartupRecovery: true,
      outcome: {
        status: 'aborted',
        cause: 'failed',
        turnsCount: 0,
        toolCallsCount: 0,
        durationMs: 0,
      },
    });
    expect((agent as any).runLoop).not.toHaveBeenCalled();
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
      ...createGoalRuntimeMocks(),
      beginTurn: vi.fn(() => ({
        id: `goal-turn-${claimedContinuations + 1}`,
      })),
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

  it('persists a premature stop and injects recovery into the next goal turn', async () => {
    const makeGoal = (
      status: 'active' | 'complete',
      continuationCount: number,
      withRecovery = false
    ) => ({
      version: 1 as const,
      sessionId: 'session-1',
      goalId: 'goal-1',
      objective: 'finish the migration',
      status,
      tokensUsed: continuationCount * 100,
      timeUsedSeconds: continuationCount,
      continuationCount,
      ...(withRecovery
        ? {
            prematureStop: {
              pattern: 'self_deferral' as const,
              consecutiveCount: 1,
              detectedAt: '2026-08-22T00:00:00.000Z',
            },
          }
        : {}),
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
    });
    let completedTurns = 0;
    let claimedTurns = 0;
    const runtime = {
      ...createGoalRuntimeMocks(),
      beginTurn: vi.fn(() => ({ id: `goal-turn-${claimedTurns}` })),
      beginGoalContinuation: vi.fn(async () => {
        claimedTurns++;
        return makeGoal('active', claimedTurns, claimedTurns > 1);
      }),
      getGoal: vi.fn(async () =>
        completedTurns >= 2
          ? makeGoal('complete', 2)
          : makeGoal('active', completedTurns, completedTurns === 1)
      ),
      recordGoalProgress: vi.fn(async () => {
        completedTurns++;
        return completedTurns >= 2
          ? makeGoal('complete', 2)
          : makeGoal('active', 1, true);
      }),
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
    const messages: string[] = [];
    (agent as any).runLoop = vi.fn(async function* (message: string) {
      messages.push(message);
      if (Date.now() < 0) yield undefined;
      return {
        success: true,
        finalMessage:
          messages.length === 1
            ? "I'll check back later."
            : 'Migration completed after recovery.',
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

    expect(runtime.recordGoalProgress).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ prematureStopPattern: 'self_deferral' })
    );
    expect(runtime.recordGoalProgress).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ prematureStopPattern: undefined })
    );
    expect(messages[1]).toContain('Previous turn pattern: self_deferral');
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'goal_continuation_started',
        prematureStopPattern: 'self_deferral',
        prematureStopCount: 1,
      })
    );
    expect(next.value).toMatchObject({ success: true });
  });
});
