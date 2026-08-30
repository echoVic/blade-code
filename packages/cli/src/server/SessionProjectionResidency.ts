import {
  isValidResidentSessionProjectionLimit,
  isValidSessionProjectionIdleMs,
} from '../config/sessionProjectionResidency.js';

export interface SessionProjectionResidencyOptions<T, S> {
  maxResident: number;
  idleMs: number;
  toSnapshot(value: T): S;
  now?: () => number;
}

export interface SessionProjectionLease<T> {
  readonly key: string;
  readonly generation: number;
  readonly value: T;
  isCurrent(): boolean;
  release(): void;
}

export interface SessionProjectionReservation<T> {
  readonly key: string;
  readonly generation: number;
  commit(value: T): SessionProjectionLease<T>;
  cancel(): void;
}

export interface SessionProjectionStats {
  resident: number;
  closing: number;
  reserved: number;
  pinned: number;
  retained: number;
  maxResident: number;
  idleMs: number;
}

export interface SessionProjectionDebugStats {
  tombstones: number;
  waiters: number;
  listeners: number;
}

export class SessionProjectionCapacityError extends Error {
  readonly resource = 'resident_session_projections' as const;
  readonly retryable = true;

  constructor(public readonly limit: number) {
    super('Session projection capacity is full');
    this.name = 'SessionProjectionCapacityError';
  }
}

export class SessionProjectionResidencyClosedError extends Error {
  constructor(public readonly reason = 'Session projection residency is closed') {
    super(reason);
    this.name = 'SessionProjectionResidencyClosedError';
  }
}

export class SessionProjectionResidencyConflictError extends Error {
  constructor(
    public readonly key: string,
    message = `Session projection residency already owns key: ${key}`
  ) {
    super(message);
    this.name = 'SessionProjectionResidencyConflictError';
  }
}

export class SessionProjectionResidencyCloseTimeoutError extends Error {
  constructor(public readonly deadlineAt: number) {
    super(`Session projection close wait timed out at ${deadlineAt}`);
    this.name = 'SessionProjectionResidencyCloseTimeoutError';
  }
}

interface ReservationState {
  readonly key: string;
  readonly generation: number;
}

type EntryPhase = 'resident' | 'closing';

interface ProjectionEntry<T> {
  readonly key: string;
  generation: number;
  value: T | undefined;
  pins: number;
  lastUsedAt: number;
  phase: EntryPhase;
}

interface IdleWaiter {
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  removeAbortListener: (() => void) | undefined;
}

interface CloseState<T, S> {
  readonly keys: string[];
  readonly generations: Map<string, number>;
  readonly snapshots: Map<string, S>;
  readonly entries: Map<string, ProjectionEntry<T>>;
  readonly originalResidentKeys: Set<string>;
  readonly waiters: Set<IdleWaiter>;
  state: 'open' | 'committed' | 'rolled_back';
  rollbackReplacements?: Map<string, T | undefined>;
}

function sameReplacementIdentity<T>(
  current: Map<string, T | undefined>,
  next: Map<string, T | undefined>
): boolean {
  if (current.size !== next.size) return false;
  for (const [key, value] of current) {
    if (!next.has(key) || next.get(key) !== value) return false;
  }
  return true;
}

export class SessionProjectionResidency<T, S> {
  private readonly maxResident: number;
  private readonly idleMs: number;
  private readonly toSnapshot: (value: T) => S;
  private readonly now: () => number;

  private readonly residents = new Map<string, ProjectionEntry<T>>();
  private readonly reservations = new Map<string, ReservationState>();
  private readonly closings = new Map<string, ProjectionEntry<T>>();
  private readonly closeStates = new Set<CloseState<T, S>>();
  private readonly capacityListeners = new Set<() => void>();

  private nextGeneration = 1;
  private closed = false;
  private closedReason = 'Session projection residency is closed';
  private invalidationPromise: Promise<void> | undefined;
  private resolveInvalidation: (() => void) | undefined;

