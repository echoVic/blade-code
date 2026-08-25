import type { BrowserContext, Frame, Page } from 'playwright';
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

  it('classifies a target-closed interaction as uncertain disconnection', async () => {
    let currentUrl = 'about:blank';
    let page: Page;
    const mainFrame = {
      url: () => currentUrl,
      page: () => page,
      parentFrame: () => null,
    } as unknown as Frame;
    const locator = {
      count: vi.fn(async () => 1),
      elementHandle: vi.fn(async () => ({
        ownerFrame: async () => mainFrame,
        dispose: async () => undefined,
      })),
      click: vi.fn(async () => {
        throw new Error('Target page, context or browser has been closed');
      }),
    };
    page = {
      isClosed: () => false,
      on: vi.fn(),
      url: () => currentUrl,
      title: vi.fn(async () => 'Fixture'),
      mainFrame: () => mainFrame,
      goto: vi.fn(async (url: string) => {
        currentUrl = url;
        return null;
      }),
      waitForEvent: vi.fn(async () => undefined),
      ariaSnapshot: vi.fn(async () => '- button "Close" [ref=e1]'),
      locator: vi.fn(() => locator),
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

    const observation = await runtime.navigate({ url: 'https://example.com/' });
    await expect(
      runtime.interact({
        pageId: observation.pageId,
        snapshotId: observation.snapshotId,
        ref: 'e1',
        expectedOrigin: 'https://example.com:443',
        action: { kind: 'click' },
      })
    ).resolves.toMatchObject({
      outcome: 'uncertain',
      errorCode: 'browser_disconnected',
    });

    await runtime.dispose();
    expect(release).toHaveBeenCalledOnce();
  });
});
