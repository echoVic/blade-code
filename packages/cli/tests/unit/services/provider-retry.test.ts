import { describe, expect, it } from 'vitest';
import {
  classifyProviderRetry,
  computeProviderRetryDelay,
  MAX_PROVIDER_RETRY_DELAY_MS,
} from '../../../src/services/pi/providerRetry.js';

describe('provider retry policy', () => {
  it.each([
    ['429 rate limited', 'rate_limit', 429],
    ['status 503 upstream unavailable', 'server_error', 503],
    ['ECONNRESET while reading response', 'transport', undefined],
    ['Provider stream closed before completion', 'stream_closed', undefined],
    ['Request timed out', 'timeout', undefined],
  ] as const)('classifies %s as retryable %s', (message, reason, statusCode) => {
    expect(classifyProviderRetry(new Error(message))).toEqual({
      retryable: true,
      reason,
      ...(statusCode !== undefined ? { statusCode } : {}),
    });
  });

  it('obeys explicit retry headers while keeping quota and abort failures terminal', () => {
    expect(
      classifyProviderRetry(new Error('status 503'), {
        statusCode: 503,
        shouldRetry: 'false',
      })
    ).toEqual({ retryable: false, statusCode: 503 });
    expect(
      classifyProviderRetry(new Error('status 400'), {
        statusCode: 400,
        shouldRetry: 'true',
      })
    ).toEqual({
      retryable: true,
      reason: 'server_error',
      statusCode: 400,
    });
    expect(
      classifyProviderRetry(new Error('429 insufficient_quota billing exhausted'))
    ).toEqual({ retryable: false });
    expect(
      classifyProviderRetry(new Error('status 503 maximum context length exceeded'))
    ).toEqual({ retryable: false });
    expect(classifyProviderRetry(new DOMException('Stopped', 'AbortError'))).toEqual({
      retryable: false,
    });
    expect(
      classifyProviderRetry(
        Object.assign(new Error('Provider stream idle timeout'), {
          code: 'STREAM_IDLE_TIMEOUT',
        })
      )
    ).toEqual({ retryable: false });
  });

  it('honors numeric and date Retry-After values within a bounded delay', () => {
    expect(
      computeProviderRetryDelay(1, { statusCode: 429, retryAfter: '3' }, { now: 1_000 })
    ).toBe(3_000);
    expect(
      computeProviderRetryDelay(
        1,
        { statusCode: 429, retryAfterMs: '1250' },
        { now: 1_000 }
      )
    ).toBe(1_250);
    expect(
      computeProviderRetryDelay(
        1,
        {
          statusCode: 429,
          retryAfter: new Date(5_000).toUTCString(),
        },
        { now: 1_000 }
      )
    ).toBe(4_000);
    expect(
      computeProviderRetryDelay(
        1,
        { statusCode: 429, retryAfter: '3600' },
        { now: 1_000 }
      )
    ).toBe(MAX_PROVIDER_RETRY_DELAY_MS);
  });

  it('uses bounded jittered exponential backoff without a server directive', () => {
    expect(computeProviderRetryDelay(1, undefined, { random: 0 })).toBe(375);
    expect(computeProviderRetryDelay(1, undefined, { random: 1 })).toBe(500);
    expect(computeProviderRetryDelay(2, undefined, { random: 1 })).toBe(1_000);
    expect(computeProviderRetryDelay(20, undefined, { random: 1 })).toBe(8_000);
  });
});
