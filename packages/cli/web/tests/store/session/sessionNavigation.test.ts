import type { SessionLocatorV2, SessionRef } from '@api/schemas';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@/services';
import {
  parseHistorySurfaceNavigation,
  parseSessionNavigation,
  readStoredSessionRef,
  resolveRestorableSession,
  syncHistorySurfaceNavigation,
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
  const remoteWorkspaceRef = `acp-remote-workspace:${'A'.repeat(43)}`;
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

  it('parses and writes the exact remote history URL without local path fields', () => {
    const locator: SessionLocatorV2 = {
      version: 2,
      sessionId: 'remote-session',
      workspace: {
        kind: 'acp-remote',
        workspaceRef: remoteWorkspaceRef,
      },
    };
    const replaceState = vi.fn();
    const pushState = vi.fn();

    const parsed = parseHistorySurfaceNavigation(
      `?view=history&session=remote-session&workspaceKind=acp-remote&workspaceRef=${remoteWorkspaceRef}`,
      null
    );
    expect(parsed.locator).toEqual(locator);
    expect(parsed.shouldCleanup).toBe(false);

    const url = syncHistorySurfaceNavigation(locator, {
      href: 'http://localhost/?debug=1&project=%2Fworkspace%2Fa&workspace=%2Fworkspace%2Fb&cwd=%2Ftmp',
      historyState: null,
      replaceState,
      pushState,
    });

    expect(url).toBe(
      '/?view=history&session=remote-session&workspaceKind=acp-remote&workspaceRef=acp-remote-workspace%3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    );
    expect(replaceState).toHaveBeenCalledWith(
      { bladeSessionSurfaceLocator: locator },
      url
    );
    expect(pushState).not.toHaveBeenCalled();
    expect(url).not.toContain('project=');
    expect(url).not.toContain('workspace=');
    expect(url).not.toContain('cwd=');
    expect(url).not.toContain('displayCwd');
  });

  it('cleans invalid remote history query combinations without producing a locator', () => {
    const replaceState = vi.fn();
    const parsed = parseHistorySurfaceNavigation(
      '?view=history&session=remote-session&workspaceKind=acp-remote',
      null
    );

    expect(parsed.locator).toBeNull();
    expect(parsed.shouldCleanup).toBe(true);

    const url = syncHistorySurfaceNavigation(null, {
      href: 'http://localhost/?view=history&session=remote-session&workspaceKind=acp-remote',
      historyState: { bladeSessionSurfaceLocator: 'invalid' },
      replaceState,
    });

    expect(url).toBe('/');
    expect(replaceState).toHaveBeenCalledWith(null, '/');
  });

  it('keeps local session URLs outside the remote cleanup path and rejects polluted remote URLs', () => {
    expect(
      parseHistorySurfaceNavigation(
        '?session=local-session&project=%2Fworkspace%2Flocal',
        null
      )
    ).toEqual({ locator: null, shouldCleanup: false });

    expect(
      parseHistorySurfaceNavigation(
        `?view=history&session=remote-session&workspaceKind=acp-remote&workspaceRef=${remoteWorkspaceRef}&project=%2Fprivate%2Fstate`,
        null
      )
    ).toEqual({ locator: null, shouldCleanup: true });
    expect(
      parseHistorySurfaceNavigation(
        `?view=history&session=remote-session&workspaceKind=acp-remote&workspaceRef=${remoteWorkspaceRef}&debug=1`,
        null
      )
    ).toEqual({ locator: null, shouldCleanup: true });
    expect(
      parseHistorySurfaceNavigation(
        `?view=history&session=remote-session&session=duplicate&workspaceKind=acp-remote&workspaceRef=${remoteWorkspaceRef}`,
        null
      )
    ).toEqual({ locator: null, shouldCleanup: true });
  });

  it('fails closed when a versioned history state disagrees with the remote URL', () => {
    const locator: SessionLocatorV2 = {
      version: 2,
      sessionId: 'remote-session',
      workspace: {
        kind: 'acp-remote',
        workspaceRef: remoteWorkspaceRef,
      },
    };
    const otherLocator: SessionLocatorV2 = {
      ...locator,
      sessionId: 'other-session',
    };
    const search = `?view=history&session=remote-session&workspaceKind=acp-remote&workspaceRef=${remoteWorkspaceRef}`;

    expect(
      parseHistorySurfaceNavigation(search, {
        bladeSessionSurfaceLocator: locator,
      })
    ).toEqual({ locator, shouldCleanup: false });
    expect(
      parseHistorySurfaceNavigation(search, {
        bladeSessionSurfaceLocator: otherLocator,
      })
    ).toEqual({ locator: null, shouldCleanup: true });
  });

  it('preserves unrelated history state while adding or removing the opaque locator', () => {
    const locator: SessionLocatorV2 = {
      version: 2,
      sessionId: 'remote-session',
      workspace: {
        kind: 'acp-remote',
        workspaceRef: remoteWorkspaceRef,
      },
    };
    const replaceState = vi.fn();

    syncHistorySurfaceNavigation(locator, {
      href: 'http://localhost/',
      historyState: { preserved: true },
      replaceState,
    });
    expect(replaceState).toHaveBeenLastCalledWith(
      { preserved: true, bladeSessionSurfaceLocator: locator },
      expect.stringContaining('view=history')
    );

    syncHistorySurfaceNavigation(null, {
      href: 'http://localhost/?view=history',
      historyState: { preserved: true, bladeSessionSurfaceLocator: locator },
      replaceState,
    });
    expect(replaceState).toHaveBeenLastCalledWith({ preserved: true }, '/');
  });
});
