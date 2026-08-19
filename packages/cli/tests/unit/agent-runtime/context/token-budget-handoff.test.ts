import { describe, expect, it } from 'vitest';
import { parseSessionJSONL } from '../../../../src/context/storage/JSONLStore.js';
import {
  deriveTokenBudgetSnapshot,
  isTokenBudgetHandoffEvent,
  isTokenBudgetHandoffMessage,
  parseTokenBudgetHandoffEvent,
  projectTokenBudgetHandoffEvent,
  stripTokenBudgetHandoffMessages,
  TOKEN_BUDGET_COMPACTION_RATIO,
  TOKEN_BUDGET_HANDOFF_MAX_BYTES,
  TOKEN_BUDGET_HANDOFF_RATIO,
  TOKEN_BUDGET_HANDOFF_TAG,
  TOKEN_BUDGET_HANDOFF_VERSION,
} from '../../../../src/context/TokenBudgetHandoff.js';
import type {
  SessionEvent,
  TokenBudgetHandoffRecordedEvent,
} from '../../../../src/context/types.js';
import type { Message } from '../../../../src/services/ChatServiceInterface.js';

const recordedEvent = {
  id: 'evt-handoff-1',
  sessionId: 'session-1',
  projectPath: '/repo',
  timestamp: '2026-08-19T08:00:00.000Z',
  type: 'token_budget_handoff_recorded',
  cwd: '/repo',
  version: '1',
  data: {
    version: 1,
    messageId: 'handoff-message-1',
    observedPromptTokens: 75_000,
    availableForInput: 100_000,
    handoffThreshold: 70_000,
    compactionThreshold: 80_000,
    createdAt: '2026-08-19T08:00:00.000Z',
  },
} satisfies TokenBudgetHandoffRecordedEvent;

function tokenBudgetHandoffEvent(
  data: Record<string, unknown> = {}
): TokenBudgetHandoffRecordedEvent {
  return {
    ...recordedEvent,
    data: {
      ...recordedEvent.data,
      ...data,
    },
  };
}

function messageCreatedEvent(): SessionEvent {
  return {
    id: 'evt-message-1',
    sessionId: 'session-1',
    projectPath: '/repo',
    timestamp: '2026-08-19T08:00:00.000Z',
    type: 'message_created',
    cwd: '/repo',
    version: '1',
    data: {
      messageId: 'message-1',
      role: 'user',
      createdAt: '2026-08-19T08:00:00.000Z',
    },
  };
}

describe('deriveTokenBudgetSnapshot', () => {
  it('classifies the handoff phases across the configured thresholds', () => {
    expect(
      deriveTokenBudgetSnapshot({
        actualPromptTokens: undefined,
        maxContextTokens: 110_000,
        maxOutputTokens: 10_000,
      })
    ).toEqual({
      phase: 'unknown',
      maxContextTokens: 110_000,
      maxOutputTokens: 10_000,
      availableForInput: 100_000,
      handoffThreshold: 70_000,
      compactionThreshold: 80_000,
    });

    expect(
      deriveTokenBudgetSnapshot({
        actualPromptTokens: 69_999,
        maxContextTokens: 110_000,
        maxOutputTokens: 10_000,
      })?.phase
    ).toBe('below_handoff');

    expect(
      deriveTokenBudgetSnapshot({
        actualPromptTokens: 70_000,
        maxContextTokens: 110_000,
        maxOutputTokens: 10_000,
      })?.phase
    ).toBe('handoff_band');

    expect(
      deriveTokenBudgetSnapshot({
        actualPromptTokens: 79_999,
        maxContextTokens: 110_000,
        maxOutputTokens: 10_000,
      })?.phase
    ).toBe('handoff_band');

    expect(
      deriveTokenBudgetSnapshot({
        actualPromptTokens: 80_000,
        maxContextTokens: 110_000,
        maxOutputTokens: 10_000,
      })?.phase
    ).toBe('compaction_due');
  });

  it('falls back to unknown for invalid inputs', () => {
    const invalidActuals = [1.5, Number.NaN, Number.POSITIVE_INFINITY, -1];

    for (const actualPromptTokens of invalidActuals) {
      expect(
        deriveTokenBudgetSnapshot({
          actualPromptTokens,
          maxContextTokens: 110_000,
          maxOutputTokens: 10_000,
        })?.phase
      ).toBe('unknown');
    }

    expect(
      deriveTokenBudgetSnapshot({
        actualPromptTokens: 1,
        maxContextTokens: 110_000,
        maxOutputTokens: 110_000,
      })?.phase
    ).toBe('unknown');

    expect(
      deriveTokenBudgetSnapshot({
        actualPromptTokens: 1,
        maxContextTokens: 110_000,
        maxOutputTokens: -1,
      })?.phase
    ).toBe('unknown');

    expect(
      deriveTokenBudgetSnapshot({
        actualPromptTokens: 1,
        maxContextTokens: 0,
        maxOutputTokens: 10_000,
      })?.phase
    ).toBe('unknown');
  });

  it('computes exact thresholds for the maximum safe input budget', () => {
    expect(
      deriveTokenBudgetSnapshot({
        actualPromptTokens: 7_205_759_403_792_792,
        maxContextTokens: Number.MAX_SAFE_INTEGER,
        maxOutputTokens: 0,
      })
    ).toEqual({
      phase: 'compaction_due',
      actualPromptTokens: 7_205_759_403_792_792,
      maxContextTokens: Number.MAX_SAFE_INTEGER,
      maxOutputTokens: 0,
      availableForInput: Number.MAX_SAFE_INTEGER,
      handoffThreshold: 6_305_039_478_318_693,
      compactionThreshold: 7_205_759_403_792_792,
    });
  });
});

