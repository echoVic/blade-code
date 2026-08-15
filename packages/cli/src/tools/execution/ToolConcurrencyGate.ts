type PendingTask<T> = {
  concurrent: boolean;
  fn: () => Promise<T>;
  onAbort: () => T;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
  started: boolean;
};

type ErasedPendingTask = PendingTask<unknown>;

export const TOOL_GATE_MAX_PENDING = 64;

export class ToolConcurrencyGateOverflowError extends Error {
  constructor(readonly limit: number) {
    super(`Tool concurrency gate queue is full (max ${limit})`);
    this.name = 'ToolConcurrencyGateOverflowError';
  }
}

export class ToolConcurrencyGateClosedError extends Error {
  constructor() {
    super('Tool concurrency gate is closed');
    this.name = 'ToolConcurrencyGateClosedError';
  }
}

/**
 * Fair per-executor gate for tool batches.
 *
 * Consecutive concurrency-safe tools share the gate. A non-safe tool is an
 * exclusive FIFO barrier, so later reads cannot overtake an earlier write.
 */
export class ToolConcurrencyGate {
  private readonly queue: ErasedPendingTask[] = [];
  private concurrentInFlight = 0;
  private exclusiveInFlight = false;
  private closed = false;

  constructor(private readonly maxPending = TOOL_GATE_MAX_PENDING) {
    if (!Number.isSafeInteger(maxPending) || maxPending <= 0) {
      throw new Error('maxPending must be a finite positive integer');
    }
  }

  run<T>(
    concurrent: boolean,
    fn: () => Promise<T>,
    signal: AbortSignal | undefined,
    onAbort: () => T
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new ToolConcurrencyGateClosedError());
    }
    if (signal?.aborted) {
      try {
        return Promise.resolve(onAbort());
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (this.queue.length >= this.maxPending) {
      return Promise.reject(new ToolConcurrencyGateOverflowError(this.maxPending));
    }

    return new Promise<T>((resolve, reject) => {
      const task: PendingTask<T> = {
        concurrent,
        fn,
        onAbort,
        resolve,
        reject,
        signal,
        started: false,
      };

      if (signal) {
        task.abortListener = () => {
          if (task.started) return;
          const index = this.queue.indexOf(task as ErasedPendingTask);
          if (index === -1) return;
          this.queue.splice(index, 1);
          signal.removeEventListener('abort', task.abortListener!);
          try {
            resolve(onAbort());
          } catch (error) {
            reject(error);
          }
          this.drain();
        };
        signal.addEventListener('abort', task.abortListener, { once: true });
      }

      this.queue.push(task as ErasedPendingTask);
      this.drain();
    });
  }

  close(_reason?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    for (const task of [...this.queue]) {
      const index = this.queue.indexOf(task);
      if (index >= 0) this.queue.splice(index, 1);
      if (task.signal && task.abortListener) {
        task.signal.removeEventListener('abort', task.abortListener);
      }
      try {
        task.resolve(task.onAbort());
      } catch (error) {
        task.reject(error);
      }
    }
  }

  stats(): {
    pending: number;
    sharedInFlight: number;
    exclusiveInFlight: boolean;
    closed: boolean;
  } {
    return {
      pending: this.queue.length,
      sharedInFlight: this.concurrentInFlight,
      exclusiveInFlight: this.exclusiveInFlight,
      closed: this.closed,
    };
  }

  private drain(): void {
    if (this.closed || this.exclusiveInFlight || this.queue.length === 0) return;

    if (this.concurrentInFlight > 0) {
      while (this.queue[0]?.concurrent) {
        this.start(this.queue.shift()!);
      }
      return;
    }

    if (!this.queue[0].concurrent) {
      this.start(this.queue.shift()!);
      return;
    }

    while (this.queue[0]?.concurrent) {
      this.start(this.queue.shift()!);
    }
  }

  private start(task: ErasedPendingTask): void {
    task.started = true;
    if (task.signal && task.abortListener) {
      task.signal.removeEventListener('abort', task.abortListener);
    }

    if (task.concurrent) {
      this.concurrentInFlight++;
    } else {
      this.exclusiveInFlight = true;
    }

    Promise.resolve()
      .then(task.fn)
      .then(task.resolve, task.reject)
      .finally(() => {
        if (task.concurrent) {
          this.concurrentInFlight--;
        } else {
          this.exclusiveInFlight = false;
        }
        this.drain();
      });
  }
}
