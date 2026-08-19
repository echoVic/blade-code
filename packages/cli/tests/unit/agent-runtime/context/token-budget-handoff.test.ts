import { describe, expect, it } from 'vitest';
import type {
  SessionEvent,
  TokenBudgetHandoffRecordedEvent,
} from '../../../../src/context/types.js';
import type { Message } from '../../../../src/services/ChatServiceInterface.js';
import {
  TOKEN_BUDGET_COMPACTION_RATIO,
  TOKEN_BUDGET_HANDOFF_MAX_BYTES,
  TOKEN_BUDGET_HANDOFF_RATIO,
  TOKEN_BUDGET_HANDOFF_TAG,
  TOKEN_BUDGET_HANDOFF_VERSION,
  deriveTokenBudgetSnapshot,
  isTokenBudgetHandoffEvent,
  isTokenBudgetHandoffMessage,
  parseTokenBudgetHandoffEvent,
  projectTokenBudgetHandoffEvent,
  stripTokenBudgetHandoffMessages,
} from '../../../../src/context/TokenBudgetHandoff.js';

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
});

describe('parseTokenBudgetHandoffEvent', () => {
  it('accepts strict v1 durable markers only inside the handoff band', () => {
    const parsed = parseTokenBudgetHandoffEvent(recordedEvent);

    expect(parsed).toEqual(recordedEvent);
    expect(isTokenBudgetHandoffEvent(recordedEvent)).toBe(true);
  });

  it('rejects version and field-shape mismatches', () => {
    expect(
      parseTokenBudgetHandoffEvent({
        ...recordedEvent,
        data: { ...recordedEvent.data, version: 2 },
      })
    ).toBeUndefined();

    expect(
      parseTokenBudgetHandoffEvent({
        ...recordedEvent,
        data: { version: 1 },
      })
    ).toBeUndefined();

    expect(
      parseTokenBudgetHandoffEvent({
        ...recordedEvent,
        data: { ...recordedEvent.data, messageId: '' },
      })
    ).toBeUndefined();

    expect(
      parseTokenBudgetHandoffEvent({
        ...recordedEvent,
        data: { ...recordedEvent.data, messageId: 'x'.repeat(129) },
      })
    ).toBeUndefined();

    expect(
      parseTokenBudgetHandoffEvent({
        ...recordedEvent,
        data: { ...recordedEvent.data, messageId: 'bad\nid' },
      })
    ).toBeUndefined();

    expect(
      parseTokenBudgetHandoffEvent({
        ...recordedEvent,
        data: { ...recordedEvent.data, observedPromptTokens: -1 },
      })
    ).toBeUndefined();

    expect(
      parseTokenBudgetHandoffEvent({
        ...recordedEvent,
        data: { ...recordedEvent.data, availableForInput: 0 },
      })
    ).toBeUndefined();

    expect(
      parseTokenBudgetHandoffEvent({
        ...recordedEvent,
        data: {
          ...recordedEvent.data,
          handoffThreshold: recordedEvent.data.handoffThreshold + 1,
        },
      })
    ).toBeUndefined();

    expect(
      parseTokenBudgetHandoffEvent({
        ...recordedEvent,
        data: {
          ...recordedEvent.data,
          compactionThreshold: recordedEvent.data.compactionThreshold + 1,
        },
      })
    ).toBeUndefined();

    expect(
      parseTokenBudgetHandoffEvent({
        ...recordedEvent,
        data: { ...recordedEvent.data, createdAt: 'not-an-iso-date' },
      })
    ).toBeUndefined();

    expect(isTokenBudgetHandoffEvent(messageCreatedEvent())).toBe(false);
  });

  it('rejects events outside the durable handoff band', () => {
    expect(
      parseTokenBudgetHandoffEvent({
        ...recordedEvent,
        data: {
          ...recordedEvent.data,
          observedPromptTokens: recordedEvent.data.handoffThreshold - 1,
        },
      })
    ).toBeUndefined();

    expect(
      parseTokenBudgetHandoffEvent({
        ...recordedEvent,
        data: {
          ...recordedEvent.data,
          observedPromptTokens: recordedEvent.data.compactionThreshold,
        },
      })
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
      metadata: {
        clientVisible: false,
        tokenBudgetHandoff: {
          version: 1,
          messageId: 'handoff-message-1',
        },
      },
    });
    expect(typeof projected.content).toBe('string');
    expect(projected.content).toContain(TOKEN_BUDGET_HANDOFF_TAG);
    expect(projected.content.match(/<token-budget-handoff version="1">/g)).toHaveLength(1);
    expect(projected.content).toContain('5000');
    expect(utf8Bytes).toBeLessThanOrEqual(TOKEN_BUDGET_HANDOFF_MAX_BYTES);
  });

  it('does not project invalid durable markers', () => {
    expect(
      projectTokenBudgetHandoffEvent({
        ...recordedEvent,
        data: { ...recordedEvent.data, version: 2 },
      })
    ).toBeUndefined();

    expect(
      projectTokenBudgetHandoffEvent({
        ...recordedEvent,
        data: { version: 1 },
      })
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
    const source: Message[] = [regular, projected, plainReminder];

    const stripped = stripTokenBudgetHandoffMessages(source);

    expect(stripped).not.toBe(source);
    expect(stripped).toEqual([regular, plainReminder]);
    expect(source).toEqual([regular, projected, plainReminder]);
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
