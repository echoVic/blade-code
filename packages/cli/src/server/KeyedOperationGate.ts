interface ActiveOperation<K> {
  readonly key: K;
  readonly internalController: AbortController;
  readonly signalController: AbortController;
  released: boolean;
  removeInternalListener: () => void;
  removeExternalListener?: () => void;
}

interface IdleWaiter {
  resolve: () => void;
  reject: (reason?: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
}

interface CloseState<K> {
  readonly keys: readonly K[];
  readonly waiters: Set<IdleWaiter>;
  state: 'open' | 'committed' | 'rolled_back';
}

export interface KeyedOperationLease {
  readonly signal: AbortSignal;
  release(): void;
}

export interface KeyedOperationCloseSet<K> {
  readonly keys: readonly K[];
  waitForIdle(options: { signal?: AbortSignal; deadlineAt: number }): Promise<void>;
  commit(): void;
  rollback(): void;
}

function compareKeys(left: unknown, right: unknown): number {
  const leftType = typeof left;
  const rightType = typeof right;
  if (leftType === rightType) {
    if (
      leftType === 'string' ||
      leftType === 'number' ||
      leftType === 'bigint' ||
      leftType === 'boolean'
    ) {
      const comparableLeft = left as string | number | bigint | boolean;
      const comparableRight = right as string | number | bigint | boolean;
      if (comparableLeft < comparableRight) return -1;
      if (comparableLeft > comparableRight) return 1;
      return 0;
    }
  }
  const leftKey = `${leftType}:${String(left)}`;
  const rightKey = `${rightType}:${String(right)}`;
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;
  return 0;
}

function toAbortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason ?? 'AbortError'));
}

export class KeyedOperationGate<K> {
  private readonly operations = new Map<K, Set<ActiveOperation<K>>>();
  private readonly closings = new Map<K, CloseState<K>>();
  private readonly permanentlyClosed = new Set<K>();
  private shutdownReason: unknown | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private resolveShutdown: (() => void) | undefined;

  enter(key: K, signal?: AbortSignal): KeyedOperationLease {
    if (this.shutdownReason !== undefined) {
      throw new Error('Keyed operation gate is shut down');
    }
    if (this.permanentlyClosed.has(key) || this.closings.has(key)) {
      throw new Error('Keyed operation is closed');
    }

    const operation: ActiveOperation<K> = {
      key,
      internalController: new AbortController(),
      signalController: new AbortController(),
      released: false,
      removeInternalListener: () => undefined,
      removeExternalListener: undefined,
    };
    const onInternalAbort = () => {
      if (operation.signalController.signal.aborted) return;
      operation.signalController.abort(operation.internalController.signal.reason);
    };
    operation.internalController.signal.addEventListener('abort', onInternalAbort, {
      once: true,
    });
    operation.removeInternalListener = () => {
      operation.internalController.signal.removeEventListener('abort', onInternalAbort);
    };
    if (signal) {
      const onExternalAbort = () => {
        if (operation.signalController.signal.aborted) return;
        operation.signalController.abort(signal.reason);
      };
      signal.addEventListener('abort', onExternalAbort, { once: true });
      operation.removeExternalListener = () => {
        signal.removeEventListener('abort', onExternalAbort);
      };
      if (signal.aborted) onExternalAbort();
    }

    let operationsForKey = this.operations.get(key);
    if (!operationsForKey) {
      operationsForKey = new Set();
      this.operations.set(key, operationsForKey);
    }
    operationsForKey.add(operation);

    return {
      signal: operation.signalController.signal,
      release: () => {
        if (operation.released) return;
        operation.released = true;
        operation.removeInternalListener();
        operation.removeExternalListener?.();
        const current = this.operations.get(key);
        current?.delete(operation);
        if (current && current.size === 0) {
          this.operations.delete(key);
        }
        this.resolveRelevantWaiters(key);
        this.maybeResolveShutdown();
      },
    };
  }

