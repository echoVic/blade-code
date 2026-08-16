import { createHmac, randomBytes } from 'node:crypto';
import type { Api } from '@earendil-works/pi-ai';
import {
  DEFAULT_PROVIDER_CIRCUIT_OPEN_MS,
  MAX_PROVIDER_CIRCUIT_OPEN_MS,
} from '../../config/providerCircuitBreaker.js';
import type { ProviderRetryReason } from './providerRetry.js';

export {
  DEFAULT_PROVIDER_CIRCUIT_OPEN_MS,
  MAX_PROVIDER_CIRCUIT_OPEN_MS,
  MIN_PROVIDER_CIRCUIT_OPEN_MS,
} from '../../config/providerCircuitBreaker.js';

export const PROVIDER_CIRCUIT_WINDOW_MS = 60_000;
export const PROVIDER_CIRCUIT_MIN_SAMPLES = 4;
export const PROVIDER_CIRCUIT_ERROR_RATE_THRESHOLD = 0.8;
export const PROVIDER_CIRCUIT_HALF_OPEN_MAX_PROBES = 1;

export const MIN_PROVIDER_CIRCUIT_PROBE_LEASE_MS = 300_000;
export const MAX_PROVIDER_CIRCUIT_PROBE_LEASE_MS = 600_000;
export const PROVIDER_CIRCUIT_HEARTBEAT_MS = 15_000;

export const MAX_PROVIDER_CIRCUIT_REGISTRY_ENTRIES = 128;
export const MAX_PROVIDER_CIRCUIT_WINDOW_ENTRIES = 256;
export const PROVIDER_CIRCUIT_IDLE_TTL_MS = 1_800_000;

const HALF_OPEN_RETRY_MS = 50;

export type ProviderCircuitState = 'closed' | 'open' | 'half_open';

export interface ProviderCircuitScope {
  provider: string;
  api: Api | string;
  baseUrl: string;
  model: string;
  serviceTier?: string;
  apiVersion?: string;
  apiKey?: string;
  customHeaders?: Record<string, string>;
  openDurationMs: number;
  probeLeaseMs: number;
}

export interface ProviderCircuitFailure {
  reason: Exclude<ProviderRetryReason, 'timeout'>;
  statusCode?: number;
  retryAfterMs?: number;
}

export type ProviderCircuitTransitionPhase = 'opened' | 'reopened' | 'closed';
export type ProviderCircuitPhase =
  | ProviderCircuitTransitionPhase
  | 'waiting'
  | 'probe'
  | 'rejected';

export interface ProviderCircuitTransition {
  phase: ProviderCircuitTransitionPhase;
  reason: ProviderCircuitFailure['reason'];
  statusCode?: number;
  retryAfterMs?: number;
  nextProbeAt?: number;
  openDurationMs: number;
  sampleCount: number;
  failureCount: number;
}

export interface ProviderCircuitEvent {
  phase: ProviderCircuitPhase;
  reason: ProviderCircuitFailure['reason'];
  statusCode?: number;
  retryAfterMs?: number;
  nextProbeAt?: number;
  openDurationMs: number;
  sampleCount?: number;
  failureCount?: number;
  recoveryRemainingMs?: number;
}

export class ProviderCircuitOpenError extends Error {
  readonly code = 'PROVIDER_CIRCUIT_OPEN';

  constructor(readonly circuit: ProviderCircuitEvent) {
    super(`Provider circuit open; retry after ${circuit.retryAfterMs ?? 0}ms`);
    this.name = 'ProviderCircuitOpenError';
  }
}

export function isProviderCircuitOpenError(
  error: unknown
): error is ProviderCircuitOpenError {
  return (
    error instanceof ProviderCircuitOpenError ||
    (error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'PROVIDER_CIRCUIT_OPEN')
  );
}

export interface ProviderCircuitAttemptToken {
  readonly kind: 'regular' | 'probe' | 'noop';
}

