import { ToolKind } from '../types/ToolTypes.js';

export const TOOL_ADMISSION_GLOBAL_MAX_IN_FLIGHT = 32;
export const TOOL_ADMISSION_GLOBAL_MAX_PENDING = 256;
export const TOOL_ADMISSION_SESSION_MAX_IN_FLIGHT = 10;
export const TOOL_ADMISSION_SESSION_MAX_PENDING = 64;
export const TOOL_ADMISSION_WAIT_TIMEOUT_MS = 180_000;

export const TOOL_ADMISSION_GLOBAL_KIND_LIMITS = {
  readonly: 24,
  write: 8,
  execute: 3,
} as const;

export const TOOL_ADMISSION_SESSION_KIND_LIMITS = {
  readonly: 8,
  write: 4,
  execute: 2,
} as const;

type KindLimits = Record<ToolKind, number>;

export interface ToolAdmissionLimits {
  /** Compatibility aliases for per-kind process limits. */
  readonly?: number;
  write?: number;
  execute?: number;
  globalMaxInFlight?: number;
  globalMaxPending?: number;
  sessionMaxInFlight?: number;
  sessionMaxPending?: number;
  waitTimeoutMs?: number;
  globalKindLimits?: Partial<Record<ToolKind, number>>;
  sessionKindLimits?: Partial<Record<ToolKind, number>>;
}

export type ConcurrencyLimits = ToolAdmissionLimits;

export type ToolAdmissionFailureReason = 'closed' | 'queue_full' | 'wait_timeout';
export type ToolAdmissionScope = 'global' | 'session';

export interface ToolAdmissionQueueSnapshot {
  kind: ToolKind;
  scope: ToolAdmissionScope;
  queuePosition: number;
  inFlight: number;
  limit: number;
}

export interface ToolAdmissionRequest {
  ownerId: string;
  sessionId: string;
  kind: ToolKind;
  signal?: AbortSignal;
  onAbort: () => unknown;
  onQueued?: (snapshot: ToolAdmissionQueueSnapshot) => void;
}

export interface ToolAdmissionStats {
  inFlight: number;
  queued: number;
  maxInFlight: number;
  maxPending: number;
  byKind: Record<ToolKind, { inFlight: number; queued: number; limit: number }>;
  sessions: Record<
    string,
    {
      inFlight: number;
      queued: number;
      maxInFlight: number;
      maxPending: number;
      byKind: Record<ToolKind, { inFlight: number; queued: number; limit: number }>;
    }
  >;
}

interface NormalizedLimits {
  globalMaxInFlight: number;
  globalMaxPending: number;
  sessionMaxInFlight: number;
  sessionMaxPending: number;
  waitTimeoutMs: number;
  globalKindLimits: KindLimits;
  sessionKindLimits: KindLimits;
}

interface SessionState {
  order: number;
  inFlight: number;
  queued: number;
  kindInFlight: KindLimits;
  kindQueued: KindLimits;
}

interface CapacityConstraint {
  scope: ToolAdmissionScope;
  dimension: 'total' | 'kind';
  inFlight: number;
  limit: number;
}

interface PendingTask<T> {
  ownerId: string;
  sessionId: string;
  kind: ToolKind;
  signal?: AbortSignal;
  onAbort: () => unknown;
  onQueued?: (snapshot: ToolAdmissionQueueSnapshot) => void;
  fn: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  abortListener?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
}

type ErasedPendingTask = PendingTask<unknown>;

export class ToolAdmissionError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly reason: ToolAdmissionFailureReason,
    readonly scope: ToolAdmissionScope,
    readonly kind: ToolKind,
    readonly limit: number,
    readonly queued: number
  ) {
    const retryable = reason !== 'closed';
    super(
      reason === 'queue_full'
        ? `Tool admission ${scope} queue is full`
        : reason === 'wait_timeout'
          ? `Tool admission timed out while waiting for ${scope} capacity`
          : 'Tool admission scheduler is closed'
    );
    this.name = 'ToolAdmissionError';
    this.retryable = retryable;
  }
}

function emptyKindCounters(): KindLimits {
  return {
    [ToolKind.ReadOnly]: 0,
    [ToolKind.Write]: 0,
    [ToolKind.Execute]: 0,
  };
}

