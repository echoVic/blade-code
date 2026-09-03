import type { Session, SessionLocatorV2, SessionRef } from '@api/schemas';
import { describe, expect, it } from 'vitest';

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'session-1',
    projectPath: '/workspace/a',
    title: 'Session A',
    gitBranch: 'main',
    rootId: 'root-session-1',
    parentId: undefined,
    relationType: undefined,
    taskStatus: 'completed',
    messageCount: 3,
    firstMessageTime: '2026-08-01T10:00:00.000Z',
    lastMessageTime: '2026-08-03T11:00:00.000Z',
    hasErrors: false,
    ...overrides,
  };
}

describe('sessionIdentity', () => {
  const remoteWorkspaceRefA = `acp-remote-workspace:${'A'.repeat(43)}`;
  const remoteWorkspaceRefB = `acp-remote-workspace:${'B'.repeat(43)}`;

  it('derives session refs from full sessions', async () => {
    const session = createSession({
      sessionId: 'session-derive',
      projectPath: '/workspace/derive',
    });
    const { sessionRefFromSession } = await import(
      '../../../src/store/session/sessionIdentity'
    );

    expect(sessionRefFromSession(session)).toEqual({
      sessionId: 'session-derive',
      projectPath: '/workspace/derive',
    } satisfies SessionRef);
  });

  it('uses JSON stringified projectPath plus sessionId keys so same ids in different workspaces stay distinct', async () => {
    const refA: SessionRef = { sessionId: 'shared-id', projectPath: '/workspace/a' };
    const refB: SessionRef = { sessionId: 'shared-id', projectPath: '/workspace/b' };
    const { sessionRefKey } = await import(
      '../../../src/store/session/sessionIdentity'
    );

    expect(sessionRefKey(refA)).toBe(JSON.stringify(['/workspace/a', 'shared-id']));
    expect(sessionRefKey(refB)).toBe(JSON.stringify(['/workspace/b', 'shared-id']));
    expect(sessionRefKey(refA)).not.toBe(sessionRefKey(refB));
  });

  it('treats sameSessionRef as exact string equality without browser-side path normalization', async () => {
    const { sameSessionRef } = await import(
      '../../../src/store/session/sessionIdentity'
    );

    expect(
      sameSessionRef(
        { sessionId: 'session-1', projectPath: '/workspace/a' },
        { sessionId: 'session-1', projectPath: '/workspace/a' }
      )
    ).toBe(true);
    expect(
      sameSessionRef(
        { sessionId: 'session-1', projectPath: '/workspace/a' },
        { sessionId: 'session-1', projectPath: '/workspace/a/../a' }
      )
    ).toBe(false);
    expect(
      sameSessionRef(
        { sessionId: 'session-1', projectPath: '/workspace/a' },
        { sessionId: 'session-2', projectPath: '/workspace/a' }
      )
    ).toBe(false);
  });

  it('upserts, finds, and removes only the exact targeted session ref', async () => {
    const sameIdOtherWorkspace = createSession({
      sessionId: 'shared-id',
      projectPath: '/workspace/b',
      title: 'Session B',
      rootId: 'root-session-b',
    });
    const updatedSameWorkspace = createSession({
      sessionId: 'shared-id',
      projectPath: '/workspace/a',
      title: 'Updated Session A',
    });

    const {
      findSessionByRef,
      removeSessionByRef,
      sessionRefFromSession,
      upsertSessionByRef,
    } = await import('../../../src/store/session/sessionIdentity');

    const initial = [
      createSession({ sessionId: 'shared-id', projectPath: '/workspace/a' }),
      sameIdOtherWorkspace,
    ];
    const refA = sessionRefFromSession(initial[0]);
    const refB = sessionRefFromSession(sameIdOtherWorkspace);

    const upserted = upsertSessionByRef(initial, updatedSameWorkspace);
    expect(upserted).toEqual([updatedSameWorkspace, sameIdOtherWorkspace]);
    expect(findSessionByRef(upserted, refA)).toEqual(updatedSameWorkspace);
    expect(findSessionByRef(upserted, refB)).toEqual(sameIdOtherWorkspace);

    const removed = removeSessionByRef(upserted, refA);
    expect(removed).toEqual([sameIdOtherWorkspace]);
    expect(findSessionByRef(removed, refA)).toBeUndefined();
    expect(findSessionByRef(removed, refB)).toEqual(sameIdOtherWorkspace);
  });

  it('builds compound surface locator keys for local and remote workspaces', async () => {
    const localLocator: SessionLocatorV2 = {
      version: 2,
      sessionId: 'shared-id',
      workspace: {
        kind: 'local',
        projectPath: '/workspace/a',
      },
    };
    const remoteLocatorA: SessionLocatorV2 = {
      version: 2,
      sessionId: 'shared-id',
      workspace: {
        kind: 'acp-remote',
        workspaceRef: remoteWorkspaceRefA,
      },
    };
    const remoteLocatorB: SessionLocatorV2 = {
      version: 2,
      sessionId: 'shared-id',
      workspace: {
        kind: 'acp-remote',
        workspaceRef: remoteWorkspaceRefB,
      },
    };
    const { sameSurfaceLocator, surfaceLocatorKey } = await import(
      '../../../src/store/session/sessionIdentity'
    );

    expect(surfaceLocatorKey(localLocator)).toBe(
      JSON.stringify([2, 'shared-id', 'local', '/workspace/a'])
    );
    expect(surfaceLocatorKey(remoteLocatorA)).toBe(
      JSON.stringify([2, 'shared-id', 'acp-remote', remoteWorkspaceRefA])
    );
    expect(surfaceLocatorKey(remoteLocatorA)).not.toBe(
      surfaceLocatorKey(remoteLocatorB)
    );
    expect(sameSurfaceLocator(remoteLocatorA, remoteLocatorA)).toBe(true);
    expect(sameSurfaceLocator(remoteLocatorA, remoteLocatorB)).toBe(false);
    expect(sameSurfaceLocator(localLocator, remoteLocatorA)).toBe(false);
  });

  it('only converts local V2 locators into V1 session refs', async () => {
    const localLocator: SessionLocatorV2 = {
      version: 2,
      sessionId: 'local-session',
      workspace: {
        kind: 'local',
        projectPath: '/workspace/local',
      },
    };
    const remoteLocator: SessionLocatorV2 = {
      version: 2,
      sessionId: 'remote-session',
      workspace: {
        kind: 'acp-remote',
        workspaceRef: remoteWorkspaceRefA,
      },
    };
    const { sessionRefFromSurfaceLocator } = await import(
      '../../../src/store/session/sessionIdentity'
    );

    expect(sessionRefFromSurfaceLocator(localLocator)).toEqual({
      sessionId: 'local-session',
      projectPath: '/workspace/local',
    } satisfies SessionRef);
    expect(sessionRefFromSurfaceLocator(remoteLocator)).toBeNull();
  });
});