  constructor(options: SessionProjectionResidencyOptions<T, S>) {
    if (!isValidResidentSessionProjectionLimit(options.maxResident)) {
      throw new Error('Invalid max resident Session projection limit');
    }
    if (!isValidSessionProjectionIdleMs(options.idleMs)) {
      throw new Error('Invalid Session projection idle timeout');
    }
    this.maxResident = options.maxResident;
    this.idleMs = options.idleMs;
    this.toSnapshot = options.toSnapshot;
    this.now = options.now ?? Date.now;
  }

  acquire(key: string): SessionProjectionLease<T> | undefined {
    this.assertNotClosed();
    if (this.closings.has(key)) {
      throw new SessionProjectionResidencyConflictError(key);
    }
    const resident = this.residents.get(key);
    if (!resident || resident.value === undefined) return undefined;
    resident.pins++;
    return this.createLease(resident);
  }

  reserve(key: string): SessionProjectionReservation<T> {
    this.assertNotClosed();
    this.assertKeyOpen(key);
    this.makeCapacityForReservation();
    const reservation: ReservationState = {
      key,
      generation: this.allocateGeneration(),
    };
    this.reservations.set(key, reservation);
    return this.createReservation(reservation);
  }

  snapshot(key: string): S | undefined {
    const resident = this.residents.get(key);
    if (!resident || resident.value === undefined) return undefined;
    return this.projectSnapshot(resident.value);
  }

  snapshotAll(): S[] {
    const snapshots: S[] = [];
    for (const resident of this.residents.values()) {
      if (resident.value === undefined) continue;
      const snapshot = this.projectSnapshot(resident.value);
      if (snapshot !== undefined) snapshots.push(snapshot);
    }
    return snapshots;
  }

  beginCloseMany(keys: readonly string[], _reason: string) {
    this.assertNotClosed();
    const normalizedKeys = [...new Set(keys)].sort((left, right) =>
      left.localeCompare(right)
    );
    for (const key of normalizedKeys) {
      if (this.closings.has(key)) {
        throw new SessionProjectionResidencyConflictError(
          key,
          `Session projection residency is already closing key: ${key}`
        );
      }
    }

    const generations = new Map<string, number>();
    const snapshots = new Map<string, S>();
    const entries = new Map<string, ProjectionEntry<T>>();
    const originalResidentKeys = new Set<string>();

    for (const key of normalizedKeys) {
      const reservation = this.reservations.get(key);
      if (reservation) {
        this.reservations.delete(key);
      }

      const resident = this.residents.get(key);
      if (resident) {
        this.residents.delete(key);
        resident.phase = 'closing';
        entries.set(key, resident);
        this.closings.set(key, resident);
        generations.set(key, resident.generation);
        originalResidentKeys.add(key);
        if (resident.value !== undefined) {
          const snapshot = this.projectSnapshot(resident.value);
          if (snapshot !== undefined) snapshots.set(key, snapshot);
        }
        continue;
      }

      const entry: ProjectionEntry<T> = {
        key,
        generation: reservation?.generation ?? this.allocateGeneration(),
        value: undefined,
        pins: 0,
        lastUsedAt: this.now(),
        phase: 'closing',
      };
      entries.set(key, entry);
      this.closings.set(key, entry);
      generations.set(key, entry.generation);
    }

    const closeState: CloseState<T, S> = {
      keys: normalizedKeys,
      generations,
      snapshots,
      entries,
      originalResidentKeys,
      waiters: new Set(),
      state: 'open',
    };
    this.closeStates.add(closeState);
    this.notifyCapacityAvailableIf(true);

    const ensureOpen = () => {
      if (closeState.state === 'committed') {
        throw new SessionProjectionResidencyClosedError(
          'Session projection close set is already committed'
        );
      }
      if (closeState.state === 'rolled_back') {
        throw new SessionProjectionResidencyClosedError(
          'Session projection close set is already rolled back'
        );
      }
    };

    const idle = () => {
      for (const entry of closeState.entries.values()) {
        if (entry.pins > 0) return false;
      }
      return true;
    };

    const resolveWaiters = () => {
      if (!idle()) return;
      for (const waiter of closeState.waiters) {
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        waiter.removeAbortListener?.();
        waiter.resolve();
      }
      closeState.waiters.clear();
    };

    const waitForIdle = ({
      signal,
      deadlineAt,
    }: {
      signal?: AbortSignal;
      deadlineAt?: number;
    } = {}): Promise<void> => {
      if (closeState.state !== 'open' || idle()) {
        return Promise.resolve();
      }
      if (deadlineAt !== undefined && deadlineAt <= this.now()) {
        return Promise.reject(
          new SessionProjectionResidencyCloseTimeoutError(deadlineAt)
        );
      }
      return new Promise<void>((resolve, reject) => {
        const waiter: IdleWaiter = {
          resolve: () => resolve(),
          reject,
          timer: undefined,
          removeAbortListener: undefined,
        };
        closeState.waiters.add(waiter);
        if (deadlineAt !== undefined) {
          const timeoutMs = Math.max(0, deadlineAt - this.now());
          waiter.timer = setTimeout(() => {
            closeState.waiters.delete(waiter);
            waiter.removeAbortListener?.();
            reject(new SessionProjectionResidencyCloseTimeoutError(deadlineAt));
          }, timeoutMs);
        }
        if (signal) {
          const onAbort = () => {
            closeState.waiters.delete(waiter);
            if (waiter.timer !== undefined) clearTimeout(waiter.timer);
            signal.removeEventListener('abort', onAbort);
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error(String(signal.reason ?? 'AbortError'))
            );
          };
          signal.addEventListener('abort', onAbort, { once: true });
          waiter.removeAbortListener = () => {
            signal.removeEventListener('abort', onAbort);
          };
          if (signal.aborted) {
            onAbort();
          }
        }
      });
    };

