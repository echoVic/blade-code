// @vitest-environment jsdom

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createRuntime: vi.fn(),
  createWithRuntime: vi.fn(),
  createAgent: vi.fn(),
  registerCleanup: vi.fn(),
  unregisterCleanup: vi.fn(),
  findSessionMetadata: vi.fn(),
  loadSession: vi.fn(),
  updateSessionMetadata: vi.fn(),
  getCwd: vi.fn(),
}));

vi.mock('../../../../../src/agent/runtime/SessionRuntime.js', () => ({
  SessionRuntime: { create: mocks.createRuntime },
}));

vi.mock('../../../../../src/agent/Agent.js', () => ({
  Agent: {
    createWithRuntime: mocks.createWithRuntime,
    create: mocks.createAgent,
  },
}));

vi.mock('../../../../../src/services/GracefulShutdown.js', () => ({
  registerCleanup: mocks.registerCleanup,
}));

vi.mock('../../../../../src/services/SessionService.js', () => ({
  SessionService: {
    findSessionMetadata: mocks.findSessionMetadata,
    loadSession: mocks.loadSession,
    updateSessionMetadata: mocks.updateSessionMetadata,
  },
}));

vi.mock('../../../../../src/utils/cwd.js', () => ({
  getCwd: mocks.getCwd,
}));

import { useAgent } from '../../../../../src/ui/hooks/useAgent.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function observe<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (error: unknown) => ({ status: 'rejected' as const, error })
  );
}

