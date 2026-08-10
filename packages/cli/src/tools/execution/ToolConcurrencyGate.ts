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

  run<T>(
    concurrent: boolean,
    fn: () => Promise<T>,
    signal: AbortSignal | undefined,
    onAbort: () => T
  ): Promise<T> {
    if (signal?.aborted) {
      try {
        return Promise.resolve(onAbort());
      } catch (error) {
        return Promise.reject(error);
      }
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

  private drain(): void {
    if (this.exclusiveInFlight || this.queue.length === 0) return;

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