    const commit = () => {
      if (closeState.state === 'committed') return;
      ensureOpen();
      if (!idle()) {
        throw new SessionProjectionResidencyConflictError(
          closeState.keys[0] ?? '',
          'Session projection close set still has active pins'
        );
      }
      let freedCapacity = false;
      for (const key of closeState.keys) {
        const entry = closeState.entries.get(key);
        if (!entry) continue;
        if (this.closings.get(key) === entry) {
          this.closings.delete(key);
          if (entry.value !== undefined) freedCapacity = true;
        }
      }
      closeState.state = 'committed';
      this.closeStates.delete(closeState);
      resolveWaiters();
      this.notifyCapacityAvailableIf(freedCapacity);
    };

    const rollback = (replacements: Map<string, T | undefined>) => {
      if (this.closed) {
        throw new SessionProjectionResidencyClosedError(this.closedReason);
      }
      if (closeState.state === 'committed') {
        throw new SessionProjectionResidencyClosedError(
          'Session projection close set is already committed'
        );
      }
      if (closeState.state === 'rolled_back') {
        if (!closeState.rollbackReplacements) return;
        if (!sameReplacementIdentity(closeState.rollbackReplacements, replacements)) {
          throw new SessionProjectionResidencyConflictError(
            closeState.keys[0] ?? '',
            'Session projection close set rollback replacements changed'
          );
        }
        return;
      }
      if (!idle()) {
        throw new SessionProjectionResidencyConflictError(
          closeState.keys[0] ?? '',
          'Session projection close set still has active pins'
        );
      }
      for (const key of closeState.originalResidentKeys) {
        if (!replacements.has(key)) {
          throw new SessionProjectionResidencyConflictError(
            key,
            `Session projection close rollback requires replacement for key: ${key}`
          );
        }
      }
      let freedCapacity = false;
      let restoredCapacity = false;
      const now = this.now();
      for (const key of closeState.keys) {
        const entry = closeState.entries.get(key);
        if (!entry) continue;
        if (this.closings.get(key) === entry) {
          this.closings.delete(key);
        }
        if (!closeState.originalResidentKeys.has(key)) {
          freedCapacity ||= entry.value !== undefined;
          continue;
        }
        const replacement = replacements.get(key);
        if (replacement === undefined) {
          freedCapacity ||= entry.value !== undefined;
          continue;
        }
        entry.value = replacement;
        entry.phase = 'resident';
        entry.lastUsedAt = now;
        this.residents.set(key, entry);
        if (entry.pins === 0) restoredCapacity = true;
      }
      closeState.rollbackReplacements = new Map(replacements);
      closeState.state = 'rolled_back';
      this.closeStates.delete(closeState);
      resolveWaiters();
      this.notifyCapacityAvailableIf(freedCapacity || restoredCapacity);
    };

