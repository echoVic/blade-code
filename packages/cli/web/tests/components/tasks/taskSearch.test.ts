import { describe, expect, it } from 'vitest';
import { searchSessions, sessionSearchTitle } from '@/components/tasks/taskSearch';
import type { Session } from '@/services';

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'session-1',
    projectPath: '/workspace/blade',
    rootId: 'session-1',
    taskStatus: 'completed',
    messageCount: 4,
    firstMessageTime: '2026-08-01T10:00:00.000Z',
    lastMessageTime: '2026-08-07T10:00:00.000Z',
    hasErrors: false,
    ...overrides,
  };
}

describe('searchSessions', () => {
  const sessions = [
    session({
      sessionId: 'auth-fix',
      title: 'Repair OAuth callback',
      projectPath: '/workspace/blade',
      gitBranch: 'fix/oauth-callback',
      taskStatus: 'running',
      lastMessageTime: '2026-08-07T12:00:00.000Z',
    }),
    session({
      sessionId: 'docs',
      title: 'Document task runtime',
      projectPath: '/workspace/maestro',
      taskStatus: 'completed',
      lastMessageTime: '2026-08-07T11:00:00.000Z',
    }),
    session({
      sessionId: 'queue',
      title: 'Capacity limits',
      projectPath: '/workspace/blade',
      taskStatus: 'queued',
      lastMessageTime: '2026-08-07T09:00:00.000Z',
    }),
  ];

  it('matches title, project, branch, localized status, and session ID', () => {
    expect(searchSessions(sessions, 'oauth', null)[0]?.sessionId).toBe('auth-fix');
    expect(searchSessions(sessions, 'maestro done', null)[0]?.sessionId).toBe('docs');
    expect(searchSessions(sessions, 'fix/oauth', null)[0]?.sessionId).toBe('auth-fix');
    expect(searchSessions(sessions, '排队中', null)[0]?.sessionId).toBe('queue');
    expect(searchSessions(sessions, 'auth-fix', null)[0]?.sessionId).toBe('auth-fix');
  });

  it('ranks title matches before metadata and defaults to task priority', () => {
    expect(searchSessions(sessions, '', null).map((item) => item.sessionId)).toEqual([
      'auth-fix',
      'queue',
      'docs',
    ]);
    expect(
      searchSessions(sessions, 'blade', null).map((item) => item.sessionId)
    ).toEqual(['auth-fix', 'queue']);
  });

  it('deduplicates by session and workspace and observes the result limit', () => {
    expect(searchSessions([...sessions, sessions[0]!], '', null, 2)).toHaveLength(2);
  });

  it('keeps attention first and sorts terminal results by recent activity', () => {
    const results = searchSessions(
      [
        session({
          sessionId: 'old-failure',
          title: 'Old failure',
          taskStatus: 'failed',
          lastMessageTime: '2026-01-01T00:00:00.000Z',
        }),
        session({
          sessionId: 'recent-completion',
          title: 'Recent completion',
          lastMessageTime: '2026-08-07T10:00:00.000Z',
        }),
        session({
          sessionId: 'approval',
          title: 'Needs approval',
          taskStatus: 'running',
          pendingInteraction: {
            type: 'permission',
            requestId: 'permission-1',
          },
          lastMessageTime: '2026-08-01T00:00:00.000Z',
        }),
      ],
      '',
      null
    );

    expect(results.map((item) => item.sessionId)).toEqual([
      'approval',
      'recent-completion',
      'old-failure',
    ]);
  });
});

describe('sessionSearchTitle', () => {
  it('provides a stable fallback for untitled historical sessions', () => {
    expect(
      sessionSearchTitle(
        session({
          sessionId: 'abcdef123',
          title: undefined,
          firstMessageTime: undefined,
          lastMessageTime: undefined,
        })
      )
    ).toBe('Session abcdef');
  });
});
