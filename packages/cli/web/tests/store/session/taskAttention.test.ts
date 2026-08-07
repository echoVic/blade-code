import { describe, expect, it } from 'vitest';
import type { Session } from '../../../src/services';
import {
  persistUnreadTaskKeys,
  pruneUnreadTaskKeys,
  readUnreadTaskKeys,
  shouldMarkTaskUnread,
} from '../../../src/store/session/taskAttention';

function session(projectPath: string): Session {
  return {
    sessionId: 'session-1',
    projectPath,
    rootId: 'session-1',
    taskStatus: 'completed',
    messageCount: 1,
    firstMessageTime: '2026-08-05T09:00:00.000Z',
    lastMessageTime: '2026-08-05T10:00:00.000Z',
    hasErrors: false,
  };
}

describe('taskAttention', () => {
  it('only marks new background terminal transitions unread', () => {
    expect(shouldMarkTaskUnread('running', 'completed', false)).toBe(true);
    expect(shouldMarkTaskUnread('queued', 'failed', false)).toBe(true);
    expect(shouldMarkTaskUnread('running', 'interrupted', false)).toBe(true);
    expect(shouldMarkTaskUnread('running', 'completed', true)).toBe(false);
    expect(shouldMarkTaskUnread('completed', 'completed', false)).toBe(false);
    expect(shouldMarkTaskUnread('failed', 'completed', false)).toBe(false);
    expect(shouldMarkTaskUnread('running', 'cancelled', false)).toBe(false);
  });

  it('persists unique keys and tolerates malformed storage', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    persistUnreadTaskKeys(['a', 'a', 'b'], storage);
    expect(readUnreadTaskKeys(storage)).toEqual(['a', 'b']);

    values.set('blade.tasks.unread', '{bad json');
    expect(readUnreadTaskKeys(storage)).toEqual([]);
  });

  it('prunes references no longer present in the catalog', () => {
    expect(
      pruneUnreadTaskKeys(
        [
          JSON.stringify(['/workspace/a', 'session-1']),
          JSON.stringify(['/workspace/missing', 'session-1']),
        ],
        [session('/workspace/a')]
      )
    ).toEqual([JSON.stringify(['/workspace/a', 'session-1'])]);
  });
});
