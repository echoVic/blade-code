import { describe, expect, it } from 'vitest';
import {
  normalizeProviderRecoveryIdentity,
  PROVIDER_RECOVERY_IDENTITY_MAX_CHARS,
  ProviderRecoveryProjectionSchema,
} from '../../../src/api/providerRecoverySchemas.js';

function retryProjection() {
  return {
    version: 1 as const,
    generation: 'generation-1',
    revision: 2,
    snapshot: {
      activity: 'retry_wait' as const,
      reason: 'rate_limit' as const,
      updatedAt: 1_780_000_000_000,
      nextActionAt: 1_780_000_002_000,
      retry: {
        attempt: 1,
        maxRetries: 12,
        statusCode: 429,
        delayMs: 2_000,
        recoveryBudgetMs: 600_000,
        recoveryElapsedMs: 1_000,
        recoveryRemainingMs: 599_000,
      },
      fallback: {
        from: { provider: 'deepseek', model: 'deepseek-chat' },
        to: { provider: 'deepseek', model: 'deepseek-reasoner' },
        candidate: 1,
        candidateCount: 1,
        trigger: {
          source: 'retry' as const,
          reason: 'rate_limit' as const,
          statusCode: 429,
        },
      },
    },
  };
}

describe('Provider recovery schemas', () => {
  it('accepts a bounded retry projection with fallback context', () => {
    expect(ProviderRecoveryProjectionSchema.parse(retryProjection())).toEqual(
      retryProjection()
    );
  });

  it('accepts an explicit authoritative clear', () => {
    const clear = {
      version: 1 as const,
      generation: 'generation-2',
      revision: 0,
      snapshot: null,
    };

    expect(ProviderRecoveryProjectionSchema.parse(clear)).toEqual(clear);
  });

  it.each([
    { field: 'revision', value: -1 },
    { field: 'revision', value: 1.5 },
  ])('rejects invalid $field counters', ({ field, value }) => {
    expect(() =>
      ProviderRecoveryProjectionSchema.parse({
        ...retryProjection(),
        [field]: value,
      })
    ).toThrow();
  });

  it('rejects malformed generations and identities', () => {
    expect(() =>
      ProviderRecoveryProjectionSchema.parse({
        ...retryProjection(),
        generation: 'x'.repeat(129),
      })
    ).toThrow();
    expect(() =>
      ProviderRecoveryProjectionSchema.parse({
        ...retryProjection(),
        snapshot: {
          ...retryProjection().snapshot,
          fallback: {
            ...retryProjection().snapshot.fallback,
            to: { provider: 'deepseek\nprivate', model: 'deepseek-reasoner' },
          },
        },
      })
    ).toThrow();
  });

  it.each(['apiKey', 'baseUrl', 'headers', 'message', 'url'])(
    'rejects the unexpected sensitive field %s',
    (field) => {
      expect(() =>
        ProviderRecoveryProjectionSchema.parse({
          ...retryProjection(),
          snapshot: {
            ...retryProjection().snapshot,
            [field]: 'must-not-cross-the-boundary',
          },
        })
      ).toThrow();
    }
  );

  it('rejects unknown nested fields and impossible counters', () => {
    expect(() =>
      ProviderRecoveryProjectionSchema.parse({
        ...retryProjection(),
        snapshot: {
          ...retryProjection().snapshot,
          retry: {
            ...retryProjection().snapshot.retry,
            attempt: -1,
          },
        },
      })
    ).toThrow();
    expect(() =>
      ProviderRecoveryProjectionSchema.parse({
        ...retryProjection(),
        snapshot: {
          ...retryProjection().snapshot,
          fallback: {
            ...retryProjection().snapshot.fallback,
            apiKey: 'secret',
          },
        },
      })
    ).toThrow();
  });

  it('normalizes catalog identity before it enters the projection', () => {
    const normalized = normalizeProviderRecoveryIdentity(
      `  deep\u0000seek\n${'x'.repeat(PROVIDER_RECOVERY_IDENTITY_MAX_CHARS)}  `
    );

    expect(
      [...normalized].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint > 31 && codePoint !== 127;
      })
    ).toBe(true);
    expect(normalized).toHaveLength(PROVIDER_RECOVERY_IDENTITY_MAX_CHARS);
    expect(normalized.startsWith('deepseek')).toBe(true);
  });

  it('rejects empty identities after normalization', () => {
    expect(() => normalizeProviderRecoveryIdentity('\u0000\n\t')).toThrow(
      'Provider recovery identity is empty'
    );
  });
});
