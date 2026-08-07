import { describe, expect, it } from 'vitest';
import { compareTaskAttentionThenActivity, taskActivityTime } from '@/lib/taskOrdering';
import type { Session } from '@/services';

function session(overrides: Partial<Session>): Session {
  return {
    sessionId: 'session',
    projectPath: '/workspace/blade',
    rootId: 'session',
    taskStatus: 'completed',
    messageCount: 1,
    firstMessageTime: '2026-08-01T00:00:00.000Z',
    lastMessageTime: '2026-08-01T00:00:00.000Z',
    hasErrors: false,
    ...overrides,
  };
}

describe('task ordering', () => {
  it('orders attention, running, queued, then all terminal work by activity', () => {
    const sessions = [
      session({
        sessionId: 'old-failure',
        taskStatus: 'failed',
        lastMessageTime: '2026-01-01T00:00:00.000Z',
      }),
      session({
        sessionId: 'recent-completion',
        lastMessageTime: '2026-08-07T10:00:00.000Z',
      }),
      session({
        sessionId: 'queued',
        taskStatus: 'queued',
        lastMessageTime: '2026-08-07T09:00:00.000Z',
      }),
      session({
        sessionId: 'running',
        taskStatus: 'running',
        lastMessageTime: '2026-08-07T08:00:00.000Z',
      }),
      session({
        sessionId: 'approval',
        taskStatus: 'running',
        pendingInteraction: {
          type: 'permission',
          requestId: 'permission-1',
        },
        lastMessageTime: '2026-08-07T07:00:00.000Z',
      }),
    ];

    expect(
      sessions.sort(compareTaskAttentionThenActivity).map((item) => item.sessionId)
    ).toEqual(['approval', 'running', 'queued', 'recent-completion', 'old-failure']);
  });

  it('treats missing and invalid activity timestamps as oldest', () => {
    expect(taskActivityTime(session({ lastMessageTime: 'invalid' }))).toBe(0);
    expect(
      taskActivityTime(
        session({
          firstMessageTime: undefined,
          lastMessageTime: undefined,
        })
      )
    ).toBe(0);
  });
});