function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a finite positive integer`);
  }
  return value;
}

function normalizeLimits(limits: ToolAdmissionLimits): NormalizedLimits {
  const globalMaxInFlight = validatePositiveInteger(
    limits.globalMaxInFlight ?? TOOL_ADMISSION_GLOBAL_MAX_IN_FLIGHT,
    'globalMaxInFlight'
  );
  const globalMaxPending = validatePositiveInteger(
    limits.globalMaxPending ?? TOOL_ADMISSION_GLOBAL_MAX_PENDING,
    'globalMaxPending'
  );
  const sessionMaxInFlight = validatePositiveInteger(
    limits.sessionMaxInFlight ??
      Math.min(TOOL_ADMISSION_SESSION_MAX_IN_FLIGHT, globalMaxInFlight),
    'sessionMaxInFlight'
  );
  const sessionMaxPending = validatePositiveInteger(
    limits.sessionMaxPending ?? TOOL_ADMISSION_SESSION_MAX_PENDING,
    'sessionMaxPending'
  );
  const waitTimeoutMs = validatePositiveInteger(
    limits.waitTimeoutMs ?? TOOL_ADMISSION_WAIT_TIMEOUT_MS,
    'waitTimeoutMs'
  );
  if (sessionMaxInFlight > globalMaxInFlight) {
    throw new Error('sessionMaxInFlight must not exceed globalMaxInFlight');
  }
  if (sessionMaxPending > globalMaxPending) {
    throw new Error('sessionMaxPending must not exceed globalMaxPending');
  }

  const globalKindLimits: KindLimits = {
    [ToolKind.ReadOnly]: validatePositiveInteger(
      limits.globalKindLimits?.[ToolKind.ReadOnly] ??
        limits.readonly ??
        TOOL_ADMISSION_GLOBAL_KIND_LIMITS.readonly,
      'globalKindLimits.readonly'
    ),
    [ToolKind.Write]: validatePositiveInteger(
      limits.globalKindLimits?.[ToolKind.Write] ??
        limits.write ??
        TOOL_ADMISSION_GLOBAL_KIND_LIMITS.write,
      'globalKindLimits.write'
    ),
    [ToolKind.Execute]: validatePositiveInteger(
      limits.globalKindLimits?.[ToolKind.Execute] ??
        limits.execute ??
        TOOL_ADMISSION_GLOBAL_KIND_LIMITS.execute,
      'globalKindLimits.execute'
    ),
  };
  const sessionKindLimits: KindLimits = {
    [ToolKind.ReadOnly]: validatePositiveInteger(
      limits.sessionKindLimits?.[ToolKind.ReadOnly] ??
        Math.min(
          TOOL_ADMISSION_SESSION_KIND_LIMITS.readonly,
          globalKindLimits[ToolKind.ReadOnly],
          sessionMaxInFlight
        ),
      'sessionKindLimits.readonly'
    ),
    [ToolKind.Write]: validatePositiveInteger(
      limits.sessionKindLimits?.[ToolKind.Write] ??
        Math.min(
          TOOL_ADMISSION_SESSION_KIND_LIMITS.write,
          globalKindLimits[ToolKind.Write],
          sessionMaxInFlight
        ),
      'sessionKindLimits.write'
    ),
    [ToolKind.Execute]: validatePositiveInteger(
      limits.sessionKindLimits?.[ToolKind.Execute] ??
        Math.min(
          TOOL_ADMISSION_SESSION_KIND_LIMITS.execute,
          globalKindLimits[ToolKind.Execute],
          sessionMaxInFlight
        ),
      'sessionKindLimits.execute'
    ),
  };

  for (const kind of Object.values(ToolKind)) {
    if (sessionKindLimits[kind] > globalKindLimits[kind]) {
      throw new Error(
        `sessionKindLimits.${kind} must not exceed globalKindLimits.${kind}`
      );
    }
  }

  return {
    globalMaxInFlight,
    globalMaxPending,
    sessionMaxInFlight,
    sessionMaxPending,
    waitTimeoutMs,
    globalKindLimits,
    sessionKindLimits,
  };
}

export class ConcurrencyScheduler {
  private static instance: ConcurrencyScheduler | null = null;

  private readonly limits: NormalizedLimits;
  private readonly queue: ErasedPendingTask[] = [];
  private readonly sessions = new Map<string, SessionState>();
  private readonly globalKindInFlight = emptyKindCounters();
  private globalInFlight = 0;
  private nextSessionOrder = 1;
  private lastAdmittedOrder = 0;
  private closed = false;

  constructor(limits: ToolAdmissionLimits = {}) {
    this.limits = normalizeLimits(limits);
  }

  static getInstance(): ConcurrencyScheduler {
    if (!ConcurrencyScheduler.instance) {
      ConcurrencyScheduler.instance = new ConcurrencyScheduler();
    }
    return ConcurrencyScheduler.instance;
  }

  /** Test-only reset. Production Session disposal must use cancelOwner(). */
  static resetInstance(): void {
    ConcurrencyScheduler.instance?.close();
    ConcurrencyScheduler.instance = null;
  }

  schedule<T>(request: ToolAdmissionRequest, fn: () => Promise<T>): Promise<T>;
  schedule<T>(kind: ToolKind, fn: () => Promise<T>): Promise<T>;
  schedule<T>(
    requestOrKind: ToolAdmissionRequest | ToolKind,
    fn: () => Promise<T>
  ): Promise<T> {
    const request: ToolAdmissionRequest =
      typeof requestOrKind === 'string'
        ? {
            ownerId: 'legacy-owner',
            sessionId: 'legacy-session',
            kind: requestOrKind,
            onAbort: () => {
              throw new ToolAdmissionError(
                'closed',
                'global',
                requestOrKind,
                this.limits.globalMaxInFlight,
                this.queue.length
              );
            },
          }
        : requestOrKind;

    if (this.closed) {
      return Promise.reject(
        new ToolAdmissionError(
          'closed',
          'global',
          request.kind,
          this.limits.globalMaxInFlight,
          this.queue.length
        )
      );
    }
    if (request.signal?.aborted) {
      return this.resolveAbort<T>(request.onAbort);
    }

    const session = this.getOrCreateSession(request.sessionId);
    if (this.queue.length === 0 && this.canStart(request.sessionId, request.kind)) {
      this.lastAdmittedOrder = session.order;
      return this.runImmediately(request.sessionId, request.kind, fn);
    }

    if (session.queued >= this.limits.sessionMaxPending) {
      this.deleteIdleSession(request.sessionId, session);
      return Promise.reject(
        new ToolAdmissionError(
          'queue_full',
          'session',
          request.kind,
          this.limits.sessionMaxPending,
          session.queued
        )
      );
    }
    if (this.queue.length >= this.limits.globalMaxPending) {
      this.deleteIdleSession(request.sessionId, session);
      return Promise.reject(
        new ToolAdmissionError(
          'queue_full',
          'global',
          request.kind,
          this.limits.globalMaxPending,
          this.queue.length
        )
      );
    }

    return new Promise<T>((resolve, reject) => {
      const task: PendingTask<T> = {
        ...request,
        fn,
        resolve,
        reject,
        settled: false,
      };
      if (request.signal) {
        task.abortListener = () => this.abortTask(task as ErasedPendingTask);
        request.signal.addEventListener('abort', task.abortListener, { once: true });
      }
      task.timer = setTimeout(
        () => this.timeoutTask(task as ErasedPendingTask),
        this.limits.waitTimeoutMs
      );
      task.timer.unref?.();

      this.queue.push(task as ErasedPendingTask);
      session.queued++;
      session.kindQueued[request.kind]++;
      this.drain();
      if (!task.settled) {
        try {
          request.onQueued?.(this.queueSnapshot(task as ErasedPendingTask));
        } catch {
          // Queue observability must not change admission ownership.
        }
      }
    });
  }

  cancelOwner(ownerId: string): void {
    const owned = this.queue.filter((task) => task.ownerId === ownerId);
    for (const task of owned) this.abortTask(task);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const task of [...this.queue]) this.abortTask(task);
  }

  getStats(): Record<ToolKind, { inFlight: number; queued: number }> {
    const queued = emptyKindCounters();
    for (const task of this.queue) queued[task.kind]++;
    return {
      [ToolKind.ReadOnly]: {
        inFlight: this.globalKindInFlight[ToolKind.ReadOnly],
        queued: queued[ToolKind.ReadOnly],
      },
      [ToolKind.Write]: {
        inFlight: this.globalKindInFlight[ToolKind.Write],
        queued: queued[ToolKind.Write],
      },
      [ToolKind.Execute]: {
        inFlight: this.globalKindInFlight[ToolKind.Execute],
        queued: queued[ToolKind.Execute],
      },
    };
  }

  getAdmissionStats(): ToolAdmissionStats {
    const byKindStats = this.getStats();
    const sessions: ToolAdmissionStats['sessions'] = {};
    for (const [sessionId, state] of this.sessions) {
      sessions[sessionId] = {
        inFlight: state.inFlight,
        queued: state.queued,
        maxInFlight: this.limits.sessionMaxInFlight,
        maxPending: this.limits.sessionMaxPending,
        byKind: {
          [ToolKind.ReadOnly]: {
            inFlight: state.kindInFlight[ToolKind.ReadOnly],
            queued: state.kindQueued[ToolKind.ReadOnly],
            limit: this.limits.sessionKindLimits[ToolKind.ReadOnly],
          },
          [ToolKind.Write]: {
            inFlight: state.kindInFlight[ToolKind.Write],
            queued: state.kindQueued[ToolKind.Write],
            limit: this.limits.sessionKindLimits[ToolKind.Write],
          },
          [ToolKind.Execute]: {
            inFlight: state.kindInFlight[ToolKind.Execute],
            queued: state.kindQueued[ToolKind.Execute],
            limit: this.limits.sessionKindLimits[ToolKind.Execute],
          },
        },
      };
    }
    return {
      inFlight: this.globalInFlight,
      queued: this.queue.length,
      maxInFlight: this.limits.globalMaxInFlight,
      maxPending: this.limits.globalMaxPending,
      byKind: {
        [ToolKind.ReadOnly]: {
          ...byKindStats[ToolKind.ReadOnly],
          limit: this.limits.globalKindLimits[ToolKind.ReadOnly],
        },
        [ToolKind.Write]: {
          ...byKindStats[ToolKind.Write],
          limit: this.limits.globalKindLimits[ToolKind.Write],
        },
        [ToolKind.Execute]: {
          ...byKindStats[ToolKind.Execute],
          limit: this.limits.globalKindLimits[ToolKind.Execute],
        },
      },
      sessions,
    };
  }

  private getOrCreateSession(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        order: this.nextSessionOrder++,
        inFlight: 0,
        queued: 0,
        kindInFlight: emptyKindCounters(),
        kindQueued: emptyKindCounters(),
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  private canStart(sessionId: string, kind: ToolKind): boolean {
    const session = this.getOrCreateSession(sessionId);
    return (
      this.globalInFlight < this.limits.globalMaxInFlight &&
      this.globalKindInFlight[kind] < this.limits.globalKindLimits[kind] &&
      session.inFlight < this.limits.sessionMaxInFlight &&
      session.kindInFlight[kind] < this.limits.sessionKindLimits[kind]
    );
  }

  private async runImmediately<T>(
    sessionId: string,
    kind: ToolKind,
    fn: () => Promise<T>
  ): Promise<T> {
    this.acquire(sessionId, kind);
    try {
      return await fn();
    } finally {
      this.release(sessionId, kind);
      this.drain();
    }
  }

  private drain(): void {
    if (this.closed) return;
    while (this.queue.length > 0) {
      const firstTaskBySession = new Map<string, ErasedPendingTask>();
      for (const task of this.queue) {
        if (!firstTaskBySession.has(task.sessionId)) {
          firstTaskBySession.set(task.sessionId, task);
        }
      }
      const eligible = [...firstTaskBySession.values()]
        .filter((task) => this.canStart(task.sessionId, task.kind))
        .map((task) => ({
          task,
          order: this.sessions.get(task.sessionId)!.order,
        }));
      if (eligible.length === 0) return;
      const afterCursor = eligible
        .filter((candidate) => candidate.order > this.lastAdmittedOrder)
        .sort((a, b) => a.order - b.order);
      const selected = afterCursor[0] ?? eligible.sort((a, b) => a.order - b.order)[0];
      const selectedIndex = this.queue.indexOf(selected.task);

      const [task] = this.queue.splice(selectedIndex, 1);
      this.removeQueuedAccounting(task);
      this.cleanupTask(task);
      task.settled = true;
      this.lastAdmittedOrder = selected.order;
      this.acquire(task.sessionId, task.kind);
      Promise.resolve()
        .then(task.fn)
        .then(task.resolve, task.reject)
        .finally(() => {
          this.release(task.sessionId, task.kind);
          this.drain();
        });
    }
  }

  private acquire(sessionId: string, kind: ToolKind): void {
    const session = this.getOrCreateSession(sessionId);
    this.globalInFlight++;
    this.globalKindInFlight[kind]++;
    session.inFlight++;
    session.kindInFlight[kind]++;
  }

  private release(sessionId: string, kind: ToolKind): void {
    const session = this.sessions.get(sessionId);
    this.globalInFlight = Math.max(0, this.globalInFlight - 1);
    this.globalKindInFlight[kind] = Math.max(0, this.globalKindInFlight[kind] - 1);
    if (session) {
      session.inFlight = Math.max(0, session.inFlight - 1);
      session.kindInFlight[kind] = Math.max(0, session.kindInFlight[kind] - 1);
      this.deleteIdleSession(sessionId, session);
    }
  }

  private abortTask(task: ErasedPendingTask): void {
    if (!this.removePendingTask(task)) return;
    try {
      task.resolve(task.onAbort());
    } catch (error) {
      task.reject(error);
    }
    this.drain();
  }

  private timeoutTask(task: ErasedPendingTask): void {
    const constraint = this.capacityConstraint(task.sessionId, task.kind);
    if (!this.removePendingTask(task)) return;
    task.reject(
      new ToolAdmissionError(
        'wait_timeout',
        constraint.scope,
        task.kind,
        constraint.limit,
        this.queue.length
      )
    );
    this.drain();
  }

  private removePendingTask(task: ErasedPendingTask): boolean {
    if (task.settled) return false;
    const index = this.queue.indexOf(task);
    if (index === -1) return false;
    task.settled = true;
    this.queue.splice(index, 1);
    this.removeQueuedAccounting(task);
    this.cleanupTask(task);
    return true;
  }

  private removeQueuedAccounting(task: ErasedPendingTask): void {
    const session = this.sessions.get(task.sessionId);
    if (!session) return;
    session.queued = Math.max(0, session.queued - 1);
    session.kindQueued[task.kind] = Math.max(0, session.kindQueued[task.kind] - 1);
    this.deleteIdleSession(task.sessionId, session);
  }

  private cleanupTask(task: ErasedPendingTask): void {
    if (task.timer) clearTimeout(task.timer);
    task.timer = undefined;
    if (task.signal && task.abortListener) {
      task.signal.removeEventListener('abort', task.abortListener);
    }
    task.abortListener = undefined;
    task.signal = undefined;
  }

  private deleteIdleSession(sessionId: string, state: SessionState): void {
    if (state.inFlight === 0 && state.queued === 0) {
      this.sessions.delete(sessionId);
    }
  }

  private queueSnapshot(task: ErasedPendingTask): ToolAdmissionQueueSnapshot {
    const constraint = this.capacityConstraint(task.sessionId, task.kind);
    const sameScopeQueue = this.queue.filter((candidate) =>
      constraint.scope === 'session'
        ? candidate.sessionId === task.sessionId
        : constraint.dimension === 'total' || candidate.kind === task.kind
    );
    return {
      kind: task.kind,
      scope: constraint.scope,
      queuePosition: sameScopeQueue.indexOf(task) + 1,
      inFlight: constraint.inFlight,
      limit: constraint.limit,
    };
  }

  private capacityConstraint(sessionId: string, kind: ToolKind): CapacityConstraint {
    const session = this.sessions.get(sessionId);
    if (session && session.kindInFlight[kind] >= this.limits.sessionKindLimits[kind]) {
      return {
        scope: 'session',
        dimension: 'kind',
        inFlight: session.kindInFlight[kind],
        limit: this.limits.sessionKindLimits[kind],
      };
    }
    if (session && session.inFlight >= this.limits.sessionMaxInFlight) {
      return {
        scope: 'session',
        dimension: 'total',
        inFlight: session.inFlight,
        limit: this.limits.sessionMaxInFlight,
      };
    }
    if (this.globalKindInFlight[kind] >= this.limits.globalKindLimits[kind]) {
      return {
        scope: 'global',
        dimension: 'kind',
        inFlight: this.globalKindInFlight[kind],
        limit: this.limits.globalKindLimits[kind],
      };
    }
    if (this.globalInFlight >= this.limits.globalMaxInFlight) {
      return {
        scope: 'global',
        dimension: 'total',
        inFlight: this.globalInFlight,
        limit: this.limits.globalMaxInFlight,
      };
    }
    return {
      scope: 'session',
      dimension: 'total',
      inFlight: session?.inFlight ?? 0,
      limit: this.limits.sessionMaxInFlight,
    };
  }

  private resolveAbort<T>(onAbort: () => unknown): Promise<T> {
    try {
      return Promise.resolve(onAbort() as T);
    } catch (error) {
      return Promise.reject(error);
    }
  }
}
