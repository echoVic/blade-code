import { EventEmitter } from 'node:events';
import type { Browser, BrowserContext } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import {
  BROWSER_CONTEXT_OPTIONS,
  BrowserProcessPool,
} from '../../../src/browser/BrowserProcessPool.js';

class FakeContext {
  readonly close = vi.fn(async () => undefined);
}

class FakeBrowser extends EventEmitter {
  readonly close = vi.fn(async () => {
    this.connected = false;
  });
  readonly contexts: FakeContext[] = [];
  private connected = true;

  isConnected(): boolean {
    return this.connected;
  }

  async newContext(): Promise<BrowserContext> {
    const context = new FakeContext();
    this.contexts.push(context);
    return context as unknown as BrowserContext;
  }

  disconnectUnexpectedly(): void {
    this.connected = false;
    this.emit('disconnected');
  }
}

describe('BrowserProcessPool', () => {
  it('launches once and isolates concurrent Session contexts', async () => {
    const browser = new FakeBrowser();
    const launch = vi.fn(async () => browser as unknown as Browser);
    const pool = new BrowserProcessPool({
      adapter: { launch },
      environment: { PATH: '/bin', DEEPSEEK_API_KEY: 'secret' },
    });

    const [first, second] = await Promise.all([
      pool.acquire(vi.fn()),
      pool.acquire(vi.fn()),
    ]);

    expect(launch).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledWith({
      headless: true,
      env: { PATH: '/bin' },
    });
    expect(browser.contexts).toHaveLength(2);
    expect(first.context).not.toBe(second.context);
    expect(first.generation).toBe(second.generation);
    expect(pool.stats()).toMatchObject({
      contexts: 2,
      running: true,
      disposed: false,
    });

    await first.release();
    expect(browser.contexts[0]?.close).toHaveBeenCalledOnce();
    expect(browser.close).not.toHaveBeenCalled();
    await second.release();
    expect(browser.contexts[1]?.close).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
    expect(pool.stats().contexts).toBe(0);
  });

  it('uses the frozen context options and enforces capacity', async () => {
    const browser = new FakeBrowser();
    const newContext = vi.spyOn(browser, 'newContext');
    const pool = new BrowserProcessPool({
      adapter: { launch: async () => browser as unknown as Browser },
      maxContexts: 1,
    });
    const lease = await pool.acquire(vi.fn());

    expect(newContext).toHaveBeenCalledWith(BROWSER_CONTEXT_OPTIONS);
    await expect(pool.acquire(vi.fn())).rejects.toMatchObject({
      code: 'browser_capacity',
      details: { retryable: true },
    });
    await lease.release();
  });

  it('does not cache a failed launch', async () => {
    const browser = new FakeBrowser();
    const launch = vi
      .fn()
      .mockRejectedValueOnce(new Error('missing executable'))
      .mockResolvedValueOnce(browser as unknown as Browser);
    const pool = new BrowserProcessPool({ adapter: { launch } });

    await expect(pool.acquire(vi.fn())).rejects.toMatchObject({
      code: 'browser_not_installed',
    });
    const lease = await pool.acquire(vi.fn());
    expect(launch).toHaveBeenCalledTimes(2);
    await lease.release();
  });

  it('invalidates leases once after an unexpected disconnect', async () => {
    const browser = new FakeBrowser();
    const disconnected = vi.fn();
    const pool = new BrowserProcessPool({
      adapter: { launch: async () => browser as unknown as Browser },
    });
    const lease = await pool.acquire(disconnected);
    const generation = lease.generation;

    browser.disconnectUnexpectedly();
    await Promise.resolve();

    expect(disconnected).toHaveBeenCalledOnce();
    expect(pool.stats()).toMatchObject({
      generation: generation + 1,
      contexts: 0,
      running: false,
    });
    await lease.release();
    expect(browser.contexts[0]?.close).not.toHaveBeenCalled();
  });

  it('disposes all leased contexts and rejects future acquisition', async () => {
    const browser = new FakeBrowser();
    const pool = new BrowserProcessPool({
      adapter: { launch: async () => browser as unknown as Browser },
    });
    await pool.acquire(vi.fn());
    await pool.acquire(vi.fn());

    await pool.dispose();
    await pool.dispose();

    expect(
      browser.contexts.every((context) => context.close.mock.calls.length === 1)
    ).toBe(true);
    expect(browser.close).toHaveBeenCalledOnce();
    expect(pool.stats()).toMatchObject({
      contexts: 0,
      running: false,
      disposed: true,
    });
    await expect(pool.acquire(vi.fn())).rejects.toMatchObject({
      code: 'browser_disposed',
    });
  });
});
