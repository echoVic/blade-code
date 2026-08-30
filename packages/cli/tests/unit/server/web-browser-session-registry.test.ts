import { describe, expect, it, vi } from 'vitest';
import type { SessionBrowserRuntime } from '../../../src/browser/SessionBrowserRuntime.js';
import { BrowserRuntimeError } from '../../../src/browser/types.js';
import { WebBrowserSessionRegistry } from '../../../src/server/WebBrowserSessionRegistry.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function expectDisposedRetryable(read: () => SessionBrowserRuntime) {
  let failure: unknown;
  try {
    read();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(BrowserRuntimeError);
  expect(failure).toMatchObject({
    code: 'browser_disposed',
    details: { retryable: true },
  });
}

function runtimeStub(overrides?: { dispose?: SessionBrowserRuntime['dispose'] }) {
  const runtime = {
    page: vi.fn().mockResolvedValue({ tabs: [] }),
    dispose: overrides?.dispose ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionBrowserRuntime;
  return runtime;
}

describe('WebBrowserSessionRegistry', () => {
  it('isolates runtime identity by project and session', () => {
    const runtimes: SessionBrowserRuntime[] = [];
    const registry = new WebBrowserSessionRegistry({
      createRuntime: () => {
        const runtime = runtimeStub();
        runtimes.push(runtime);
        return runtime;
      },
    });

    const first = registry.get({ sessionId: 'same', projectPath: '/first' });
    expect(registry.get({ sessionId: 'same', projectPath: '/first' })).toBe(first);
    expect(registry.get({ sessionId: 'same', projectPath: '/second' })).not.toBe(first);
    expect(runtimes).toHaveLength(2);
    expect(registry.stats()).toMatchObject({ sessions: 2, live: 2 });
  });

  it('resets one Web context without affecting another', async () => {
    const first = runtimeStub();
    const second = runtimeStub();
    const registry = new WebBrowserSessionRegistry({
      createRuntime: (ref) => (ref.sessionId === 'first' ? first : second),
    });
    const firstRef = { sessionId: 'first', projectPath: '/project' };
    const secondRef = { sessionId: 'second', projectPath: '/project' };
    registry.get(firstRef);
    registry.get(secondRef);

    await registry.reset(firstRef);

    expect(first.page).toHaveBeenCalledWith({ action: { kind: 'reset' } });
    expect(second.page).not.toHaveBeenCalled();
  });

  it('marks a runtime disposing before await, shares the in-flight dispose promise, and reopens after success', async () => {
    const disposeGate = deferred<void>();
    const first = runtimeStub({
      dispose: vi.fn().mockImplementation(() => disposeGate.promise),
    });
    const createRuntime = vi.fn(() => first);
    const registry = new WebBrowserSessionRegistry({
      createRuntime,
    });
    const ref = { sessionId: 'first', projectPath: '/project' };

    expect(registry.get(ref)).toBe(first);

    const firstDispose = registry.dispose(ref);
    const secondDispose = registry.dispose(ref);

    expect(first.dispose).toHaveBeenCalledOnce();
    expect(firstDispose).toBe(secondDispose);
    expect(registry.stats()).toMatchObject({
      sessions: 1,
      live: 0,
      disposing: 1,
      failed: 0,
    });
    expectDisposedRetryable(() => registry.get(ref));
    expect(createRuntime).toHaveBeenCalledOnce();

    disposeGate.resolve(undefined);
    await expect(firstDispose).resolves.toBeUndefined();
    await expect(secondDispose).resolves.toBeUndefined();

    expect(registry.stats()).toMatchObject({
      sessions: 0,
      live: 0,
      disposing: 0,
      failed: 0,
    });

    const reopened = runtimeStub();
    createRuntime.mockReturnValueOnce(reopened);
    expect(registry.get(ref)).toBe(reopened);
    expect(createRuntime).toHaveBeenCalledTimes(2);
  });

  it('retains failed tombstones and retries disposal against the exact retained runtime', async () => {
    const failure = new Error('dispose failed');
    const dispose = vi
      .fn<SessionBrowserRuntime['dispose']>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    const runtime = runtimeStub({ dispose });
    const createRuntime = vi.fn(() => runtime);
    const registry = new WebBrowserSessionRegistry({ createRuntime });
    const ref = { sessionId: 'failed', projectPath: '/project' };

    expect(registry.get(ref)).toBe(runtime);

    await expect(registry.dispose(ref)).rejects.toBe(failure);
    expect(registry.stats()).toMatchObject({
      sessions: 1,
      live: 0,
      disposing: 0,
      failed: 1,
    });
    expectDisposedRetryable(() => registry.get(ref));
    expect(createRuntime).toHaveBeenCalledOnce();

    await expect(registry.dispose(ref)).resolves.toBeUndefined();
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(registry.stats()).toMatchObject({
      sessions: 0,
      live: 0,
      disposing: 0,
      failed: 0,
    });
    expect(createRuntime).toHaveBeenCalledOnce();
  });

  it('disposeAll waits all runtimes, retries failed tombstones, and preserves failures without pre-clearing', async () => {
    const firstFailure = new Error('first failed');
    const firstDispose = vi
      .fn<SessionBrowserRuntime['dispose']>()
      .mockRejectedValueOnce(firstFailure)
      .mockResolvedValueOnce(undefined);
    const secondDisposeGate = deferred<void>();
    const secondDispose = vi
      .fn<SessionBrowserRuntime['dispose']>()
      .mockImplementationOnce(() => secondDisposeGate.promise);
    const first = runtimeStub({ dispose: firstDispose });
    const second = runtimeStub({ dispose: secondDispose });
    const registry = new WebBrowserSessionRegistry({
      createRuntime: (ref) => (ref.sessionId === 'first' ? first : second),
    });
    const firstRef = { sessionId: 'first', projectPath: '/project' };
    const secondRef = { sessionId: 'second', projectPath: '/project' };

    registry.get(firstRef);
    registry.get(secondRef);

    const firstPass = registry.disposeAll();
    expect(registry.stats()).toMatchObject({
      sessions: 2,
      live: 0,
      disposing: 2,
      failed: 0,
    });

    secondDisposeGate.resolve(undefined);
    await expect(firstPass).rejects.toBe(firstFailure);

    expect(firstDispose).toHaveBeenCalledOnce();
    expect(secondDispose).toHaveBeenCalledOnce();
    expect(registry.stats()).toMatchObject({
      sessions: 1,
      live: 0,
      disposing: 0,
      failed: 1,
    });
    expectDisposedRetryable(() => registry.get(firstRef));

    await expect(registry.disposeAll()).resolves.toBeUndefined();

    expect(firstDispose).toHaveBeenCalledTimes(2);
    expect(registry.stats()).toMatchObject({
      sessions: 0,
      live: 0,
      disposing: 0,
      failed: 0,
    });
  });
});
