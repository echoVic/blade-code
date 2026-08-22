import { randomBytes } from 'node:crypto';
import type { Api } from '@earendil-works/pi-ai';
import {
  MAX_PROVIDER_REQUEST_ADMISSION_MS,
  MAX_PROVIDER_REQUEST_PENDING_BYTES,
  MAX_PROVIDER_REQUEST_SCHEDULER_CONCURRENCY,
  MIN_PROVIDER_REQUEST_CONCURRENCY,
} from '../../config/providerRequestAdmission.js';
import {
  createProviderFailureDomainKey,
  type ProviderFailureDomainScope,
} from './providerFailureDomain.js';

export {
  DEFAULT_PROVIDER_REQUEST_ADMISSION_MS,
  DEFAULT_PROVIDER_REQUEST_CONCURRENCY,
  DEFAULT_PROVIDER_REQUEST_PENDING_BYTES,
  MAX_PROVIDER_REQUEST_ADMISSION_MS,
  MAX_PROVIDER_REQUEST_CONCURRENCY,
  MAX_PROVIDER_REQUEST_PENDING_BYTES,
  MAX_PROVIDER_REQUEST_SCHEDULER_CONCURRENCY,
  MIN_PROVIDER_REQUEST_ADMISSION_MS,
  MIN_PROVIDER_REQUEST_CONCURRENCY,
  MIN_PROVIDER_REQUEST_PENDING_BYTES,
} from '../../config/providerRequestAdmission.js';

export const PROVIDER_ADMISSION_GLOBAL_MAX_IN_FLIGHT = 16;
export const PROVIDER_ADMISSION_GLOBAL_MAX_PENDING = 128;
export const PROVIDER_ADMISSION_DOMAIN_MAX_PENDING = 32;
export const PROVIDER_ADMISSION_OWNER_MAX_IN_FLIGHT = 3;
export const PROVIDER_ADMISSION_OWNER_MAX_PENDING = 16;

export const PROVIDER_ADMISSION_NON_FOREGROUND_GLOBAL_MAX_PENDING = 96;
export const PROVIDER_ADMISSION_NON_FOREGROUND_DOMAIN_MAX_PENDING = 24;
export const PROVIDER_ADMISSION_NON_FOREGROUND_OWNER_MAX_PENDING = 12;
export const PROVIDER_ADMISSION_INTERNAL_GLOBAL_MAX_PENDING = 16;
export const PROVIDER_ADMISSION_INTERNAL_DOMAIN_MAX_PENDING = 4;
export const PROVIDER_ADMISSION_INTERNAL_OWNER_MAX_PENDING = 4;

export const PROVIDER_ADMISSION_DOMAIN_MAX_PENDING_BYTES = 64 * 1024 * 1024;
export const PROVIDER_ADMISSION_OWNER_MAX_PENDING_BYTES = 32 * 1024 * 1024;

export const PROVIDER_ADMISSION_NON_FOREGROUND_GLOBAL_MAX_IN_FLIGHT = 12;
export const PROVIDER_ADMISSION_NON_FOREGROUND_OWNER_MAX_IN_FLIGHT = 2;
export const PROVIDER_ADMISSION_INTERNAL_GLOBAL_MAX_IN_FLIGHT = 2;
export const PROVIDER_ADMISSION_INTERNAL_DOMAIN_MAX_IN_FLIGHT = 1;

export const PROVIDER_ADMISSION_HEARTBEAT_MS = 15_000;
export const PROVIDER_ADMISSION_AGING_MS = 30_000;

export type ProviderRequestClass = 'foreground' | 'background' | 'internal';
export type ProviderAdmissionPhase = 'queued' | 'admitted' | 'rejected';
export type ProviderAdmissionScope = 'global' | 'domain' | 'owner' | 'class';
export type ProviderAdmissionResource = 'stream' | 'pending_count' | 'pending_bytes';
export type ProviderAdmissionFailureReason = 'queue_full' | 'wait_timeout' | 'closed';

export interface ProviderRequestScope extends ProviderFailureDomainScope {
  provider: string;
  api: Api | string;
  maxConcurrent: number;
  maxPendingBytes: number;
}

export interface ProviderAdmissionEvent {
  phase: ProviderAdmissionPhase;
  requestClass: ProviderRequestClass;
  resource: ProviderAdmissionResource;
  scope: ProviderAdmissionScope;
  reason?: 'capacity' | ProviderAdmissionFailureReason;
  queuePosition: number;
  queueDepth: number;
  inFlight: number;
  limit: number;
  waitMs: number;
  maxWaitMs: number;
  recoveryRemainingMs?: number;
}

export interface ProviderAdmissionRequest {
  scope: ProviderRequestScope;
  sessionId: string;
  ownerId: string;
  requestClass: ProviderRequestClass;
  maxWaitMs: number;
  pendingBytes: number;
  signal?: AbortSignal;
}

export interface ProviderAdmissionQueueSnapshot
  extends Omit<ProviderAdmissionEvent, 'phase'> {
  state: 'queued' | 'admitted';
}

export interface ProviderAdmissionPermit {
  release(): void;
}

export interface ProviderAdmissionTicket {
  readonly ready: Promise<ProviderAdmissionPermit>;
  getSnapshot(): ProviderAdmissionQueueSnapshot;
  cancel(reason?: unknown): void;
}

export interface ProviderAdmissionStats {
  inFlight: number;
  queued: number;
  pendingBytes: number;
  nonForegroundInFlight: number;
  internalInFlight: number;
  nonForegroundQueued: number;
  internalQueued: number;
  nonForegroundPendingBytes: number;
  internalPendingBytes: number;
  domainCount: number;
  ownerCount: number;
  closed: boolean;
}

