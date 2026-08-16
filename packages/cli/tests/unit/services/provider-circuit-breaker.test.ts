import { describe, expect, it } from 'vitest';
import {
  createProviderCircuitFailureDomainKey,
  DEFAULT_PROVIDER_CIRCUIT_OPEN_MS,
  MAX_PROVIDER_CIRCUIT_REGISTRY_ENTRIES,
  MAX_PROVIDER_CIRCUIT_WINDOW_ENTRIES,
  PROVIDER_CIRCUIT_ERROR_RATE_THRESHOLD,
  PROVIDER_CIRCUIT_MIN_SAMPLES,
  PROVIDER_CIRCUIT_WINDOW_MS,
  type ProviderCircuitHandle,
  ProviderCircuitRegistry,
  type ProviderCircuitScope,
} from '../../../src/services/pi/providerCircuitBreaker.js';

const TEST_SECRET = new Uint8Array(32).fill(7);

function scope(overrides: Partial<ProviderCircuitScope> = {}): ProviderCircuitScope {
  return {
    provider: 'deepseek',
    api: 'openai-completions',
    baseUrl: 'https://provider.example/v1',
    model: 'deepseek-v4-flash',
    serviceTier: 'default',
    apiVersion: '2026-08-16',
    apiKey: 'secret-api-key',
    customHeaders: {
      'x-route-tenant': 'tenant-a',
      Authorization: 'Bearer private-token',
    },
    openDurationMs: DEFAULT_PROVIDER_CIRCUIT_OPEN_MS,
    probeLeaseMs: 300_000,
    ...overrides,
  };
}

function registry(
  options: {
    now?: () => number;
    wallNow?: () => number;
    maxEntries?: number;
    maxWindowEntries?: number;
    windowMs?: number;
    minSamples?: number;
    errorRateThreshold?: number;
    idleTtlMs?: number;
  } = {}
): ProviderCircuitRegistry {
  return new ProviderCircuitRegistry({
    processSecret: TEST_SECRET,
    ...options,
  });
}

function recordFailure(
  handle: ProviderCircuitHandle,
  failure: {
    reason?: 'server_error' | 'rate_limit' | 'transport' | 'stream_closed';
    statusCode?: number;
    retryAfterMs?: number;
  } = {}
) {
  const admission = handle.check();
  expect(admission.allowed).toBe(true);
  if (!admission.allowed) throw new Error('expected circuit admission');
  return handle.recordFailure(admission.token, {
    reason: failure.reason ?? 'server_error',
    statusCode: failure.statusCode ?? 503,
    retryAfterMs: failure.retryAfterMs,
  });
}

function trip(handle: ProviderCircuitHandle) {
  let transition: ReturnType<ProviderCircuitHandle['recordFailure']>;
  for (let index = 0; index < PROVIDER_CIRCUIT_MIN_SAMPLES; index++) {
    transition = recordFailure(handle);
  }
  expect(transition).toMatchObject({
    phase: 'opened',
    reason: 'server_error',
    statusCode: 503,
    sampleCount: PROVIDER_CIRCUIT_MIN_SAMPLES,
    failureCount: PROVIDER_CIRCUIT_MIN_SAMPLES,
  });
}

