import { describe, expect, it } from 'vitest';
import {
  ContextTokenTracker,
  createContextTokenRequestProfile,
  resolveProviderContextTokens,
} from '../../../../src/context/ContextTokenTracker.js';
import { TokenCounter } from '../../../../src/context/TokenCounter.js';
import type {
  Message,
  UsageInfo,
} from '../../../../src/services/ChatServiceInterface.js';

const modelName = 'gpt-4';
const systemMessages: Message[] = [
  {
    role: 'system',
    content: [{ type: 'text', text: 'You are a coding agent.' }],
  },
];
const tools = [
  {
    name: 'Read',
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
    },
  },
];

function usage(overrides: Partial<UsageInfo> = {}): UsageInfo {
  return {
    promptTokens: 700,
    completionTokens: 300,
    totalTokens: 1_000,
    ...overrides,
  };
}

describe('ContextTokenTracker', () => {
  it('uses the largest valid Provider total', () => {
    expect(resolveProviderContextTokens(usage())).toBe(1_000);
    expect(
      resolveProviderContextTokens(
        usage({ promptTokens: 800, completionTokens: 400, totalTokens: 900 })
      )
    ).toBe(1_200);
    expect(
      resolveProviderContextTokens(
        usage({
          promptTokens: Number.NaN,
          completionTokens: Number.NaN,
          totalTokens: 900,
        })
      )
    ).toBe(900);
  });

  it('falls back to a complete local request estimate without Provider usage', () => {
    const tracker = new ContextTokenTracker();
    const history: Message[] = [{ role: 'user', content: 'inspect this project' }];
    const pending: Message[] = [{ role: 'user', content: 'pending reminder' }];
    const profile = createContextTokenRequestProfile(systemMessages, tools, modelName);

    expect(
      tracker.project({
        history,
        pendingMessages: pending,
        contextRevision: 0,
        modelName,
        requestProfile: profile,
      })
    ).toEqual({
      contextTokens:
        profile.estimatedFixedTokens +
        TokenCounter.countTokens([...history, ...pending], modelName),
      source: 'local_estimate',
    });
  });

  it('adds only post-response tool and control messages to Provider total usage', () => {
    const tracker = new ContextTokenTracker();
    const initialHistory: Message[] = [{ role: 'user', content: 'run checks' }];
    const profile = createContextTokenRequestProfile(systemMessages, tools, modelName);
    tracker.recordProviderUsage({
      usage: usage(),
      contextRevision: 0,
      historyLength: initialHistory.length,
      modelName,
      requestProfile: profile,
    });

    const assistant: Message = {
      role: 'assistant',
      content: 'a'.repeat(8_000),
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'Read', arguments: '{"file_path":"large.txt"}' },
        },
      ],
    };
    const additions: Message[] = [
      { role: 'tool', tool_call_id: 'call-1', content: 'x'.repeat(4_000) },
      { role: 'user', content: 'continue after the tool result' },
    ];
    const expectedDelta = TokenCounter.countTokens(additions, modelName);

    expect(
      tracker.project({
        history: [...initialHistory, assistant, ...additions],
        contextRevision: 0,
        modelName,
        requestProfile: profile,
      })
    ).toEqual({
      contextTokens: 1_000 + expectedDelta,
      source: 'provider_plus_estimate',
      estimatedPendingTokens: expectedDelta,
    });
  });

  it('counts a pending pre-request reminder without double-counting the assistant', () => {
    const tracker = new ContextTokenTracker();
    const initialHistory: Message[] = [{ role: 'user', content: 'run checks' }];
    const profile = createContextTokenRequestProfile(systemMessages, tools, modelName);
    tracker.recordProviderUsage({
      usage: usage(),
      contextRevision: 0,
      historyLength: initialHistory.length,
      modelName,
      requestProfile: profile,
    });
    const pending: Message[] = [{ role: 'user', content: 'reflect before retry' }];

    const projection = tracker.project({
      history: [
        ...initialHistory,
        { role: 'assistant', content: 'model output already in totalTokens' },
      ],
      pendingMessages: pending,
      contextRevision: 0,
      modelName,
      requestProfile: profile,
    });

    expect(projection).toEqual({
      contextTokens: 1_000 + TokenCounter.countTokens(pending, modelName),
      source: 'provider_plus_estimate',
      estimatedPendingTokens: TokenCounter.countTokens(pending, modelName),
    });
  });

  it('invalidates the Provider baseline after a destructive history rewrite', () => {
    const tracker = new ContextTokenTracker();
    const initialHistory: Message[] = [{ role: 'user', content: 'run checks' }];
    const profile = createContextTokenRequestProfile(systemMessages, tools, modelName);
    tracker.recordProviderUsage({
      usage: usage(),
      contextRevision: 0,
      historyLength: initialHistory.length,
      modelName,
      requestProfile: profile,
    });

    expect(
      tracker.project({
        history: [...initialHistory, { role: 'assistant', content: 'response' }],
        contextRevision: 1,
        modelName,
        requestProfile: profile,
      }).source
    ).toBe('local_estimate');
  });

  it('clears a stale Provider baseline when a response omits usage', () => {
    const tracker = new ContextTokenTracker();
    const initialHistory: Message[] = [{ role: 'user', content: 'run checks' }];
    const profile = createContextTokenRequestProfile(systemMessages, tools, modelName);
    tracker.recordProviderUsage({
      usage: usage(),
      contextRevision: 0,
      historyLength: initialHistory.length,
      modelName,
      requestProfile: profile,
    });
    tracker.recordProviderUsage({
      usage: undefined,
      contextRevision: 0,
      historyLength: initialHistory.length + 1,
      modelName,
      requestProfile: profile,
    });

    expect(
      tracker.project({
        history: [
          ...initialHistory,
          { role: 'assistant', content: 'response without usage' },
        ],
        contextRevision: 0,
        modelName,
        requestProfile: profile,
      }).source
    ).toBe('local_estimate');
  });

  it('falls back locally when the stored request boundary is not followed by an assistant response', () => {
    const tracker = new ContextTokenTracker();
    const initialHistory: Message[] = [{ role: 'user', content: 'run checks' }];
    const profile = createContextTokenRequestProfile(systemMessages, tools, modelName);
    tracker.recordProviderUsage({
      usage: usage(),
      contextRevision: 0,
      historyLength: initialHistory.length,
      modelName,
      requestProfile: profile,
    });

    expect(
      tracker.project({
        history: [
          ...initialHistory,
          { role: 'user', content: 'host recovery without an assistant response' },
        ],
        contextRevision: 0,
        modelName,
        requestProfile: profile,
      }).source
    ).toBe('local_estimate');
  });

  it.each([
    ['model switch', 'other-model', tools],
    [
      'tool schema growth',
      modelName,
      [
        ...tools,
        {
          name: 'Write',
          description: 'Write a file',
          parameters: { type: 'object' },
        },
      ],
    ],
  ])(
    'keeps Provider total as a conservative floor after a %s',
    (_label, nextModel, nextTools) => {
      const tracker = new ContextTokenTracker();
      const initialHistory: Message[] = [{ role: 'user', content: 'run checks' }];
      const profile = createContextTokenRequestProfile(
        systemMessages,
        tools,
        modelName
      );
      tracker.recordProviderUsage({
        usage: usage(),
        contextRevision: 0,
        historyLength: initialHistory.length,
        modelName,
        requestProfile: profile,
      });
      const nextProfile = createContextTokenRequestProfile(
        systemMessages,
        nextTools,
        nextModel
      );

      const projection = tracker.project({
        history: [...initialHistory, { role: 'assistant', content: 'response' }],
        contextRevision: 0,
        modelName: nextModel,
        requestProfile: nextProfile,
      });

      expect(projection.source).toBe('provider_plus_estimate');
      expect(projection.contextTokens).toBeGreaterThanOrEqual(1_000);
    }
  );

  it('adds contextual system growth without discarding the Provider floor', () => {
    const tracker = new ContextTokenTracker();
    const initialHistory: Message[] = [{ role: 'user', content: 'inspect files' }];
    const initialProfile = createContextTokenRequestProfile(
      systemMessages,
      tools,
      modelName
    );
    tracker.recordProviderUsage({
      usage: usage(),
      contextRevision: 0,
      historyLength: initialHistory.length,
      modelName,
      requestProfile: initialProfile,
    });
    const expandedSystemMessages: Message[] = [
      ...systemMessages,
      {
        role: 'system',
        content: 'Apply this newly activated project rule.',
        metadata: { contextualProjectRules: true },
      },
    ];
    const expandedProfile = createContextTokenRequestProfile(
      expandedSystemMessages,
      tools,
      modelName
    );
    const fixedGrowth =
      expandedProfile.estimatedFixedTokens - initialProfile.estimatedFixedTokens;

    expect(
      tracker.project({
        history: [
          ...initialHistory,
          { role: 'assistant', content: 'provider response' },
        ],
        contextRevision: 0,
        modelName,
        requestProfile: expandedProfile,
      })
    ).toEqual({
      contextTokens: 1_000 + fixedGrowth,
      source: 'provider_plus_estimate',
      estimatedPendingTokens: fixedGrowth,
    });
  });
});