export interface ProviderRequestAdmissionSchedulerOptions {
  processSecret?: Uint8Array;
  now?: () => number;
  globalMaxInFlight?: number;
  globalMaxPending?: number;
  domainMaxPending?: number;
  ownerMaxInFlight?: number;
  ownerMaxPending?: number;
  nonForegroundGlobalMaxPending?: number;
  nonForegroundDomainMaxPending?: number;
  nonForegroundOwnerMaxPending?: number;
  internalGlobalMaxPending?: number;
  internalDomainMaxPending?: number;
  internalOwnerMaxPending?: number;
  globalMaxPendingBytes?: number;
  domainMaxPendingBytes?: number;
  ownerMaxPendingBytes?: number;
  nonForegroundGlobalMaxInFlight?: number;
  nonForegroundOwnerMaxInFlight?: number;
  internalGlobalMaxInFlight?: number;
  internalDomainMaxInFlight?: number;
  agingMs?: number;
  classLimitsEnabled?: boolean;
}

interface ClassCounters {
  foreground: number;
  background: number;
  internal: number;
}

interface ResourceCounters {
  inFlight: ClassCounters;
  queued: ClassCounters;
  pendingBytes: ClassCounters;
}

interface DomainState {
  maxConcurrent: number;
  counters: ResourceCounters;
}

interface OwnerState {
  order: number;
  counters: ResourceCounters;
}

function createClassCounters(): ClassCounters {
  return { foreground: 0, background: 0, internal: 0 };
}

function createResourceCounters(): ResourceCounters {
  return {
    inFlight: createClassCounters(),
    queued: createClassCounters(),
    pendingBytes: createClassCounters(),
  };
}

function totalOf(counters: ClassCounters): number {
  return counters.foreground + counters.background + counters.internal;
}

function nonForegroundOf(counters: ClassCounters): number {
  return counters.background + counters.internal;
}

function isResourceCountersIdle(counters: ResourceCounters): boolean {
  return (
    counters.inFlight.foreground === 0 &&
    counters.inFlight.background === 0 &&
    counters.inFlight.internal === 0 &&
    counters.queued.foreground === 0 &&
    counters.queued.background === 0 &&
    counters.queued.internal === 0 &&
    counters.pendingBytes.foreground === 0 &&
    counters.pendingBytes.background === 0 &&
    counters.pendingBytes.internal === 0
  );
}

interface CapacityConstraint {
  scope: ProviderAdmissionScope;
  resource: ProviderAdmissionResource;
  inFlight: number;
  limit: number;
}

interface PendingAdmission {
  domainKey: string;
  sessionId: string;
  ownerId: string;
  requestClass: ProviderRequestClass;
  maxWaitMs: number;
  pendingBytes: number;
  enqueuedAt: number;
  signal?: AbortSignal;
  abortListener?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (permit: ProviderAdmissionPermit) => void;
  reject: (error: unknown) => void;
  settled: boolean;
  admitted: boolean;
  permit?: ProviderAdmissionPermit;
}

interface NormalizedSchedulerOptions {
  globalMaxInFlight: number;
  globalMaxPending: number;
  domainMaxPending: number;
  ownerMaxInFlight: number;
  ownerMaxPending: number;
  nonForegroundGlobalMaxPending: number;
  nonForegroundDomainMaxPending: number;
  nonForegroundOwnerMaxPending: number;
  internalGlobalMaxPending: number;
  internalDomainMaxPending: number;
  internalOwnerMaxPending: number;
  globalMaxPendingBytes: number;
  domainMaxPendingBytes: number;
  ownerMaxPendingBytes: number;
  nonForegroundGlobalMaxInFlight: number;
  nonForegroundOwnerMaxInFlight: number;
  internalGlobalMaxInFlight: number;
  internalDomainMaxInFlight: number;
  agingMs: number;
  classLimitsEnabled: boolean;
}

export class ProviderAdmissionError extends Error {
  readonly code = 'PROVIDER_ADMISSION_BUSY';
  readonly retryable: boolean;

  constructor(
    readonly reason: ProviderAdmissionFailureReason,
    readonly scope: ProviderAdmissionScope,
    readonly requestClass: ProviderRequestClass,
    readonly resource: ProviderAdmissionResource,
    readonly inFlight: number,
    readonly limit: number,
    readonly queued: number,
    readonly maxWaitMs: number
  ) {
    super(
      reason === 'queue_full'
        ? `Provider request admission ${scope} ${resource} queue is full`
        : reason === 'wait_timeout'
          ? `Provider request admission timed out waiting for ${scope} capacity`
          : 'Provider request admission scheduler is closed'
    );
    this.name = 'ProviderAdmissionError';
    this.retryable = reason !== 'closed';
  }
}

export function isProviderAdmissionError(
  error: unknown
): error is ProviderAdmissionError {
  return (
    error instanceof ProviderAdmissionError ||
    (error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'PROVIDER_ADMISSION_BUSY')
  );
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  hardMax: number
): number {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, hardMax);
}

