import {
  DEFAULT_MAX_QUEUED_TASK_BYTES,
  isValidConcurrentTaskLimit,
  isValidQueuedTaskByteLimit,
  isValidQueuedTaskLimit,
  MAX_CONCURRENT_TASKS,
  MAX_MAX_QUEUED_TASK_BYTES,
  MAX_QUEUED_TASKS,
  MIN_CONCURRENT_TASKS,
  MIN_MAX_QUEUED_TASK_BYTES,
  MIN_QUEUED_TASKS,
} from '../../config/taskConcurrency.js';

export type TaskAdmissionState = 'queued' | 'running';
export type TaskAdmissionResource = 'pending_count' | 'pending_bytes';

export interface TaskAdmissionSnapshot {
  state: TaskAdmissionState;
  queuePosition?: number;
  queueDepth: number;
  inFlight: number;
  maxConcurrent: number;
  maxQueued: number;
}

export interface TaskRunPermit {
  release(): void;
}

export interface TaskAdmissionHandle {
  readonly ready: Promise<TaskRunPermit>;
  getSnapshot(): TaskAdmissionSnapshot;
  cancel(reason?: string): void;
  release(): void;
}

export interface TaskAdmissionOptions {
  key: string;
  maxConcurrent: number;
  maxQueued: number;
  maxQueuedBytes: number;
  pendingBytes: number;
  signal?: AbortSignal;
  onUpdate?: (snapshot: TaskAdmissionSnapshot) => void;
}

interface PendingAdmission {
  key: string;
  pendingBytes: number;
  charged: boolean;
  signal?: AbortSignal;
  onUpdate?: (snapshot: TaskAdmissionSnapshot) => void;
  resolve: (permit: TaskRunPermit) => void;
  reject: (error: Error) => void;
  snapshot: TaskAdmissionSnapshot;
  abortListener?: () => void;
  permit?: TaskRunPermit;
  settled: boolean;
}

export class TaskAdmissionQueueFullError extends Error {
  constructor(
    public readonly resource: TaskAdmissionResource,
    public readonly limit: number
  ) {
    super(
      resource === 'pending_count'
        ? 'Task admission pending-count capacity is full'
        : 'Task admission pending-byte capacity is full'
    );
    this.name = 'TaskAdmissionQueueFullError';
  }
}

export class TaskAdmissionConflictError extends Error {
  constructor(key: string) {
    super(`Task already owns an admission slot or queue entry: ${key}`);
    this.name = 'TaskAdmissionConflictError';
  }
}

export class TaskAdmissionCancelledError extends Error {
  constructor(reason = 'Task admission was cancelled') {
    super(reason);
    this.name = 'TaskAdmissionCancelledError';
  }
}

export class TaskRunScheduler {
  private maxConcurrent = 3;
  private maxQueued = 100;
  private maxQueuedBytes = DEFAULT_MAX_QUEUED_TASK_BYTES;
  private inFlight = 0;
  private pendingBytes = 0;
  private readonly queue: PendingAdmission[] = [];
  private readonly activeKeys = new Set<string>();
  private explicitlyConfigured = false;