    return {
      keys: closeState.keys,
      generations: closeState.generations,
      snapshots: closeState.snapshots,
      waitForIdle,
      commit,
      rollback,
    };
  }

  invalidateAll(reason: string): Promise<void> {
    if (this.closed && this.invalidationPromise) {
      return this.invalidationPromise;
    }
    this.closed = true;
    this.closedReason = reason;
    for (const key of [...this.reservations.keys()]) {
      this.reservations.delete(key);
    }

    for (const [key, resident] of [...this.residents.entries()]) {
      this.residents.delete(key);
      resident.phase = 'closing';
      this.closings.set(key, resident);
    }

    this.invalidationPromise = new Promise<void>((resolve) => {
      this.resolveInvalidation = resolve;
    });
    this.maybeFinishInvalidation();
    return this.invalidationPromise;
  }

  sweepIdle(): number {
    if (this.closed) return 0;
    const now = this.now();
    let evicted = 0;
    while (true) {
      const candidate = [...this.residents.values()]
        .filter((entry) => entry.pins === 0)
        .sort(
          (left, right) =>
            left.lastUsedAt - right.lastUsedAt || left.generation - right.generation
        )
        .find((entry) => now - entry.lastUsedAt >= this.idleMs);
      if (!candidate) return evicted;
      this.residents.delete(candidate.key);
      evicted++;
      this.notifyCapacityAvailableIf(true);
    }
  }

  onCapacityAvailable(listener: () => void): () => void {
    this.capacityListeners.add(listener);
    return () => {
      this.capacityListeners.delete(listener);
    };
  }

  getStats(): SessionProjectionStats {
    let resident = 0;
    let closing = 0;
    const reserved = this.reservations.size;
    let pinned = 0;

    for (const entry of this.residents.values()) {
      resident++;
      if (entry.pins > 0) pinned++;
    }
    for (const entry of this.closings.values()) {
      closing++;
      if (entry.pins > 0) pinned++;
    }

    return {
      resident,
      closing,
      reserved,
      pinned,
      retained: resident + reserved + this.countClosingWithValue(),
      maxResident: this.maxResident,
      idleMs: this.idleMs,
    };
  }

  getDebugStats(): SessionProjectionDebugStats {
    let tombstones = 0;
    let waiters = 0;
    for (const entry of this.closings.values()) {
      if (entry.value === undefined) tombstones++;
    }
    for (const state of this.closeStates) {
      waiters += state.waiters.size;
    }
    return {
      tombstones,
      waiters,
      listeners: this.capacityListeners.size,
    };
  }

  private assertNotClosed(): void {
    if (this.closed) {
      throw new SessionProjectionResidencyClosedError(this.closedReason);
    }
  }

  private assertKeyOpen(key: string): void {
    if (
      this.residents.has(key) ||
      this.reservations.has(key) ||
      this.closings.has(key)
    ) {
      throw new SessionProjectionResidencyConflictError(key);
    }
  }

  private retainedCount(): number {
    return this.residents.size + this.reservations.size + this.countClosingWithValue();
  }

  private countClosingWithValue(): number {
    let count = 0;
    for (const entry of this.closings.values()) {
      if (entry.value !== undefined) count++;
    }
    return count;
  }

  private allocateGeneration(): number {
    const generation = this.nextGeneration;
    this.nextGeneration =
      this.nextGeneration === Number.MAX_SAFE_INTEGER ? 1 : this.nextGeneration + 1;
    return generation;
  }

  private createReservation(
    reservation: ReservationState
  ): SessionProjectionReservation<T> {
    let settled = false;
    return {
      key: reservation.key,
      generation: reservation.generation,
      commit: (value) => {
        if (settled) {
          throw new SessionProjectionResidencyConflictError(reservation.key);
        }
        if (this.closed) {
          this.reservations.delete(reservation.key);
          settled = true;
          throw new SessionProjectionResidencyClosedError(this.closedReason);
        }
        if (this.reservations.get(reservation.key) !== reservation) {
          settled = true;
          throw new SessionProjectionResidencyConflictError(reservation.key);
        }
        this.reservations.delete(reservation.key);
        const entry: ProjectionEntry<T> = {
          key: reservation.key,
          generation: reservation.generation,
          value,
          pins: 1,
          lastUsedAt: this.now(),
          phase: 'resident',
        };
        this.residents.set(reservation.key, entry);
        settled = true;
        return this.createLease(entry);
      },
      cancel: () => {
        if (settled) return;
        if (this.reservations.get(reservation.key) === reservation) {
          this.reservations.delete(reservation.key);
          this.notifyCapacityAvailableIf(true);
        }
        settled = true;
      },
    };
  }

  private createLease(entry: ProjectionEntry<T>): SessionProjectionLease<T> {
    let released = false;
    return {
      key: entry.key,
      generation: entry.generation,
      get value() {
        return entry.value as T;
      },
      isCurrent: () => {
        const resident = this.residents.get(entry.key);
        if (resident === entry && resident.generation === entry.generation) return true;
        const closing = this.closings.get(entry.key);
        return closing === entry && closing.generation === entry.generation;
      },
      release: () => {
        if (released) return;
        released = true;
        const currentResident = this.residents.get(entry.key);
        const currentClosing = this.closings.get(entry.key);
        const current =
          currentResident === entry && currentResident.generation === entry.generation
            ? currentResident
            : currentClosing === entry && currentClosing.generation === entry.generation
              ? currentClosing
              : undefined;
        if (!current) return;
        current.pins = Math.max(0, current.pins - 1);
        current.lastUsedAt = this.now();
        this.notifyCapacityAvailableIf(true);
        this.resolveIdleWaitersForEntry(current);
        this.maybeFinishInvalidation();
      },
    };
  }

  private makeCapacityForReservation(): void {
    while (this.retainedCount() >= this.maxResident) {
      const candidate = [...this.residents.values()]
        .filter((entry) => entry.pins === 0)
        .sort(
          (left, right) =>
            left.lastUsedAt - right.lastUsedAt || left.generation - right.generation
        )[0];
      if (!candidate) {
        throw new SessionProjectionCapacityError(this.maxResident);
      }
      this.residents.delete(candidate.key);
    }
  }

  private projectSnapshot(value: T): S | undefined {
    try {
      return this.toSnapshot(value);
    } catch {
      return undefined;
    }
  }

  private resolveIdleWaitersForEntry(entry: ProjectionEntry<T>): void {
    if (entry.pins > 0) return;
    for (const state of this.closeStates) {
      if (!state.entries.has(entry.key)) continue;
      let allIdle = true;
      for (const closeEntry of state.entries.values()) {
        if (closeEntry.pins > 0) {
          allIdle = false;
          break;
        }
      }
      if (!allIdle) continue;
      for (const waiter of state.waiters) {
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        waiter.removeAbortListener?.();
        waiter.resolve();
      }
      state.waiters.clear();
    }
  }

  private maybeFinishInvalidation(): void {
    if (!this.closed || !this.resolveInvalidation) return;
    for (const entry of this.closings.values()) {
      if (entry.pins > 0) return;
    }
    this.closings.clear();
    const resolve = this.resolveInvalidation;
    this.resolveInvalidation = undefined;
    resolve();
  }

  private notifyCapacityAvailableIf(shouldNotify: boolean): void {
    if (!shouldNotify) return;
    for (const listener of [...this.capacityListeners]) {
      try {
        listener();
      } catch {
        // Listener failures are isolated and must not leak into residency flows.
      }
    }
  }
}
