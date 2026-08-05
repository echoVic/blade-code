import { describe, expect, it } from 'vitest';
import type { Session, SessionRef } from '@api/schemas';

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'session-1',
    projectPath: '/workspace/a',
    title: 'Session A',
    gitBranch: 'main',
    rootId: 'root-session-1',
    parentId: undefined,
    relationType: undefined,
    messageCount: 3,
    firstMessageTime: '2026-08-01T10:00:00.000Z',
    lastMessageTime: '2026-08-03T11:00:00.000Z',
    hasErrors: false,
    ...overrides,
  };
}

describe('sessionIdentity', () => {
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
});