  admit(options: TaskAdmissionOptions): TaskAdmissionHandle {
    this.validateLimits(
      options.maxConcurrent,
      options.maxQueued,
      options.maxQueuedBytes,
      options.pendingBytes
    );
    if (!this.explicitlyConfigured) {
      this.applyConfiguration(
        options.maxConcurrent,
        options.maxQueued,
        options.maxQueuedBytes
      );
    }
    if (!options.key.trim()) throw new Error('Task admission key must not be blank');
    if (this.activeKeys.has(options.key)) {
      throw new TaskAdmissionConflictError(options.key);
    }
    const mustQueue = this.inFlight >= this.maxConcurrent;
    if (mustQueue && this.queue.length >= this.maxQueued) {
      throw new TaskAdmissionQueueFullError('pending_count', this.maxQueued);
    }
    if (mustQueue && options.pendingBytes > this.maxQueuedBytes - this.pendingBytes) {
      throw new TaskAdmissionQueueFullError('pending_bytes', this.maxQueuedBytes);
    }

    let resolveReady!: (permit: TaskRunPermit) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<TaskRunPermit>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void ready.catch(() => undefined);
    const pending: PendingAdmission = {
      key: options.key,
      pendingBytes: options.pendingBytes,
      charged: false,
      signal: options.signal,
      onUpdate: options.onUpdate,
      resolve: resolveReady,
      reject: rejectReady,
      snapshot: this.snapshot('queued', 1),
      settled: false,
    };
    const cancel = (reason?: string): void => {
      this.cancelPending(pending, new TaskAdmissionCancelledError(reason || undefined));
    };
    const handle: TaskAdmissionHandle = {
      ready,
      getSnapshot: () => ({ ...pending.snapshot }),
      cancel,
      release: () => {
        if (pending.permit) pending.permit.release();
        else cancel('Task admission released before execution');
      },
    };
    this.activeKeys.add(options.key);

    if (options.signal?.aborted) {
      cancel(String(options.signal.reason || 'Task admission was cancelled'));
      return handle;
    }
    if (options.signal) {
      pending.abortListener = () =>
        cancel(String(options.signal?.reason || 'Task admission was cancelled'));
      options.signal.addEventListener('abort', pending.abortListener, {
        once: true,
      });
    }

    if (!mustQueue) {
      this.startPending(pending);
    } else {
      this.chargePending(pending);
      this.queue.push(pending);
      this.publishQueueSnapshots();
    }
    return handle;
  }

  configure(maxConcurrent: number, maxQueued: number, maxQueuedBytes: number): void {
    this.validateLimits(maxConcurrent, maxQueued, maxQueuedBytes);
    this.explicitlyConfigured = true;
    this.applyConfiguration(maxConcurrent, maxQueued, maxQueuedBytes);
  }

  private applyConfiguration(
    maxConcurrent: number,
    maxQueued: number,
    maxQueuedBytes: number
  ): void {
    this.maxConcurrent = maxConcurrent;
    this.maxQueued = maxQueued;
    this.maxQueuedBytes = maxQueuedBytes;
    this.drain();
    this.publishQueueSnapshots();
  }

  getStats(): {
    inFlight: number;
    queued: number;
    pendingBytes: number;
    maxConcurrent: number;
    maxQueued: number;
    maxQueuedBytes: number;
  } {
    return {
      inFlight: this.inFlight,
      queued: this.queue.length,
      pendingBytes: this.pendingBytes,
      maxConcurrent: this.maxConcurrent,
      maxQueued: this.maxQueued,
      maxQueuedBytes: this.maxQueuedBytes,
    };
  }

  resetForTests(): void {
    for (const pending of [...this.queue]) {
      this.cancelPending(pending, new TaskAdmissionCancelledError('Scheduler reset'));
    }
    this.queue.length = 0;
    this.activeKeys.clear();
    this.inFlight = 0;
    this.pendingBytes = 0;
    this.maxConcurrent = 3;
    this.maxQueued = 100;
    this.maxQueuedBytes = DEFAULT_MAX_QUEUED_TASK_BYTES;
    this.explicitlyConfigured = false;
  }

  private startPending(pending: PendingAdmission): void {
    if (pending.settled) return;
    this.unchargePending(pending);
    this.detachAbort(pending);
    this.inFlight++;
    let released = false;
    const permit: TaskRunPermit = {
      release: () => {
        if (released) return;
        released = true;
        pending.settled = true;
        this.detachAbort(pending);
        this.activeKeys.delete(pending.key);
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.drain();
        this.publishQueueSnapshots();
      },
    };
    pending.permit = permit;
    pending.snapshot = this.snapshot('running');
    this.publish(pending);
    pending.resolve(permit);
    this.publishQueueSnapshots();
  }

