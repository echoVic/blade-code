import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore } from '../../../src/store/session';
import { initialTokenUsage } from '../../../src/store/session/constants';

describe('Web session token usage', () => {
  beforeEach(() => {
    useSessionStore.setState({ tokenUsage: { ...initialTokenUsage } });
  });

  it('accumulates per-call tokens, cache usage, and exact cost', () => {
    useSessionStore.getState().updateTokenUsage({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
      costUsd: 0.125,
    });
    useSessionStore.getState().updateTokenUsage({
      inputTokens: 140,
      outputTokens: 15,
      totalTokens: 155,
      cacheReadTokens: 50,
      cacheWriteTokens: 5,
      costUsd: 0.25,
    });

    expect(useSessionStore.getState().tokenUsage).toMatchObject({
      inputTokens: 140,
      outputTokens: 15,
      totalTokens: 155,
      totalInputTokens: 240,
      totalOutputTokens: 35,
      cacheReadTokens: 80,
      cacheWriteTokens: 15,
      estimatedCostUsd: 0.375,
    });
  });

  it.each([false, true])(
    'adds auxiliary costs without replacing main context (reset: %s)',
    (reset) => {
      useSessionStore.getState().updateTokenUsage({
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        maxContextTokens: 128_000,
        costUsd: 0.125,
      });
      if (reset) useSessionStore.getState().resetContextUsage();
      useSessionStore.getState().updateTokenUsage({
        scope: 'auxiliary',
        inputTokens: 40,
        outputTokens: 5,
        totalTokens: 45,
        maxContextTokens: 64_000,
        cacheReadTokens: 10,
        cacheWriteTokens: 2,
        costUsd: 0.25,
      });
      expect(useSessionStore.getState().tokenUsage).toMatchObject({
        inputTokens: reset ? 0 : 100,
        outputTokens: reset ? 0 : 20,
        totalTokens: reset ? 0 : 120,
        maxContextTokens: 128_000,
        totalInputTokens: 140,
        totalOutputTokens: 25,
        cacheReadTokens: 10,
        cacheWriteTokens: 2,
        estimatedCostUsd: 0.375,
      });
      expect(useSessionStore.getState().tokenUsage).not.toHaveProperty('scope');
    }
  );

  it('clears current context usage without losing session totals and cost', () => {
    useSessionStore.getState().updateTokenUsage({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 30,
      costUsd: 0.125,
    });

    useSessionStore.getState().resetContextUsage();

    expect(useSessionStore.getState().tokenUsage).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalInputTokens: 100,
      totalOutputTokens: 20,
      cacheReadTokens: 30,
      estimatedCostUsd: 0.125,
    });
  });

  it('retains the latest cache-break attribution across later usage events', () => {
    useSessionStore.getState().updateTokenUsage({
      inputTokens: 4_000,
      cacheReadTokens: 100,
      cacheBreak: {
        reason: 'tools_changed',
        previousCacheReadTokens: 5_000,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
        tokenDrop: 4_900,
        elapsedMs: 1_000,
        callNumber: 2,
      },
    });
    useSessionStore.getState().updateTokenUsage({
      inputTokens: 500,
      cacheReadTokens: 400,
    });

    expect(useSessionStore.getState().tokenUsage.cacheBreak).toMatchObject({
      reason: 'tools_changed',
      previousCacheReadTokens: 5_000,
      cacheReadTokens: 100,
    });
  });
});
