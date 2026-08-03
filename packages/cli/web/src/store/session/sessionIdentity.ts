import type { Session, SessionRef } from '@api/schemas';

export function sessionRefFromSession(session: Session): SessionRef {
  return {
    sessionId: session.sessionId,
    projectPath: session.projectPath,
  };
}

export function sessionRefKey(ref: SessionRef): string {
  return JSON.stringify([ref.projectPath, ref.sessionId]);
}

export function sameSessionRef(
  left: SessionRef | null | undefined,
  right: SessionRef | null | undefined
): boolean {
  if (!left || !right) return left === right;
  return left.sessionId === right.sessionId && left.projectPath === right.projectPath;
}

export function findSessionByRef(
  sessions: readonly Session[],
  ref: SessionRef
): Session | undefined {
  return sessions.find((session) =>
    sameSessionRef(sessionRefFromSession(session), ref)
  );
}

export function upsertSessionByRef(
  sessions: readonly Session[],
  nextSession: Session
): Session[] {
  const nextRef = sessionRefFromSession(nextSession);
  const existingIndex = sessions.findIndex((session) =>
    sameSessionRef(sessionRefFromSession(session), nextRef)
  );
  if (existingIndex === -1) {
    return [...sessions, nextSession];
  }
  const updated = [...sessions];
  updated[existingIndex] = nextSession;
  return updated;
}

export function removeSessionByRef(
  sessions: readonly Session[],
  ref: SessionRef
): Session[] {
  return sessions.filter(
    (session) => !sameSessionRef(sessionRefFromSession(session), ref)
  );
}