describe('parseTokenBudgetHandoffEvent', () => {
  it('accepts strict v1 durable markers only inside the handoff band', () => {
    const parsed = parseTokenBudgetHandoffEvent(recordedEvent);

    expect(parsed).toEqual(recordedEvent);
    expect(isTokenBudgetHandoffEvent(recordedEvent)).toBe(true);
  });

  it('treats token-budget handoff events as a raw event-type guard before strict parsing', () => {
    const futureEvent = tokenBudgetHandoffEvent({
      version: 2,
      futureField: 'reserved',
    });
    const malformedEvent = tokenBudgetHandoffEvent({
      version: 1,
      createdAt: 'not-an-iso-date',
    });

    expect(isTokenBudgetHandoffEvent(futureEvent)).toBe(true);
    expect(parseTokenBudgetHandoffEvent(futureEvent)).toBeUndefined();
    expect(projectTokenBudgetHandoffEvent(futureEvent)).toBeUndefined();

    expect(isTokenBudgetHandoffEvent(malformedEvent)).toBe(true);
    expect(parseTokenBudgetHandoffEvent(malformedEvent)).toBeUndefined();
    expect(projectTokenBudgetHandoffEvent(malformedEvent)).toBeUndefined();

    expect(isTokenBudgetHandoffEvent(messageCreatedEvent())).toBe(false);
  });

  it('classifies malformed persisted handoff data by its raw discriminant', () => {
    const persistedEvents = parseSessionJSONL(
      `${JSON.stringify({ ...recordedEvent, data: null })}\n${JSON.stringify({
        ...recordedEvent,
        id: 'evt-handoff-array',
        data: [],
      })}\n`
    );
    const nullDataEvent = persistedEvents[0];
    const arrayDataEvent = persistedEvents[1];
    if (!nullDataEvent || !arrayDataEvent) {
      throw new Error('Expected both persisted handoff events');
    }

    expect(isTokenBudgetHandoffEvent(nullDataEvent)).toBe(true);
    expect(parseTokenBudgetHandoffEvent(nullDataEvent)).toBeUndefined();
    expect(projectTokenBudgetHandoffEvent(nullDataEvent)).toBeUndefined();

    expect(isTokenBudgetHandoffEvent(arrayDataEvent)).toBe(true);
    expect(parseTokenBudgetHandoffEvent(arrayDataEvent)).toBeUndefined();
    expect(projectTokenBudgetHandoffEvent(arrayDataEvent)).toBeUndefined();
  });

  it('rejects version and field-shape mismatches', () => {
    const { createdAt: _createdAt, ...missingCreatedAt } = recordedEvent.data;

    expect(
      parseTokenBudgetHandoffEvent(
        tokenBudgetHandoffEvent({
          version: 2,
        })
      )
    ).toBeUndefined();

    expect(
      parseTokenBudgetHandoffEvent({
        ...recordedEvent,
        data: missingCreatedAt,
      })
    ).toBeUndefined();

    expect(
      parseTokenBudgetHandoffEvent(
        tokenBudgetHandoffEvent({
          version: 1,
          messageId: undefined,
          observedPromptTokens: undefined,
          availableForInput: undefined,
          handoffThreshold: undefined,
          compactionThreshold: undefined,
          createdAt: undefined,
        })
      )
    ).toBeUndefined();

    expect(
      parseTokenBudgetHandoffEvent(
        tokenBudgetHandoffEvent({
          messageId: '',
        })
      )
    ).toBeUndefined();

    expect(
      parseTokenBudgetHandoffEvent(
        tokenBudgetHandoffEvent({
          messageId: 'x'.repeat(129),
        })
      )
    ).toBeUndefined();

    expect(
      parseTokenBudgetHandoffEvent(
        tokenBudgetHandoffEvent({
          messageId: 'bad\nid',
        })
      )
    ).toBeUndefined();

    expect(
      parseTokenBudgetHandoffEvent(
        tokenBudgetHandoffEvent({
          observedPromptTokens: -1,
        })
      )
    ).toBeUndefined();

    expect(
      parseTokenBudgetHandoffEvent(
        tokenBudgetHandoffEvent({
          availableForInput: 0,
        })
      )
    ).toBeUndefined();

    expect(
      parseTokenBudgetHandoffEvent(
        tokenBudgetHandoffEvent({
          handoffThreshold: recordedEvent.data.handoffThreshold + 1,
        })
      )
    ).toBeUndefined();

    expect(
      parseTokenBudgetHandoffEvent(
        tokenBudgetHandoffEvent({
          compactionThreshold: recordedEvent.data.compactionThreshold + 1,
        })
      )
    ).toBeUndefined();

    expect(
      parseTokenBudgetHandoffEvent(
        tokenBudgetHandoffEvent({
          extra: true,
        })
      )
    ).toBeUndefined();

    expect(
      parseTokenBudgetHandoffEvent(
        tokenBudgetHandoffEvent({
          createdAt: 'not-an-iso-date',
        })
      )
    ).toBeUndefined();

    expect(
      parseTokenBudgetHandoffEvent(
        tokenBudgetHandoffEvent({
          createdAt: '2026-08-19',
        })
      )
    ).toBeUndefined();

    expect(
      parseTokenBudgetHandoffEvent(
        tokenBudgetHandoffEvent({
          createdAt: '2026-08-19T08:00:00Z',
        })
      )
    ).toBeUndefined();

    expect(
      parseTokenBudgetHandoffEvent(
        tokenBudgetHandoffEvent({
          createdAt: '2026-08-19T16:00:00.000+08:00',
        })
      )
    ).toBeUndefined();

    expect(
      parseTokenBudgetHandoffEvent(
        tokenBudgetHandoffEvent({
          createdAt: '2026-02-30T08:00:00.000Z',
        })
      )
    ).toBeUndefined();
  });

  it('rejects events outside the durable handoff band', () => {
    expect(
      parseTokenBudgetHandoffEvent(
        tokenBudgetHandoffEvent({
          observedPromptTokens: recordedEvent.data.handoffThreshold - 1,
        })
      )
    ).toBeUndefined();

    expect(
      parseTokenBudgetHandoffEvent(
        tokenBudgetHandoffEvent({
          observedPromptTokens: recordedEvent.data.compactionThreshold,
        })
      )
    ).toBeUndefined();
  });
});

