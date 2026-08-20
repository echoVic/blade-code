import type { SessionRef } from '@api/schemas';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@/services';
import {
  parseSessionNavigation,
  readStoredSessionRef,
  resolveRestorableSession,
  syncSessionNavigation,
} from '@/store/session/sessionNavigation';

function session(sessionId: string, projectPath: string): Session {
  return {
    sessionId,
    projectPath,
    rootId: sessionId,
    taskStatus: 'completed',
    messageCount: 1,
    firstMessageTime: '2026-08-07T00:00:00.000Z',
    lastMessageTime: '2026-08-07T00:01:00.000Z',
    hasErrors: false,
  };
}

describe('session navigation', () => {
  const refA: SessionRef = {
    sessionId: 'shared-id',
    projectPath: '/workspace/a',
  };
  const refB: SessionRef = {
    sessionId: 'shared-id',
    projectPath: '/workspace/b',
  };
  const sessions = [
    session(refA.sessionId, refA.projectPath),
    session(refB.sessionId, refB.projectPath),
  ];

  it('parses encoded combined identity and project-only home links', () => {
    expect(
      parseSessionNavigation('?session=shared-id&project=%2Fworkspace%2Fb')
    ).toEqual({
      sessionRef: refB,
      projectPath: '/workspace/b',
      hasSessionParam: true,
      view: 'workspace',
    });
    expect(
      parseSessionNavigation(
        '?session=task-1&project=%2Fworkspace%2Fsource&workspace=%2Fworkspace%2Fworktree'
      )
    ).toEqual({
      sessionRef: {
        sessionId: 'task-1',
        projectPath: '/workspace/worktree',
      },
      projectPath: '/workspace/source',
      hasSessionParam: true,
      view: 'workspace',
    });
    expect(parseSessionNavigation('?project=%2Fworkspace%2Fa')).toEqual({
      sessionRef: null,
      projectPath: '/workspace/a',
      hasSessionParam: false,
      view: 'workspace',
    });
  });

  it('treats explicit invalid deep links as authoritative', () => {
    const invalidIntent = parseSessionNavigation(
      '?session=deleted&project=%2Fworkspace%2Fa'
    );
    expect(resolveRestorableSession(sessions, invalidIntent, refB)).toBeNull();

    expect(
      resolveRestorableSession(sessions, parseSessionNavigation(''), refB)
    ).toEqual(refB);
    expect(
      resolveRestorableSession(
        sessions,
        parseSessionNavigation('?project=%2Fworkspace%2Fa'),
        refB
      )
    ).toBeNull();
  });

  it('writes an encoded shareable URL and persists exact identity', () => {
    const values = new Map<string, string>();
    const storage = {
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      getItem: (key: string) => values.get(key) ?? null,
    };
    const replaceState = vi.fn();

    const url = syncSessionNavigation(refB, '/workspace/a', {
      href: 'http://localhost/?debug=1',
      storage,
      replaceState,
    });

    expect(url).toBe('/?debug=1&session=shared-id&project=%2Fworkspace%2Fb');
    expect(replaceState).toHaveBeenCalledWith(url);
    expect(readStoredSessionRef(storage)).toEqual(refB);

    const worktreeUrl = syncSessionNavigation(
      {
        sessionId: 'task-1',
        projectPath: '/workspace/.blade/worktrees/task-1',
      },
      '/workspace/source',
      {
        href: 'http://localhost/?debug=1',
        displayProjectPath: '/workspace/source',
        storage,
        replaceState,
      }
    );
    expect(worktreeUrl).toBe(
      '/?debug=1&session=task-1&project=%2Fworkspace%2Fsource&workspace=%2Fworkspace%2F.blade%2Fworktrees%2Ftask-1'
    );
    expect(readStoredSessionRef(storage)).toEqual({
      sessionId: 'task-1',
      projectPath: '/workspace/.blade/worktrees/task-1',
    });

    syncSessionNavigation(null, '/workspace/a', {
      href: `http://localhost${url}`,
      storage,
      replaceState,
    });
    expect(readStoredSessionRef(storage)).toBeNull();
    expect(replaceState).toHaveBeenLastCalledWith('/?debug=1&project=%2Fworkspace%2Fa');
  });

  it('parses and writes a board deep link without leaking a selected session', () => {
    expect(parseSessionNavigation('?view=board&project=%2Fworkspace%2Fa')).toEqual({
      sessionRef: null,
      projectPath: '/workspace/a',
      hasSessionParam: false,
      view: 'board',
    });

    const replaceState = vi.fn();
    const url = syncSessionNavigation(refB, '/workspace/a', {
      href: 'http://localhost/?session=stale&workspace=%2Fworkspace%2Fb',
      view: 'board',
      storage: null,
      replaceState,
    });
    expect(url).toBe('/?project=%2Fworkspace%2Fa&view=board');
    expect(replaceState).toHaveBeenCalledWith(url);
  });

  it('fails open when stored navigation data is malformed', () => {
    expect(readStoredSessionRef({ getItem: () => '{not-json' })).toBeNull();
  });
});
