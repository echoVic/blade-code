export type BoundedSerialEgressFailureKind =
  | 'aborted'
  | 'closed'
  | 'invalid_size'
  | 'overflow'
  | 'oversized'
  | 'write_failed'
  | 'write_timeout';

export const SURFACE_EGRESS_MAX_PENDING_ITEMS = 256;
export const SURFACE_EGRESS_MAX_PENDING_BYTES = 8 * 1024 * 1024;
export const SURFACE_EGRESS_WRITE_TIMEOUT_MS = 30_000;

export class BoundedSerialEgressError extends Error {
  pendingItems?: number;
  pendingBytes?: number;

  constructor(
    readonly kind: BoundedSerialEgressFailureKind,
    message: string,
    options?: {
      cause?: unknown;
      pendingItems?: number;
      pendingBytes?: number;
    }
  ) {
    super(message, options);
    this.name = 'BoundedSerialEgressError';
    this.pendingItems = options?.pendingItems;
    this.pendingBytes = options?.pendingBytes;
  }
}

export type BoundedSerialEgressOffer =
  | {
      accepted: true;
      completion: Promise<void>;
    }
  | {
      accepted: false;
      error: BoundedSerialEgressError;
    };

export interface BoundedSerialEgressStats {
  closed: boolean;
  pendingItems: number;
  pendingBytes: number;
}

export interface BoundedSerialEgressOptions<T> {
  maxPendingItems: number;
  maxPendingBytes: number;
  writeTimeoutMs: number;
  sizeOf: (value: T) => number;
  write: (value: T, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  onFailure?: (error: BoundedSerialEgressError) => void;
}

interface PendingEgressValue<T> {
  value: T;
  bytes: number;
  sequence: number;
  resolve: () => void;
  reject: (error: BoundedSerialEgressError) => void;
  completion: Promise<void>;
}

interface FlushWaiter {
  targetSequence: number;
  resolve: () => void;
  reject: (error: BoundedSerialEgressError) => void;
}

function observeRejection(promise: Promise<unknown>): void {
  void promise.catch(() => undefined);
}

export class BoundedSerialEgress<T> {
  private readonly pending: PendingEgressValue<T>[] = [];
  private readonly flushWaiters: FlushWaiter[] = [];
  private pendingBytes = 0;
  private nextSequence = 0;
  private completedSequence = 0;
  private draining = false;
  private closed = false;
  private failure?: BoundedSerialEgressError;
  private activeWriteAbort?: AbortController;
  private activeWriteStop?: (error: BoundedSerialEgressError) => void;
  private activeWriteTimeout?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: BoundedSerialEgressOptions<T>) {
    this.assertPositiveInteger(options.maxPendingItems, 'maxPendingItems');
    this.assertPositiveInteger(options.maxPendingBytes, 'maxPendingBytes');
    this.assertPositiveInteger(options.writeTimeoutMs, 'writeTimeoutMs');
    options.signal?.addEventListener('abort', this.handleAbort, { once: true });
    if (options.signal?.aborted) this.handleAbort();
  }

  offer(value: T): BoundedSerialEgressOffer {
    if (this.closed) {
      return {
        accepted: false,
        error:
          this.failure ??
          new BoundedSerialEgressError('closed', 'Egress is already closed'),
      };
    }

    let bytes: number;
    try {
      bytes = this.options.sizeOf(value);
    } catch (error) {
      return this.rejectAdmission(
        new BoundedSerialEgressError('invalid_size', 'Egress size calculation failed', {
          cause: error,
        })
      );
    }
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      return this.rejectAdmission(
        new BoundedSerialEgressError(
          'invalid_size',
          'Egress size must be a non-negative safe integer'
        )
      );
    }
    if (bytes > this.options.maxPendingBytes) {
      return this.rejectAdmission(
        new BoundedSerialEgressError(
          'oversized',
          `Egress value requires ${bytes} bytes; limit is ${this.options.maxPendingBytes}`
        )
      );
    }
    if (
      this.pending.length >= this.options.maxPendingItems ||
      this.pendingBytes + bytes > this.options.maxPendingBytes
    ) {
      return this.rejectAdmission(
        new BoundedSerialEgressError(
          'overflow',
          `Egress pending limit exceeded (${this.pending.length} items, ${this.pendingBytes} bytes)`
        )
      );
    }