describe('projectTokenBudgetHandoffEvent', () => {
  it('projects a valid durable marker into one hidden user message', () => {
    const projected = projectTokenBudgetHandoffEvent(recordedEvent);
    if (!projected || typeof projected.content !== 'string')
      throw new Error('Expected string content');
    const utf8Bytes = new TextEncoder().encode(projected.content).length;

    expect(projected).toMatchObject({
      id: 'handoff-message-1',
      role: 'user',
    });
    expect(projected.metadata).toEqual({
      clientVisible: false,
      tokenBudgetHandoff: {
        version: 1,
        messageId: 'handoff-message-1',
      },
    });
    expect(typeof projected.content).toBe('string');
    expect(projected.content).toContain(TOKEN_BUDGET_HANDOFF_TAG);
    expect(projected.content.match(/<token-budget-handoff version="1">/g)).toHaveLength(
      1
    );
    expect(projected.content).toContain('5000');
    expect(utf8Bytes).toBeLessThanOrEqual(TOKEN_BUDGET_HANDOFF_MAX_BYTES);
  });

  it('does not project invalid durable markers', () => {
    expect(
      projectTokenBudgetHandoffEvent(
        tokenBudgetHandoffEvent({
          version: 2,
        })
      )
    ).toBeUndefined();

    expect(
      projectTokenBudgetHandoffEvent(
        tokenBudgetHandoffEvent({
          version: 1,
          messageId: undefined,
          observedPromptTokens: undefined,
          availableForInput: undefined,
          handoffThreshold: undefined,
          compactionThreshold: undefined,
          createdAt: undefined,
        })
      )
    ).toBeUndefined();

    expect(
      projectTokenBudgetHandoffEvent(
        tokenBudgetHandoffEvent({
          extra: true,
        })
      )
    ).toBeUndefined();
  });
});

