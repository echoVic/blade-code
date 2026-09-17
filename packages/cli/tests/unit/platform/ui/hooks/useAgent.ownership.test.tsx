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
    getFollowUpQueueSnapshot: ReturnType<typeof vi.fn>;
    mutateFollowUpQueue: ReturnType<typeof vi.fn>;
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
      getFollowUpQueueSnapshot: vi.fn().mockResolvedValue({
        version: 'a'.repeat(64),
        pending: 0,
        mutable: 0,
        locked: 0,
        internal: 0,
        items: [],
      }),
      mutateFollowUpQueue: vi.fn().mockResolvedValue({
        snapshot: {
          version: 'b'.repeat(64),
          pending: 0,
          mutable: 0,
          locked: 0,
          internal: 0,
          items: [],
        },
      }),
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

  it('commits only the replacement workspace when the old Runtime resolves late', async () => {
    const oldRuntime = createRuntimeCandidate('session-1', '/tmp/project-a');
    const nextRuntime = createRuntimeCandidate('session-1', '/tmp/project-b');
    const oldRuntimeCreation = deferred<typeof runtime>();
    mocks.createRuntime
      .mockReturnValueOnce(oldRuntimeCreation.promise)
      .mockResolvedValueOnce(nextRuntime);
    const nextAgent = createAgentCandidate();
    mocks.createWithRuntime.mockResolvedValueOnce(nextAgent);
    await act(async () => {
      root.render(<WorkspaceHarness workspaceRoot="/tmp/project-a" />);
      await Promise.resolve();
    });

    const oldCreation = observe(hook!.createAgent());
    await vi.waitFor(() => expect(mocks.createRuntime).toHaveBeenCalledOnce());
    await act(async () => {
      root.render(<WorkspaceHarness workspaceRoot="/tmp/project-b" />);
      await Promise.resolve();
    });
    const nextCreation = hook!.createAgent();
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
      expect.objectContaining({ sessionId: 'session-1' })
    );
    expect(hook?.agentRef.current).toBe(nextAgent);
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

  it('shares standalone Agent initialization while retaining an owned Session Runtime', async () => {
    const ephemeralAgent = createAgentCandidate();
    const ephemeralCreation = deferred<typeof agent>();
    mocks.createAgent.mockReturnValueOnce(ephemeralCreation.promise);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    await expect(hook!.createAgent()).resolves.toBe(agent);

    const firstCreation = hook!.createAgent({ modelId: 'different-model' });
    const secondCreation = hook!.createAgent({ modelId: 'different-model' });
    await vi.waitFor(() => expect(mocks.createAgent).toHaveBeenCalled());
    ephemeralCreation.resolve(ephemeralAgent);
    const [firstAgent, secondAgent] = await Promise.all([
      firstCreation,
      secondCreation,
    ]);

    expect(mocks.createAgent).toHaveBeenCalledOnce();
    expect(firstAgent).toBe(ephemeralAgent);
    expect(secondAgent).toBe(ephemeralAgent);
    expect(mocks.createRuntime).toHaveBeenCalledOnce();
    expect(runtime.dispose).not.toHaveBeenCalled();
    expect(hook?.agentRef.current).toBe(ephemeralAgent);
  });

  it('invalidates a different Agent target before awaiting its shared Runtime', async () => {
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
    firstAgentCreation.resolve(firstAgent);
    const secondCreation = observe(
      hook!.createAgent({ systemPrompt: 'second target' })
    );

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
    expect(mocks.createWithRuntime).toHaveBeenCalledTimes(2);
    expect(hook?.agentRef.current).toBe(secondAgent);
  });

  it('does not reopen a replacement target after external cleanup joins its barrier', async () => {
    const runtimeA = createRuntimeCandidate('session-1', '/tmp/project-a');
    const destroyStarted = deferred<void>();
    const destroyGate = deferred<void>();
    const firstAgent = createAgentCandidate(async () => {
      destroyStarted.resolve();
      await destroyGate.promise;
    });
    mocks.createRuntime.mockResolvedValueOnce(runtimeA);
    mocks.createWithRuntime.mockResolvedValueOnce(firstAgent);
    await act(async () => {
      root.render(<WorkspaceHarness workspaceRoot="/tmp/project-a" />);
      await Promise.resolve();
    });
    await expect(hook!.createAgent()).resolves.toBe(firstAgent);
    await act(async () => {
      root.render(<WorkspaceHarness workspaceRoot="/tmp/project-b" />);
      await Promise.resolve();
    });

    const replacement = observe(hook!.createAgent());
    await destroyStarted.promise;
    const externalCleanup = hook!.cleanupAgent();
    destroyGate.resolve();
    await externalCleanup;
    const outcome = await replacement;

    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.error).toMatchObject({ name: 'AbortError' });
    }
    expect(firstAgent.destroy).toHaveBeenCalledOnce();
    expect(runtimeA.dispose).toHaveBeenCalledOnce();
    expect(mocks.createRuntime).toHaveBeenCalledOnce();
    expect(mocks.createWithRuntime).toHaveBeenCalledOnce();
    expect(hook?.agentRef.current).toBeUndefined();
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
});
