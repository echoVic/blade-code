import { describe, expect, it } from 'vitest';
import { projectConversation } from '../../../src/context/events/reducers/conversationReducer.js';
import type { SessionEvent } from '../../../src/context/types.js';
import { projectCommittedSessionEvent } from '../../../src/server/routes/session.js';
import { SessionService } from '../../../src/services/SessionService.js';
import { buildContextMessagesFromSession } from '../../../src/ui/utils/sessionContext.js';

describe('recap history projection', () => {
  const base = {
    sessionId: 's',
    timestamp: '2026-09-21T00:00:00Z',
    cwd: '/workspace',
    version: '0.11.1',
  };
  const events: SessionEvent[] = [
    {
      ...base,
      id: 'm',
      type: 'message_created',
      data: {
        messageId: 'recap',
        role: 'assistant',
        createdAt: base.timestamp,
        metadata: { conversationRecap: true },
      },
    },
    {
      ...base,
      id: 'p',
      type: 'part_created',
      data: {
        messageId: 'recap',
        partId: 'text',
        partType: 'text',
        payload: { text: 'Goal: ship. Next: review.', conversationRecap: true },
        createdAt: base.timestamp,
      },
    },
  ];

  it('keeps durable recap text and styling metadata for history but removes it from model context', () => {
    const history = SessionService.convertJSONLToMessages(events);
    expect(history[0]).toMatchObject({
      content: 'Goal: ship. Next: review.',
      metadata: { conversationRecap: true },
    });
    expect(SessionService.convertJSONLToModelContext(events)).toEqual([]);
    expect(projectConversation(events).messages[0]?.metadata).toEqual({
      conversationRecap: true,
    });
  });

  it('projects committed recap text for both live SSE and reconnect replay', () => {
    expect(projectCommittedSessionEvent({ ...events[1]!, seq: 2 })).toEqual({
      type: 'conversation.recap',
      seq: 2,
      properties: { messageId: 'recap', text: 'Goal: ship. Next: review.' },
    });
  });

  it.each([false, true])(
    'never feeds live or restored recaps back through the TUI context (resume=%s)',
    (resume) => {
      const messages = projectConversation(events).messages;
      const result = buildContextMessagesFromSession({
        messages,
        restoredContextMessages: resume
          ? SessionService.convertJSONLToMessages(events)
          : null,
        restoredVisibleMessageCount: resume ? 1 : 0,
      });
      expect(result).toEqual([]);
    }
  );
});