function normalizeOptions(
  options: ProviderRequestAdmissionSchedulerOptions
): NormalizedSchedulerOptions {
  const globalMaxInFlight = boundedPositiveInteger(
    options.globalMaxInFlight,
    PROVIDER_ADMISSION_GLOBAL_MAX_IN_FLIGHT,
    Number.MAX_SAFE_INTEGER
  );
  const globalMaxPending = boundedPositiveInteger(
    options.globalMaxPending,
    PROVIDER_ADMISSION_GLOBAL_MAX_PENDING,
    PROVIDER_ADMISSION_GLOBAL_MAX_PENDING
  );
  const domainMaxPending = boundedPositiveInteger(
    options.domainMaxPending,
    PROVIDER_ADMISSION_DOMAIN_MAX_PENDING,
    PROVIDER_ADMISSION_DOMAIN_MAX_PENDING
  );
  const ownerMaxInFlight = Math.min(
    boundedPositiveInteger(
      options.ownerMaxInFlight,
      PROVIDER_ADMISSION_OWNER_MAX_IN_FLIGHT,
      Number.MAX_SAFE_INTEGER
    ),
    globalMaxInFlight
  );
  const ownerMaxPending = Math.min(
    boundedPositiveInteger(
      options.ownerMaxPending,
      PROVIDER_ADMISSION_OWNER_MAX_PENDING,
      PROVIDER_ADMISSION_OWNER_MAX_PENDING
    ),
    globalMaxPending
  );
  const nonForegroundGlobalMaxPending = Math.min(
    boundedPositiveInteger(
      options.nonForegroundGlobalMaxPending,
      Math.min(
        PROVIDER_ADMISSION_NON_FOREGROUND_GLOBAL_MAX_PENDING,
        Math.max(1, Math.floor((globalMaxPending * 3) / 4))
      ),
      PROVIDER_ADMISSION_NON_FOREGROUND_GLOBAL_MAX_PENDING
    ),
    globalMaxPending
  );
  const nonForegroundDomainMaxPending = Math.min(
    boundedPositiveInteger(
      options.nonForegroundDomainMaxPending,
      Math.min(
        PROVIDER_ADMISSION_NON_FOREGROUND_DOMAIN_MAX_PENDING,
        Math.max(1, Math.floor((domainMaxPending * 3) / 4))
      ),
      PROVIDER_ADMISSION_NON_FOREGROUND_DOMAIN_MAX_PENDING
    ),
    domainMaxPending
  );
  const nonForegroundOwnerMaxPending = Math.min(
    boundedPositiveInteger(
      options.nonForegroundOwnerMaxPending,
      Math.min(
        PROVIDER_ADMISSION_NON_FOREGROUND_OWNER_MAX_PENDING,
        Math.max(1, Math.floor((ownerMaxPending * 3) / 4))
      ),
      PROVIDER_ADMISSION_NON_FOREGROUND_OWNER_MAX_PENDING
    ),
    ownerMaxPending
  );
  const internalGlobalMaxPending = Math.min(
    boundedPositiveInteger(
      options.internalGlobalMaxPending,
      Math.min(
        PROVIDER_ADMISSION_INTERNAL_GLOBAL_MAX_PENDING,
        Math.max(1, Math.floor(globalMaxPending / 8))
      ),
      PROVIDER_ADMISSION_INTERNAL_GLOBAL_MAX_PENDING
    ),
    nonForegroundGlobalMaxPending
  );
  const internalDomainMaxPending = Math.min(
    boundedPositiveInteger(
      options.internalDomainMaxPending,
      Math.min(
        PROVIDER_ADMISSION_INTERNAL_DOMAIN_MAX_PENDING,
        Math.max(1, Math.floor(domainMaxPending / 8))
      ),
      PROVIDER_ADMISSION_INTERNAL_DOMAIN_MAX_PENDING
    ),
    nonForegroundDomainMaxPending
  );
  const internalOwnerMaxPending = Math.min(
    boundedPositiveInteger(
      options.internalOwnerMaxPending,
      Math.min(
        PROVIDER_ADMISSION_INTERNAL_OWNER_MAX_PENDING,
        Math.max(1, Math.floor(ownerMaxPending / 4))
      ),
      PROVIDER_ADMISSION_INTERNAL_OWNER_MAX_PENDING
    ),
    nonForegroundOwnerMaxPending
  );
  const globalMaxPendingBytes = boundedPositiveInteger(
    options.globalMaxPendingBytes,
    MAX_PROVIDER_REQUEST_PENDING_BYTES,
    MAX_PROVIDER_REQUEST_PENDING_BYTES
  );
  const domainMaxPendingBytes = Math.min(
    boundedPositiveInteger(
      options.domainMaxPendingBytes,
      PROVIDER_ADMISSION_DOMAIN_MAX_PENDING_BYTES,
      PROVIDER_ADMISSION_DOMAIN_MAX_PENDING_BYTES
    ),
    globalMaxPendingBytes
  );
  const ownerMaxPendingBytes = Math.min(
    boundedPositiveInteger(
      options.ownerMaxPendingBytes,
      PROVIDER_ADMISSION_OWNER_MAX_PENDING_BYTES,
      PROVIDER_ADMISSION_OWNER_MAX_PENDING_BYTES
    ),
    globalMaxPendingBytes
  );
  const nonForegroundGlobalMaxInFlight = Math.min(
    boundedPositiveInteger(
      options.nonForegroundGlobalMaxInFlight,
      Math.min(
        PROVIDER_ADMISSION_NON_FOREGROUND_GLOBAL_MAX_IN_FLIGHT,
        globalMaxInFlight
      ),
      globalMaxInFlight
    ),
    globalMaxInFlight
  );
  const nonForegroundOwnerMaxInFlight = Math.min(
    boundedPositiveInteger(
      options.nonForegroundOwnerMaxInFlight,
      Math.min(PROVIDER_ADMISSION_NON_FOREGROUND_OWNER_MAX_IN_FLIGHT, ownerMaxInFlight),
      ownerMaxInFlight
    ),
    ownerMaxInFlight
  );
  const internalGlobalMaxInFlight = Math.min(
    boundedPositiveInteger(
      options.internalGlobalMaxInFlight,
      Math.min(PROVIDER_ADMISSION_INTERNAL_GLOBAL_MAX_IN_FLIGHT, globalMaxInFlight),
      PROVIDER_ADMISSION_INTERNAL_GLOBAL_MAX_IN_FLIGHT
    ),
    globalMaxInFlight
  );
  const internalDomainMaxInFlight = boundedPositiveInteger(
    options.internalDomainMaxInFlight,
    PROVIDER_ADMISSION_INTERNAL_DOMAIN_MAX_IN_FLIGHT,
    PROVIDER_ADMISSION_INTERNAL_DOMAIN_MAX_IN_FLIGHT
  );
  const agingMs = boundedPositiveInteger(
    options.agingMs,
    PROVIDER_ADMISSION_AGING_MS,
    PROVIDER_ADMISSION_AGING_MS
  );
  return {
    globalMaxInFlight,
    globalMaxPending,
    domainMaxPending,
    ownerMaxInFlight,
    ownerMaxPending,
    nonForegroundGlobalMaxPending,
    nonForegroundDomainMaxPending,
    nonForegroundOwnerMaxPending,
    internalGlobalMaxPending,
    internalDomainMaxPending,
    internalOwnerMaxPending,
    globalMaxPendingBytes,
    domainMaxPendingBytes,
    ownerMaxPendingBytes,
    nonForegroundGlobalMaxInFlight,
    nonForegroundOwnerMaxInFlight,
    internalGlobalMaxInFlight,
    internalDomainMaxInFlight,
    agingMs,
    classLimitsEnabled: options.classLimitsEnabled !== false,
  };
}

