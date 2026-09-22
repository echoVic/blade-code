import { describe, expect, it } from 'vitest';
import { SessionService } from '../../../src/services/SessionService.js';

describe('SessionService client message identity', () => {
  it('includes durable ids only when requested for a client history projection', () => {
    const events = [
      {
        id: 'event-1',
        sessionId: 'session-1',
        type: 'message_created',
        timestamp: '2026-09-21T00:00:00.000Z',
        cwd: '/workspace',
        version: '0.0.0',
        data: {
          messageId: 'durable-message-1',
          role: 'assistant',
          createdAt: '2026-09-21T00:00:00.000Z',
        },
      },
      {
        id: 'event-2',
        sessionId: 'session-1',
        type: 'part_created',
        timestamp: '2026-09-21T00:00:01.000Z',
        cwd: '/workspace',
        version: '0.0.0',
        data: {
          partId: 'part-1',
          messageId: 'durable-message-1',
          partType: 'text',
          payload: { text: 'Persisted response' },
          createdAt: '2026-09-21T00:00:01.000Z',
        },
      },
    ] as never;

    expect(SessionService.convertJSONLToMessages(events)).toEqual([
      { role: 'assistant', content: 'Persisted response' },
    ]);
    expect(
      SessionService.convertJSONLToMessages(events, { includeMessageIds: true })
    ).toEqual([
      {
        id: 'durable-message-1',
        role: 'assistant',
        content: 'Persisted response',
        timestamp: Date.parse('2026-09-21T00:00:00.000Z'),
      },
    ]);
  });
});