  private cancelPending(pending: PendingAdmission, error: Error): void {
    if (pending.settled) return;
    if (pending.permit) return;
    const index = this.queue.indexOf(pending);
    if (index >= 0) this.queue.splice(index, 1);
    this.unchargePending(pending);
    pending.settled = true;
    this.detachAbort(pending);
    this.activeKeys.delete(pending.key);
    pending.reject(error);
    this.publishQueueSnapshots();
  }

  private drain(): void {
    while (this.inFlight < this.maxConcurrent && this.queue.length > 0) {
      const pending = this.queue.shift();
      if (pending && !pending.settled) this.startPending(pending);
    }
  }

  private publishQueueSnapshots(): void {
    for (const [index, pending] of this.queue.entries()) {
      pending.snapshot = this.snapshot('queued', index + 1);
      this.publish(pending);
    }
  }

  private snapshot(
    state: TaskAdmissionState,
    queuePosition?: number
  ): TaskAdmissionSnapshot {
    return {
      state,
      ...(queuePosition !== undefined ? { queuePosition } : {}),
      queueDepth: this.queue.length,
      inFlight: this.inFlight,
      maxConcurrent: this.maxConcurrent,
      maxQueued: this.maxQueued,
    };
  }

  private publish(pending: PendingAdmission): void {
    try {
      pending.onUpdate?.({ ...pending.snapshot });
    } catch {
      // Admission accounting must not depend on observers.
    }
  }

  private detachAbort(pending: PendingAdmission): void {
    if (pending.abortListener && pending.signal) {
      pending.signal.removeEventListener('abort', pending.abortListener);
    }
    pending.abortListener = undefined;
  }

  private chargePending(pending: PendingAdmission): void {
    if (pending.charged) {
      throw new Error(`Task admission bytes already charged: ${pending.key}`);
    }
    if (pending.pendingBytes > this.maxQueuedBytes - this.pendingBytes) {
      throw new Error('Task admission byte accounting exceeded its configured limit');
    }
    this.pendingBytes += pending.pendingBytes;
    pending.charged = true;
  }

  private unchargePending(pending: PendingAdmission): void {
    if (!pending.charged) return;
    if (pending.pendingBytes > this.pendingBytes) {
      throw new Error('Task admission byte accounting underflow');
    }
    this.pendingBytes -= pending.pendingBytes;
    pending.charged = false;
  }

  private validateLimits(
    maxConcurrent: number,
    maxQueued: number,
    maxQueuedBytes: number,
    pendingBytes?: number
  ): void {
    if (!isValidConcurrentTaskLimit(maxConcurrent)) {
      throw new Error(
        `maxConcurrent must be an integer between ${MIN_CONCURRENT_TASKS} and ${MAX_CONCURRENT_TASKS}`
      );
    }
    if (!isValidQueuedTaskLimit(maxQueued)) {
      throw new Error(
        `maxQueued must be an integer between ${MIN_QUEUED_TASKS} and ${MAX_QUEUED_TASKS}`
      );
    }
    if (!isValidQueuedTaskByteLimit(maxQueuedBytes)) {
      throw new Error(
        `maxQueuedBytes must be an integer between ${MIN_MAX_QUEUED_TASK_BYTES} and ${MAX_MAX_QUEUED_TASK_BYTES}`
      );
    }
    if (
      pendingBytes !== undefined &&
      (!Number.isSafeInteger(pendingBytes) ||
        pendingBytes <= 0 ||
        pendingBytes > MAX_MAX_QUEUED_TASK_BYTES + 1)
    ) {
      throw new Error(
        `pendingBytes must be an integer between 1 and ${MAX_MAX_QUEUED_TASK_BYTES + 1}`
      );
    }
  }
}

export const taskRunScheduler = new TaskRunScheduler();
