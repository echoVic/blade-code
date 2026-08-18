import { describe, expect, it } from 'vitest';
import type { UsageInfo } from '../../../src/services/ChatServiceInterface.js';
import {
  PromptCacheBreakMonitor,
  type PromptCacheObservation,
} from '../../../src/services/pi/promptCacheBreakMonitor.js';

function observation(
  overrides: Partial<PromptCacheObservation> = {}
): PromptCacheObservation {
  return {
    sessionId: 'session-cache-break',
    modelIdentity: 'provider\u0000api\u0000model-a',
    context: {
      systemPrompt: 'stable system prompt',
      messages: [],
      tools: [
        {
          name: 'Read',
          description: 'Read a file',
          parameters: { type: 'object', properties: {} },
        },
      ],
    },
    retention: 'short',
    policy: { reasoning: 'high' },
    usage: {
      promptTokens: 8_000,
      completionTokens: 10,
      totalTokens: 8_010,
      cacheReadInputTokens: 6_000,
    },
    now: 1_000,
    ...overrides,
  };
}

function usage(cacheReadInputTokens: number, promptTokens = 8_000): UsageInfo {
  return {
    promptTokens,
    completionTokens: 10,
    totalTokens: promptTokens + 10,
    cacheReadInputTokens,
  };
}

function retainedState(monitor: PromptCacheBreakMonitor): string {
  const sessions = (
    monitor as unknown as {
      sessions: Map<string, unknown>;
    }
  ).sessions;
  return JSON.stringify([...sessions]);
}

describe('PromptCacheBreakMonitor', () => {
  it('attributes a confirmed cache-read collapse to system prompt churn', () => {
    const monitor = new PromptCacheBreakMonitor();
    expect(monitor.observe(observation())).toBeUndefined();

    expect(
      monitor.observe(
        observation({
          context: {
            systemPrompt: 'changed system prompt with more content',
            messages: [],
          },
          usage: usage(500),
          now: 2_000,
        })
      )
    ).toMatchObject({
      reason: 'system_prompt_changed',
      previousCacheReadTokens: 6_000,
      cacheReadTokens: 500,
      tokenDrop: 5_500,
      callNumber: 2,
      systemPromptChanged: true,
      modelChanged: false,
    });
  });

  it('reports tool and request-policy changes without retaining tool names', () => {
    const monitor = new PromptCacheBreakMonitor();
    monitor.observe(observation());
    const result = monitor.observe(
      observation({
        context: {
          systemPrompt: 'stable system prompt',
          messages: [],
          tools: [
            {
              name: 'Read',
              description: 'Read a file with a changed contract',
              parameters: { type: 'object', properties: {} },
            },
            {
              name: 'Write',
              description: 'Write a file',
              parameters: { type: 'object', properties: {} },
            },
          ],
        },
        policy: { reasoning: 'low' },
        usage: usage(0),
        now: 2_000,
      })
    );

    expect(result).toMatchObject({
      reason: 'tools_changed',
      toolsChanged: true,
      addedToolCount: 1,
      removedToolCount: 0,
      changedToolCount: 1,
      requestPolicyChanged: true,
    });
    expect(JSON.stringify(result)).not.toContain('"name":"Read"');
    expect(JSON.stringify(result)).not.toContain('Read a file');
    expect(JSON.stringify(result)).not.toContain('"name":"Write"');
    const retained = retainedState(monitor);
    expect(retained).not.toContain('"name":"Read"');
    expect(retained).not.toContain('Read a file');
    expect(retained).not.toContain('"name":"Write"');
    expect(retained.match(/[a-f0-9]{64}/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('separates TTL expiry from an unchanged short-gap server-side break', () => {
    const shortGap = new PromptCacheBreakMonitor();
    shortGap.observe(observation());
    expect(
      shortGap.observe(observation({ usage: usage(0), now: 2_000 }))
    ).toMatchObject({ reason: 'server_side' });

    const expired = new PromptCacheBreakMonitor();
    expired.observe(observation());
    expect(
      expired.observe(
        observation({
          usage: usage(0),
          now: 5 * 60_000 + 1_001,
        })
      )
    ).toMatchObject({ reason: 'ttl_expired' });
  });

  it('does not flag normal context reduction or insignificant cache variance', () => {
    const compacted = new PromptCacheBreakMonitor();
    compacted.observe(observation());
    expect(
      compacted.observe(
        observation({
          usage: usage(1_000, 4_000),
          now: 2_000,
        })
      )
    ).toBeUndefined();

    const variance = new PromptCacheBreakMonitor();
    variance.observe(observation());
    expect(
      variance.observe(
        observation({
          usage: usage(5_800),
          now: 2_000,
        })
      )
    ).toBeUndefined();
  });

  it('uses an adaptive absolute threshold for medium-sized cached prompts', () => {
    const monitor = new PromptCacheBreakMonitor();
    monitor.observe(
      observation({
        usage: usage(5_156, 11_115),
      })
    );

    expect(
      monitor.observe(
        observation({
          context: {
            systemPrompt: 'changed first cache block',
            messages: [],
          },
          usage: usage(3_840, 8_653),
          now: 2_000,
        })
      )
    ).toMatchObject({
      reason: 'system_prompt_changed',
      tokenDrop: 1_316,
    });
  });

  it('resets the comparison baseline once when compaction changes context epoch', () => {
    const monitor = new PromptCacheBreakMonitor();
    monitor.observe(observation({ contextEpoch: 'before-compaction' }));
    expect(
      monitor.observe(
        observation({
          contextEpoch: 'after-compaction',
          usage: usage(3_000, 4_000),
          now: 2_000,
        })
      )
    ).toBeUndefined();
    expect(
      monitor.observe(
        observation({
          contextEpoch: 'after-compaction',
          usage: usage(0, 4_100),
          context: {
            systemPrompt: 'changed after compaction',
            messages: [],
          },
          now: 3_000,
        })
      )
    ).toMatchObject({
      reason: 'system_prompt_changed',
      previousCacheReadTokens: 3_000,
    });
  });

  it('bounds and clears per-session tracking state', () => {
    const monitor = new PromptCacheBreakMonitor();
    for (let index = 0; index < 40; index++) {
      monitor.observe(observation({ sessionId: `session-${index}` }));
    }
    expect(monitor.statsForTests()).toEqual({ sessions: 32 });
    monitor.clear('session-39');
    expect(monitor.statsForTests()).toEqual({ sessions: 31 });
    monitor.clear();
    expect(monitor.statsForTests()).toEqual({ sessions: 0 });
  });
});