  beginCloseMany(keys: readonly K[], reason: unknown): KeyedOperationCloseSet<K> {
    const closeKeys = [...new Set(keys)].sort(compareKeys) as K[];
    if (this.shutdownReason !== undefined) {
      throw new Error('Keyed operation gate is shut down');
    }
    for (const key of closeKeys) {
      if (this.closings.has(key) || this.permanentlyClosed.has(key)) {
        throw new Error('Keyed operation close conflict');
      }
    }

    const closeState: CloseState<K> = {
      keys: closeKeys,
      waiters: new Set(),
      state: 'open',
    };
    for (const key of closeKeys) {
      this.closings.set(key, closeState);
    }
    for (const key of closeKeys) {
      for (const operation of this.operations.get(key) ?? []) {
        operation.internalController.abort(reason);
      }
    }

    const ensureOpen = () => {
      if (closeState.state === 'committed') {
        throw new Error('Keyed operation close set is already committed');
      }
      if (closeState.state === 'rolled_back') {
        throw new Error('Keyed operation close set is already rolled back');
      }
    };

    const settleWaiters = () => {
      for (const waiter of closeState.waiters) {
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        waiter.removeAbortListener?.();
        waiter.resolve();
      }
      closeState.waiters.clear();
    };

    return {
      keys: closeState.keys,
      waitForIdle: ({
        signal,
        deadlineAt,
      }: {
        signal?: AbortSignal;
        deadlineAt: number;
      }) => {
        if (closeState.state !== 'open' || this.isCloseStateIdle(closeState)) {
          return Promise.resolve();
        }
        if (deadlineAt <= Date.now()) {
          return Promise.reject(
            new Error(`Keyed operation close wait timed out at ${deadlineAt}`)
          );
        }
        return new Promise<void>((resolve, reject) => {
          const waiter: IdleWaiter = {
            resolve,
            reject,
            timer: undefined,
            removeAbortListener: undefined,
          };
          closeState.waiters.add(waiter);
          waiter.timer = setTimeout(
            () => {
              closeState.waiters.delete(waiter);
              waiter.removeAbortListener?.();
              reject(
                new Error(`Keyed operation close wait timed out at ${deadlineAt}`)
              );
            },
            Math.max(0, deadlineAt - Date.now())
          );
          if (signal) {
            const onAbort = () => {
              closeState.waiters.delete(waiter);
              if (waiter.timer !== undefined) clearTimeout(waiter.timer);
              signal.removeEventListener('abort', onAbort);
              reject(toAbortError(signal.reason));
            };
            signal.addEventListener('abort', onAbort, { once: true });
            waiter.removeAbortListener = () => {
              signal.removeEventListener('abort', onAbort);
            };
            if (signal.aborted) onAbort();
          }
        });
      },
      commit: () => {
        if (closeState.state === 'committed') return;
        ensureOpen();
        if (!this.isCloseStateIdle(closeState)) {
          throw new Error('Keyed operation close set still has active operations');
        }
        closeState.state = 'committed';
        for (const key of closeState.keys) {
          if (this.closings.get(key) === closeState) {
            this.closings.delete(key);
          }
          this.permanentlyClosed.add(key);
        }
        settleWaiters();
      },
      rollback: () => {
        if (closeState.state === 'rolled_back') return;
        ensureOpen();
        closeState.state = 'rolled_back';
        for (const key of closeState.keys) {
          if (this.closings.get(key) === closeState) {
            this.closings.delete(key);
          }
        }
        settleWaiters();
      },
    };
  }

  shutdown(reason: unknown): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownReason = reason;
    this.closings.clear();
    for (const operationsForKey of this.operations.values()) {
      for (const operation of operationsForKey) {
        operation.internalController.abort(reason);
      }
    }
    if (this.countOperations() === 0) {
      this.shutdownPromise = Promise.resolve();
      return this.shutdownPromise;
    }
    this.shutdownPromise = new Promise<void>((resolve) => {
      this.resolveShutdown = resolve;
    });
    return this.shutdownPromise;
  }

  getStats(): { keys: number; operations: number; closing: number } {
    const keys = new Set<K>();
    for (const key of this.operations.keys()) {
      keys.add(key);
    }
    for (const key of this.closings.keys()) {
      keys.add(key);
    }
    return {
      keys: keys.size,
      operations: this.countOperations(),
      closing: this.closings.size,
    };
  }

  private countOperations(): number {
    let total = 0;
    for (const operationsForKey of this.operations.values()) {
      total += operationsForKey.size;
    }
    return total;
  }

  private isCloseStateIdle(closeState: CloseState<K>): boolean {
    for (const key of closeState.keys) {
      if ((this.operations.get(key)?.size ?? 0) > 0) {
        return false;
      }
    }
    return true;
  }

  private resolveRelevantWaiters(key: K): void {
    const closeState = this.closings.get(key);
    if (!closeState || !this.isCloseStateIdle(closeState)) return;
    for (const waiter of closeState.waiters) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.removeAbortListener?.();
      waiter.resolve();
    }
    closeState.waiters.clear();
  }

  private maybeResolveShutdown(): void {
    if (this.shutdownReason === undefined) return;
    if (this.countOperations() !== 0) return;
    this.resolveShutdown?.();
    this.resolveShutdown = undefined;
  }
}