function assertNonBlank(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} must not be blank`);
}

function assertRequest(request: ProviderAdmissionRequest): void {
  assertNonBlank(request.sessionId, 'sessionId');
  assertNonBlank(request.ownerId, 'ownerId');
  if (
    !Number.isSafeInteger(request.scope.maxConcurrent) ||
    request.scope.maxConcurrent < MIN_PROVIDER_REQUEST_CONCURRENCY ||
    request.scope.maxConcurrent > MAX_PROVIDER_REQUEST_SCHEDULER_CONCURRENCY
  ) {
    throw new Error(
      `maxConcurrent must be between ${MIN_PROVIDER_REQUEST_CONCURRENCY} and ${MAX_PROVIDER_REQUEST_SCHEDULER_CONCURRENCY}`
    );
  }
  if (
    !Number.isSafeInteger(request.scope.maxPendingBytes) ||
    request.scope.maxPendingBytes <= 0 ||
    request.scope.maxPendingBytes > MAX_PROVIDER_REQUEST_PENDING_BYTES
  ) {
    throw new Error(
      `maxPendingBytes must be between 1 and ${MAX_PROVIDER_REQUEST_PENDING_BYTES}`
    );
  }
  if (
    !Number.isSafeInteger(request.pendingBytes) ||
    request.pendingBytes <= 0 ||
    request.pendingBytes > MAX_PROVIDER_REQUEST_PENDING_BYTES + 1
  ) {
    throw new Error(
      `pendingBytes must be between 1 and ${MAX_PROVIDER_REQUEST_PENDING_BYTES + 1}`
    );
  }
  if (
    !Number.isSafeInteger(request.maxWaitMs) ||
    request.maxWaitMs < 0 ||
    request.maxWaitMs > MAX_PROVIDER_REQUEST_ADMISSION_MS
  ) {
    throw new Error(`maxWaitMs must be 0-${MAX_PROVIDER_REQUEST_ADMISSION_MS}`);
  }
}

function abortReason(signal: AbortSignal | undefined, fallback?: unknown): unknown {
  if (fallback !== undefined) return fallback;
  if (signal?.reason !== undefined) return signal.reason;
  return new DOMException('Provider request admission cancelled', 'AbortError');
}

export function createProviderRequestDomainKey(
  scope: ProviderRequestScope,
  processSecret: Uint8Array
): string {
  return createProviderFailureDomainKey(scope, processSecret, {
    providerRequestConcurrency: scope.maxConcurrent,
    providerRequestPendingBytes: scope.maxPendingBytes,
  });
}

export class ProviderRequestAdmissionScheduler {
  readonly #processSecret: Uint8Array;
  readonly #now: () => number;
  readonly #limits: NormalizedSchedulerOptions;
  readonly #queue: PendingAdmission[] = [];
  readonly #domains = new Map<string, DomainState>();
  readonly #owners = new Map<string, OwnerState>();
  readonly #globalCounters: ResourceCounters = createResourceCounters();
  #nextOwnerOrder = 1;
  #lastAdmittedOwnerOrder = 0;
  #closed = false;

  constructor(options: ProviderRequestAdmissionSchedulerOptions = {}) {
    this.#processSecret = options.processSecret
      ? new Uint8Array(options.processSecret)
      : randomBytes(32);
    this.#now = options.now ?? (() => performance.now());
    this.#limits = normalizeOptions(options);
  }

  admit(request: ProviderAdmissionRequest): ProviderAdmissionTicket {
    assertRequest(request);
    if (this.#closed) {
      throw this.#errorFor(
        'closed',
        request,
        {
          scope: 'global',
          resource: 'stream',
          inFlight: totalOf(this.#globalCounters.inFlight),
          limit: this.#limits.globalMaxInFlight,
        },
        this.#queue.length
      );
    }
    if (request.signal?.aborted) throw abortReason(request.signal);

    const domainKey = createProviderRequestDomainKey(
      request.scope,
      this.#processSecret
    );
    const existingDomain = this.#domains.get(domainKey);
    const existingOwner = this.#owners.get(request.ownerId);
    const domain = existingDomain ?? this.#createDomain(request.scope.maxConcurrent);
    const owner = existingOwner ?? this.#createOwner();

    if (
      this.#queue.length === 0 &&
      this.#canStart(domain, owner, request.requestClass)
    ) {
      if (!existingDomain) this.#domains.set(domainKey, domain);
      if (!existingOwner) {
        this.#owners.set(request.ownerId, owner);
        this.#nextOwnerOrder++;
      }
      const permit = this.#acquire(domainKey, request.ownerId, request.requestClass);
      let snapshot = this.#snapshotForAdmitted(request, 0);
      return {
        ready: Promise.resolve(permit),
        getSnapshot: () => ({ ...snapshot }),
        cancel: () => {
          snapshot = { ...snapshot };
        },
      };
    }

    const pendingConstraint = this.#pendingConstraint(request, domain, owner);
    if (pendingConstraint) {
      throw this.#errorFor(
        'queue_full',
        request,
        pendingConstraint,
        this.#queue.length
      );
    }
    const constraint = this.#constraint(domain, owner, request.requestClass);
    if (request.maxWaitMs === 0) {
      throw this.#errorFor('wait_timeout', request, constraint, this.#queue.length);
    }

    if (!existingDomain) this.#domains.set(domainKey, domain);
    if (!existingOwner) {
      this.#owners.set(request.ownerId, owner);
      this.#nextOwnerOrder++;
    }
    let resolveReady!: (permit: ProviderAdmissionPermit) => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<ProviderAdmissionPermit>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void ready.catch(() => undefined);
    const pending: PendingAdmission = {
      domainKey,
      sessionId: request.sessionId,
      ownerId: request.ownerId,
      requestClass: request.requestClass,
      maxWaitMs: request.maxWaitMs,
      pendingBytes: request.pendingBytes,
      enqueuedAt: this.#now(),
      signal: request.signal,
      resolve: resolveReady,
      reject: rejectReady,
      settled: false,
      admitted: false,
    };
    if (request.signal) {
      pending.abortListener = () =>
        this.#cancelPending(pending, abortReason(request.signal));
      request.signal.addEventListener('abort', pending.abortListener, {
        once: true,
      });
    }
    pending.timer = setTimeout(() => this.#timeoutPending(pending), request.maxWaitMs);
    pending.timer.unref?.();
    this.#queue.push(pending);
    this.#chargePending(domain, owner, pending);
    this.#drain();

    return {
      ready,
      getSnapshot: () => this.#snapshotForPending(pending),
      cancel: (reason) =>
        this.#cancelPending(pending, abortReason(request.signal, reason)),
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of [...this.#queue]) {
      const domain = this.#domains.get(pending.domainKey);
      const owner = this.#owners.get(pending.ownerId);
      const constraint =
        domain && owner
          ? this.#constraint(domain, owner, pending.requestClass)
          : {
              scope: 'global' as const,
              resource: 'stream' as const,
              inFlight: totalOf(this.#globalCounters.inFlight),
              limit: this.#limits.globalMaxInFlight,
            };
      this.#rejectPending(
        pending,
        new ProviderAdmissionError(
          'closed',
          constraint.scope,
          pending.requestClass,
          constraint.resource,
          constraint.inFlight,
          constraint.limit,
          this.#queue.length,
          pending.maxWaitMs
        )
      );
    }
  }

  getStats(): ProviderAdmissionStats {
    return {
      inFlight: totalOf(this.#globalCounters.inFlight),
      queued: this.#queue.length,
      pendingBytes: totalOf(this.#globalCounters.pendingBytes),
      nonForegroundInFlight: nonForegroundOf(this.#globalCounters.inFlight),
      internalInFlight: this.#globalCounters.inFlight.internal,
      nonForegroundQueued: nonForegroundOf(this.#globalCounters.queued),
      internalQueued: this.#globalCounters.queued.internal,
      nonForegroundPendingBytes: nonForegroundOf(this.#globalCounters.pendingBytes),
      internalPendingBytes: this.#globalCounters.pendingBytes.internal,
      domainCount: this.#domains.size,
      ownerCount: this.#owners.size,
      closed: this.#closed,
    };
  }

  #pendingConstraint(
    request: ProviderAdmissionRequest,
    domain: DomainState,
    owner: OwnerState
  ): CapacityConstraint | undefined {
    const count = (
      scope: ProviderAdmissionScope,
      current: number,
      limit: number
    ): CapacityConstraint | undefined =>
      current >= limit
        ? {
            scope,
            resource: 'pending_count',
            inFlight: current,
            limit,
          }
        : undefined;

    if (this.#limits.classLimitsEnabled && request.requestClass === 'internal') {
      const internalCount =
        count(
          'class',
          this.#globalCounters.queued.internal,
          this.#limits.internalGlobalMaxPending
        ) ??
        count(
          'class',
          owner.counters.queued.internal,
          this.#limits.internalOwnerMaxPending
        ) ??
        count(
          'class',
          domain.counters.queued.internal,
          this.#limits.internalDomainMaxPending
        );
      if (internalCount) return internalCount;
    }
    if (this.#limits.classLimitsEnabled && request.requestClass !== 'foreground') {
      const nonForegroundCount =
        count(
          'class',
          nonForegroundOf(this.#globalCounters.queued),
          this.#limits.nonForegroundGlobalMaxPending
        ) ??
        count(
          'class',
          nonForegroundOf(owner.counters.queued),
          this.#limits.nonForegroundOwnerMaxPending
        ) ??
        count(
          'class',
          nonForegroundOf(domain.counters.queued),
          this.#limits.nonForegroundDomainMaxPending
        );
      if (nonForegroundCount) return nonForegroundCount;
    }
    const totalCount =
      count('global', this.#queue.length, this.#limits.globalMaxPending) ??
      count('owner', totalOf(owner.counters.queued), this.#limits.ownerMaxPending) ??
      count('domain', totalOf(domain.counters.queued), this.#limits.domainMaxPending);
    if (totalCount) return totalCount;

    const globalByteLimit = Math.min(
      request.scope.maxPendingBytes,
      this.#limits.globalMaxPendingBytes
    );
    const domainByteLimit = Math.min(
      globalByteLimit,
      this.#limits.domainMaxPendingBytes
    );
    const ownerByteLimit = Math.min(globalByteLimit, this.#limits.ownerMaxPendingBytes);
    const exceeds = (current: number, limit: number): boolean =>
      request.pendingBytes > limit - current;
    const byteConstraint = (scope: ProviderAdmissionScope): CapacityConstraint => {
      if (scope === 'owner') {
        return {
          scope,
          resource: 'pending_bytes',
          inFlight: totalOf(owner.counters.inFlight),
          limit: this.#limits.ownerMaxInFlight,
        };
      }
      if (scope === 'domain') {
        return {
          scope,
          resource: 'pending_bytes',
          inFlight: totalOf(domain.counters.inFlight),
          limit: domain.maxConcurrent,
        };
      }
      return {
        scope,
        resource: 'pending_bytes',
        inFlight: totalOf(this.#globalCounters.inFlight),
        limit: this.#limits.globalMaxInFlight,
      };
    };

    if (request.requestClass === 'internal') {
      const internalGlobalBytes = Math.max(1, Math.floor(globalByteLimit / 8));
      const internalDomainBytes = Math.max(1, Math.floor(domainByteLimit / 4));
      const internalOwnerBytes = Math.max(1, Math.floor(ownerByteLimit / 4));
      if (
        exceeds(this.#globalCounters.pendingBytes.internal, internalGlobalBytes) ||
        exceeds(owner.counters.pendingBytes.internal, internalOwnerBytes) ||
        exceeds(domain.counters.pendingBytes.internal, internalDomainBytes)
      ) {
        return byteConstraint('class');
      }
    }
    if (request.requestClass !== 'foreground') {
      const nonForegroundGlobalBytes = Math.max(
        1,
        Math.floor((globalByteLimit * 3) / 4)
      );
      const nonForegroundDomainBytes = Math.max(
        1,
        Math.floor((domainByteLimit * 3) / 4)
      );
      const nonForegroundOwnerBytes = Math.max(1, Math.floor(ownerByteLimit / 2));
      if (
        exceeds(
          nonForegroundOf(this.#globalCounters.pendingBytes),
          nonForegroundGlobalBytes
        ) ||
        exceeds(
          nonForegroundOf(owner.counters.pendingBytes),
          nonForegroundOwnerBytes
        ) ||
        exceeds(nonForegroundOf(domain.counters.pendingBytes), nonForegroundDomainBytes)
      ) {
        return byteConstraint('class');
      }
    }
    if (exceeds(totalOf(this.#globalCounters.pendingBytes), globalByteLimit)) {
      return byteConstraint('global');
    }
    if (exceeds(totalOf(owner.counters.pendingBytes), ownerByteLimit)) {
      return byteConstraint('owner');
    }
    if (exceeds(totalOf(domain.counters.pendingBytes), domainByteLimit)) {
      return byteConstraint('domain');
    }
    return undefined;
  }

  #chargePending(
    domain: DomainState,
    owner: OwnerState,
    pending: PendingAdmission
  ): void {
    const cls = pending.requestClass;
    const bytes = pending.pendingBytes;
    this.#globalCounters.queued[cls]++;
    domain.counters.queued[cls]++;
    owner.counters.queued[cls]++;
    this.#globalCounters.pendingBytes[cls] += bytes;
    domain.counters.pendingBytes[cls] += bytes;
    owner.counters.pendingBytes[cls] += bytes;
  }

  #createDomain(maxConcurrent: number): DomainState {
    return {
      maxConcurrent,
      counters: createResourceCounters(),
    };
  }

  #createOwner(): OwnerState {
    return {
      order: this.#nextOwnerOrder,
      counters: createResourceCounters(),
    };
  }

  #canStart(
    domain: DomainState,
    owner: OwnerState,
    requestClass: ProviderRequestClass
  ): boolean {
    if (totalOf(this.#globalCounters.inFlight) >= this.#limits.globalMaxInFlight)
      return false;
    if (totalOf(domain.counters.inFlight) >= domain.maxConcurrent) return false;
    if (totalOf(owner.counters.inFlight) >= this.#limits.ownerMaxInFlight) return false;
    if (requestClass === 'foreground' || !this.#limits.classLimitsEnabled) {
      return true;
    }

    if (
      nonForegroundOf(this.#globalCounters.inFlight) >=
      this.#limits.nonForegroundGlobalMaxInFlight
    ) {
      return false;
    }
    if (
      nonForegroundOf(owner.counters.inFlight) >=
      this.#limits.nonForegroundOwnerMaxInFlight
    ) {
      return false;
    }
    const nonForegroundDomainLimit = Math.max(1, domain.maxConcurrent - 1);
    if (nonForegroundOf(domain.counters.inFlight) >= nonForegroundDomainLimit)
      return false;
    if (requestClass !== 'internal') return true;

    return (
      this.#globalCounters.inFlight.internal < this.#limits.internalGlobalMaxInFlight &&
      domain.counters.inFlight.internal < this.#limits.internalDomainMaxInFlight
    );
  }

  #constraint(
    domain: DomainState,
    owner: OwnerState,
    requestClass: ProviderRequestClass
  ): CapacityConstraint {
    if (totalOf(owner.counters.inFlight) >= this.#limits.ownerMaxInFlight) {
      return {
        scope: 'owner',
        resource: 'stream',
        inFlight: totalOf(owner.counters.inFlight),
        limit: this.#limits.ownerMaxInFlight,
      };
    }
    if (
      this.#limits.classLimitsEnabled &&
      requestClass !== 'foreground' &&
      nonForegroundOf(owner.counters.inFlight) >=
        this.#limits.nonForegroundOwnerMaxInFlight
    ) {
      return {
        scope: 'class',
        resource: 'stream',
        inFlight: nonForegroundOf(owner.counters.inFlight),
        limit: this.#limits.nonForegroundOwnerMaxInFlight,
      };
    }
    if (totalOf(domain.counters.inFlight) >= domain.maxConcurrent) {
      return {
        scope: 'domain',
        resource: 'stream',
        inFlight: totalOf(domain.counters.inFlight),
        limit: domain.maxConcurrent,
      };
    }
    if (this.#limits.classLimitsEnabled && requestClass !== 'foreground') {
      const limit = Math.max(1, domain.maxConcurrent - 1);
      if (nonForegroundOf(domain.counters.inFlight) >= limit) {
        return {
          scope: 'class',
          resource: 'stream',
          inFlight: nonForegroundOf(domain.counters.inFlight),
          limit,
        };
      }
    }
    if (
      this.#limits.classLimitsEnabled &&
      requestClass === 'internal' &&
      domain.counters.inFlight.internal >= this.#limits.internalDomainMaxInFlight
    ) {
      return {
        scope: 'class',
        resource: 'stream',
        inFlight: domain.counters.inFlight.internal,
        limit: this.#limits.internalDomainMaxInFlight,
      };
    }
    if (totalOf(this.#globalCounters.inFlight) >= this.#limits.globalMaxInFlight) {
      return {
        scope: 'global',
        resource: 'stream',
        inFlight: totalOf(this.#globalCounters.inFlight),
        limit: this.#limits.globalMaxInFlight,
      };
    }
    if (
      this.#limits.classLimitsEnabled &&
      requestClass !== 'foreground' &&
      nonForegroundOf(this.#globalCounters.inFlight) >=
        this.#limits.nonForegroundGlobalMaxInFlight
    ) {
      return {
        scope: 'class',
        resource: 'stream',
        inFlight: nonForegroundOf(this.#globalCounters.inFlight),
        limit: this.#limits.nonForegroundGlobalMaxInFlight,
      };
    }
    if (
      this.#limits.classLimitsEnabled &&
      requestClass === 'internal' &&
      this.#globalCounters.inFlight.internal >= this.#limits.internalGlobalMaxInFlight
    ) {
      return {
        scope: 'class',
        resource: 'stream',
        inFlight: this.#globalCounters.inFlight.internal,
        limit: this.#limits.internalGlobalMaxInFlight,
      };
    }
    return {
      scope: 'domain',
      resource: 'stream',
      inFlight: totalOf(domain.counters.inFlight),
      limit: domain.maxConcurrent,
    };
  }

  #acquire(
    domainKey: string,
    ownerId: string,
    requestClass: ProviderRequestClass
  ): ProviderAdmissionPermit {
    const domain = this.#domains.get(domainKey);
    const owner = this.#owners.get(ownerId);
    if (!domain || !owner) {
      throw new Error('Provider admission accounting state is unavailable');
    }
    this.#globalCounters.inFlight[requestClass]++;
    domain.counters.inFlight[requestClass]++;
    owner.counters.inFlight[requestClass]++;

    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#release(domainKey, ownerId, requestClass);
      },
    };
  }

  #release(
    domainKey: string,
    ownerId: string,
    requestClass: ProviderRequestClass
  ): void {
    const domain = this.#domains.get(domainKey);
    const owner = this.#owners.get(ownerId);
    this.#globalCounters.inFlight[requestClass]--;
    if (domain) domain.counters.inFlight[requestClass]--;
    if (owner) owner.counters.inFlight[requestClass]--;
    this.#deleteIdleState(domainKey, ownerId);
    this.#drain();
  }

  #drain(): void {
    if (this.#closed) return;
    while (this.#queue.length > 0) {
      const now = this.#now();
      const bestByOwner = new Map<
        string,
        { pending: PendingAdmission; rank: number; index: number }
      >();
      for (const [index, pending] of this.#queue.entries()) {
        const domain = this.#domains.get(pending.domainKey);
        const owner = this.#owners.get(pending.ownerId);
        if (
          domain === undefined ||
          owner === undefined ||
          !this.#canStart(domain, owner, pending.requestClass)
        ) {
          continue;
        }
        const rank = this.#effectiveRank(pending, now);
        const current = bestByOwner.get(pending.ownerId);
        if (
          !current ||
          rank < current.rank ||
          (rank === current.rank && index < current.index)
        ) {
          bestByOwner.set(pending.ownerId, { pending, rank, index });
        }
      }
      const eligible = [...bestByOwner.values()]
        .filter(({ pending }) => {
          const domain = this.#domains.get(pending.domainKey);
          const owner = this.#owners.get(pending.ownerId);
          return (
            domain !== undefined &&
            owner !== undefined &&
            this.#canStart(domain, owner, pending.requestClass)
          );
        })
        .map(({ pending, rank }) => ({
          pending,
          rank,
          order: this.#owners.get(pending.ownerId)!.order,
        }));
      if (eligible.length === 0) return;
      const bestRank = Math.min(...eligible.map((candidate) => candidate.rank));
      const sameRank = eligible.filter((candidate) => candidate.rank === bestRank);
      const afterCursor = sameRank
        .filter((candidate) => candidate.order > this.#lastAdmittedOwnerOrder)
        .sort((left, right) => left.order - right.order);
      const selected =
        afterCursor[0] ?? sameRank.sort((left, right) => left.order - right.order)[0];
      this.#startPending(selected.pending, selected.order);
    }
  }

  #effectiveRank(pending: PendingAdmission, now: number): number {
    const base =
      pending.requestClass === 'foreground'
        ? 0
        : pending.requestClass === 'background'
          ? 1
          : 2;
    const promotions = Math.floor(
      Math.max(0, now - pending.enqueuedAt) / this.#limits.agingMs
    );
    return Math.max(0, base - promotions);
  }

  #startPending(pending: PendingAdmission, ownerOrder: number): void {
    if (!this.#removeQueued(pending, false)) return;
    pending.settled = true;
    pending.admitted = true;
    this.#lastAdmittedOwnerOrder = ownerOrder;
    const permit = this.#acquire(
      pending.domainKey,
      pending.ownerId,
      pending.requestClass
    );
    pending.permit = permit;
    pending.resolve(permit);
  }

  #timeoutPending(pending: PendingAdmission): void {
    const domain = this.#domains.get(pending.domainKey);
    const owner = this.#owners.get(pending.ownerId);
    const constraint =
      domain && owner
        ? this.#constraint(domain, owner, pending.requestClass)
        : {
            scope: 'global' as const,
            resource: 'stream' as const,
            inFlight: totalOf(this.#globalCounters.inFlight),
            limit: this.#limits.globalMaxInFlight,
          };
    this.#rejectPending(
      pending,
      new ProviderAdmissionError(
        'wait_timeout',
        constraint.scope,
        pending.requestClass,
        constraint.resource,
        constraint.inFlight,
        constraint.limit,
        this.#queue.length,
        pending.maxWaitMs
      )
    );
  }

  #cancelPending(pending: PendingAdmission, reason: unknown): void {
    this.#rejectPending(pending, reason);
  }

  #rejectPending(pending: PendingAdmission, reason: unknown): void {
    if (!this.#removeQueued(pending)) return;
    pending.settled = true;
    pending.reject(reason);
    this.#drain();
  }

  #removeQueued(pending: PendingAdmission, deleteIdle = true): boolean {
    if (pending.settled || pending.admitted) return false;
    const index = this.#queue.indexOf(pending);
    if (index < 0) return false;
    this.#queue.splice(index, 1);
    const domain = this.#domains.get(pending.domainKey);
    const owner = this.#owners.get(pending.ownerId);
    if (domain && owner) this.#unchargePending(domain, owner, pending);
    this.#cleanupPending(pending);
    if (deleteIdle) {
      this.#deleteIdleState(pending.domainKey, pending.ownerId);
    }
    return true;
  }

  #unchargePending(
    domain: DomainState,
    owner: OwnerState,
    pending: PendingAdmission
  ): void {
    const cls = pending.requestClass;
    const bytes = pending.pendingBytes;
    this.#globalCounters.queued[cls]--;
    domain.counters.queued[cls]--;
    owner.counters.queued[cls]--;
    this.#globalCounters.pendingBytes[cls] -= bytes;
    domain.counters.pendingBytes[cls] -= bytes;
    owner.counters.pendingBytes[cls] -= bytes;
  }

  #cleanupPending(pending: PendingAdmission): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = undefined;
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener('abort', pending.abortListener);
    }
    pending.abortListener = undefined;
    pending.signal = undefined;
  }

  #deleteIdleState(domainKey: string, ownerId: string): void {
    const domain = this.#domains.get(domainKey);
    if (domain && isResourceCountersIdle(domain.counters)) {
      this.#domains.delete(domainKey);
    }
    const owner = this.#owners.get(ownerId);
    if (owner && isResourceCountersIdle(owner.counters)) {
      this.#owners.delete(ownerId);
    }
  }

  #snapshotForPending(pending: PendingAdmission): ProviderAdmissionQueueSnapshot {
    const waitMs = Math.max(0, Math.floor(this.#now() - pending.enqueuedAt));
    if (pending.admitted) {
      return {
        state: 'admitted',
        requestClass: pending.requestClass,
        resource: 'stream',
        scope: 'domain',
        queuePosition: 0,
        queueDepth: this.#queue.length,
        inFlight: totalOf(this.#globalCounters.inFlight),
        limit: this.#limits.globalMaxInFlight,
        waitMs,
        maxWaitMs: pending.maxWaitMs,
      };
    }
    const domain = this.#domains.get(pending.domainKey);
    const owner = this.#owners.get(pending.ownerId);
    const constraint =
      domain && owner
        ? this.#constraint(domain, owner, pending.requestClass)
        : {
            scope: 'global' as const,
            resource: 'stream' as const,
            inFlight: totalOf(this.#globalCounters.inFlight),
            limit: this.#limits.globalMaxInFlight,
          };
    return {
      state: 'queued',
      requestClass: pending.requestClass,
      resource: constraint.resource,
      scope: constraint.scope,
      reason: 'capacity',
      queuePosition: this.#queuePosition(pending, constraint.scope),
      queueDepth: this.#queue.length,
      inFlight: constraint.inFlight,
      limit: constraint.limit,
      waitMs,
      maxWaitMs: pending.maxWaitMs,
    };
  }

  #snapshotForAdmitted(
    request: ProviderAdmissionRequest,
    waitMs: number
  ): ProviderAdmissionQueueSnapshot {
    return {
      state: 'admitted',
      requestClass: request.requestClass,
      resource: 'stream',
      scope: 'domain',
      queuePosition: 0,
      queueDepth: this.#queue.length,
      inFlight: totalOf(this.#globalCounters.inFlight),
      limit: this.#limits.globalMaxInFlight,
      waitMs,
      maxWaitMs: request.maxWaitMs,
    };
  }

  #queuePosition(pending: PendingAdmission, scope: ProviderAdmissionScope): number {
    const matching = this.#queue.filter((candidate) => {
      switch (scope) {
        case 'owner':
          return candidate.ownerId === pending.ownerId;
        case 'domain':
          return candidate.domainKey === pending.domainKey;
        case 'class':
          return candidate.requestClass === pending.requestClass;
        case 'global':
          return true;
      }
    });
    return Math.max(1, matching.indexOf(pending) + 1);
  }

  #errorFor(
    reason: ProviderAdmissionFailureReason,
    request: ProviderAdmissionRequest,
    constraint: CapacityConstraint,
    queued: number
  ): ProviderAdmissionError {
    return new ProviderAdmissionError(
      reason,
      constraint.scope,
      request.requestClass,
      constraint.resource,
      constraint.inFlight,
      constraint.limit,
      queued,
      request.maxWaitMs
    );
  }
}

let sharedScheduler: ProviderRequestAdmissionScheduler | undefined;

export function getProviderRequestAdmissionScheduler(
  options: ProviderRequestAdmissionSchedulerOptions = {}
): ProviderRequestAdmissionScheduler {
  sharedScheduler ??= new ProviderRequestAdmissionScheduler(options);
  return sharedScheduler;
}

export function resetProviderRequestAdmissionSchedulerForTests(): void {
  sharedScheduler?.close();
  sharedScheduler = undefined;
}
