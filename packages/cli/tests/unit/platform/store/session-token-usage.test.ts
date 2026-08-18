import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../../src/config/defaults.js';
import { getState, sessionActions } from '../../../../src/store/vanilla.js';

describe('session token usage', () => {
  beforeEach(() => {
    sessionActions().resetTokenUsage();
  });

  it('adds every API call instead of treating usage as a cumulative snapshot', () => {
    sessionActions().updateTokenUsage({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
      costUsd: 0.125,
    });
    sessionActions().updateTokenUsage({
      inputTokens: 140,
      outputTokens: 15,
      totalTokens: 155,
      cacheReadTokens: 50,
      cacheWriteTokens: 5,
      costUsd: 0.25,
    });

    expect(getState().session.tokenUsage).toMatchObject({
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

  it('uses catalog cache prices when exact pi cost is unavailable', () => {
    getState().config.actions.setConfig({
      ...DEFAULT_CONFIG,
      currentModelId: 'claude',
      models: [
        {
          id: 'claude',
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
        },
      ],
    });

    sessionActions().updateTokenUsage({
      inputTokens: 170_000,
      outputTokens: 10_000,
      totalTokens: 180_000,
      cacheReadTokens: 50_000,
      cacheWriteTokens: 20_000,
    });

    expect(getState().session.tokenUsage.estimatedCostUsd).toBeCloseTo(
      (100_000 / 1_000_000) * 3 +
        (10_000 / 1_000_000) * 15 +
        (50_000 / 1_000_000) * 0.3 +
        (20_000 / 1_000_000) * 3.75,
      6
    );
  });

  it('retains the latest cache-break attribution', () => {
    sessionActions().updateTokenUsage({
      inputTokens: 5_000,
      cacheReadTokens: 100,
      cacheBreak: {
        reason: 'system_prompt_changed',
        previousCacheReadTokens: 5_000,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
        tokenDrop: 4_900,
        elapsedMs: 1_000,
        callNumber: 2,
        systemPromptChanged: true,
        systemCharDelta: 20,
        toolsChanged: false,
        addedToolCount: 0,
        removedToolCount: 0,
        changedToolCount: 0,
        modelChanged: false,
        requestPolicyChanged: false,
      },
    });
    sessionActions().updateTokenUsage({
      inputTokens: 500,
      cacheReadTokens: 400,
    });

    expect(getState().session.tokenUsage.cacheBreak).toMatchObject({
      reason: 'system_prompt_changed',
      previousCacheReadTokens: 5_000,
      cacheReadTokens: 100,
    });
  });
});
