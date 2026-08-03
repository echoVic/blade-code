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

import { useAgent } from '../../../../../src/ui/hooks/useAgent.js';

describe('useAgent runtime ownership', () => {
  let container: HTMLDivElement;
  let root: ReactDOM.Root;
  let hook: ReturnType<typeof useAgent> | undefined;
  let runtime: {
    sessionId: string;
    refresh: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    enqueueSteering: ReturnType<typeof vi.fn>;
  };
  let agent: { destroy: ReturnType<typeof vi.fn> };

  function Harness() {
    hook = useAgent({ sessionId: 'session-1' });
    return null;
  }

  beforeEach(() => {
    runtime = {
      sessionId: 'session-1',
      refresh: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      enqueueSteering: vi.fn(() => ({
        accepted: true,
        turnId: 'turn-1',
        queued: 1,
      })),
    };
    agent = { destroy: vi.fn().mockResolvedValue(undefined) };
    mocks.createRuntime.mockResolvedValue(runtime);
    mocks.createWithRuntime.mockResolvedValue(agent);
    mocks.createAgent.mockResolvedValue(agent);
    mocks.registerCleanup.mockReturnValue(mocks.unregisterCleanup);

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
});
