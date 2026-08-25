import type { BrowserContext, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import type {
  BrowserContextLease,
  BrowserProcessPool,
} from '../../../src/browser/BrowserProcessPool.js';
import { SessionBrowserRuntime } from '../../../src/browser/SessionBrowserRuntime.js';

describe('SessionBrowserRuntime lifecycle', () => {
  it('settles disposal while context acquisition is still pending', async () => {
    let resolveAcquire: ((lease: BrowserContextLease) => void) | undefined;
    const release = vi.fn(async () => undefined);
    const acquire = vi.fn(
      () =>
        new Promise<BrowserContextLease>((resolve) => {
          resolveAcquire = resolve;
        })
    );
    const runtime = new SessionBrowserRuntime('/project', 'session', {
      pool: { acquire } as unknown as BrowserProcessPool,
    });

    const operation = runtime.snapshot();
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());

    await expect(runtime.dispose()).resolves.toBeUndefined();
    await expect(operation).rejects.toMatchObject({ code: 'browser_disposed' });

    resolveAcquire?.({
      context: {} as BrowserContext,
      generation: 1,
      release,
    });
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  });

  it('normalizes a Playwright target-closed race as browser_disconnected', async () => {
    const page = {
      isClosed: () => false,
      on: vi.fn(),
      ariaSnapshot: vi.fn(async () => {
        throw new Error('Target page, context or browser has been closed');
      }),
    } as unknown as Page;
    const context = {
      route: vi.fn(async () => undefined),
      setDefaultTimeout: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      on: vi.fn(),
      newPage: vi.fn(async () => page),
    } as unknown as BrowserContext;
    const release = vi.fn(async () => undefined);
    const runtime = new SessionBrowserRuntime('/project', 'session', {
      pool: {
        acquire: vi.fn(async () => ({
          context,
          generation: 1,
          release,
        })),
      } as unknown as BrowserProcessPool,
    });

    await expect(runtime.snapshot()).rejects.toMatchObject({
      code: 'browser_disconnected',
      details: { retryable: true },
    });

    await runtime.dispose();
    expect(release).toHaveBeenCalledOnce();
  });
});
