import { describe, expect, it } from 'vitest';
import { ProviderRecoveryState } from '../../../../src/agent/runtime/ProviderRecoveryState.js';

const retryScheduled = {
  kind: 'provider_retry' as const,
  phase: 'scheduled' as const,
  attempt: 1,
  maxRetries: 12,
  reason: 'rate_limit' as const,
  statusCode: 429,
  delayMs: 2_000,
  nextRetryAt: 3_000,
  mode: 'bounded_foreground' as const,
  recoveryBudgetMs: 600_000,
  recoveryElapsedMs: 1_000,
  recoveryRemainingMs: 599_000,
};

describe('ProviderRecoveryState', () => {
  it('starts a new cleared generation and advances revisions monotonically', () => {
    let nextGeneration = 0;
    const state = new ProviderRecoveryState({
      now: () => 1_000,
      createGenerationId: () => `generation-${++nextGeneration}`,
    });

    const generation = state.begin();
    expect(state.snapshot()).toEqual({
      version: 1,
      generation: 'generation-1',
      revision: 0,
      snapshot: null,
    });

    const retry = state.observe(generation, retryScheduled);
    expect(retry).toMatchObject({
      version: 1,
      generation: 'generation-1',
      revision: 1,
      snapshot: {
        activity: 'retry_wait',
        reason: 'rate_limit',
        updatedAt: 1_000,
        nextActionAt: 3_000,
        retry: {
          attempt: 1,
          maxRetries: 12,
          statusCode: 429,
          delayMs: 2_000,
          recoveryRemainingMs: 599_000,
        },
      },
    });
  });

  it('reduces admission, circuit, stall, and fallback using stable precedence', () => {
    const state = new ProviderRecoveryState({
      now: () => 10_000,
      createGenerationId: () => 'generation-1',
    });
    const generation = state.begin();

    expect(
      state.observe(generation, {
        kind: 'provider_admission',
        phase: 'queued',
        requestClass: 'foreground',
        resource: 'stream',
        scope: 'domain',
        reason: 'capacity',
        queuePosition: 2,
        queueDepth: 3,
        inFlight: 1,
        limit: 1,
        waitMs: 4_000,
        maxWaitMs: 30_000,
      })?.snapshot
    ).toMatchObject({ activity: 'admission_wait', reason: 'capacity' });

    expect(
      state.observe(generation, {
        kind: 'provider_circuit',
        phase: 'waiting',
        reason: 'server_error',
        statusCode: 503,
        retryAfterMs: 5_000,
        nextProbeAt: 15_000,
        openDurationMs: 5_000,
      })?.snapshot
    ).toMatchObject({
      activity: 'circuit_open',
      reason: 'server_error',
      nextActionAt: 15_000,
    });

    expect(
      state.observe(generation, {
        kind: 'provider_stall',
        phase: 'detected',
        stallCount: 1,
        durationMs: 15_000,
        warningAfterMs: 15_000,
        timeoutMs: 60_000,
        outputStarted: false,
      })?.snapshot
    ).toMatchObject({ activity: 'stream_stall', reason: 'stream_stall' });

    expect(
      state.observe(generation, {
        kind: 'model_fallback',
        from: { provider: 'primary', model: 'one' },
        to: { provider: 'secondary', model: 'two' },
        candidate: 1,
        candidateCount: 1,
        trigger: { source: 'retry', reason: 'server_error', statusCode: 503 },
      })?.snapshot
    ).toEqual({
      activity: 'fallback',
      reason: 'server_error',
      updatedAt: 10_000,
      fallback: {
        from: { provider: 'primary', model: 'one' },
        to: { provider: 'secondary', model: 'two' },
        candidate: 1,
        candidateCount: 1,
        trigger: { source: 'retry', reason: 'server_error', statusCode: 503 },
      },
    });

    expect(state.observe(generation, retryScheduled)?.snapshot).toMatchObject({
      activity: 'retry_wait',
      fallback: { to: { model: 'two' } },
    });
  });

  it('removes recovered layers and clears on useful progress', () => {
    const state = new ProviderRecoveryState({
      now: () => 2_000,
      createGenerationId: () => 'generation-1',
    });
    const generation = state.begin();
    state.observe(generation, retryScheduled);

    expect(
      state.observe(generation, {
        kind: 'provider_retry',
        phase: 'recovered',
        attempt: 1,
        maxRetries: 12,
        reason: 'rate_limit',
      })?.snapshot
    ).toBeNull();

    state.observe(generation, retryScheduled);
    expect(
      state.observe(generation, { kind: 'content_delta', delta: 'ok' })?.snapshot
    ).toBeNull();
    expect(
      state.observe(generation, { kind: 'content_delta', delta: '' })
    ).toBeUndefined();
  });

  it('treats a zero-delay retry as an active attempt instead of a wait', () => {
    const state = new ProviderRecoveryState({
      now: () => 2_000,
      createGenerationId: () => 'generation-1',
    });
    const generation = state.begin();

    expect(
      state.observe(generation, {
        ...retryScheduled,
        delayMs: 0,
        nextRetryAt: 2_000,
      })?.snapshot
    ).toMatchObject({
      activity: 'retry_attempt',
      reason: 'rate_limit',
    });
  });

  it('preserves the absolute retry deadline instead of extending it from now', () => {
    const state = new ProviderRecoveryState({
      now: () => 2_500,
      createGenerationId: () => 'generation-1',
    });
    const generation = state.begin();

    expect(
      state.observe(generation, {
        ...retryScheduled,
        delayMs: 10_000,
        nextRetryAt: 4_000,
      })?.snapshot?.nextActionAt
    ).toBe(4_000);
  });

  it('preserves fallback context after a recovered stall', () => {
    const state = new ProviderRecoveryState({
      now: () => 5_000,
      createGenerationId: () => 'generation-1',
    });
    const generation = state.begin();
    state.observe(generation, {
      kind: 'model_fallback',
      from: { provider: 'primary', model: 'one' },
      to: { provider: 'secondary', model: 'two' },
      candidate: 1,
      candidateCount: 1,
      trigger: { source: 'stall', reason: 'timeout' },
    });
    state.observe(generation, {
      kind: 'provider_stall',
      phase: 'detected',
      stallCount: 1,
      durationMs: 15_000,
      warningAfterMs: 15_000,
      timeoutMs: 60_000,
      outputStarted: false,
    });

    expect(
      state.observe(generation, {
        kind: 'provider_stall',
        phase: 'recovered',
        stallCount: 1,
        durationMs: 16_000,
        warningAfterMs: 15_000,
        timeoutMs: 60_000,
        outputStarted: false,
      })?.snapshot
    ).toMatchObject({ activity: 'fallback', fallback: { candidate: 1 } });
  });

  it('rejects stale generations and returns defensive snapshots', () => {
    let nextGeneration = 0;
    const state = new ProviderRecoveryState({
      now: () => 1_000,
      createGenerationId: () => `generation-${++nextGeneration}`,
    });
    const stale = state.begin();
    state.observe(stale, retryScheduled);
    const current = state.begin();

    expect(
      state.observe(stale, { ...retryScheduled, phase: 'attempt' })
    ).toBeUndefined();
    expect(state.clear(stale)).toBeUndefined();
    expect(state.snapshot()).toMatchObject({
      generation: current.id,
      revision: 0,
      snapshot: null,
    });

    state.observe(current, retryScheduled);
    const copy = state.snapshot();
    if (!copy.snapshot?.retry) throw new Error('Expected retry snapshot');
    copy.snapshot.retry.attempt = 99;
    expect(state.snapshot().snapshot?.retry?.attempt).toBe(1);
  });

  it('clears an active snapshot once and ignores repeated clears', () => {
    const state = new ProviderRecoveryState({
      now: () => 3_000,
      createGenerationId: () => 'generation-1',
    });
    const generation = state.begin();
    state.observe(generation, retryScheduled);

    expect(state.clear(generation)).toMatchObject({ revision: 2, snapshot: null });
    expect(state.clear(generation)).toBeUndefined();
    expect(state.observe(generation, retryScheduled)).toBeUndefined();
    expect(state.snapshot()).toMatchObject({ revision: 2, snapshot: null });
  });

  it('invalidates a generation even when no recovery snapshot became visible', () => {
    const state = new ProviderRecoveryState({
      now: () => 3_000,
      createGenerationId: () => 'generation-1',
    });
    const generation = state.begin();

    expect(state.clear(generation)).toBeUndefined();
    expect(state.observe(generation, retryScheduled)).toBeUndefined();
    expect(state.snapshot()).toMatchObject({ revision: 0, snapshot: null });
  });
});