export type ProviderCircuitAdmission =
  | {
      allowed: true;
      probe: boolean;
      token: ProviderCircuitAttemptToken;
      reason?: ProviderCircuitFailure['reason'];
      statusCode?: number;
      openDurationMs?: number;
      sampleCount?: number;
      failureCount?: number;
    }
  | {
      allowed: false;
      state: 'open' | 'half_open';
      reason: ProviderCircuitFailure['reason'];
      statusCode?: number;
      retryAfterMs: number;
      nextProbeAt?: number;
      openDurationMs: number;
      sampleCount: number;
      failureCount: number;
    };

export interface ProviderCircuitSnapshot {
  state: ProviderCircuitState;
  sampleCount: number;
  failureCount: number;
  nextProbeAt?: number;
  noop: boolean;
  detached: boolean;
}

export interface ProviderCircuitHandle {
  check(): ProviderCircuitAdmission;
  recordSuccess(
    token: ProviderCircuitAttemptToken
  ): ProviderCircuitTransition | undefined;
  recordFailure(
    token: ProviderCircuitAttemptToken,
    failure: ProviderCircuitFailure
  ): ProviderCircuitTransition | undefined;
  recordNeutral(
    token: ProviderCircuitAttemptToken
  ): ProviderCircuitTransition | undefined;
  abandon(token: ProviderCircuitAttemptToken): boolean;
  snapshot(): ProviderCircuitSnapshot;
}

interface CircuitSample {
  at: number;
  failure: boolean;
}

interface CircuitEntry {
  readonly key: string;
  state: ProviderCircuitState;
  samples: CircuitSample[];
  generation: number;
  nextAttemptId: number;
  nextProbeLeaseId: number;
  probeLeaseId?: number;
  probeLeaseExpiresAt?: number;
  nextProbeAt?: number;
  readonly configuredOpenDurationMs: number;
  effectiveOpenDurationMs: number;
  lastFailure?: ProviderCircuitFailure;
  lastTouchedAt: number;
  detached: boolean;
}

interface AttemptState {
  readonly entry?: CircuitEntry;
  readonly generation: number;
  readonly attemptId: number;
  readonly kind: ProviderCircuitAttemptToken['kind'];
  readonly probeLeaseId?: number;
  settled: boolean;
}

interface RegistryOptions {
  processSecret?: Uint8Array;
  now?: () => number;
  wallNow?: () => number;
  maxEntries?: number;
  maxWindowEntries?: number;
  windowMs?: number;
  minSamples?: number;
  errorRateThreshold?: number;
  idleTtlMs?: number;
}

interface RegistryPolicy {
  readonly maxEntries: number;
  readonly maxWindowEntries: number;
  readonly windowMs: number;
  readonly minSamples: number;
  readonly errorRateThreshold: number;
  readonly idleTtlMs: number;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function boundedRate(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 && value <= 1
    ? value
    : fallback;
}

function canonicalBaseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    url.searchParams.sort();
    if (url.pathname !== '/') {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    return url.toString();
  } catch {
    return raw.trim().replace(/\/+$/, '');
  }
}

function canonicalHeaders(
  headers: Readonly<Record<string, string>> | undefined
): ReadonlyArray<readonly [string, string]> {
  if (!headers) return [];
  return Object.entries(headers)
    .map(([name, value]) => [name.trim().toLowerCase(), value.trim()] as const)
    .sort(([left], [right]) => left.localeCompare(right));
}

export function createProviderCircuitFailureDomainKey(
  scope: ProviderCircuitScope,
  processSecret: Uint8Array
): string {
  const canonical = JSON.stringify([
    scope.provider.trim(),
    String(scope.api).trim(),
    canonicalBaseUrl(scope.baseUrl),
    scope.model.trim(),
    scope.serviceTier?.trim() ?? '',
    scope.apiVersion?.trim() ?? '',
    scope.apiKey ?? '',
    canonicalHeaders(scope.customHeaders),
    scope.openDurationMs,
  ]);
  return createHmac('sha256', Buffer.from(processSecret))
    .update(canonical)
    .digest('hex');
}