    let resolve!: () => void;
    let reject!: (error: BoundedSerialEgressError) => void;
    const completion = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    observeRejection(completion);
    this.nextSequence += 1;
    this.pending.push({
      value,
      bytes,
      sequence: this.nextSequence,
      resolve,
      reject,
      completion,
    });
    this.pendingBytes += bytes;
    this.startDrain();
    return { accepted: true, completion };
  }

  flush(): Promise<void> {
    if (this.failure) {
      const rejected = Promise.reject(this.failure);
      observeRejection(rejected);
      return rejected;
    }
    const targetSequence = this.nextSequence;
    if (targetSequence <= this.completedSequence) return Promise.resolve();

    let resolve!: () => void;
    let reject!: (error: BoundedSerialEgressError) => void;
    const completion = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    observeRejection(completion);
    this.flushWaiters.push({ targetSequence, resolve, reject });
    return completion;
  }

  close(reason?: unknown): void {
    const error =
      reason instanceof BoundedSerialEgressError
        ? reason
        : new BoundedSerialEgressError('closed', 'Egress was closed', {
            cause: reason,
          });
    this.fail(error);
  }

  stats(): BoundedSerialEgressStats {
    return {
      closed: this.closed,
      pendingItems: this.pending.length,
      pendingBytes: this.pendingBytes,
    };
  }

  private readonly handleAbort = (): void => {
    this.fail(
      new BoundedSerialEgressError('aborted', 'Egress was aborted', {
        cause: this.options.signal?.reason,
      })
    );
  };

  private rejectAdmission(error: BoundedSerialEgressError): BoundedSerialEgressOffer {
    this.fail(error);
    return { accepted: false, error };
  }

  private startDrain(): void {
    if (this.draining || this.closed) return;
    this.draining = true;
    const draining = this.drain();
    observeRejection(draining);
  }

  private async drain(): Promise<void> {
    try {
      while (!this.closed) {
        const entry = this.pending[0];
        if (!entry) return;
        try {
          await this.writeOne(entry.value);
        } catch (error) {
          this.fail(this.normalizeWriteError(error));
          return;
        }
        if (this.closed || this.pending[0] !== entry) return;
        this.pending.shift();
        this.pendingBytes -= entry.bytes;
        this.completedSequence = entry.sequence;
        entry.resolve();
        this.settleFlushWaiters();
      }
    } finally {
      this.draining = false;
      if (!this.closed && this.pending.length > 0) this.startDrain();
    }
  }

  private async writeOne(value: T): Promise<void> {
    const controller = new AbortController();
    this.activeWriteAbort = controller;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let stopReject!: (error: BoundedSerialEgressError) => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      stopReject = reject;
    });
    observeRejection(stopped);
    this.activeWriteStop = stopReject;

    const write = Promise.resolve().then(() =>
      this.options.write(value, controller.signal)
    );
    observeRejection(write);
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new BoundedSerialEgressError(
          'write_timeout',
          `Egress write timed out after ${this.options.writeTimeoutMs}ms`
        );
        controller.abort(error);
        reject(error);
      }, this.options.writeTimeoutMs);
      this.activeWriteTimeout = timeout;
    });
    observeRejection(timedOut);

    try {
      await Promise.race([write, timedOut, stopped]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (this.activeWriteTimeout === timeout) this.activeWriteTimeout = undefined;
      if (this.activeWriteAbort === controller) this.activeWriteAbort = undefined;
      if (this.activeWriteStop === stopReject) this.activeWriteStop = undefined;
    }
  }

  private normalizeWriteError(error: unknown): BoundedSerialEgressError {
    if (error instanceof BoundedSerialEgressError) return error;
    return new BoundedSerialEgressError('write_failed', 'Egress write failed', {
      cause: error,
    });
  }

  private fail(error: BoundedSerialEgressError): void {
    if (this.closed) return;
    error.pendingItems ??= this.pending.length;
    error.pendingBytes ??= this.pendingBytes;
    this.closed = true;
    this.failure = error;
    this.options.signal?.removeEventListener('abort', this.handleAbort);
    if (this.activeWriteTimeout !== undefined) {
      clearTimeout(this.activeWriteTimeout);
      this.activeWriteTimeout = undefined;
    }
    this.activeWriteAbort?.abort(error);
    this.activeWriteStop?.(error);
    this.activeWriteAbort = undefined;
    this.activeWriteStop = undefined;

    const pending = this.pending.splice(0);
    this.pendingBytes = 0;
    for (const entry of pending) entry.reject(error);
    for (const waiter of this.flushWaiters.splice(0)) waiter.reject(error);

    try {
      this.options.onFailure?.(error);
    } catch {
      // Egress cleanup must not be defeated by a diagnostic hook.
    }
  }

  private settleFlushWaiters(): void {
    for (let index = 0; index < this.flushWaiters.length; ) {
      const waiter = this.flushWaiters[index]!;
      if (waiter.targetSequence > this.completedSequence) {
        index += 1;
        continue;
      }
      this.flushWaiters.splice(index, 1);
      waiter.resolve();
    }
  }

  private assertPositiveInteger(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
}
