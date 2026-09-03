import {
  type Session,
  type SessionLocatorV2,
  SessionLocatorV2Schema,
  type SessionRef,
} from '@api/schemas';
import { findSessionByRef, sameSurfaceLocator } from './sessionIdentity';

const LAST_SESSION_KEY = 'blade.sessions.last';
const SESSION_PARAM = 'session';
const PROJECT_PARAM = 'project';
const WORKSPACE_PARAM = 'workspace';
const VIEW_PARAM = 'view';
const WORKSPACE_KIND_PARAM = 'workspaceKind';
const WORKSPACE_REF_PARAM = 'workspaceRef';
const HISTORY_VIEW = 'history';
const HISTORY_STATE_KEY = 'bladeSessionSurfaceLocator';
const HISTORY_QUERY_PARAMS = [
  VIEW_PARAM,
  SESSION_PARAM,
  WORKSPACE_KIND_PARAM,
  WORKSPACE_REF_PARAM,
] as const;
const LOCAL_PATH_QUERY_PARAMS = [
  PROJECT_PARAM,
  WORKSPACE_PARAM,
  'cwd',
  'displayCwd',
] as const;

export interface SessionNavigationIntent {
  sessionRef: SessionRef | null;
  projectPath: string | null;
  hasSessionParam: boolean;
  view: 'workspace' | 'board';
}

export interface HistorySurfaceNavigationIntent {
  locator: SessionLocatorV2 | null;
  shouldCleanup: boolean;
}

function validSurfaceLocator(value: unknown): SessionLocatorV2 | null {
  try {
    return SessionLocatorV2Schema.parse(value);
  } catch {
    return null;
  }
}

function locatorFromHistoryState(value: unknown): SessionLocatorV2 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return validSurfaceLocator((value as Record<string, unknown>)[HISTORY_STATE_KEY]);
}

function hasHistoryLocatorState(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.hasOwn(value, HISTORY_STATE_KEY)
  );
}

function remoteLocatorFromQuery(params: URLSearchParams): SessionLocatorV2 | null {
  const sessionId = params.get(SESSION_PARAM);
  const workspaceKind = params.get(WORKSPACE_KIND_PARAM);
  const workspaceRef = params.get(WORKSPACE_REF_PARAM);
  if (!sessionId || workspaceKind !== 'acp-remote' || !workspaceRef) return null;
  return validSurfaceLocator({
    version: 2,
    sessionId,
    workspace: {
      kind: 'acp-remote',
      workspaceRef,
    },
  });
}

export function parseHistorySurfaceNavigation(
  search: string,
  historyState: unknown
): HistorySurfaceNavigationIntent {
  const params = new URLSearchParams(search);
  const isHistoryView = params.get(VIEW_PARAM) === HISTORY_VIEW;
  const hasHistoryParams =
    params.has(WORKSPACE_KIND_PARAM) || params.has(WORKSPACE_REF_PARAM);
  const stateLocator = locatorFromHistoryState(historyState);
  const hasStateLocator = hasHistoryLocatorState(historyState);

  if (!isHistoryView) {
    return {
      locator: null,
      shouldCleanup: hasHistoryParams || hasStateLocator,
    };
  }
  const seen = new Set<string>();
  for (const [key] of params) {
    if (!(HISTORY_QUERY_PARAMS as readonly string[]).includes(key) || seen.has(key)) {
      return { locator: null, shouldCleanup: true };
    }
    seen.add(key);
  }

  const queryLocator = remoteLocatorFromQuery(params);
  if (!queryLocator) {
    return { locator: null, shouldCleanup: true };
  }
  if (hasStateLocator && !stateLocator) {
    return { locator: null, shouldCleanup: true };
  }
  if (stateLocator && !sameSurfaceLocator(stateLocator, queryLocator)) {
    return { locator: null, shouldCleanup: true };
  }

  return {
    locator: queryLocator,
    shouldCleanup: false,
  };
}

export function syncHistorySurfaceNavigation(
  locator: SessionLocatorV2 | null,
  options: {
    href?: string;
    historyState?: unknown;
    push?: boolean;
    replaceState?: (state: Record<string, unknown> | null, url: string) => void;
    pushState?: (state: Record<string, unknown>, url: string) => void;
  } = {}
): string {
  const href =
    options.href ??
    (typeof window === 'undefined' ? 'http://localhost/' : window.location.href);
  const url = new URL(href);

  const parsedLocator = locator ? validSurfaceLocator(locator) : null;
  const validLocator =
    parsedLocator?.workspace.kind === 'acp-remote' ? parsedLocator : null;
  if (validLocator) {
    url.search = '';
  } else {
    for (const key of [...HISTORY_QUERY_PARAMS, ...LOCAL_PATH_QUERY_PARAMS]) {
      url.searchParams.delete(key);
    }
  }
  const priorState =
    options.historyState &&
    typeof options.historyState === 'object' &&
    !Array.isArray(options.historyState)
      ? { ...(options.historyState as Record<string, unknown>) }
      : {};
  delete priorState[HISTORY_STATE_KEY];
  const state = validLocator
    ? { ...priorState, [HISTORY_STATE_KEY]: validLocator }
    : Object.keys(priorState).length > 0
      ? priorState
      : null;

  if (validLocator?.workspace.kind === 'acp-remote') {
    url.searchParams.set(VIEW_PARAM, HISTORY_VIEW);
    url.searchParams.set(SESSION_PARAM, validLocator.sessionId);
    url.searchParams.set(WORKSPACE_KIND_PARAM, validLocator.workspace.kind);
    url.searchParams.set(WORKSPACE_REF_PARAM, validLocator.workspace.workspaceRef);
  }

  const relativeUrl = `${url.pathname}${url.search}${url.hash}`;
  const replaceState =
    options.replaceState ??
    (typeof window === 'undefined'
      ? undefined
      : (nextState: Record<string, unknown> | null, nextUrl: string) =>
          window.history.replaceState(nextState, '', nextUrl));
  const pushState =
    options.pushState ??
    (typeof window === 'undefined'
      ? undefined
      : (nextState: Record<string, unknown>, nextUrl: string) =>
          window.history.pushState(nextState, '', nextUrl));

  if (state && options.push) {
    pushState?.(state, relativeUrl);
  } else {
    replaceState?.(state, relativeUrl);
  }
  return relativeUrl;
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