function countFailures(samples: readonly CircuitSample[]): number {
  let failures = 0;
  for (const sample of samples) {
    if (sample.failure) failures++;
  }
  return failures;
}

function sanitizeStatusCode(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function sanitizeRetryAfter(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.min(Math.ceil(value), MAX_PROVIDER_CIRCUIT_OPEN_MS);
}

export class ProviderCircuitRegistry {
  readonly #entries = new Map<string, CircuitEntry>();
  readonly #attempts = new WeakMap<object, AttemptState>();
  readonly #processSecret: Uint8Array;
  readonly #now: () => number;
  readonly #wallNow: () => number;
  readonly #policy: RegistryPolicy;

  constructor(options: RegistryOptions = {}) {
    this.#processSecret = options.processSecret
      ? new Uint8Array(options.processSecret)
      : randomBytes(32);
    this.#now = options.now ?? (() => performance.now());
    this.#wallNow = options.wallNow ?? options.now ?? Date.now;
    this.#policy = {
      maxEntries: Math.min(
        positiveInteger(options.maxEntries, MAX_PROVIDER_CIRCUIT_REGISTRY_ENTRIES),
        MAX_PROVIDER_CIRCUIT_REGISTRY_ENTRIES
      ),
      maxWindowEntries: Math.min(
        positiveInteger(options.maxWindowEntries, MAX_PROVIDER_CIRCUIT_WINDOW_ENTRIES),
        MAX_PROVIDER_CIRCUIT_WINDOW_ENTRIES
      ),
      windowMs: positiveInteger(options.windowMs, PROVIDER_CIRCUIT_WINDOW_MS),
      minSamples: positiveInteger(options.minSamples, PROVIDER_CIRCUIT_MIN_SAMPLES),
      errorRateThreshold: boundedRate(
        options.errorRateThreshold,
        PROVIDER_CIRCUIT_ERROR_RATE_THRESHOLD
      ),
      idleTtlMs: positiveInteger(options.idleTtlMs, PROVIDER_CIRCUIT_IDLE_TTL_MS),
    };
  }

  get size(): number {
    return this.#entries.size;
  }

  get(scope: ProviderCircuitScope): ProviderCircuitHandle {
    if (scope.openDurationMs === 0) {
      return this.#noopHandle();
    }

    const now = this.#now();
    this.#evictIdleClosed(now);
    const key = createProviderCircuitFailureDomainKey(scope, this.#processSecret);
    const existing = this.#entries.get(key);
    if (existing) {
      existing.lastTouchedAt = now;
      return this.#handle(existing, scope.probeLeaseMs);
    }

    if (this.#entries.size >= this.#policy.maxEntries) {
      this.#evictLeastRecentlyUsedClosed();
    }
    if (this.#entries.size >= this.#policy.maxEntries) {
      return this.#noopHandle();
    }

    const entry: CircuitEntry = {
      key,
      state: 'closed',
      samples: [],
      generation: 0,
      nextAttemptId: 1,
      nextProbeLeaseId: 1,
      configuredOpenDurationMs: scope.openDurationMs,
      effectiveOpenDurationMs: scope.openDurationMs,
      lastTouchedAt: now,
      detached: false,
    };
    this.#entries.set(key, entry);
    return this.#handle(entry, scope.probeLeaseMs);
  }

  #handle(entry: CircuitEntry, requestedProbeLeaseMs: number): ProviderCircuitHandle {
    const registry = this;
    const probeLeaseMs = Math.max(
      MIN_PROVIDER_CIRCUIT_PROBE_LEASE_MS,
      Math.min(
        positiveInteger(requestedProbeLeaseMs, MIN_PROVIDER_CIRCUIT_PROBE_LEASE_MS),
        MAX_PROVIDER_CIRCUIT_PROBE_LEASE_MS
      )
    );
    return {
      check: () => registry.#check(entry, probeLeaseMs),
      recordSuccess: (token) => registry.#record(token, 'success'),
      recordFailure: (token, failure) => registry.#record(token, 'failure', failure),
      recordNeutral: (token) => registry.#record(token, 'neutral'),
      abandon: (token) => registry.#abandon(token),
      snapshot: () => registry.#snapshot(entry),
    };
  }

  #noopHandle(): ProviderCircuitHandle {
    const registry = this;
    return {
      check: () => {
        const token = Object.freeze({ kind: 'noop' as const });
        registry.#attempts.set(token, {
          generation: 0,
          attemptId: 0,
          kind: 'noop',
          settled: false,
        });
        return { allowed: true, probe: false, token };
      },
      recordSuccess: (token) => registry.#settleNoop(token),
      recordFailure: (token) => registry.#settleNoop(token),
      recordNeutral: (token) => registry.#settleNoop(token),
      abandon: (token) => registry.#abandon(token),
      snapshot: () => ({
        state: 'closed',
        sampleCount: 0,
        failureCount: 0,
        noop: true,
        detached: false,
      }),
    };
  }

  #settleNoop(token: ProviderCircuitAttemptToken): undefined {
    const state = this.#attempts.get(token);
    if (state?.kind === 'noop') state.settled = true;
    return undefined;
  }

  #check(entry: CircuitEntry, probeLeaseMs: number): ProviderCircuitAdmission {
    const now = this.#now();
    if (entry.detached) return this.#noopHandle().check();
    entry.lastTouchedAt = now;
    this.#evictSamples(entry, now);

    if (entry.state === 'closed') {
      return this.#admit(entry, 'regular');
    }
    if (entry.state === 'open') {
      const nextProbeAt = entry.nextProbeAt ?? now;
      if (now < nextProbeAt) return this.#blocked(entry, nextProbeAt - now);
      entry.state = 'half_open';
      entry.generation++;
      entry.probeLeaseId = undefined;
      entry.probeLeaseExpiresAt = undefined;
    }

    if (
      entry.probeLeaseId === undefined ||
      (entry.probeLeaseExpiresAt !== undefined && now >= entry.probeLeaseExpiresAt)
    ) {
      return this.#admitProbe(entry, now, probeLeaseMs);
    }

    const leaseRemaining = Math.max(
      1,
      (entry.probeLeaseExpiresAt ?? now + HALF_OPEN_RETRY_MS) - now
    );
    return this.#blocked(entry, Math.min(HALF_OPEN_RETRY_MS, leaseRemaining));
  }

  #admit(
    entry: CircuitEntry,
    kind: 'regular' | 'probe',
    probeLeaseId?: number
  ): Extract<ProviderCircuitAdmission, { allowed: true }> {
    const token = Object.freeze({ kind });
    this.#attempts.set(token, {
      entry,
      generation: entry.generation,
      attemptId: entry.nextAttemptId++,
      kind,
      ...(probeLeaseId !== undefined ? { probeLeaseId } : {}),
      settled: false,
    });
    return { allowed: true, probe: kind === 'probe', token };
  }

  #admitProbe(
    entry: CircuitEntry,
    now: number,
    probeLeaseMs: number
  ): Extract<ProviderCircuitAdmission, { allowed: true }> {
    const probeLeaseId = entry.nextProbeLeaseId++;
    entry.probeLeaseId = probeLeaseId;
    entry.probeLeaseExpiresAt = now + probeLeaseMs;
    entry.lastTouchedAt = now;
    const admission = this.#admit(entry, 'probe', probeLeaseId);
    const failure = entry.lastFailure ?? { reason: 'server_error' as const };
    return {
      ...admission,
      reason: failure.reason,
      ...(failure.statusCode !== undefined ? { statusCode: failure.statusCode } : {}),
      openDurationMs: entry.effectiveOpenDurationMs,
      sampleCount: entry.samples.length,
      failureCount: countFailures(entry.samples),
    };
  }

  #blocked(
    entry: CircuitEntry,
    retryAfterMs: number
  ): Extract<ProviderCircuitAdmission, { allowed: false }> {
    const failure = entry.lastFailure ?? { reason: 'server_error' as const };
    return {
      allowed: false,
      state: entry.state === 'open' ? 'open' : 'half_open',
      reason: failure.reason,
      ...(failure.statusCode !== undefined ? { statusCode: failure.statusCode } : {}),
      retryAfterMs: Math.max(0, Math.ceil(retryAfterMs)),
      nextProbeAt: this.#wallNow() + Math.max(0, Math.ceil(retryAfterMs)),
      openDurationMs: entry.effectiveOpenDurationMs,
      sampleCount: entry.samples.length,
      failureCount: countFailures(entry.samples),
    };
  }

  #record(
    token: ProviderCircuitAttemptToken,
    outcome: 'success' | 'failure' | 'neutral',
    rawFailure?: ProviderCircuitFailure
  ): ProviderCircuitTransition | undefined {
    const attempt = this.#attempts.get(token);
    if (!attempt || attempt.settled) return undefined;
    attempt.settled = true;
    if (attempt.kind === 'noop' || !attempt.entry) return undefined;

    const entry = attempt.entry;
    if (
      entry.detached ||
      attempt.generation !== entry.generation ||
      (attempt.kind === 'regular' && entry.state !== 'closed') ||
      (attempt.kind === 'probe' &&
        (entry.state !== 'half_open' || attempt.probeLeaseId !== entry.probeLeaseId))
    ) {
      return undefined;
    }

    const now = this.#now();
    entry.lastTouchedAt = now;
    if (attempt.kind === 'probe') {
      if (outcome === 'failure' && rawFailure) {
        return this.#open(entry, rawFailure, now, 'reopened');
      }
      return this.#close(entry);
    }

    if (outcome === 'neutral') return undefined;
    this.#pushSample(entry, outcome === 'failure', now);
    if (outcome !== 'failure' || !rawFailure) return undefined;

    const failures = countFailures(entry.samples);
    const errorRate = entry.samples.length === 0 ? 0 : failures / entry.samples.length;
    if (
      entry.samples.length >= this.#policy.minSamples &&
      errorRate >= this.#policy.errorRateThreshold
    ) {
      return this.#open(entry, rawFailure, now, 'opened');
    }
    return undefined;
  }

  #open(
    entry: CircuitEntry,
    rawFailure: ProviderCircuitFailure,
    now: number,
    phase: 'opened' | 'reopened'
  ): ProviderCircuitTransition {
    const failure: ProviderCircuitFailure = {
      reason: rawFailure.reason,
      ...(sanitizeStatusCode(rawFailure.statusCode) !== undefined
        ? { statusCode: sanitizeStatusCode(rawFailure.statusCode) }
        : {}),
      ...(sanitizeRetryAfter(rawFailure.retryAfterMs) !== undefined
        ? { retryAfterMs: sanitizeRetryAfter(rawFailure.retryAfterMs) }
        : {}),
    };
    const serverDelay = failure.retryAfterMs ?? 0;
    const effectiveOpenDurationMs = Math.max(
      entry.configuredOpenDurationMs,
      serverDelay
    );
    entry.state = 'open';
    entry.generation++;
    entry.probeLeaseId = undefined;
    entry.probeLeaseExpiresAt = undefined;
    entry.effectiveOpenDurationMs = effectiveOpenDurationMs;
    entry.nextProbeAt = now + effectiveOpenDurationMs;
    entry.lastFailure = failure;

    return {
      phase,
      reason: failure.reason,
      ...(failure.statusCode !== undefined ? { statusCode: failure.statusCode } : {}),
      retryAfterMs: effectiveOpenDurationMs,
      nextProbeAt: this.#wallNow() + effectiveOpenDurationMs,
      openDurationMs: effectiveOpenDurationMs,
      sampleCount: entry.samples.length,
      failureCount: countFailures(entry.samples),
    };
  }

  #close(entry: CircuitEntry): ProviderCircuitTransition {
    const failure = entry.lastFailure ?? { reason: 'server_error' as const };
    entry.state = 'closed';
    entry.generation++;
    entry.samples = [];
    entry.probeLeaseId = undefined;
    entry.probeLeaseExpiresAt = undefined;
    entry.nextProbeAt = undefined;
    entry.effectiveOpenDurationMs = entry.configuredOpenDurationMs;
    return {
      phase: 'closed',
      reason: failure.reason,
      ...(failure.statusCode !== undefined ? { statusCode: failure.statusCode } : {}),
      openDurationMs: entry.effectiveOpenDurationMs,
      sampleCount: 0,
      failureCount: 0,
    };
  }

  #abandon(token: ProviderCircuitAttemptToken): boolean {
    const attempt = this.#attempts.get(token);
    if (!attempt || attempt.settled) return false;
    attempt.settled = true;
    if (attempt.kind === 'noop') return true;
    const entry = attempt.entry;
    if (
      !entry ||
      entry.detached ||
      attempt.kind !== 'probe' ||
      attempt.generation !== entry.generation ||
      attempt.probeLeaseId !== entry.probeLeaseId
    ) {
      return false;
    }
    entry.probeLeaseId = undefined;
    entry.probeLeaseExpiresAt = undefined;
    entry.lastTouchedAt = this.#now();
    return true;
  }

  #pushSample(entry: CircuitEntry, failure: boolean, now: number): void {
    this.#evictSamples(entry, now);
    if (entry.samples.length >= this.#policy.maxWindowEntries) {
      entry.samples.shift();
    }
    entry.samples.push({ at: now, failure });
  }

  #evictSamples(entry: CircuitEntry, now: number): void {
    const cutoff = now - this.#policy.windowMs;
    let firstLive = 0;
    while (firstLive < entry.samples.length && entry.samples[firstLive].at < cutoff) {
      firstLive++;
    }
    if (firstLive > 0) entry.samples.splice(0, firstLive);
  }

  #snapshot(entry: CircuitEntry): ProviderCircuitSnapshot {
    if (!entry.detached) this.#evictSamples(entry, this.#now());
    return {
      state: entry.state,
      sampleCount: entry.samples.length,
      failureCount: countFailures(entry.samples),
      ...(entry.nextProbeAt !== undefined ? { nextProbeAt: entry.nextProbeAt } : {}),
      noop: false,
      detached: entry.detached,
    };
  }

  #evictIdleClosed(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (
        entry.state === 'closed' &&
        now - entry.lastTouchedAt > this.#policy.idleTtlMs
      ) {
        this.#detach(key, entry);
      }
    }
  }

  #evictLeastRecentlyUsedClosed(): void {
    let candidate: CircuitEntry | undefined;
    for (const entry of this.#entries.values()) {
      if (
        entry.state === 'closed' &&
        (!candidate || entry.lastTouchedAt < candidate.lastTouchedAt)
      ) {
        candidate = entry;
      }
    }
    if (candidate) this.#detach(candidate.key, candidate);
  }

  #detach(key: string, entry: CircuitEntry): void {
    entry.detached = true;
    this.#entries.delete(key);
  }
}

let sharedRegistry: ProviderCircuitRegistry | undefined;

export function getProviderCircuitRegistry(): ProviderCircuitRegistry {
  sharedRegistry ??= new ProviderCircuitRegistry();
  return sharedRegistry;
}
