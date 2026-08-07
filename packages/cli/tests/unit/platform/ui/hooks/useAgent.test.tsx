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
  updateSessionMetadata: vi.fn(),
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
    updateSessionMetadata: mocks.updateSessionMetadata,
  },
}));

import { useAgent } from '../../../../../src/ui/hooks/useAgent.js';

describe('useAgent runtime ownership', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  let hook: ReturnType<typeof useAgent> | undefined;
  let runtime: {
    sessionId: string;
    workspaceRoot: string;
    getCurrentModelId: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    enqueueSteering: ReturnType<typeof vi.fn>;
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

  function WorkspaceHarness({ workspaceRoot }: { workspaceRoot: string }) {
    hook = useAgent({ sessionId: 'session-1', workspaceRoot });
    return null;
  }

  beforeEach(() => {
    runtime = {
      sessionId: 'session-1',
      workspaceRoot: '/tmp/project',
      getCurrentModelId: vi.fn(() => 'model-1'),
      refresh: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      enqueueSteering: vi.fn(() => ({
        accepted: true,
        turnId: 'turn-1',
        queued: 1,
      })),
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
    mocks.updateSessionMetadata.mockResolvedValue({
      selectedModelId: 'model-2',
    });

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

  it('releases the previous runtime before creating an Agent for another session', async () => {
    const nextRuntime = {
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

    expect(runtime.refresh).toHaveBeenCalledWith({ modelId: 'model-2' });
    expect(mocks.updateSessionMetadata).toHaveBeenCalledWith(
      'session-1',
      '/tmp/project',
      { selectedModelId: 'model-2' }
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

    expect(runtime.refresh).toHaveBeenNthCalledWith(1, { modelId: 'model-2' });
    expect(runtime.refresh).toHaveBeenNthCalledWith(2, { modelId: 'model-1' });
    expect(mocks.createWithRuntime).not.toHaveBeenCalled();
  });
});
