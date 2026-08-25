import { randomUUID } from 'node:crypto';
import { Mutex } from 'async-mutex';
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  LaunchOptions,
} from 'playwright';
import { createBrowserRuntimeEnvironment } from './BrowserInstallation.js';
import { MAX_BROWSER_CONTEXTS } from './constants.js';
import { BrowserRuntimeError } from './types.js';

export const BROWSER_CONTEXT_OPTIONS: BrowserContextOptions = {
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  locale: 'en-US',
  timezoneId: 'UTC',
  acceptDownloads: false,
};

export interface BrowserProcessAdapter {
  launch(options: LaunchOptions): Promise<Browser>;
}

export interface BrowserContextLease {
  readonly context: BrowserContext;
  readonly generation: number;
  release(): Promise<void>;
}

export interface BrowserProcessPoolOptions {
  adapter?: BrowserProcessAdapter;
  contextOptions?: BrowserContextOptions;
  environment?: NodeJS.ProcessEnv;
  maxContexts?: number;
}

interface LeaseRecord {
  context: BrowserContext;
  generation: number;
  onDisconnected: () => void;
}

async function loadDefaultAdapter(): Promise<BrowserProcessAdapter> {
  const { chromium } = await import('playwright');
  return {
    launch: (options) => chromium.launch(options),
  };
}

export class BrowserProcessPool {
  private readonly mutex = new Mutex();
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly maxContexts: number;
  private readonly contextOptions: BrowserContextOptions;
  private readonly environment: NodeJS.ProcessEnv;
  private adapter?: BrowserProcessAdapter;
  private browser?: Browser;
  private launchPromise?: Promise<Browser>;
  private generation = 0;
  private disposed = false;
  private disconnectListener?: () => void;

  constructor(options: BrowserProcessPoolOptions = {}) {
    this.adapter = options.adapter;
    this.contextOptions = options.contextOptions ?? BROWSER_CONTEXT_OPTIONS;
    this.environment = options.environment ?? process.env;
    this.maxContexts = options.maxContexts ?? MAX_BROWSER_CONTEXTS;
    if (!Number.isSafeInteger(this.maxContexts) || this.maxContexts <= 0) {
      throw new Error('Browser context limit must be a positive integer');
    }
  }

  async acquire(onDisconnected: () => void): Promise<BrowserContextLease> {
    return this.mutex.runExclusive(async () => {
      if (this.disposed) {
        throw new BrowserRuntimeError(
          'browser_disposed',
          'Browser process pool is closed'
        );
      }
      if (this.leases.size >= this.maxContexts) {
        throw new BrowserRuntimeError(
          'browser_capacity',
          `Browser context capacity is full (max ${this.maxContexts})`,
          { retryable: true }
        );
      }

      const browser = await this.ensureBrowser();
      const generation = this.generation;
      let context: BrowserContext;
      try {
        context = await browser.newContext(this.contextOptions);
      } catch (error) {
        if (!browser.isConnected() || browser !== this.browser) {
          throw new BrowserRuntimeError(
            'browser_disconnected',
            'Chromium disconnected while creating a Session context',
            { retryable: true }
          );
        }
        if (this.leases.size === 0 && browser === this.browser) {
          this.detachDisconnectListener(browser);
          this.browser = undefined;
          this.launchPromise = undefined;
          await browser.close().catch(() => undefined);
        }
        throw error;
      }
      if (this.disposed || browser !== this.browser || generation !== this.generation) {
        await context.close().catch(() => undefined);
        throw new BrowserRuntimeError(
          this.disposed ? 'browser_disposed' : 'browser_disconnected',
          this.disposed
            ? 'Browser process pool is closed'
            : 'Chromium disconnected while creating a Session context',
          { retryable: !this.disposed }
        );
      }

      const leaseId = randomUUID();
      this.leases.set(leaseId, { context, generation, onDisconnected });
      let released = false;
      return {
        context,
        generation,
        release: async () => {
          if (released) return;
          released = true;
          await this.release(leaseId);
        },
      };
    });
  }