describe('isTokenBudgetHandoffMessage', () => {
  it('accepts only the projected bounded hidden-message shape', () => {
    const projected = projectTokenBudgetHandoffEvent(recordedEvent);
    if (!projected) throw new Error('Expected a valid projected handoff');

    expect(isTokenBudgetHandoffMessage(projected)).toBe(true);
    expect(
      isTokenBudgetHandoffMessage({
        ...projected,
        id: 'other-id',
      })
    ).toBe(false);
    expect(
      isTokenBudgetHandoffMessage({
        ...projected,
        role: 'assistant',
      })
    ).toBe(false);
    expect(
      isTokenBudgetHandoffMessage({
        ...projected,
        metadata: {
          clientVisible: false,
          tokenBudgetHandoff: {
            version: 1,
            messageId: 'handoff-message-1',
            extra: true,
          },
        },
      })
    ).toBe(false);
  });

  it('requires content to exactly match the canonical reminder rebuilt from its tail headroom', () => {
    const projected = projectTokenBudgetHandoffEvent(recordedEvent);
    if (!projected || typeof projected.content !== 'string') {
      throw new Error('Expected string handoff content');
    }

    const prefixed: Message = {
      ...projected,
      content: `prefix\n${projected.content}`,
    };
    const suffixed: Message = {
      ...projected,
      content: `${projected.content}\nsuffix`,
    };
    const tamperedNumber: Message = {
      ...projected,
      content: projected.content.replace('5000', '05000'),
    };
    const unsafeNumber: Message = {
      ...projected,
      content: projected.content.replace('5000', '9007199254740992'),
    };
    const arbitraryBodyWithTag: Message = {
      ...projected,
      content: `${TOKEN_BUDGET_HANDOFF_TAG}\narbitrary reminder body\nRemaining prompt-token headroom before compaction: 5000.`,
    };

    expect(isTokenBudgetHandoffMessage(projected)).toBe(true);
    expect(isTokenBudgetHandoffMessage(prefixed)).toBe(false);
    expect(isTokenBudgetHandoffMessage(suffixed)).toBe(false);
    expect(isTokenBudgetHandoffMessage(tamperedNumber)).toBe(false);
    expect(isTokenBudgetHandoffMessage(unsafeNumber)).toBe(false);
    expect(isTokenBudgetHandoffMessage(arbitraryBodyWithTag)).toBe(false);
  });

  it('does not misclassify plain user text even when the reminder matches', () => {
    const projected = projectTokenBudgetHandoffEvent(recordedEvent);
    if (!projected || typeof projected.content !== 'string') {
      throw new Error('Expected string handoff content');
    }

    expect(
      isTokenBudgetHandoffMessage({
        id: 'handoff-message-1',
        role: 'user',
        content: projected.content,
      })
    ).toBe(false);
  });
});

describe('stripTokenBudgetHandoffMessages', () => {
  it('returns a new array and removes only valid projected markers without mutation', () => {
    const projected = projectTokenBudgetHandoffEvent(recordedEvent);
    if (!projected || typeof projected.content !== 'string') {
      throw new Error('Expected string handoff content');
    }
    const plainReminder: Message = {
      id: 'plain-reminder',
      role: 'user',
      content: projected.content,
    };
    const regular: Message = {
      id: 'user-1',
      role: 'user',
      content: 'continue the task',
    };
    const spoofed: Message = {
      ...projected,
      content: `${TOKEN_BUDGET_HANDOFF_TAG}\nspoofed reminder`,
    };
    const source: Message[] = [regular, projected, plainReminder, spoofed];

    const stripped = stripTokenBudgetHandoffMessages(source);

    expect(stripped).not.toBe(source);
    expect(stripped).toEqual([regular, plainReminder, spoofed]);
    expect(source).toEqual([regular, projected, plainReminder, spoofed]);
    expect(source[1]).toBe(projected);
  });
});

describe('module contract constants', () => {
  it('exports the stable handoff constants', () => {
    expect(TOKEN_BUDGET_HANDOFF_VERSION).toBe(1);
    expect(TOKEN_BUDGET_HANDOFF_RATIO).toBe(0.7);
    expect(TOKEN_BUDGET_COMPACTION_RATIO).toBe(0.8);
    expect(TOKEN_BUDGET_HANDOFF_MAX_BYTES).toBe(2000);
    expect(TOKEN_BUDGET_HANDOFF_TAG).toBe('<token-budget-handoff version="1">');
  });
});
