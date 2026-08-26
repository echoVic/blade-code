import { describe, expect, it, vi } from 'vitest';
import type { SessionBrowserRuntime } from '../../../src/browser/SessionBrowserRuntime.js';
import { WebBrowserSessionRegistry } from '../../../src/server/WebBrowserSessionRegistry.js';

function runtimeStub() {
  return {
    page: vi.fn().mockResolvedValue({ tabs: [] }),
    dispose: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionBrowserRuntime;
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
    expect(registry.stats()).toEqual({ sessions: 2 });
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

  it('disposes deleted Sessions and all remaining runtimes on shutdown', async () => {
    const first = runtimeStub();
    const second = runtimeStub();
    const registry = new WebBrowserSessionRegistry({
      createRuntime: (ref) => (ref.sessionId === 'first' ? first : second),
    });
    const firstRef = { sessionId: 'first', projectPath: '/project' };
    registry.get(firstRef);
    registry.get({ sessionId: 'second', projectPath: '/project' });

    await registry.dispose(firstRef);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(registry.stats()).toEqual({ sessions: 1 });

    await registry.disposeAll();
    expect(second.dispose).toHaveBeenCalledOnce();
    expect(registry.stats()).toEqual({ sessions: 0 });
  });
});
