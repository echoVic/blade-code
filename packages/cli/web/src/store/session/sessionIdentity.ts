import type { Session, SessionLocatorV2, SessionRef } from '@api/schemas';

export function sessionRefFromSession(session: Session): SessionRef {
  return {
    sessionId: session.sessionId,
    projectPath: session.projectPath,
  };
}

export function sessionRefKey(ref: SessionRef): string {
  return JSON.stringify([ref.projectPath, ref.sessionId]);
}

export function surfaceLocatorKey(locator: SessionLocatorV2): string {
  return JSON.stringify([
    locator.version,
    locator.sessionId,
    locator.workspace.kind,
    locator.workspace.kind === 'local'
      ? locator.workspace.projectPath
      : locator.workspace.workspaceRef,
  ]);
}

export function sameSessionRef(
  left: SessionRef | null | undefined,
  right: SessionRef | null | undefined
): boolean {
  if (!left || !right) return left === right;
  return left.sessionId === right.sessionId && left.projectPath === right.projectPath;
}

export function sameSurfaceLocator(
  left: SessionLocatorV2 | null | undefined,
  right: SessionLocatorV2 | null | undefined
): boolean {
  if (!left || !right) return left === right;
  if (left.version !== right.version || left.sessionId !== right.sessionId)
    return false;
  if (left.workspace.kind !== right.workspace.kind) return false;
  if (left.workspace.kind === 'local' && right.workspace.kind === 'local') {
    return left.workspace.projectPath === right.workspace.projectPath;
  }
  if (left.workspace.kind === 'acp-remote' && right.workspace.kind === 'acp-remote') {
    return left.workspace.workspaceRef === right.workspace.workspaceRef;
  }
  return false;
}

export function sessionRefFromSurfaceLocator(
  locator: SessionLocatorV2
): SessionRef | null {
  if (locator.workspace.kind !== 'local') return null;
  return {
    sessionId: locator.sessionId,
    projectPath: locator.workspace.projectPath,
  };
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
