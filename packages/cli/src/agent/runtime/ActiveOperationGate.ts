export interface ActiveOperationLease {
  readonly signal: AbortSignal;
  release(): void;
}

interface ActiveLeaseState {
  controller: AbortController;
  externalSignal?: AbortSignal;
  externalAbort?: () => void;
  released: boolean;
}

export class ActiveOperationGateClosedError extends Error {
  constructor() {
    super('Active operation gate is closed');
    this.name = 'ActiveOperationGateClosedError';
  }
}

export class ActiveOperationGate {
  private accepting = true;
  private readonly leases = new Set<ActiveLeaseState>();
  private readonly idleWaiters = new Set<() => void>();
  private shutdownPromise?: Promise<void>;

  enter(externalSignal?: AbortSignal): ActiveOperationLease {
    if (!this.accepting) {
      throw new ActiveOperationGateClosedError();
    }

    const state: ActiveLeaseState = {
      controller: new AbortController(),
      externalSignal,
      released: false,
    };
    if (externalSignal?.aborted) {
      state.controller.abort(externalSignal.reason);
    } else if (externalSignal) {
      state.externalAbort = () => state.controller.abort(externalSignal.reason);
      externalSignal.addEventListener('abort', state.externalAbort, { once: true });
    }
    this.leases.add(state);

    return {
      signal: state.controller.signal,
      release: () => this.release(state),
    };
  }

  close(reason: unknown = 'active-operation-gate-closed'): void {
    if (!this.accepting) return;
    this.accepting = false;
    for (const state of this.leases) {
      if (!state.controller.signal.aborted) {
        state.controller.abort(reason);
      }
    }
    this.settleIdleWaiters();
  }

  waitForIdle(): Promise<void> {
    if (this.leases.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.add(resolve);
      this.settleIdleWaiters();
    });
  }

  shutdown(reason?: unknown): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.close(reason);
    this.shutdownPromise = this.waitForIdle();
    return this.shutdownPromise;
  }

  stats(): { accepting: boolean; active: number } {
    return {
      accepting: this.accepting,
      active: this.leases.size,
    };
  }

  private release(state: ActiveLeaseState): void {
    if (state.released) return;
    state.released = true;
    if (state.externalSignal && state.externalAbort) {
      state.externalSignal.removeEventListener('abort', state.externalAbort);
    }
    state.externalSignal = undefined;
    state.externalAbort = undefined;
    this.leases.delete(state);
    this.settleIdleWaiters();
  }

  private settleIdleWaiters(): void {
    if (this.leases.size > 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
