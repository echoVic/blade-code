import type { Session, SessionRef } from '@api/schemas';
import { findSessionByRef } from './sessionIdentity';

const LAST_SESSION_KEY = 'blade.sessions.last';
const SESSION_PARAM = 'session';
const PROJECT_PARAM = 'project';
const WORKSPACE_PARAM = 'workspace';
const VIEW_PARAM = 'view';

export interface SessionNavigationIntent {
  sessionRef: SessionRef | null;
  projectPath: string | null;
  hasSessionParam: boolean;
  view: 'workspace' | 'board';
}

function validRef(value: unknown): SessionRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.sessionId === 'string' &&
    candidate.sessionId.trim() &&
    typeof candidate.projectPath === 'string' &&
    candidate.projectPath.trim()
    ? {
        sessionId: candidate.sessionId,
        projectPath: candidate.projectPath,
      }
    : null;
}

export function parseSessionNavigation(search: string): SessionNavigationIntent {
  const params = new URLSearchParams(search);
  const sessionId = params.get(SESSION_PARAM)?.trim() || null;
  const projectPath = params.get(PROJECT_PARAM)?.trim() || null;
  const workspacePath = params.get(WORKSPACE_PARAM)?.trim() || null;
  const view = params.get(VIEW_PARAM) === 'board' ? 'board' : 'workspace';
  return {
    sessionRef:
      sessionId && (workspacePath || projectPath)
        ? { sessionId, projectPath: workspacePath || projectPath! }
        : null,
    projectPath,
    hasSessionParam: params.has(SESSION_PARAM),
    view,
  };
}

export function readStoredSessionRef(
  storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined'
    ? null
    : localStorage
): SessionRef | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(LAST_SESSION_KEY);
    return raw ? validRef(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function resolveRestorableSession(
  sessions: readonly Session[],
  intent: SessionNavigationIntent,
  storedRef: SessionRef | null
): SessionRef | null {
  // An explicit URL is authoritative. Never silently open another task when
  // a shared/deep link points to a deleted or unavailable session.
  if (intent.hasSessionParam) {
    return intent.sessionRef && findSessionByRef(sessions, intent.sessionRef)
      ? intent.sessionRef
      : null;
  }
  if (intent.projectPath) return null;
  return storedRef && findSessionByRef(sessions, storedRef) ? storedRef : null;
}

export function syncSessionNavigation(
  sessionRef: SessionRef | null,
  selectedProjectPath: string | null,
  options: {
    href?: string;
    displayProjectPath?: string | null;
    view?: 'workspace' | 'board';
    storage?: Pick<Storage, 'setItem' | 'removeItem'> | null;
    replaceState?: (url: string) => void;
  } = {}
): string {
  const href =
    options.href ??
    (typeof window === 'undefined' ? 'http://localhost/' : window.location.href);
  const url = new URL(href);
  const view = options.view ?? 'workspace';
  const projectPath =
    options.displayProjectPath ??
    (view === 'board' ? selectedProjectPath : sessionRef?.projectPath) ??
    selectedProjectPath;
  const sessionWorkspacePath = sessionRef?.projectPath ?? null;

  if (sessionRef && view === 'workspace') {
    url.searchParams.set(SESSION_PARAM, sessionRef.sessionId);
  } else {
    url.searchParams.delete(SESSION_PARAM);
  }
  if (projectPath) {
    url.searchParams.set(PROJECT_PARAM, projectPath);
  } else {
    url.searchParams.delete(PROJECT_PARAM);
  }
  if (sessionWorkspacePath && projectPath && sessionWorkspacePath !== projectPath) {
    url.searchParams.set(WORKSPACE_PARAM, sessionWorkspacePath);
  } else {
    url.searchParams.delete(WORKSPACE_PARAM);
  }
  if (view === 'board') {
    url.searchParams.set(VIEW_PARAM, 'board');
    url.searchParams.delete(SESSION_PARAM);
    url.searchParams.delete(WORKSPACE_PARAM);
  } else {
    url.searchParams.delete(VIEW_PARAM);
  }

  const storage =
    options.storage === undefined
      ? typeof localStorage === 'undefined'
        ? null
        : localStorage
      : options.storage;
  try {
    if (sessionRef && view === 'workspace') {
      storage?.setItem(LAST_SESSION_KEY, JSON.stringify(sessionRef));
    } else if (view === 'workspace') {
      storage?.removeItem(LAST_SESSION_KEY);
    }
  } catch {
    // Navigation remains usable when storage is disabled or full.
  }

  const relativeUrl = `${url.pathname}${url.search}${url.hash}`;
  const replaceState =
    options.replaceState ??
    (typeof window === 'undefined'
      ? undefined
      : (nextUrl: string) => window.history.replaceState(null, '', nextUrl));
  replaceState?.(relativeUrl);
  return relativeUrl;
}
