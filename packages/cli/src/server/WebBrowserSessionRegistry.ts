import { SessionBrowserRuntime } from '../browser/SessionBrowserRuntime.js';
import type { SessionRef } from './sessionRef.js';
import { sessionRefKey } from './sessionRef.js';

export interface WebBrowserSessionRegistryOptions {
  createRuntime?: (ref: SessionRef) => SessionBrowserRuntime;
}

export class WebBrowserSessionRegistry {
  private readonly runtimes = new Map<string, SessionBrowserRuntime>();
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
    let runtime = this.runtimes.get(key);
    if (!runtime) {
      runtime = this.createRuntime(ref);
      this.runtimes.set(key, runtime);
    }
    return runtime;
  }

  async reset(ref: SessionRef): Promise<void> {
    const runtime = this.runtimes.get(sessionRefKey(ref));
    if (runtime) {
      await runtime.page({ action: { kind: 'reset' } });
    }
  }

  async dispose(ref: SessionRef): Promise<void> {
    const key = sessionRefKey(ref);
    const runtime = this.runtimes.get(key);
    if (!runtime) return;
    this.runtimes.delete(key);
    await runtime.dispose();
  }

  async disposeAll(): Promise<void> {
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    const results = await Promise.allSettled(
      runtimes.map((runtime) => runtime.dispose())
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failure) throw failure.reason;
  }

  stats(): { sessions: number } {
    return { sessions: this.runtimes.size };
  }
}
