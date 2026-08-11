import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../../../src/context/types.js';
import {
  listSessionRewindCheckpoints,
  materializeSessionEvents,
  planSessionRewind,
} from '../../../src/services/sessionRewind.js';

const sessionId = 'rewind-session';
const cwd = '/workspace';
let sequence = 0;

function base(type: SessionEvent['type']) {
  sequence += 1;
  return {
    id: `event-${sequence}`,
    sessionId,
    timestamp: `2026-08-05T00:00:${String(sequence).padStart(2, '0')}.000Z`,
    type,
    cwd,
    gitBranch: 'main',
    version: 'test',
  };
}

function created(): SessionEvent {
  const event = base('session_created');
  return {
    ...event,
    type: 'session_created',
    data: {
      sessionId,
      rootId: sessionId,
      createdAt: event.timestamp,
      updatedAt: event.timestamp,
    },
  };
}

function message(
  messageId: string,
  role: 'user' | 'assistant',
  text: string,
  options: { parentMessageId?: string; inboxMessageId?: string } = {}
): SessionEvent[] {
  const messageEvent = base('message_created');
  const partEvent = base('part_created');
  return [
    {
      ...messageEvent,
      type: 'message_created',
      data: {
        messageId,
        role,
        parentMessageId: options.parentMessageId,
        inboxMessageId: options.inboxMessageId,
        createdAt: messageEvent.timestamp,
      },
    },
    {
      ...partEvent,
      type: 'part_created',
      data: {
        partId: `${messageId}-text`,
        messageId,
        partType: 'text',
        payload: { text },
        createdAt: partEvent.timestamp,
      },
    },
  ];
}

function toolCall(messageId: string, partId: string): SessionEvent {
  const event = base('part_created');
  return {
    ...event,
    type: 'part_created',
    data: {
      partId,
      messageId,
      partType: 'tool_call',
      payload: { toolCallId: partId, toolName: 'Write', input: {} },
      createdAt: event.timestamp,
    },
  };
}

function turnStarted(turnId: string, inputMessageId: string): SessionEvent {
  const event = base('turn_started');
  return {
    ...event,
    type: 'turn_started',
    data: {
      turnId,
      kind: 'user',
      startedAt: event.timestamp,
      inputMessageIds: [inputMessageId],
    },
  };
}

function turnCompleted(turnId: string): SessionEvent {
  const event = base('turn_completed');
  return {
    ...event,
    type: 'turn_completed',
    data: {
      turnId,
      completedAt: event.timestamp,
      turnsCount: 1,
      toolCallsCount: 0,
      durationMs: 10,
    },
  };
}

function rewound(
  targetMessageId: string,
  mode: 'conversation' | 'code' | 'both' = 'conversation'
): SessionEvent {
  const event = base('session_rewound');
  return {
    ...event,
    type: 'session_rewound',
    data: {
      rewindId: `rewind-${sequence}`,
      targetMessageId,
      mode,
      restoredFiles: [],
      createdAt: event.timestamp,
    },
  };
}

function messageIds(events: readonly SessionEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'message_created' ? [event.data.messageId] : []
  );
}

describe('session rewind projection', () => {
  it('materializes append-only rewind markers cumulatively', () => {
    sequence = 0;
    const entries = [
      created(),
      ...message('user-1', 'user', 'first', { inboxMessageId: 'inbox-1' }),
      ...message('assistant-1', 'assistant', 'done', {
        parentMessageId: 'user-1',
      }),
      ...message('user-2', 'user', 'second', { inboxMessageId: 'inbox-2' }),
      ...message('assistant-2', 'assistant', 'done', {
        parentMessageId: 'user-2',
      }),
      rewound('user-2'),
      ...message('user-3', 'user', 'replacement', {
        inboxMessageId: 'inbox-3',
      }),
      ...message('assistant-3', 'assistant', 'done', {
        parentMessageId: 'user-3',
      }),
      rewound('user-3'),
    ];

    const projected = materializeSessionEvents(entries);

    expect(messageIds(projected)).toEqual(['user-1', 'assistant-1']);
    expect(projected.some((event) => event.type === 'session_rewound')).toBe(false);
  });

  it('lists only user-authored checkpoints with bounded previews', () => {
    sequence = 0;
    const entries = [
      created(),
      ...message('user-1', 'user', 'first request', {
        inboxMessageId: 'inbox-1',
      }),
      ...message('control', 'user', '<system-reminder>continue</system-reminder>', {
        parentMessageId: 'user-1',
      }),
      ...message('user-2', 'user', 'x'.repeat(400), {
        inboxMessageId: 'inbox-2',
      }),
    ];

    const checkpoints = listSessionRewindCheckpoints(entries);

    expect(checkpoints.map((checkpoint) => checkpoint.messageId)).toEqual([
      'user-2',
      'user-1',
    ]);
    expect(checkpoints[0]?.preview.length).toBeLessThanOrEqual(163);
    expect(checkpoints[1]?.preview).toBe('first request');
  });

  it('plans removed turns and their durable tool snapshot identities', () => {
    sequence = 0;
    const entries = [
      created(),
      ...message('user-1', 'user', 'first', { inboxMessageId: 'inbox-1' }),
      toolCall('user-1', 'tool-before'),
      ...message('assistant-1', 'assistant', 'done', {
        parentMessageId: 'user-1',
      }),
      ...message('user-2', 'user', 'second', { inboxMessageId: 'inbox-2' }),
      toolCall('user-2', 'tool-after'),
      ...message('assistant-2', 'assistant', 'done', {
        parentMessageId: 'user-2',
      }),
    ];

    const plan = planSessionRewind(entries, 'user-2');

    expect(plan.removedTurns).toBe(1);
    expect(plan.snapshotMessageIds).toEqual(['tool-after']);
    expect(messageIds(plan.projectedEntries)).toEqual(['user-1', 'assistant-1']);
  });

  it('removes the durable lifecycle boundary for the rewound input', () => {
    sequence = 0;
    const entries = [
      created(),
      turnStarted('turn-1', 'inbox-1'),
      ...message('user-1', 'user', 'first', { inboxMessageId: 'inbox-1' }),
      ...message('assistant-1', 'assistant', 'done', {
        parentMessageId: 'user-1',
      }),
      turnCompleted('turn-1'),
      turnStarted('turn-2', 'inbox-2'),
      ...message('user-2', 'user', 'second', { inboxMessageId: 'inbox-2' }),
      ...message('assistant-2', 'assistant', 'done', {
        parentMessageId: 'user-2',
      }),
      turnCompleted('turn-2'),
      rewound('user-2'),
    ];

    const projected = materializeSessionEvents(entries);

    expect(
      projected.flatMap((event) =>
        event.type === 'turn_started' ? [event.data.turnId] : []
      )
    ).toEqual(['turn-1']);
    expect(
      projected.flatMap((event) =>
        event.type === 'turn_completed' ? [event.data.turnId] : []
      )
    ).toEqual(['turn-1']);
  });

  it('fails closed when a rewind marker references a missing checkpoint', () => {
    sequence = 0;
    expect(() => materializeSessionEvents([created(), rewound('missing')])).toThrow(
      'Rewind checkpoint not found: missing'
    );
  });
});
