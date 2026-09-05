import { describe, expect, it } from 'vitest';
import type { ProviderRecoveryProjection } from '../../../../src/api/providerRecoverySchemas.js';
import {
  formatProviderRecoveryPresentation,
  providerRecoveryRemainingMs,
} from '../../../../src/ui/utils/providerRecoveryPresentation.js';

function projection(
  snapshot: NonNullable<ProviderRecoveryProjection['snapshot']>
): ProviderRecoveryProjection {
  return {
    version: 1,
    generation: 'generation-1',
    revision: 1,
    snapshot,
  };
}

describe('Provider recovery presentation', () => {
  it('formats a retry countdown from the absolute next action time', () => {
    const recovery = projection({
      activity: 'retry_wait',
      reason: 'rate_limit',
      updatedAt: 1_000,
      nextActionAt: 33_000,
      retry: {
        attempt: 4,
        maxRetries: 12,
        delayMs: 32_000,
        recoveryRemainingMs: 585_000,
      },
    });

    expect(providerRecoveryRemainingMs(recovery, 2_000)).toBe(31_000);
    expect(formatProviderRecoveryPresentation(recovery, 2_000)).toEqual({
      primary: 'Provider 请求受限，31s 后重试',
      secondary: '尝试 4/12 · 剩余预算 9m 45s',
      compact: 'Provider 限流 · 31s · 4/12',
    });
    expect(providerRecoveryRemainingMs(recovery, 40_000)).toBe(0);
  });

  it('formats admission, circuit, stall, and fallback activities', () => {
    expect(
      formatProviderRecoveryPresentation(
        projection({
          activity: 'admission_wait',
          reason: 'capacity',
          updatedAt: 1_000,
          admission: {
            requestClass: 'foreground',
            resource: 'stream',
            scope: 'domain',
            queuePosition: 2,
            queueDepth: 3,
            inFlight: 1,
            limit: 1,
            waitMs: 4_000,
            maxWaitMs: 30_000,
          },
        }),
        2_000
      )
    ).toMatchObject({
      primary: '等待 Provider 容量',
      secondary: '队列 2/3 · domain · 已等待 4s',
    });
    expect(
      formatProviderRecoveryPresentation(
        projection({
          activity: 'circuit_open',
          reason: 'rate_limit',
          updatedAt: 1_000,
          nextActionAt: 33_000,
          circuit: {
            phase: 'waiting',
            statusCode: 429,
            retryAfterMs: 32_000,
            nextProbeAt: 33_000,
            openDurationMs: 32_000,
            sampleCount: 1,
            failureCount: 1,
          },
        }),
        2_000
      )
    ).toMatchObject({
      primary: 'Provider 请求受限，等待恢复探测（31s）',
      compact: 'Provider 限流 · 31s',
    });
    expect(
      formatProviderRecoveryPresentation(
        projection({
          activity: 'circuit_probe',
          reason: 'server_error',
          updatedAt: 1_000,
          circuit: { phase: 'probe', openDurationMs: 2_000 },
        }),
        2_000
      )
    ).toMatchObject({ primary: 'Provider 正在执行恢复探测' });
    expect(
      formatProviderRecoveryPresentation(
        projection({
          activity: 'stream_stall',
          reason: 'stream_stall',
          updatedAt: 1_000,
          stall: {
            stallCount: 1,
            durationMs: 15_000,
            warningAfterMs: 15_000,
            timeoutMs: 60_000,
            outputStarted: false,
          },
        }),
        2_000
      )
    ).toMatchObject({
      primary: 'Provider 尚未返回流数据',
      secondary: '已等待 15s · 超时上限 1m 0s',
    });
    expect(
      formatProviderRecoveryPresentation(
        projection({
          activity: 'fallback',
          reason: 'server_error',
          updatedAt: 1_000,
          fallback: {
            from: { provider: 'primary', model: 'one' },
            to: { provider: 'secondary', model: 'two' },
            candidate: 1,
            candidateCount: 2,
            trigger: { source: 'retry', reason: 'server_error', statusCode: 503 },
          },
        }),
        2_000
      )
    ).toEqual({
      primary: '正在切换到 two',
      secondary: '候选 1/2 · 来源 one',
      compact: 'Provider 切换 · two',
    });
  });

  it('returns null for an authoritative clear', () => {
    expect(
      formatProviderRecoveryPresentation(
        { version: 1, generation: 'generation-1', revision: 2, snapshot: null },
        2_000
      )
    ).toBeNull();
  });
});
