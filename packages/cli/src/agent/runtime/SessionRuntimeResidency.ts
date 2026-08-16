import { Mutex } from 'async-mutex';
import {
  isValidResidentSessionRuntimeLimit,
  isValidSessionRuntimeIdleMs,
} from '../../config/sessionRuntimeResidency.js';

export type SessionRuntimeResidencySurface = 'web' | 'acp';

export interface SessionRuntimeResidencyEntry<T> {
  key: string;
  surface: SessionRuntimeResidencySurface;
  value: T;
  canEvict(): boolean;
  dispose(): Promise<void>;
}

export interface SessionRuntimeResidencyLease<T> {
  readonly value: T;
  release(): void;
}

export interface SessionRuntimeResidencyReservation<T> {
  commit(entry: SessionRuntimeResidencyEntry<T>): SessionRuntimeResidencyLease<T>;
  cancel(): void;
}

export interface SessionRuntimeResidencyOptions {
  maxResident: number;
  idleMs: number;
  now?: () => number;
}

export interface SessionRuntimeResidencyReservationOptions {
  surface: SessionRuntimeResidencySurface;
  allowEviction: boolean;
}

interface Resident<T> extends SessionRuntimeResidencyEntry<T> {
  generation: number;
  pins: number;
  lastUsedAt: number;
  poisoned: boolean;
}

interface ReservationState {
  generation: number;
  surface: SessionRuntimeResidencySurface;
}

export class SessionRuntimeCapacityError extends Error {
  readonly resource = 'resident_runtimes' as const;
  readonly retryable = true;

  constructor(public readonly limit: number) {
    super('Session runtime capacity is full');
    this.name = 'SessionRuntimeCapacityError';
  }
}

export class SessionRuntimeResidencyClosedError extends Error {
  constructor() {
    super('Session runtime residency is closed');
    this.name = 'SessionRuntimeResidencyClosedError';
  }
}

export class SessionRuntimeResidencyConflictError extends Error {
  constructor(key: string) {
    super(`Session runtime residency already owns key: ${key}`);
    this.name = 'SessionRuntimeResidencyConflictError';
  }
}

export class SessionRuntimeResidency<T> {
  private readonly maxResident: number;
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly residents = new Map<string, Resident<T>>();
  private readonly reservations = new Map<string, ReservationState>();
  private readonly operations = new Mutex();
  private nextGeneration = 1;
  private closed = false;

  constructor(options: SessionRuntimeResidencyOptions) {
    if (!isValidResidentSessionRuntimeLimit(options.maxResident)) {
      throw new Error('Invalid max resident Session Runtime limit');
    }
    if (!isValidSessionRuntimeIdleMs(options.idleMs)) {
      throw new Error('Invalid Session Runtime idle timeout');
    }
    this.maxResident = options.maxResident;
    this.idleMs = options.idleMs;
    this.now = options.now ?? Date.now;
  }

  acquire(key: string): SessionRuntimeResidencyLease<T> | undefined {
    const resident = this.residents.get(key);
    if (!resident || resident.poisoned) return undefined;
    resident.pins++;
    resident.lastUsedAt = this.now();
    return this.createLease(resident);
  }

  owns(key: string, expectedValue?: T): boolean {
    const resident = this.residents.get(key);
    return Boolean(
      resident && (expectedValue === undefined || resident.value === expectedValue)
    );
  }

  async reserve(
    key: string,
    options: SessionRuntimeResidencyReservationOptions
  ): Promise<SessionRuntimeResidencyReservation<T>> {
    if (!key.trim()) throw new Error('Session runtime residency key must not be blank');

    return this.operations.runExclusive(async () => {
      if (this.closed) throw new SessionRuntimeResidencyClosedError();
      if (this.residents.has(key) || this.reservations.has(key)) {
        throw new SessionRuntimeResidencyConflictError(key);
      }

      while (this.retainedCount() >= this.maxResident) {
        if (!options.allowEviction) {
          throw new SessionRuntimeCapacityError(this.maxResident);
        }
        const candidate = this.oldestEvictableWebResident();
        if (!candidate) {
          throw new SessionRuntimeCapacityError(this.maxResident);
        }
        await this.disposeResident(candidate, true);
      }

      const state: ReservationState = {
        generation: this.allocateGeneration(),
        surface: options.surface,
      };
      this.reservations.set(key, state);
      return this.createReservation(key, state);
    });
  }

  async remove(key: string, expectedValue?: T): Promise<boolean> {
    return this.operations.runExclusive(async () => {
      const resident = this.residents.get(key);
      if (
        !resident ||
        (expectedValue !== undefined && resident.value !== expectedValue)
      ) {
        return false;
      }
      if (resident.pins > 0) return false;
      await this.disposeResident(resident, true);
      return true;
    });
  }

