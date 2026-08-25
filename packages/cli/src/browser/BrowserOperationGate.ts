import { MAX_BROWSER_PENDING_OPERATIONS } from './constants.js';
import { BrowserRuntimeError } from './types.js';

interface PendingOperation<T> {
  run: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

type ErasedPendingOperation = PendingOperation<unknown>;

export class BrowserOperationGate {
  private readonly queue: ErasedPendingOperation[] = [];
  private readonly closeController = new AbortController();
  private readonly idleWaiters = new Set<() => void>();
  private active = false;
  private closed = false;

  constructor(private readonly maxPending = MAX_BROWSER_PENDING_OPERATIONS) {
    if (!Number.isSafeInteger(maxPending) || maxPending <= 0) {
      throw new Error('Browser operation pending limit must be a positive integer');
    }
  }

  run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new BrowserRuntimeError('browser_disposed', 'Browser Session Runtime is closed')
      );
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new Error('Browser operation aborted'));
    }
    if (this.queue.length >= this.maxPending) {
      return Promise.reject(
        new BrowserRuntimeError('browser_busy', 'Browser operation queue is full', {
          retryable: true,
        })
      );
    }

    return new Promise<T>((resolve, reject) => {
      const pending: PendingOperation<T> = {
        run: operation,
        resolve,
        reject,
        signal,
      };
      if (signal) {
        pending.abortListener = () => {
          const index = this.queue.indexOf(pending as ErasedPendingOperation);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(signal.reason ?? new Error('Browser operation aborted'));
        };
        signal.addEventListener('abort', pending.abortListener, { once: true });
      }
      this.queue.push(pending as ErasedPendingOperation);
      this.drain();
    });
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.closeController.abort(
        new BrowserRuntimeError('browser_disposed', 'Browser Session Runtime is closed')
      );
      for (const pending of this.queue.splice(0)) {
        if (pending.signal && pending.abortListener) {
          pending.signal.removeEventListener('abort', pending.abortListener);
        }
        pending.reject(
          new BrowserRuntimeError(
            'browser_disposed',
            'Browser Session Runtime is closed'
          )
        );
      }
    }
    if (!this.active) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  stats(): { active: boolean; pending: number; closed: boolean } {
    return {
      active: this.active,
      pending: this.queue.length,
      closed: this.closed,
    };
  }

  private drain(): void {
    if (this.active || this.closed) return;
    const pending = this.queue.shift();
    if (!pending) return;
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener('abort', pending.abortListener);
    }
    this.active = true;
    const signal = pending.signal
      ? AbortSignal.any([pending.signal, this.closeController.signal])
      : this.closeController.signal;
    Promise.resolve()
      .then(() => pending.run(signal))
      .then(pending.resolve, pending.reject)
      .finally(() => {
        this.active = false;
        if (this.closed) {
          for (const resolve of this.idleWaiters) resolve();
          this.idleWaiters.clear();
        }
        this.drain();
      });
  }
}