describe('useAgent runtime ownership', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  let hook: ReturnType<typeof useAgent> | undefined;
  let runtime: {
    sessionId: string;
    workspaceRoot: string;
    getCurrentModelId: ReturnType<typeof vi.fn>;
    getReasoningConfiguration: ReturnType<typeof vi.fn>;
    resolveReasoningConfiguration: ReturnType<typeof vi.fn>;
    getServiceTierConfiguration: ReturnType<typeof vi.fn>;
    resolveServiceTierConfiguration: ReturnType<typeof vi.fn>;
    getResponseVerbosityConfiguration: ReturnType<typeof vi.fn>;
    resolveResponseVerbosityConfiguration: ReturnType<typeof vi.fn>;
    getCommunicationStyleConfiguration: ReturnType<typeof vi.fn>;
    resolveCommunicationStyleConfiguration: ReturnType<typeof vi.fn>;
    hasTurnOwner: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    enqueueSteering: ReturnType<typeof vi.fn>;
    askSideQuestion: ReturnType<typeof vi.fn>;
    listRewindCheckpoints: ReturnType<typeof vi.fn>;
    rewindSession: ReturnType<typeof vi.fn>;
    listSubagents: ReturnType<typeof vi.fn>;
    resumeSubagent: ReturnType<typeof vi.fn>;
  };
  let agent: { destroy: ReturnType<typeof vi.fn> };

  function Harness() {
    hook = useAgent({ sessionId: 'session-1', workspaceRoot: '/tmp/project' });
    return null;
  }

  function ModelHarness() {
    hook = useAgent({
      sessionId: 'session-1',
      workspaceRoot: '/tmp/project',
      modelId: 'model-2',
    });
    return null;
  }

  function AgentsHarness() {
    hook = useAgent({
      sessionId: 'session-1',
      workspaceRoot: '/tmp/project',
      agents: [
        {
          name: 'invocation-reviewer',
          description: 'Invocation-only reviewer',
          source: 'flag',
        },
      ],
    });
    return null;
  }

  function ImplicitWorkspaceHarness() {
    hook = useAgent({ sessionId: 'session-1' });
    return null;
  }

  function WorkspaceHarness({ workspaceRoot }: { workspaceRoot: string }) {
    hook = useAgent({ sessionId: 'session-1', workspaceRoot });
    return null;
  }

  const createRuntimeCandidate = (
    sessionId: string,
    workspaceRoot: string
  ): typeof runtime => ({
    ...runtime,
    sessionId,
    workspaceRoot,
    getCurrentModelId: vi.fn(() => 'model-1'),
    dispose: vi.fn().mockResolvedValue(undefined),
  });

  const createAgentCandidate = (
    destroy: () => Promise<void> = async () => undefined
  ): typeof agent => ({
    destroy: vi.fn(destroy),
  });

  beforeEach(() => {
    runtime = {
      sessionId: 'session-1',
      workspaceRoot: '/tmp/project',
      getCurrentModelId: vi.fn(() => 'model-1'),
      getReasoningConfiguration: vi.fn(() => ({
        selection: 'off',
        effective: 'off',
        supported: ['off', 'low', 'medium', 'high'],
      })),
      resolveReasoningConfiguration: vi.fn((selection: string) => ({
        selection,
        effective: selection === 'auto' ? 'high' : selection,
        supported: ['off', 'low', 'medium', 'high'],
      })),
      getServiceTierConfiguration: vi.fn(() => ({
        selection: 'auto',
        effective: 'provider-default',
        supported: ['standard', 'fast', 'flex'],
      })),
      resolveServiceTierConfiguration: vi.fn((selection: string) => ({
        selection,
        effective: selection === 'auto' ? 'provider-default' : selection,
        supported: ['standard', 'fast', 'flex'],
      })),
      getResponseVerbosityConfiguration: vi.fn(() => ({
        selection: 'auto',
        effective: 'provider-default',
        supported: ['low', 'medium', 'high'],
      })),
      resolveResponseVerbosityConfiguration: vi.fn((selection: string) => ({
        selection,
        effective: selection === 'auto' ? 'provider-default' : selection,
        supported: ['low', 'medium', 'high'],
      })),
      getCommunicationStyleConfiguration: vi.fn(() => ({
        selection: 'auto',
        effective: 'blade-default',
        name: 'Auto',
        description: 'Default',
        source: 'built-in',
        supported: [],
      })),
      resolveCommunicationStyleConfiguration: vi.fn((selection: string) => ({
        selection,
        effective: selection === 'auto' ? 'blade-default' : selection,
        name: selection,
        description: `Use ${selection}`,
        source: selection.includes(':') ? 'project' : 'built-in',
        ...(selection.includes(':') ? { contentSha256: 'a'.repeat(64) } : {}),
        supported: [],
      })),
      hasTurnOwner: vi.fn(() => false),
      refresh: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      enqueueSteering: vi.fn(() => ({
        accepted: true,
        turnId: 'turn-1',
        queued: 1,
      })),
      askSideQuestion: vi.fn().mockResolvedValue({
        response: 'Side answer',
        durationMs: 8,
      }),
      listRewindCheckpoints: vi.fn().mockResolvedValue([
        {
          messageId: 'user-2',
          preview: 'rewind this',
          createdAt: '2026-08-05T00:00:00.000Z',
          fileCount: 1,
        },
      ]),
      rewindSession: vi.fn().mockResolvedValue({
        checkpoint: {
          messageId: 'user-2',
          preview: 'rewind this',
          createdAt: '2026-08-05T00:00:00.000Z',
          fileCount: 1,
        },
        mode: 'conversation',
        removedTurns: 1,
        restoredFiles: [],
        messages: [{ role: 'user', content: 'kept' }],
      }),
      listSubagents: vi.fn(() => [
        {
          id: 'agent-source',
          status: 'completed',
        },
      ]),
      resumeSubagent: vi.fn(() => ({
        source: { id: 'agent-source' },
        session: {
          id: 'agent-child',
          resumedFrom: 'agent-source',
          resumeDepth: 1,
        },
      })),
    };
    agent = { destroy: vi.fn().mockResolvedValue(undefined) };
    mocks.createRuntime.mockResolvedValue(runtime);
    mocks.createWithRuntime.mockResolvedValue(agent);
    mocks.createAgent.mockResolvedValue(agent);
    mocks.registerCleanup.mockReturnValue(mocks.unregisterCleanup);
    mocks.findSessionMetadata.mockResolvedValue({
      selectedModelId: undefined,
    });
    mocks.loadSession.mockResolvedValue([]);
    mocks.updateSessionMetadata.mockResolvedValue({
      selectedModelId: 'model-2',
      reasoningEffort: 'off',
      serviceTier: 'auto',
      responseVerbosity: 'auto',
      communicationStyle: 'auto',
    });
    mocks.getCwd.mockReturnValue('/tmp/project');

    container = document.createElement('div');
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it('destroys the Agent and disposes its SessionRuntime exactly once', async () => {
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    await hook?.createAgent();

    await hook?.cleanupAgent();
    await hook?.cleanupAgent();

    expect(agent.destroy).toHaveBeenCalledTimes(1);
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });

  it('registers runtime cleanup with graceful shutdown', async () => {
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    await hook?.createAgent();

    expect(mocks.registerCleanup).toHaveBeenCalledTimes(1);
    const shutdownCleanup = mocks.registerCleanup.mock.calls[0]?.[0] as
      | (() => Promise<void>)
      | undefined;
    await shutdownCleanup?.();

    expect(agent.destroy).toHaveBeenCalledTimes(1);
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes a late SessionRuntime when unmounted during creation', async () => {
    const runtimeCreation = deferred<typeof runtime>();
    mocks.createRuntime.mockReturnValueOnce(runtimeCreation.promise);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    const creation = observe(hook!.createAgent());
    await vi.waitFor(() => expect(mocks.createRuntime).toHaveBeenCalledOnce());
    act(() => root.unmount());
    runtimeCreation.resolve(runtime);

    const outcome = await creation;
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.error).toMatchObject({ name: 'AbortError' });
    }
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(mocks.createWithRuntime).not.toHaveBeenCalled();
    expect(hook?.agentRef.current).toBeUndefined();
  });

  it('joins graceful cleanup with an in-flight SessionRuntime creation', async () => {
    const runtimeCreation = deferred<typeof runtime>();
    mocks.createRuntime.mockReturnValueOnce(runtimeCreation.promise);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    const shutdownCleanup = mocks.registerCleanup.mock.calls[0]?.[0] as
      | (() => Promise<void>)
      | undefined;
    if (!shutdownCleanup) throw new Error('Expected registered graceful cleanup');

    const creation = observe(hook!.createAgent());
    await vi.waitFor(() => expect(mocks.createRuntime).toHaveBeenCalledOnce());
    let cleanupSettled = false;
    const cleanup = shutdownCleanup().then(() => {
      cleanupSettled = true;
    });
    await Promise.resolve();
    expect(cleanupSettled).toBe(false);

    runtimeCreation.resolve(runtime);
    const outcome = await creation;
    await cleanup;
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.error).toMatchObject({ name: 'AbortError' });
    }
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(mocks.createWithRuntime).not.toHaveBeenCalled();
    await hook!.cleanupAgent();
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });

  it('destroys a late Agent before disposing its Runtime after unmount', async () => {
    const agentCreation = deferred<typeof agent>();
    mocks.createWithRuntime.mockReturnValueOnce(agentCreation.promise);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    const creation = observe(hook!.createAgent());
    await vi.waitFor(() => expect(mocks.createWithRuntime).toHaveBeenCalledOnce());
    act(() => root.unmount());
    agentCreation.resolve(agent);

    const outcome = await creation;
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.error).toMatchObject({ name: 'AbortError' });
    }
    expect(agent.destroy).toHaveBeenCalledOnce();
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(agent.destroy.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.dispose.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(hook?.agentRef.current).toBeUndefined();
  });

  it('commits only the replacement Session when the old Runtime resolves late', async () => {
    const oldRuntime = createRuntimeCandidate('session-1', '/tmp/project');
    const nextRuntime = createRuntimeCandidate('session-2', '/tmp/project');
    const oldRuntimeCreation = deferred<typeof runtime>();
    mocks.createRuntime
      .mockReturnValueOnce(oldRuntimeCreation.promise)
      .mockResolvedValueOnce(nextRuntime);
    const nextAgent = createAgentCandidate();
    mocks.createWithRuntime.mockResolvedValueOnce(nextAgent);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    const oldCreation = observe(hook!.createAgent());
    await vi.waitFor(() => expect(mocks.createRuntime).toHaveBeenCalledOnce());
    const nextCreation = hook!.createAgent({ sessionId: 'session-2' });
    oldRuntimeCreation.resolve(oldRuntime);

    const oldOutcome = await oldCreation;
    const resolvedNextAgent = await nextCreation;
    expect(oldOutcome.status).toBe('rejected');
    if (oldOutcome.status === 'rejected') {
      expect(oldOutcome.error).toMatchObject({ name: 'AbortError' });
    }
    expect(resolvedNextAgent).toBe(nextAgent);
    expect(oldRuntime.dispose).toHaveBeenCalledOnce();
    expect(nextRuntime.dispose).not.toHaveBeenCalled();
    expect(mocks.createWithRuntime).toHaveBeenCalledOnce();
    expect(mocks.createWithRuntime).toHaveBeenCalledWith(
      nextRuntime,
      expect.objectContaining({ sessionId: 'session-2' })
    );
    expect(hook?.agentRef.current).toBe(nextAgent);
  });

  it('destroys the previous completed-turn Agent before creating the next one', async () => {
    const firstAgent = createAgentCandidate();
    const secondAgent = createAgentCandidate();
    mocks.createWithRuntime
      .mockResolvedValueOnce(firstAgent)
      .mockResolvedValueOnce(secondAgent);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    await expect(hook!.createAgent()).resolves.toBe(firstAgent);
    await expect(hook!.createAgent()).resolves.toBe(secondAgent);

    expect(mocks.createRuntime).toHaveBeenCalledOnce();
    expect(firstAgent.destroy).toHaveBeenCalledOnce();
    expect(firstAgent.destroy.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createWithRuntime.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY
    );
    expect(runtime.dispose).not.toHaveBeenCalled();
    expect(hook?.agentRef.current).toBe(secondAgent);
  });

  it('shares Runtime and Agent initialization for concurrent exact-target callers', async () => {
    const runtimeCreation = deferred<typeof runtime>();
    const agentCreation = deferred<typeof agent>();
    mocks.createRuntime.mockReturnValue(runtimeCreation.promise);
    mocks.createWithRuntime.mockReturnValue(agentCreation.promise);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    const firstCreation = hook!.createAgent();
    const secondCreation = hook!.createAgent();
    await vi.waitFor(() => expect(mocks.createRuntime).toHaveBeenCalled());

    runtimeCreation.resolve(runtime);
    await vi.waitFor(() => expect(mocks.createWithRuntime).toHaveBeenCalled());
    agentCreation.resolve(agent);
    const [firstAgent, secondAgent] = await Promise.all([
      firstCreation,
      secondCreation,
    ]);

    expect(mocks.createRuntime).toHaveBeenCalledOnce();
    expect(mocks.createWithRuntime).toHaveBeenCalledOnce();
    expect(firstAgent).toBe(agent);
    expect(secondAgent).toBe(agent);
    expect(hook?.agentRef.current).toBe(agent);
  });

  it('serializes different Agent targets and destroys the stale candidate', async () => {
    const firstAgent = createAgentCandidate();
    const secondAgent = createAgentCandidate();
    const firstAgentCreation = deferred<typeof agent>();
    mocks.createWithRuntime
      .mockReturnValueOnce(firstAgentCreation.promise)
      .mockResolvedValueOnce(secondAgent);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    const firstCreation = observe(hook!.createAgent({ systemPrompt: 'first target' }));
    await vi.waitFor(() => expect(mocks.createWithRuntime).toHaveBeenCalledOnce());
    let secondSettled = false;
    const secondCreation = observe(
      hook!.createAgent({ systemPrompt: 'second target' })
    ).then((outcome) => {
      secondSettled = true;
      return outcome;
    });

    try {
      await Promise.resolve();
      expect({
        factoryCalls: mocks.createWithRuntime.mock.calls.length,
        secondSettled,
      }).toEqual({ factoryCalls: 1, secondSettled: false });

      firstAgentCreation.resolve(firstAgent);
      const [firstOutcome, secondOutcome] = await Promise.all([
        firstCreation,
        secondCreation,
      ]);
      expect(firstOutcome.status).toBe('rejected');
      if (firstOutcome.status === 'rejected') {
        expect(firstOutcome.error).toMatchObject({ name: 'AbortError' });
      }
      expect(secondOutcome).toEqual({ status: 'fulfilled', value: secondAgent });
      expect(firstAgent.destroy).toHaveBeenCalledOnce();
      expect(firstAgent.destroy.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.createWithRuntime.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY
      );
      expect(mocks.createRuntime).toHaveBeenCalledOnce();
      expect(runtime.dispose).not.toHaveBeenCalled();
      expect(hook?.agentRef.current).toBe(secondAgent);
    } finally {
      firstAgentCreation.resolve(firstAgent);
      await Promise.all([firstCreation, secondCreation]);
    }
  });

  it('passes invocation-scoped agents into the owned SessionRuntime', async () => {
    await act(async () => {
      root.render(<AgentsHarness />);
      await Promise.resolve();
    });
    await hook?.createAgent();

    expect(mocks.createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        workspaceRoot: '/tmp/project',
        agents: [
          expect.objectContaining({
            name: 'invocation-reviewer',
            source: 'flag',
          }),
        ],
      })
    );
    expect(mocks.createWithRuntime).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        agents: [
          expect.objectContaining({
            name: 'invocation-reviewer',
          }),
        ],
      })
    );
  });

  it('marks SessionStart as resume only when durable history exists', async () => {
    mocks.loadSession.mockResolvedValue([
      { role: 'user', content: 'persisted message' },
    ]);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    await hook?.createAgent();

    expect(mocks.createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionStart: {
          isResume: true,
          resumeSessionId: 'session-1',
        },
      })
    );
  });

  it('releases the previous runtime before creating an Agent for another session', async () => {
    const nextRuntime = {
      ...runtime,
      sessionId: 'session-2',
      workspaceRoot: '/tmp/project',
      getCurrentModelId: vi.fn(() => 'model-1'),
      refresh: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const nextAgent = { destroy: vi.fn().mockResolvedValue(undefined) };
    mocks.createRuntime
      .mockResolvedValueOnce(runtime)
      .mockResolvedValueOnce(nextRuntime);
    mocks.createWithRuntime
      .mockResolvedValueOnce(agent)
      .mockResolvedValueOnce(nextAgent);

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    await hook?.createAgent();
    await hook?.createAgent({ sessionId: 'session-2' });

    expect(agent.destroy).toHaveBeenCalledTimes(1);
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createRuntime.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY
    );

    await hook?.cleanupAgent();
    expect(nextAgent.destroy).toHaveBeenCalledTimes(1);
    expect(nextRuntime.dispose).toHaveBeenCalledTimes(1);
  });

  it('recreates the runtime when the active session workspace changes', async () => {
    const nextRuntime = {
      ...runtime,
      workspaceRoot: '/tmp/project-b',
      getCurrentModelId: vi.fn(() => 'model-1'),
      refresh: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    mocks.createRuntime
      .mockResolvedValueOnce(runtime)
      .mockResolvedValueOnce(nextRuntime);

    await act(async () => {
      root.render(<WorkspaceHarness workspaceRoot="/tmp/project-a" />);
      await Promise.resolve();
    });
    await hook?.createAgent();

    await act(async () => {
      root.render(<WorkspaceHarness workspaceRoot="/tmp/project-b" />);
      await Promise.resolve();
    });
    await hook?.createAgent();

    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(mocks.createRuntime).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: 'session-1',
        workspaceRoot: '/tmp/project-b',
      })
    );
    await hook?.cleanupAgent();
  });

  it('keeps the owned runtime workspace across async CWD boundaries', async () => {
    runtime.workspaceRoot = '/tmp/project-a';
    mocks.getCwd.mockReturnValue('/tmp/project-a');
    await act(async () => {
      root.render(<ImplicitWorkspaceHarness />);
      await Promise.resolve();
    });
    await hook?.createAgent();

    mocks.getCwd.mockReturnValue('/tmp/project-b');
    await hook?.listRewindCheckpoints();

    expect(mocks.createRuntime).toHaveBeenCalledOnce();
    expect(runtime.dispose).not.toHaveBeenCalled();
    expect(runtime.listRewindCheckpoints).toHaveBeenCalledOnce();
  });

  it('still disposes the runtime when Agent destruction fails', async () => {
    agent.destroy.mockRejectedValueOnce(new Error('agent cleanup failed'));

    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    await hook?.createAgent();

    await expect(hook?.cleanupAgent()).rejects.toThrow('agent cleanup failed');
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });

  it('queues steering through the owned SessionRuntime', async () => {
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    await hook?.createAgent();

    await expect(hook?.steerActiveTurn('updated requirement')).resolves.toMatchObject({
      accepted: true,
      queued: 1,
    });
    expect(runtime.enqueueSteering).toHaveBeenCalledWith('updated requirement', {
      allowBeforeTurn: true,
    });
  });

  it('asks a side question through the owned runtime with prompt overrides', async () => {
    function PromptHarness() {
      hook = useAgent({
        sessionId: 'session-1',
        workspaceRoot: '/tmp/project',
        systemPrompt: 'replacement prompt',
        appendSystemPrompt: 'additional prompt',
      });
      return null;
    }

    await act(async () => {
      root.render(<PromptHarness />);
      await Promise.resolve();
    });

    const controller = new AbortController();
    await expect(
      hook?.askSideQuestion('What changed?', controller.signal)
    ).resolves.toMatchObject({ response: 'Side answer' });
    expect(runtime.askSideQuestion).toHaveBeenCalledWith('What changed?', {
      signal: controller.signal,
      systemPrompt: 'replacement prompt',
      appendSystemPrompt: 'additional prompt',
    });
  });

  it('rewinds through the owned runtime and releases stale agent state', async () => {
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    await hook?.createAgent();

    await expect(hook?.listRewindCheckpoints()).resolves.toEqual([
      expect.objectContaining({ messageId: 'user-2' }),
    ]);
    await expect(
      hook?.rewindSession({
        targetMessageId: 'user-2',
        mode: 'conversation',
      })
    ).resolves.toMatchObject({
      removedTurns: 1,
      messages: [{ role: 'user', content: 'kept' }],
    });

    expect(runtime.listRewindCheckpoints).toHaveBeenCalledOnce();
    expect(runtime.rewindSession).toHaveBeenCalledWith({
      targetMessageId: 'user-2',
      mode: 'conversation',
    });
    expect(agent.destroy).toHaveBeenCalledOnce();
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });

  it('lists and resumes subagents without releasing the parent runtime', async () => {
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    await hook?.createAgent();

    await expect(hook?.listSubagents()).resolves.toEqual([
      expect.objectContaining({ id: 'agent-source' }),
    ]);
    await expect(
      hook?.resumeSubagent('agent-source', 'Check the follow-up')
    ).resolves.toMatchObject({
      source: { id: 'agent-source' },
      session: { id: 'agent-child', resumeDepth: 1 },
    });
    expect(runtime.listSubagents).toHaveBeenCalledOnce();
    expect(runtime.resumeSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-source',
        prompt: 'Check the follow-up',
        onEvent: expect.any(Function),
        onCompleted: expect.any(Function),
      })
    );
    expect(agent.destroy).not.toHaveBeenCalled();
    expect(runtime.dispose).not.toHaveBeenCalled();
  });

  it('persists an explicit TUI model selection before creating the Agent', async () => {
    await act(async () => {
      root.render(<ModelHarness />);
      await Promise.resolve();
    });

    await hook?.createAgent();

    expect(runtime.refresh).toHaveBeenCalledWith({
      modelId: 'model-2',
      reasoningEffort: 'off',
      serviceTier: 'auto',
      responseVerbosity: 'auto',
      communicationStyle: 'auto',
    });
    expect(mocks.updateSessionMetadata).toHaveBeenCalledWith(
      'session-1',
      '/tmp/project',
      {
        selectedModelId: 'model-2',
        reasoningEffort: 'off',
        serviceTier: 'auto',
        responseVerbosity: 'auto',
        communicationStyle: 'auto',
        communicationStyleDigest: null,
      }
    );
    expect(mocks.createWithRuntime).toHaveBeenCalledOnce();
  });

  it('rolls back a TUI model switch when durable persistence fails', async () => {
    mocks.updateSessionMetadata.mockRejectedValueOnce(new Error('disk unavailable'));
    await act(async () => {
      root.render(<ModelHarness />);
      await Promise.resolve();
    });

    await expect(hook?.createAgent()).rejects.toThrow('disk unavailable');

    expect(runtime.refresh).toHaveBeenNthCalledWith(1, {
      modelId: 'model-2',
      reasoningEffort: 'off',
      serviceTier: 'auto',
      responseVerbosity: 'auto',
      communicationStyle: 'auto',
    });
    expect(runtime.refresh).toHaveBeenNthCalledWith(2, {
      modelId: 'model-1',
      reasoningEffort: 'off',
      serviceTier: 'auto',
      responseVerbosity: 'auto',
      communicationStyle: 'auto',
    });
    expect(mocks.createWithRuntime).not.toHaveBeenCalled();
  });

  it('persists a Session communication-style switch through the TUI boundary', async () => {
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });

    await hook?.setCommunicationStyle('friendly');

    expect(runtime.resolveCommunicationStyleConfiguration).toHaveBeenCalledWith(
      'friendly'
    );
    expect(runtime.refresh).toHaveBeenCalledWith({
      communicationStyle: 'friendly',
    });
    expect(mocks.updateSessionMetadata).toHaveBeenCalledWith(
      'session-1',
      '/tmp/project',
      {
        communicationStyle: 'friendly',
        communicationStyleDigest: null,
      }
    );
  });
});