  async forget(key: string, expectedValue?: T): Promise<boolean> {
    return this.operations.runExclusive(async () => {
      const resident = this.residents.get(key);
      if (
        !resident ||
        (expectedValue !== undefined && resident.value !== expectedValue) ||
        resident.pins > 0
      ) {
        return false;
      }
      this.residents.delete(key);
      return true;
    });
  }

  async sweepIdle(): Promise<number> {
    return this.operations.runExclusive(async () => {
      if (this.closed) return 0;
      let evicted = 0;
      while (true) {
        const candidate = this.oldestIdleWebResident();
        if (!candidate) return evicted;
        await this.disposeResident(candidate, true);
        evicted++;
      }
    });
  }

  async disposeAll(): Promise<void> {
    await this.operations.runExclusive(async () => {
      this.closed = true;
      this.reservations.clear();
      let firstError: unknown;
      for (const resident of [...this.residents.values()]) {
        try {
          await this.disposeResident(resident, false);
        } catch (error) {
          firstError ??= error;
        }
      }
      this.residents.clear();
      if (firstError !== undefined) throw firstError;
    });
  }

  getStats(): {
    resident: number;
    reserved: number;
    pinned: number;
    maxResident: number;
  } {
    let pinned = 0;
    for (const resident of this.residents.values()) {
      if (resident.pins > 0) pinned++;
    }
    return {
      resident: this.residents.size,
      reserved: this.reservations.size,
      pinned,
      maxResident: this.maxResident,
    };
  }

  private retainedCount(): number {
    return this.residents.size + this.reservations.size;
  }

  private allocateGeneration(): number {
    const generation = this.nextGeneration;
    this.nextGeneration =
      this.nextGeneration === Number.MAX_SAFE_INTEGER ? 1 : this.nextGeneration + 1;
    return generation;
  }

  private createReservation(
    key: string,
    state: ReservationState
  ): SessionRuntimeResidencyReservation<T> {
    let settled = false;
    return {
      commit: (entry) => {
        if (settled) {
          throw new SessionRuntimeResidencyConflictError(key);
        }
        if (
          entry.key !== key ||
          entry.surface !== state.surface ||
          this.reservations.get(key) !== state ||
          this.closed
        ) {
          this.reservations.delete(key);
          settled = true;
          throw this.closed
            ? new SessionRuntimeResidencyClosedError()
            : new SessionRuntimeResidencyConflictError(key);
        }
        this.reservations.delete(key);
        const resident: Resident<T> = {
          ...entry,
          generation: state.generation,
          pins: 1,
          lastUsedAt: this.now(),
          poisoned: false,
        };
        this.residents.set(key, resident);
        settled = true;
        return this.createLease(resident);
      },
      cancel: () => {
        if (settled) return;
        if (this.reservations.get(key) === state) {
          this.reservations.delete(key);
        }
        settled = true;
      },
    };
  }

  private createLease(resident: Resident<T>): SessionRuntimeResidencyLease<T> {
    let released = false;
    return {
      value: resident.value,
      release: () => {
        if (released) return;
        released = true;
        const current = this.residents.get(resident.key);
        if (current !== resident || current.generation !== resident.generation) return;
        current.pins = Math.max(0, current.pins - 1);
        current.lastUsedAt = this.now();
      },
    };
  }

  private oldestEvictableWebResident(): Resident<T> | undefined {
    return this.sortedWebResidents().find((resident) => this.canEvict(resident));
  }

  private oldestIdleWebResident(): Resident<T> | undefined {
    const now = this.now();
    return this.sortedWebResidents().find(
      (resident) => now - resident.lastUsedAt >= this.idleMs && this.canEvict(resident)
    );
  }

  private sortedWebResidents(): Resident<T>[] {
    return [...this.residents.values()]
      .filter((resident) => resident.surface === 'web')
      .sort(
        (left, right) =>
          left.lastUsedAt - right.lastUsedAt || left.generation - right.generation
      );
  }

  private canEvict(resident: Resident<T>): boolean {
    if (resident.pins > 0 || resident.poisoned) return false;
    try {
      return resident.canEvict();
    } catch {
      return false;
    }
  }

  private async disposeResident(
    resident: Resident<T>,
    restoreOnFailure: boolean
  ): Promise<void> {
    if (this.residents.get(resident.key) !== resident) return;
    this.residents.delete(resident.key);
    try {
      await resident.dispose();
    } catch (error) {
      if (restoreOnFailure && !this.closed && !this.residents.has(resident.key)) {
        resident.lastUsedAt = this.now();
        resident.poisoned = true;
        this.residents.set(resident.key, resident);
      }
      throw error;
    }
  }
}