describe('ProviderCircuitRegistry state machine', () => {
  it('freezes the production bounds', () => {
    expect(DEFAULT_PROVIDER_CIRCUIT_OPEN_MS).toBe(10_000);
    expect(PROVIDER_CIRCUIT_WINDOW_MS).toBe(60_000);
    expect(PROVIDER_CIRCUIT_MIN_SAMPLES).toBe(4);
    expect(PROVIDER_CIRCUIT_ERROR_RATE_THRESHOLD).toBe(0.8);
    expect(MAX_PROVIDER_CIRCUIT_REGISTRY_ENTRIES).toBe(128);
    expect(MAX_PROVIDER_CIRCUIT_WINDOW_ENTRIES).toBe(256);
  });

  it('opens after four circuit failures and reports an exact retry boundary', () => {
    let now = 1_000;
    const handle = registry({ now: () => now }).get(scope());

    trip(handle);

    expect(handle.snapshot()).toMatchObject({
      state: 'open',
      sampleCount: 4,
      failureCount: 4,
      nextProbeAt: 11_000,
    });
    now = 4_250;
    expect(handle.check()).toMatchObject({
      allowed: false,
      state: 'open',
      retryAfterMs: 6_750,
      nextProbeAt: 11_000,
      reason: 'server_error',
      statusCode: 503,
    });
  });

  it('preflights circuit state without claiming an attempt or half-open probe', () => {
    let now = 1_000;
    const handle = registry({ now: () => now }).get(scope());

    expect(handle.preflight()).toEqual({ eligible: true });
    trip(handle);
    expect(handle.preflight()).toMatchObject({
      eligible: false,
      state: 'open',
      retryAfterMs: DEFAULT_PROVIDER_CIRCUIT_OPEN_MS,
    });

    now += DEFAULT_PROVIDER_CIRCUIT_OPEN_MS;
    expect(handle.preflight()).toEqual({ eligible: true });
    expect(handle.snapshot().state).toBe('open');

    const probe = handle.check();
    expect(probe).toMatchObject({ allowed: true, probe: true });
    expect(handle.preflight()).toMatchObject({
      eligible: false,
      state: 'half_open',
    });
    if (!probe.allowed) throw new Error('expected probe admission');
    expect(handle.abandon(probe.token)).toBe(true);
    expect(handle.preflight()).toEqual({ eligible: true });
  });

  it('uses monotonic time for admission and wall time only for UI hints', () => {
    let monotonicNow = 1_000;
    let wallNow = 100_000;
    const handle = registry({
      now: () => monotonicNow,
      wallNow: () => wallNow,
    }).get(scope());

    let transition: ReturnType<ProviderCircuitHandle['recordFailure']>;
    for (let index = 0; index < 4; index++) {
      transition = recordFailure(handle);
    }
    expect(handle.snapshot().nextProbeAt).toBe(11_000);
    expect(transition?.nextProbeAt).toBe(110_000);

    wallNow = 1;
    monotonicNow += DEFAULT_PROVIDER_CIRCUIT_OPEN_MS;
    expect(handle.check()).toMatchObject({ allowed: true, probe: true });
  });

  it('requires the frozen error rate after the minimum sample count', () => {
    const below = registry().get(scope({ model: 'below-threshold' }));
    for (let index = 0; index < 3; index++) recordFailure(below);
    const success = below.check();
    expect(success.allowed).toBe(true);
    if (!success.allowed) throw new Error('expected success admission');
    below.recordSuccess(success.token);
    expect(below.snapshot()).toMatchObject({
      state: 'closed',
      sampleCount: 4,
      failureCount: 3,
    });

    const exact = registry().get(scope({ model: 'exact-threshold' }));
    const initialSuccess = exact.check();
    expect(initialSuccess.allowed).toBe(true);
    if (!initialSuccess.allowed) throw new Error('expected success admission');
    exact.recordSuccess(initialSuccess.token);
    for (let index = 0; index < 4; index++) recordFailure(exact);
    expect(exact.snapshot()).toMatchObject({
      state: 'open',
      sampleCount: 5,
      failureCount: 4,
    });
  });

  it('evicts stale samples and bounds retained outcomes', () => {
    let now = 1_000;
    const handle = registry({
      now: () => now,
      minSamples: Number.MAX_SAFE_INTEGER,
      maxWindowEntries: 5,
    }).get(scope());

    for (let index = 0; index < 12; index++) {
      recordFailure(handle);
      now += 1;
    }
    expect(handle.snapshot()).toMatchObject({
      state: 'closed',
      sampleCount: 5,
      failureCount: 5,
    });

    now += PROVIDER_CIRCUIT_WINDOW_MS + 1;
    const admission = handle.check();
    expect(admission.allowed).toBe(true);
    if (!admission.allowed) throw new Error('expected success admission');
    handle.recordSuccess(admission.token);
    expect(handle.snapshot()).toMatchObject({
      state: 'closed',
      sampleCount: 1,
      failureCount: 0,
    });
  });

  it('honors a bounded server retry directive when opening', () => {
    let now = 10_000;
    const handle = registry({ now: () => now }).get(scope());
    for (let index = 0; index < 3; index++) recordFailure(handle);
    const transition = recordFailure(handle, { retryAfterMs: 45_000 });

    expect(transition).toMatchObject({
      phase: 'opened',
      retryAfterMs: 45_000,
      nextProbeAt: 55_000,
    });
    now += 20_000;
    expect(handle.check()).toMatchObject({
      allowed: false,
      retryAfterMs: 25_000,
    });
  });

  it('admits exactly one half-open probe for concurrent same-tick checks', () => {
    let now = 1_000;
    const handle = registry({ now: () => now }).get(scope());
    trip(handle);
    now += DEFAULT_PROVIDER_CIRCUIT_OPEN_MS;

    const admissions = Array.from({ length: 32 }, () => handle.check());
    expect(admissions.filter((entry) => entry.allowed)).toHaveLength(1);
    expect(admissions.filter((entry) => !entry.allowed)).toHaveLength(31);
    expect(admissions.find((entry) => entry.allowed)).toMatchObject({
      allowed: true,
      probe: true,
    });
    expect(handle.snapshot().state).toBe('half_open');
  });

  it('closes on probe success or neutral response and reopens on probe failure', () => {
    let now = 1_000;
    const successHandle = registry({ now: () => now }).get(
      scope({ model: 'probe-success' })
    );
    trip(successHandle);
    now += DEFAULT_PROVIDER_CIRCUIT_OPEN_MS;
    const successProbe = successHandle.check();
    expect(successProbe.allowed).toBe(true);
    if (!successProbe.allowed) throw new Error('expected probe admission');
    expect(successHandle.recordSuccess(successProbe.token)).toMatchObject({
      phase: 'closed',
    });
    expect(successHandle.snapshot()).toMatchObject({
      state: 'closed',
      sampleCount: 0,
      failureCount: 0,
    });

    const neutralHandle = registry({ now: () => now }).get(
      scope({ model: 'probe-neutral' })
    );
    trip(neutralHandle);
    now += DEFAULT_PROVIDER_CIRCUIT_OPEN_MS;
    const neutralProbe = neutralHandle.check();
    expect(neutralProbe.allowed).toBe(true);
    if (!neutralProbe.allowed) throw new Error('expected probe admission');
    expect(neutralHandle.recordNeutral(neutralProbe.token)).toMatchObject({
      phase: 'closed',
    });

    const failureHandle = registry({ now: () => now }).get(
      scope({ model: 'probe-failure' })
    );
    trip(failureHandle);
    now += DEFAULT_PROVIDER_CIRCUIT_OPEN_MS;
    const failureProbe = failureHandle.check();
    expect(failureProbe.allowed).toBe(true);
    if (!failureProbe.allowed) throw new Error('expected probe admission');
    expect(
      failureHandle.recordFailure(failureProbe.token, {
        reason: 'transport',
      })
    ).toMatchObject({
      phase: 'reopened',
      reason: 'transport',
      retryAfterMs: DEFAULT_PROVIDER_CIRCUIT_OPEN_MS,
    });
    expect(failureHandle.snapshot()).toMatchObject({
      state: 'open',
      nextProbeAt: now + DEFAULT_PROVIDER_CIRCUIT_OPEN_MS,
    });
  });

  it('restores the configured open policy after a successful probe', () => {
    let now = 1_000;
    const handle = registry({ now: () => now }).get(scope({ openDurationMs: 2_000 }));
    for (let index = 0; index < 4; index++) {
      recordFailure(handle, { retryAfterMs: 45_000 });
    }
    expect(handle.snapshot().nextProbeAt).toBe(46_000);

    now = 46_000;
    const probe = handle.check();
    expect(probe.allowed).toBe(true);
    if (!probe.allowed) throw new Error('expected probe admission');
    handle.recordSuccess(probe.token);

    for (let index = 0; index < 4; index++) recordFailure(handle);
    expect(handle.snapshot().nextProbeAt).toBe(48_000);
  });

  it('rejects forged tokens and records each admitted outcome at most once', () => {
    const handle = registry().get(scope());
    const forged = { kind: 'regular' as const };
    expect(handle.recordSuccess(forged)).toBeUndefined();
    expect(
      handle.recordFailure(forged, {
        reason: 'server_error',
        statusCode: 503,
      })
    ).toBeUndefined();

    const admission = handle.check();
    expect(admission.allowed).toBe(true);
    if (!admission.allowed) throw new Error('expected admission');
    handle.recordFailure(admission.token, {
      reason: 'server_error',
      statusCode: 503,
    });
    handle.recordFailure(admission.token, {
      reason: 'server_error',
      statusCode: 503,
    });
    expect(handle.snapshot()).toMatchObject({
      sampleCount: 1,
      failureCount: 1,
    });
  });

  it('releases an explicitly abandoned probe immediately', () => {
    let now = 1_000;
    const handle = registry({ now: () => now }).get(scope());
    trip(handle);
    now += DEFAULT_PROVIDER_CIRCUIT_OPEN_MS;

    const abandoned = handle.check();
    expect(abandoned.allowed).toBe(true);
    if (!abandoned.allowed) throw new Error('expected probe admission');
    expect(handle.abandon(abandoned.token)).toBe(true);

    const replacement = handle.check();
    expect(replacement).toMatchObject({ allowed: true, probe: true });
  });

  it('reclaims an expired probe and ignores stale outcomes from its old owner', () => {
    let now = 1_000;
    const handle = registry({ now: () => now }).get(scope({ probeLeaseMs: 300_000 }));
    trip(handle);
    now += DEFAULT_PROVIDER_CIRCUIT_OPEN_MS;

    const stale = handle.check();
    expect(stale.allowed).toBe(true);
    if (!stale.allowed) throw new Error('expected probe admission');
    now += 300_000;
    const replacement = handle.check();
    expect(replacement).toMatchObject({ allowed: true, probe: true });
    if (!replacement.allowed) throw new Error('expected replacement probe');

    expect(handle.recordSuccess(stale.token)).toBeUndefined();
    expect(
      handle.recordFailure(stale.token, {
        reason: 'server_error',
        statusCode: 503,
      })
    ).toBeUndefined();
    expect(handle.snapshot().state).toBe('half_open');

    expect(handle.recordSuccess(replacement.token)).toMatchObject({
      phase: 'closed',
    });
    expect(handle.snapshot().state).toBe('closed');
  });

  it('ignores stale regular failures after another attempt opens the circuit', () => {
    let now = 1_000;
    const handle = registry({ now: () => now }).get(scope());
    const admissions = Array.from({ length: 5 }, () => handle.check());
    expect(admissions.every((entry) => entry.allowed)).toBe(true);
    const tokens = admissions.flatMap((entry) => (entry.allowed ? [entry.token] : []));

    for (const token of tokens.slice(0, 4)) {
      handle.recordFailure(token, {
        reason: 'server_error',
        statusCode: 503,
      });
    }
    const openedAt = handle.snapshot().nextProbeAt;
    now += 5_000;
    expect(
      handle.recordFailure(tokens[4], {
        reason: 'server_error',
        statusCode: 503,
        retryAfterMs: 300_000,
      })
    ).toBeUndefined();
    expect(handle.snapshot().nextProbeAt).toBe(openedAt);
  });

  it('disables all state and sampling when open duration is zero', () => {
    const disabled = registry().get(scope({ openDurationMs: 0 }));
    for (let index = 0; index < 20; index++) recordFailure(disabled);
    expect(disabled.snapshot()).toMatchObject({
      state: 'closed',
      sampleCount: 0,
      failureCount: 0,
      noop: true,
    });
  });
});