  stats(): {
    generation: number;
    contexts: number;
    launching: boolean;
    running: boolean;
    disposed: boolean;
  } {
    return {
      generation: this.generation,
      contexts: this.leases.size,
      launching: this.launchPromise !== undefined && this.browser === undefined,
      running: this.browser?.isConnected() === true,
      disposed: this.disposed,
    };
  }

  async dispose(): Promise<void> {
    const resources = await this.mutex.runExclusive(async () => {
      if (this.disposed) return undefined;
      this.disposed = true;
      const browser = this.browser;
      const contexts = [...this.leases.values()].map((lease) => lease.context);
      this.leases.clear();
      this.detachDisconnectListener(browser);
      this.browser = undefined;
      this.launchPromise = undefined;
      this.generation++;
      return { browser, contexts };
    });
    if (!resources) return;
    await Promise.allSettled(resources.contexts.map((context) => context.close()));
    await resources.browser?.close().catch(() => undefined);
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.launchPromise) {
      this.launchPromise = this.launch();
    }
    try {
      return await this.launchPromise;
    } finally {
      this.launchPromise = undefined;
    }
  }

  private async launch(): Promise<Browser> {
    const adapter = this.adapter ?? (await loadDefaultAdapter());
    this.adapter = adapter;
    let browser: Browser;
    try {
      browser = await adapter.launch({
        headless: true,
        chromiumSandbox: true,
        env: createBrowserRuntimeEnvironment(this.environment),
      });
    } catch {
      throw new BrowserRuntimeError(
        'browser_not_installed',
        'Chromium is unavailable or failed to launch.\n' +
          'Install with: blade browser install'
      );
    }
    if (this.disposed) {
      await browser.close().catch(() => undefined);
      throw new BrowserRuntimeError(
        'browser_disposed',
        'Browser process pool is closed'
      );
    }

    this.generation++;
    this.browser = browser;
    const generation = this.generation;
    const listener = () => this.handleDisconnected(browser, generation);
    this.disconnectListener = listener;
    browser.on('disconnected', listener);
    return browser;
  }

  private handleDisconnected(browser: Browser, generation: number): void {
    if (browser !== this.browser || generation !== this.generation) return;
    this.detachDisconnectListener(browser);
    this.browser = undefined;
    this.launchPromise = undefined;
    this.generation++;
    const leases = [...this.leases.values()];
    this.leases.clear();
    for (const lease of leases) {
      queueMicrotask(lease.onDisconnected);
    }
  }

  private async release(leaseId: string): Promise<void> {
    const resources = await this.mutex.runExclusive(async () => {
      const lease = this.leases.get(leaseId);
      if (!lease) return undefined;
      this.leases.delete(leaseId);
      const browser = this.browser;
      const closeBrowser = this.leases.size === 0 && browser !== undefined;
      if (closeBrowser) {
        this.detachDisconnectListener(browser);
        this.browser = undefined;
        this.launchPromise = undefined;
      }
      return {
        context: lease.context,
        browser: closeBrowser ? browser : undefined,
      };
    });
    if (!resources) return;
    await resources.context.close().catch(() => undefined);
    await resources.browser?.close().catch(() => undefined);
  }

  private detachDisconnectListener(browser: Browser | undefined): void {
    if (browser && this.disconnectListener) {
      browser.off('disconnected', this.disconnectListener);
    }
    this.disconnectListener = undefined;
  }
}

let defaultPool: BrowserProcessPool | undefined;

export function getBrowserProcessPool(): BrowserProcessPool {
  defaultPool ??= new BrowserProcessPool();
  return defaultPool;
}

export async function disposeBrowserProcessPool(): Promise<void> {
  const pool = defaultPool;
  defaultPool = undefined;
  await pool?.dispose();
}
