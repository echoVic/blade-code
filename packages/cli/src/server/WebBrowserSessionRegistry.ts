import { SessionBrowserRuntime } from '../browser/SessionBrowserRuntime.js';
import { BrowserRuntimeError } from '../browser/types.js';
import type { SessionRef } from './sessionRef.js';
import { sessionRefKey } from './sessionRef.js';

export interface WebBrowserSessionRegistryOptions {
  createRuntime?: (ref: SessionRef) => SessionBrowserRuntime;
}

type RuntimeEntry =
  | {
      state: 'live';
      runtime: SessionBrowserRuntime;
    }
  | {
      state: 'disposing';
      runtime: SessionBrowserRuntime;
      disposePromise: Promise<void>;
    }
  | {
      state: 'failed';
      runtime: SessionBrowserRuntime;
      error: unknown;
    };

export class WebBrowserSessionRegistry {
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private readonly createRuntime: (ref: SessionRef) => SessionBrowserRuntime;

  constructor(options: WebBrowserSessionRegistryOptions = {}) {
    this.createRuntime =
      options.createRuntime ??
      ((ref) =>
        new SessionBrowserRuntime(ref.projectPath, `web-browser:${ref.sessionId}`, {
          exposeArtifactPaths: false,
        }));
  }

  get(ref: SessionRef): SessionBrowserRuntime {
    const key = sessionRefKey(ref);
    const entry = this.runtimes.get(key);
    if (entry?.state === 'live') {
      return entry.runtime;
    }
    if (entry) {
      throw new BrowserRuntimeError(
        'browser_disposed',
        'Browser Session Runtime is closed',
        { retryable: true }
      );
    }
    const runtime = this.createRuntime(ref);
    this.runtimes.set(key, { state: 'live', runtime });
    return runtime;
  }

  async reset(ref: SessionRef): Promise<void> {
    const entry = this.runtimes.get(sessionRefKey(ref));
    if (entry?.state === 'live') {
      await entry.runtime.page({ action: { kind: 'reset' } });
    }
  }

  dispose(ref: SessionRef): Promise<void> {
    const key = sessionRefKey(ref);
    const entry = this.runtimes.get(key);
    if (!entry) return Promise.resolve();
    if (entry.state === 'disposing') {
      return entry.disposePromise;
    }
    return this.disposeKey(key, entry.runtime);
  }

  async disposeAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.runtimes.keys()].map((key) => {
        const entry = this.runtimes.get(key);
        if (!entry) return Promise.resolve();
        if (entry.state === 'disposing') return entry.disposePromise;
        return this.disposeKey(key, entry.runtime);
      })
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failure) throw failure.reason;
  }

  stats(): { sessions: number; live: number; disposing: number; failed: number } {
    let live = 0;
    let disposing = 0;
    let failed = 0;
    for (const entry of this.runtimes.values()) {
      if (entry.state === 'live') live++;
      if (entry.state === 'disposing') disposing++;
      if (entry.state === 'failed') failed++;
    }
    return { sessions: this.runtimes.size, live, disposing, failed };
  }

  private disposeKey(key: string, runtime: SessionBrowserRuntime): Promise<void> {
    const disposePromise = runtime.dispose().then(
      () => {
        const current = this.runtimes.get(key);
        if (current?.runtime === runtime) {
          this.runtimes.delete(key);
        }
      },
      (error) => {
        const current = this.runtimes.get(key);
        if (current?.runtime === runtime) {
          this.runtimes.set(key, { state: 'failed', runtime, error });
        }
        throw error;
      }
    );
    this.runtimes.set(key, { state: 'disposing', runtime, disposePromise });
    return disposePromise;
  }
}