describe('ProviderCircuitRegistry identity and capacity', () => {
  it('uses a stable opaque HMAC without retaining raw routing or credentials', () => {
    const input = scope();
    const first = createProviderCircuitFailureDomainKey(input, TEST_SECRET);
    const second = createProviderCircuitFailureDomainKey(
      {
        ...input,
        customHeaders: {
          Authorization: 'Bearer private-token',
          'x-route-tenant': 'tenant-a',
        },
      },
      TEST_SECRET
    );

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(
      createProviderCircuitFailureDomainKey(input, new Uint8Array(32).fill(8))
    ).not.toBe(first);
    for (const secret of [
      input.baseUrl,
      input.apiKey,
      input.customHeaders?.Authorization,
      input.customHeaders?.['x-route-tenant'],
      input.provider,
      input.model,
    ]) {
      expect(first).not.toContain(secret);
    }
  });

  it.each([
    ['endpoint', { baseUrl: 'https://other.example/v1' }],
    ['model', { model: 'deepseek-v4-pro' }],
    ['tier', { serviceTier: 'fast' }],
    ['API version', { apiVersion: '2027-01-01' }],
    ['credential', { apiKey: 'another-secret' }],
    ['routing header', { customHeaders: { 'x-route-tenant': 'tenant-b' } }],
    ['open policy', { openDurationMs: 20_000 }],
  ] satisfies Array<[string, Partial<ProviderCircuitScope>]>)(
    'isolates a different %s',
    (_name, override) => {
      const circuits = registry();
      const first = circuits.get(scope());
      const second = circuits.get(scope(override));
      trip(first);
      expect(first.snapshot().state).toBe('open');
      expect(second.snapshot().state).toBe('closed');
    }
  );

  it('shares state for equivalent canonical scopes', () => {
    const circuits = registry();
    const first = circuits.get(scope());
    const second = circuits.get(
      scope({
        baseUrl: 'https://PROVIDER.example/v1/',
        customHeaders: {
          authorization: 'Bearer private-token',
          'X-Route-Tenant': 'tenant-a',
        },
      })
    );
    trip(first);
    expect(second.snapshot().state).toBe('open');
  });

  it('evicts idle and least-recently-used closed entries before active entries', () => {
    let now = 1_000;
    const circuits = registry({
      now: () => now,
      maxEntries: 2,
      idleTtlMs: 100,
    });
    const first = circuits.get(scope({ model: 'first' }));
    now += 1;
    const second = circuits.get(scope({ model: 'second' }));
    expect(circuits.size).toBe(2);

    now += 101;
    circuits.get(scope({ model: 'third' }));
    expect(circuits.size).toBe(1);
    expect(first.snapshot().detached).toBe(true);
    expect(second.snapshot().detached).toBe(true);

    const lruRegistry = registry({ now: () => now, maxEntries: 2 });
    const lruFirst = lruRegistry.get(scope({ model: 'lru-first' }));
    now += 1;
    lruRegistry.get(scope({ model: 'lru-second' }));
    now += 1;
    lruRegistry.get(scope({ model: 'lru-third' }));
    expect(lruRegistry.size).toBe(2);
    expect(lruFirst.snapshot().detached).toBe(true);
  });

  it('keeps active entries and returns a bounded no-op handle at capacity', () => {
    const circuits = registry({ maxEntries: 2 });
    const first = circuits.get(scope({ model: 'active-first' }));
    const second = circuits.get(scope({ model: 'active-second' }));
    trip(first);
    trip(second);

    const overflow = circuits.get(scope({ model: 'overflow' }));
    expect(circuits.size).toBe(2);
    expect(overflow.snapshot()).toMatchObject({
      state: 'closed',
      noop: true,
    });
    for (let index = 0; index < 20; index++) recordFailure(overflow);
    expect(circuits.size).toBe(2);
    expect(overflow.snapshot().sampleCount).toBe(0);
  });

  it('does not let injected options exceed production memory bounds', () => {
    const circuits = registry({
      maxEntries: MAX_PROVIDER_CIRCUIT_REGISTRY_ENTRIES * 10,
      maxWindowEntries: MAX_PROVIDER_CIRCUIT_WINDOW_ENTRIES * 10,
      minSamples: Number.MAX_SAFE_INTEGER,
    });
    for (let index = 0; index < MAX_PROVIDER_CIRCUIT_REGISTRY_ENTRIES + 10; index++) {
      circuits.get(scope({ model: `bounded-${index}` }));
    }
    expect(circuits.size).toBe(MAX_PROVIDER_CIRCUIT_REGISTRY_ENTRIES);

    const handle = circuits.get(scope({ model: 'bounded-window' }));
    for (let index = 0; index < MAX_PROVIDER_CIRCUIT_WINDOW_ENTRIES + 20; index++) {
      recordFailure(handle);
    }
    expect(handle.snapshot().sampleCount).toBe(MAX_PROVIDER_CIRCUIT_WINDOW_ENTRIES);
  });
});
