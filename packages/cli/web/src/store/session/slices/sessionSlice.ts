import { deriveSessionTitle } from '@api/sessionTitle';
import { parseSideConversationCommand } from '@api/sideConversation';
import { isHttpResponseError } from '@/lib/http';
import { projectPathOf } from '@/lib/projectIdentity';
import { sessionService } from '@/services';
import { DEFAULT_WEB_PERMISSION_MODE, useConfigStore } from '@/store/ConfigStore';
import { useSettingsStore } from '@/store/SettingsStore';
import { initialTokenUsage, TEMP_SESSION_ID } from '../constants';
import {
  HISTORY_SURFACE_READ_ONLY_ERROR,
  isHistorySurfaceActive,
} from '../historySurfaceGuard';
import {
  findSessionByRef,
  removeSessionByRef,
  sameSessionRef,
  sessionRefFromSession,
  sessionRefKey,
  upsertSessionByRef,
} from '../sessionIdentity';
import {
  persistTaskTerminalReadLedger,
  persistUnreadTaskKeys,
  reconcileTaskAttention,
  type TaskTerminalReadLedgerV1,
} from '../taskAttention';
import type {
  Message,
  MessageContentPart,
  SendMessagePayload,
  Session,
  SessionCatalogOverlay,
  SessionRef,
  SessionSlice,
  SliceCreator,
  StreamEvent,
} from '../types';
import { createEmptyAgentContent } from '../utils/agentTimeline';
import { aggregateMessages } from '../utils/aggregateMessages';

const buildOptimisticUserContent = (payload: SendMessagePayload) => {
  const parts: MessageContentPart[] = [];

  if (payload.content.trim()) {
    parts.push({ type: 'text', text: payload.content });
  }

  for (const attachment of payload.attachments ?? []) {
    if (attachment.type === 'image') {
      parts.push({ type: 'image_url', image_url: { url: attachment.content } });
    }
  }

  if (parts.length === 0) {
    return payload.content;
  }

  if (parts.length === 1 && parts[0]?.type === 'text') {
    return parts[0].text;
  }

  return parts;
};

const mergePendingInteractionProjection = (
  authoritativeMessages: Message[],
  currentMessages: Message[],
  pendingInteraction: Session['pendingInteraction']
): Message[] => {
  if (!pendingInteraction) return authoritativeMessages;

  const projectedMessage = currentMessages.find((message) => {
    const content = message.agentContent;
    if (!content) return false;
    switch (pendingInteraction.type) {
      case 'permission':
        return (
          content.confirmation?.toolCallId === pendingInteraction.requestId &&
          content.confirmation.status === 'pending'
        );
      case 'question':
        return (
          content.question?.toolCallId === pendingInteraction.requestId &&
          content.question.status === 'pending'
        );
      case 'elicitation':
        return (
          content.elicitation?.toolCallId === pendingInteraction.requestId &&
          content.elicitation.status === 'pending'
        );
    }
  });
  if (!projectedMessage?.agentContent) return authoritativeMessages;

  const authoritativeIndex = authoritativeMessages.findIndex(
    (message) => message.id === projectedMessage.id
  );
  const authoritativeMessage = authoritativeMessages[authoritativeIndex];
  const baseMessage: Message = authoritativeMessage ?? {
    id: projectedMessage.id,
    role: 'assistant',
    content: '',
    timestamp: projectedMessage.timestamp,
  };
  let agentContent = baseMessage.agentContent ?? createEmptyAgentContent();
  switch (pendingInteraction.type) {
    case 'permission':
      agentContent = {
        ...agentContent,
        confirmation: projectedMessage.agentContent.confirmation,
      };
      break;
    case 'question':
      agentContent = {
        ...agentContent,
        question: projectedMessage.agentContent.question,
      };
      break;
    case 'elicitation':
      agentContent = {
        ...agentContent,
        elicitation: projectedMessage.agentContent.elicitation,
      };
      break;
  }
  const mergedMessage = { ...baseMessage, agentContent };
  if (authoritativeIndex < 0) {
    return [...authoritativeMessages, mergedMessage];
  }
  return authoritativeMessages.map((message, index) =>
    index === authoritativeIndex ? mergedMessage : message
  );
};

const resetStreamingState = () => ({
  eventUnsubscribe: null,
  sessionEventConnectionState: 'idle' as const,
  isStreaming: false,
  isStopping: false,
  agentPhase: 'idle' as const,
  providerAdmission: null,
  providerCircuit: null,
  providerRetry: null,
  pendingResume: null,
  providerStall: null,
  actionStationarity: null,
  turnRecovery: null,
  currentRunId: null,
  pendingSteeringCount: 0,
  pendingInputDelivery: null,
  recoveredSteeringCount: 0,
  pendingSubagentCompletions: {},
  currentAssistantMessageId: null,
  hasToolCalls: false,
});

const waitForCatalogContinuation = (): Promise<void> =>
  new Promise((resolve) => {
    globalThis.setTimeout(() => {
      if (
        typeof window !== 'undefined' &&
        typeof window.requestIdleCallback === 'function'
      ) {
        window.requestIdleCallback(() => resolve(), { timeout: 750 });
        return;
      }
      resolve();
    }, 350);
  });

function taskTerminalReadLedger(
  ledger: TaskTerminalReadLedgerV1 | undefined
): TaskTerminalReadLedgerV1 {
  return ledger ?? { version: 1, entries: [] };
}

function applySessionCatalogOverlays(
  sessions: readonly Session[],
  overlays: Record<string, SessionCatalogOverlay>,
  startRevision: number
): Session[] {
  let merged = [...sessions];
  for (const [key, overlay] of Object.entries(overlays)) {
    if (overlay.revision <= startRevision) continue;
    if (overlay.kind === 'remove') {
      merged = merged.filter(
        (session) => sessionRefKey(sessionRefFromSession(session)) !== key
      );
    } else {
      merged = upsertSessionByRef(merged, overlay.session);
    }
  }
  return merged;
}

function retainNewerSessionCatalogOverlays(
  overlays: Record<string, SessionCatalogOverlay>,
  startRevision: number
): Record<string, SessionCatalogOverlay> {
  return Object.fromEntries(
    Object.entries(overlays).filter(([, overlay]) => overlay.revision > startRevision)
  );
}

const fetchTeams = async (ref: SessionRef) =>
  (await import('@/services/teamService')).teamService.list(ref);

export const createSessionSlice: SliceCreator<SessionSlice> = (set, get) => {
  let navigationGeneration = 0;
  let viewSelectionGeneration = 0;
  let catalogGeneration = 0;
  let archivedCatalogGeneration = 0;
  const messageResyncs = new Map<string, Promise<void>>();
  const teamLoads = new Map<string, Promise<void>>();
  let sideConversationController: AbortController | null = null;

  const beginNavigation = (): number => {
    sideConversationController?.abort('session-navigation');
    sideConversationController = null;
    navigationGeneration += 1;
    return navigationGeneration;
  };

  const isCurrentNavigation = (generation: number): boolean =>
    generation === navigationGeneration;

  const closePreparedSubscription = (unsubscribe: () => void): void => {
    try {
      unsubscribe();
    } catch (error) {
      console.warn('Failed to clean up stale event subscription', error);
    }
  };

  return {
    sessions: [],
    archivedSessions: [],
    currentSessionId: null,
    currentSessionRef: null,
    forkingSessionRef: null,
    isTemporarySession: false,
    isLoading: false,
    catalogLoadState: 'idle',
    catalogError: null,
    archivedCatalogLoadState: 'idle',
    archivedCatalogError: null,
    error: null,
    errorContext: null,
    goal: null,
    sideConversation: null,
    teams: [],

    setSessions: (sessions) => set({ sessions }),

    addSession: (session) =>
      set((state) => ({
        sessions: upsertSessionByRef(state.sessions, session),
      })),

    removeSession: (ref) => {
      const state = get();
      const key = sessionRefKey(ref);
      const isCurrent = sameSessionRef(state.currentSessionRef, ref);
      const cancelsFork = sameSessionRef(state.forkingSessionRef, ref);
      if (isCurrent || cancelsFork) {
        beginNavigation();
      }
      if (isCurrent) {
        state.unsubscribeFromEvents();
      }
      let nextUnreadTaskKeys = state.unreadTaskKeys;
      let nextLedger = taskTerminalReadLedger(state.taskTerminalReadLedger);
      set((currentState) => {
        const sessionCatalogOverlays = { ...currentState.sessionCatalogOverlays };
        delete sessionCatalogOverlays[key];
        nextUnreadTaskKeys = currentState.unreadTaskKeys.filter(
          (candidate) => candidate !== key
        );
        nextLedger = {
          version: 1,
          entries: taskTerminalReadLedger(
            currentState.taskTerminalReadLedger
          ).entries.filter((entry) => entry.key !== key),
        };
        return {
          sessions: removeSessionByRef(currentState.sessions, ref),
          unreadTaskKeys: nextUnreadTaskKeys,
          taskTerminalReadLedger: nextLedger,
          sessionCatalogOverlays,
          currentSessionId: isCurrent ? null : currentState.currentSessionId,
          currentSessionRef: isCurrent ? null : currentState.currentSessionRef,
          messages: isCurrent ? [] : currentState.messages,
          goal: isCurrent ? null : currentState.goal,
          sideConversation: isCurrent ? null : currentState.sideConversation,
          teams: isCurrent ? [] : currentState.teams,
          forkingSessionRef: cancelsFork ? null : currentState.forkingSessionRef,
          ...(isCurrent ? resetStreamingState() : {}),
        };
      });
      persistTaskTerminalReadLedger(nextLedger);
      persistUnreadTaskKeys(nextUnreadTaskKeys);
    },

    setCurrentSession: (ref) => {
      beginNavigation();
      get().claimViewSelection();
      get().closeHistorySurface();
      set({
        currentSessionId: ref?.sessionId ?? null,
        currentSessionRef: ref,
        isTemporarySession: false,
        sideConversation: null,
        teams: [],
        pendingResume: null,
      });
    },

    setTemporarySession: (isTemp) => set({ isTemporarySession: isTemp }),

    setLoading: (loading) => set({ isLoading: loading }),

    setError: (error) => set({ error, errorContext: null }),

    getNavigationVersion: () => navigationGeneration,

    getViewSelectionVersion: () => viewSelectionGeneration,

    claimViewSelection: () => {
      viewSelectionGeneration += 1;
      return viewSelectionGeneration;
    },

    clearError: () => set({ error: null, errorContext: null }),

    setGoal: (goal) => set({ goal }),

    startTemporarySession: (projectPath) => {
      beginNavigation();
      get().claimViewSelection();
      get().closeHistorySurface();
      get().unsubscribeFromEvents();
      useConfigStore.getState().resetMode();
      if (projectPath) {
        get().selectProject(projectPath);
      }
      set({
        currentSessionId: TEMP_SESSION_ID,
        currentSessionRef: null,
        isTemporarySession: true,
        forkingSessionRef: null,
        isLoading: false,
        messages: [],
        goal: null,
        sideConversation: null,
        teams: [],
        tokenUsage: { ...initialTokenUsage },
        error: null,
        errorContext: null,
        ...resetStreamingState(),
      });
    },

    loadSessions: async () => {
      const generation = ++catalogGeneration;
      const initialSessions = get().sessions;
      const startRevision = get().catalogOverlayRevision ?? 0;
      let catalogSessions: Session[] = [];
      set({ catalogLoadState: 'loading', catalogError: null });
      try {
        let cursor: string | undefined;
        do {
          const page = await sessionService.listSessionPage(cursor);
          if (generation !== catalogGeneration) return;
          for (const session of page.sessions) {
            catalogSessions = upsertSessionByRef(catalogSessions, session);
          }
          set((state) => {
            const catalogKeys = new Set(
              catalogSessions.map((session) =>
                sessionRefKey(sessionRefFromSession(session))
              )
            );
            const progressiveSessions = [
              ...catalogSessions,
              ...initialSessions.filter(
                (session) =>
                  !catalogKeys.has(sessionRefKey(sessionRefFromSession(session)))
              ),
            ];
            return {
              sessions: applySessionCatalogOverlays(
                progressiveSessions,
                state.sessionCatalogOverlays ?? {},
                startRevision
              ),
              catalogLoadState: 'hydrating',
            };
          });
          cursor = page.nextCursor;
          if (cursor) {
            await waitForCatalogContinuation();
            if (generation !== catalogGeneration) return;
          }
        } while (cursor);

        if (generation !== catalogGeneration) return;
        let nextUnreadTaskKeys = get().unreadTaskKeys;
        let nextLedger = taskTerminalReadLedger(get().taskTerminalReadLedger);
        set((state) => {
          const sessions = applySessionCatalogOverlays(
            catalogSessions,
            state.sessionCatalogOverlays ?? {},
            startRevision
          );
          const reconciled = reconcileTaskAttention({
            ledger: taskTerminalReadLedger(state.taskTerminalReadLedger),
            unreadTaskKeys: state.unreadTaskKeys,
            sessions,
            currentSessionRef: state.currentSessionRef,
            documentVisible:
              typeof document !== 'undefined' && document.visibilityState === 'visible',
          });
          nextUnreadTaskKeys = reconciled.unreadTaskKeys;
          nextLedger = reconciled.ledger;
          return {
            sessions,
            unreadTaskKeys: nextUnreadTaskKeys,
            taskTerminalReadLedger: nextLedger,
            sessionCatalogOverlays: retainNewerSessionCatalogOverlays(
              state.sessionCatalogOverlays ?? {},
              startRevision
            ),
            catalogLoadState: 'ready' as const,
            catalogError: null,
          };
        });
        persistTaskTerminalReadLedger(nextLedger);
        persistUnreadTaskKeys(nextUnreadTaskKeys);
      } catch (err) {
        if (generation !== catalogGeneration) return;
        set({
          catalogLoadState: 'error',
          catalogError: (err as Error).message,
        });
      }
    },

    loadArchivedSessions: async () => {
      const generation = ++archivedCatalogGeneration;
      set({
        archivedCatalogLoadState: 'loading',
        archivedCatalogError: null,
      });
      try {
        let cursor: string | undefined;
        const archivedSessions: ReturnType<typeof get>['sessions'] = [];
        do {
          const page = await sessionService.listSessionPage(cursor, 50, true);
          if (generation !== archivedCatalogGeneration) return;
          for (const session of page.sessions) {
            const index = archivedSessions.findIndex((candidate) =>
              sameSessionRef(
                sessionRefFromSession(candidate),
                sessionRefFromSession(session)
              )
            );
            if (index === -1) archivedSessions.push(session);
            else archivedSessions[index] = session;
          }
          cursor = page.nextCursor;
          if (cursor) {
            set({ archivedCatalogLoadState: 'hydrating' });
            await waitForCatalogContinuation();
          }
        } while (cursor);

        if (generation !== archivedCatalogGeneration) return;
        set({
          archivedSessions,
          archivedCatalogLoadState: 'ready',
          archivedCatalogError: null,
        });
      } catch (err) {
        if (generation !== archivedCatalogGeneration) return;
        set({
          archivedCatalogLoadState: 'error',
          archivedCatalogError: (err as Error).message,
        });
      }
    },

    selectSession: async (ref) => {
      const generation = beginNavigation();
      const viewSelection = get().claimViewSelection();
      get().closeHistorySurface();
      set({
        isLoading: true,
        error: null,
        errorContext: null,
        forkingSessionRef: null,
      });
      let preparedUnsubscribe: (() => void) | null = null;
      try {
        const existingSession = findSessionByRef(get().sessions, ref);
        const pendingEvents: StreamEvent[] = [];
        let subscriptionCommitted = false;
        preparedUnsubscribe = await get().prepareEventSubscription(ref, (event) => {
          if (subscriptionCommitted) {
            get().handleEvent(event);
          } else {
            pendingEvents.push(event);
          }
        });
        if (
          !isCurrentNavigation(generation) ||
          viewSelection !== get().getViewSelectionVersion()
        ) {
          closePreparedSubscription(preparedUnsubscribe);
          preparedUnsubscribe = null;
          return;
        }
        const [rawMessages, goal, exactSession, teams] = await Promise.all([
          sessionService.getMessages(ref),
          sessionService.getGoal(ref).catch(() => null),
          existingSession
            ? Promise.resolve(existingSession)
            : sessionService.getSession(ref),
          useSettingsStore.getState().agentTeamsEnabled
            ? fetchTeams(ref).catch(() => [])
            : Promise.resolve([]),
        ]);
        if (
          !isCurrentNavigation(generation) ||
          viewSelection !== get().getViewSelectionVersion()
        ) {
          closePreparedSubscription(preparedUnsubscribe);
          preparedUnsubscribe = null;
          return;
        }
        const messages = aggregateMessages(rawMessages);
        const displayProjectPath = projectPathOf(
          exactSession,
          get().selectedProjectPath ?? get().taskWorkspaceInfo?.cwd ?? null
        );
        if (
          get().boundProjects.some(
            (project) => project.available && project.path === displayProjectPath
          )
        ) {
          get().selectProject(displayProjectPath);
        }
        useConfigStore
          .getState()
          .setMode(exactSession.permissionMode ?? DEFAULT_WEB_PERMISSION_MODE);
        set((state) => ({
          currentSessionId: ref.sessionId,
          currentSessionRef: ref,
          isTemporarySession: false,
          messages,
          goal,
          teams,
          isLoading: false,
          tokenUsage: { ...initialTokenUsage },
          isStreaming: false,
          isStopping: false,
          agentPhase: 'idle',
          providerAdmission: null,
          providerCircuit: null,
          providerRetry: null,
          pendingResume: null,
          providerStall: null,
          actionStationarity: null,
          turnRecovery: null,
          currentRunId: null,
          pendingSteeringCount: 0,
          pendingInputDelivery: null,
          recoveredSteeringCount: 0,
          pendingSubagentCompletions: {},
          currentAssistantMessageId: null,
          hasToolCalls: false,
          error:
            exactSession.taskStatus === 'failed'
              ? (exactSession.taskFailure?.message ?? null)
              : null,
          errorContext:
            exactSession.taskStatus === 'failed' && exactSession.taskFailure
              ? {
                  kind: 'execution',
                  sessionRef: ref,
                  failureCode: exactSession.taskFailure.code,
                }
              : null,
          sessions: upsertSessionByRef(state.sessions, exactSession),
        }));
        get().markTaskRead(ref);
        subscriptionCommitted = true;
        get().replaceEventSubscription(preparedUnsubscribe);
        preparedUnsubscribe = null;
        for (const event of pendingEvents) {
          get().handleEvent(event);
        }
      } catch (err) {
        if (preparedUnsubscribe) {
          closePreparedSubscription(preparedUnsubscribe);
        }
        if (
          !isCurrentNavigation(generation) ||
          viewSelection !== get().getViewSelectionVersion()
        )
          return;
        set({
          error: (err as Error).message,
          errorContext: { kind: 'navigation', sessionRef: ref },
          isLoading: false,
        });
      }
    },

    resyncSessionMessages: async (ref) => {
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        return;
      }
      const key = sessionRefKey(ref);
      const existing = messageResyncs.get(key);
      if (existing) return existing;
      const generation = navigationGeneration;
      const resync = Promise.resolve().then(async () => {
        try {
          const rawMessages = await sessionService.getMessages(ref);
          if (
            !isCurrentNavigation(generation) ||
            !sameSessionRef(get().currentSessionRef, ref)
          ) {
            return;
          }
          const authoritativeMessages = aggregateMessages(rawMessages);
          set((state) => ({
            messages: mergePendingInteractionProjection(
              authoritativeMessages,
              state.messages,
              findSessionByRef(state.sessions, ref)?.pendingInteraction
            ),
            sessions: state.sessions.map((session) =>
              sameSessionRef(sessionRefFromSession(session), ref)
                ? { ...session, messageCount: authoritativeMessages.length }
                : session
            ),
          }));
        } catch (error) {
          console.warn('Failed to resync terminal session messages', error);
        } finally {
          if (messageResyncs.get(key) === resync) {
            messageResyncs.delete(key);
          }
        }
      });
      messageResyncs.set(key, resync);
      return resync;
    },

    archiveSession: async (ref) => {
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        return;
      }
      try {
        const result = await sessionService.archiveSession(ref);
        const archivedIds = new Set(result.archivedSessionIds);
        const state = get();
        const archivesCurrent =
          state.currentSessionRef?.projectPath === ref.projectPath &&
          archivedIds.has(state.currentSessionRef.sessionId);
        if (archivesCurrent) {
          beginNavigation();
          state.unsubscribeFromEvents();
        }
        let nextUnreadTaskKeys = state.unreadTaskKeys;
        let nextLedger = taskTerminalReadLedger(state.taskTerminalReadLedger);
        set((currentState) => {
          const archivedKeys = new Set(
            result.archivedSessionIds.map((sessionId) =>
              sessionRefKey({ sessionId, projectPath: ref.projectPath })
            )
          );
          const sessions = currentState.sessions.filter(
            (session) =>
              session.projectPath !== ref.projectPath ||
              !archivedIds.has(session.sessionId)
          );
          nextUnreadTaskKeys = currentState.unreadTaskKeys.filter(
            (key) => !archivedKeys.has(key)
          );
          nextLedger = {
            version: 1,
            entries: taskTerminalReadLedger(
              currentState.taskTerminalReadLedger
            ).entries.filter((entry) => !archivedKeys.has(entry.key)),
          };
          const revision = (currentState.catalogOverlayRevision ?? 0) + 1;
          const sessionCatalogOverlays = {
            ...currentState.sessionCatalogOverlays,
          };
          for (const key of archivedKeys) {
            sessionCatalogOverlays[key] = { revision, kind: 'remove' };
          }
          return {
            sessions,
            archivedSessions: upsertSessionByRef(
              currentState.archivedSessions,
              result.session
            ),
            unreadTaskKeys: nextUnreadTaskKeys,
            taskTerminalReadLedger: nextLedger,
            catalogOverlayRevision: revision,
            sessionCatalogOverlays,
            currentSessionId: archivesCurrent ? null : currentState.currentSessionId,
            currentSessionRef: archivesCurrent ? null : currentState.currentSessionRef,
            messages: archivesCurrent ? [] : currentState.messages,
            goal: archivesCurrent ? null : currentState.goal,
            ...(archivesCurrent ? resetStreamingState() : {}),
          };
        });
        persistTaskTerminalReadLedger(nextLedger);
        persistUnreadTaskKeys(nextUnreadTaskKeys);
        if (isHistorySurfaceActive(get().historySurfaceSelection)) return;
        await get().loadArchivedSessions();
      } catch (err) {
        set({
          error: (err as Error).message,
          errorContext: { kind: 'task_action', sessionRef: ref },
        });
      }
    },

    unarchiveSession: async (ref) => {
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        return;
      }
      try {
        const result = await sessionService.unarchiveSession(ref);
        const restoredIds = new Set(result.restoredSessionIds);
        set((state) => {
          const revision = (state.catalogOverlayRevision ?? 0) + 1;
          const key = sessionRefKey(sessionRefFromSession(result.session));
          return {
            archivedSessions: state.archivedSessions.filter(
              (session) =>
                session.projectPath !== ref.projectPath ||
                !restoredIds.has(session.sessionId)
            ),
            sessions: upsertSessionByRef(state.sessions, result.session),
            catalogOverlayRevision: revision,
            sessionCatalogOverlays: {
              ...state.sessionCatalogOverlays,
              [key]: { revision, kind: 'upsert', session: result.session },
            },
          };
        });
        if (isHistorySurfaceActive(get().historySurfaceSelection)) return;
        await Promise.all([get().loadSessions(), get().loadArchivedSessions()]);
      } catch (err) {
        set({
          error: (err as Error).message,
          errorContext: { kind: 'task_action', sessionRef: ref },
        });
      }
    },

    deleteSession: async (ref) => {
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        return;
      }
      const initialState = get();
      const wasCurrent = sameSessionRef(initialState.currentSessionRef, ref);
      const cancelsFork = sameSessionRef(initialState.forkingSessionRef, ref);
      const invalidationGeneration =
        wasCurrent || cancelsFork ? beginNavigation() : null;
      const generation = wasCurrent ? invalidationGeneration : null;
      if (cancelsFork) {
        set({ forkingSessionRef: null });
      }
      try {
        await sessionService.deleteSession(ref);
        const state = get();
        const shouldClearCurrent =
          sameSessionRef(state.currentSessionRef, ref) &&
          (generation === null || isCurrentNavigation(generation));
        if (shouldClearCurrent) {
          beginNavigation();
          state.unsubscribeFromEvents();
        }
        const key = sessionRefKey(ref);
        let nextUnreadTaskKeys = state.unreadTaskKeys;
        let nextLedger = taskTerminalReadLedger(state.taskTerminalReadLedger);
        set((currentState) => {
          const revision = (currentState.catalogOverlayRevision ?? 0) + 1;
          nextUnreadTaskKeys = currentState.unreadTaskKeys.filter(
            (candidate) => candidate !== key
          );
          nextLedger = {
            version: 1,
            entries: taskTerminalReadLedger(
              currentState.taskTerminalReadLedger
            ).entries.filter((entry) => entry.key !== key),
          };
          return {
            sessions: removeSessionByRef(currentState.sessions, ref),
            unreadTaskKeys: nextUnreadTaskKeys,
            taskTerminalReadLedger: nextLedger,
            catalogOverlayRevision: revision,
            sessionCatalogOverlays: {
              ...currentState.sessionCatalogOverlays,
              [key]: { revision, kind: 'remove' },
            },
            currentSessionId: shouldClearCurrent ? null : currentState.currentSessionId,
            currentSessionRef: shouldClearCurrent
              ? null
              : currentState.currentSessionRef,
            messages: shouldClearCurrent ? [] : currentState.messages,
            goal: shouldClearCurrent ? null : currentState.goal,
            ...(shouldClearCurrent ? resetStreamingState() : {}),
          };
        });
        persistTaskTerminalReadLedger(nextLedger);
        persistUnreadTaskKeys(nextUnreadTaskKeys);
      } catch (err) {
        if (
          generation !== null &&
          (!isCurrentNavigation(generation) ||
            !sameSessionRef(get().currentSessionRef, ref))
        ) {
          return;
        }
        set({ error: (err as Error).message });
      }
    },

    updateSession: async (ref, title) => {
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        return;
      }
      try {
        await sessionService.updateSession(ref, title);
        set((state) => ({
          sessions: state.sessions.map((session) =>
            session.sessionId === ref.sessionId &&
            session.projectPath === ref.projectPath
              ? { ...session, title }
              : session
          ),
        }));
      } catch (err) {
        set({ error: (err as Error).message });
      }
    },

    forkSession: async (session) => {
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        return;
      }
      const generation = beginNavigation();
      const viewSelection = get().claimViewSelection();
      get().closeHistorySurface();
      const sourceRef = sessionRefFromSession(session);
      set({ forkingSessionRef: sourceRef, isLoading: false, error: null });

      let preparedUnsubscribe: (() => void) | null = null;
      try {
        const forked = await sessionService.forkSession(session);
        const childRef = sessionRefFromSession(forked.session);
        const messages = aggregateMessages(forked.messages);
        set((state) => ({
          sessions: upsertSessionByRef(state.sessions, forked.session),
        }));
        if (
          !isCurrentNavigation(generation) ||
          viewSelection !== get().getViewSelectionVersion()
        )
          return;

        preparedUnsubscribe = await get().prepareEventSubscription(childRef);
        if (
          !isCurrentNavigation(generation) ||
          viewSelection !== get().getViewSelectionVersion()
        ) {
          closePreparedSubscription(preparedUnsubscribe);
          preparedUnsubscribe = null;
          return;
        }

        set({
          currentSessionId: childRef.sessionId,
          currentSessionRef: childRef,
          isTemporarySession: false,
          messages,
          goal: null,
          tokenUsage: { ...initialTokenUsage },
          error: null,
          forkingSessionRef: null,
        });
        get().replaceEventSubscription(preparedUnsubscribe);
        preparedUnsubscribe = null;
      } catch (err) {
        if (preparedUnsubscribe) {
          closePreparedSubscription(preparedUnsubscribe);
        }
        if (
          !isCurrentNavigation(generation) ||
          viewSelection !== get().getViewSelectionVersion()
        )
          return;
        set({
          error: (err as Error).message,
          forkingSessionRef: null,
        });
      }
    },

    rewindSession: async (targetMessageId, mode) => {
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        return false;
      }
      const { currentSessionRef, isTemporarySession, isStreaming } = get();
      if (!currentSessionRef || isTemporarySession) {
        set({ error: 'No persisted session is available for rewind' });
        return false;
      }
      if (isStreaming) {
        set({ error: 'Stop the active run before rewinding' });
        return false;
      }
      const generation = navigationGeneration;
      try {
        const result = await sessionService.rewindSession(
          currentSessionRef,
          targetMessageId,
          mode
        );
        if (
          !isCurrentNavigation(generation) ||
          !sameSessionRef(get().currentSessionRef, currentSessionRef)
        ) {
          return false;
        }
        const messages = aggregateMessages(result.messages);
        set((state) => ({
          messages,
          tokenUsage: { ...initialTokenUsage },
          error: null,
          currentRunId: null,
          agentPhase: 'idle',
          providerAdmission: null,
          providerCircuit: null,
          providerRetry: null,
          pendingResume: null,
          providerStall: null,
          actionStationarity: null,
          turnRecovery: null,
          pendingSteeringCount: 0,
          pendingInputDelivery: null,
          recoveredSteeringCount: 0,
          pendingSubagentCompletions: {},
          currentAssistantMessageId: null,
          hasToolCalls: false,
          sessions: state.sessions.map((session) =>
            session.sessionId === currentSessionRef.sessionId &&
            session.projectPath === currentSessionRef.projectPath
              ? { ...session, messageCount: messages.length }
              : session
          ),
        }));
        return true;
      } catch (err) {
        if (
          !isCurrentNavigation(generation) ||
          !sameSessionRef(get().currentSessionRef, currentSessionRef)
        ) {
          return false;
        }
        set({ error: (err as Error).message });
        return false;
      }
    },

    sendMessage: async (payload: SendMessagePayload) => {
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        return false;
      }
      const {
        currentSessionId,
        currentSessionRef,
        isTemporarySession,
        isStreaming,
        addSession,
        addMessage,
      } = get();
      const generation = navigationGeneration;
      const originRef = currentSessionRef;
      const originalStreamingState = {
        isStreaming,
        agentPhase: get().agentPhase,
        currentRunId: get().currentRunId,
      };

      let sessionRef = currentSessionRef;
      let sessionId = currentSessionId;
      let expectedRef = originRef;
      let preparedUnsubscribe: (() => void) | null = null;
      let optimisticMessageId: string | null = null;
      const isCurrentSend = (): boolean =>
        isCurrentNavigation(generation) &&
        sameSessionRef(get().currentSessionRef, expectedRef) &&
        !isHistorySurfaceActive(get().historySurfaceSelection);
      const sideCommand = parseSideConversationCommand(payload.content);

      if (sideCommand) {
        if ((payload.attachments?.length ?? 0) > 0) {
          set({ error: 'Side conversations do not accept image attachments' });
          return false;
        }
        if (!sideCommand.question) {
          set({ error: 'Usage: /btw <question>' });
          return false;
        }
        if (isTemporarySession || !sessionRef || !sessionId) {
          set({ error: 'Start or select a Session before using /btw' });
          return false;
        }

        sideConversationController?.abort('side-conversation-replaced');
        const controller = new AbortController();
        sideConversationController = controller;
        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        set({
          sideConversation: {
            requestId,
            sessionRef,
            question: sideCommand.question,
            status: 'loading',
          },
          error: null,
          errorContext: null,
        });
        try {
          const result = await sessionService.askSideQuestion(
            sessionRef,
            sideCommand.question,
            controller.signal
          );
          if (
            controller.signal.aborted ||
            !isCurrentSend() ||
            get().sideConversation?.requestId !== requestId
          ) {
            return false;
          }
          set({
            sideConversation: {
              requestId,
              sessionRef,
              question: sideCommand.question,
              status: 'completed',
              response: result.response,
              durationMs: result.durationMs,
              modelId: result.modelId,
            },
          });
          if (result.usage) {
            get().updateTokenUsage({
              inputTokens: result.usage.promptTokens,
              outputTokens: result.usage.completionTokens,
              totalTokens: result.usage.totalTokens,
              cacheReadTokens: result.usage.cacheReadInputTokens ?? 0,
              cacheWriteTokens: result.usage.cacheCreationInputTokens ?? 0,
              costUsd: result.usage.costUsd,
            });
          }
          return true;
        } catch (error) {
          if (controller.signal.aborted || !isCurrentSend()) return false;
          set({
            sideConversation: {
              requestId,
              sessionRef,
              question: sideCommand.question,
              status: 'error',
              error: error instanceof Error ? error.message : String(error),
            },
          });
          return false;
        } finally {
          if (sideConversationController === controller) {
            sideConversationController = null;
          }
        }
      }

      sideConversationController?.abort('main-conversation-submitted');
      sideConversationController = null;
      set({ sideConversation: null, pendingResume: null });

      if (isTemporarySession || !sessionId || sessionId === TEMP_SESSION_ID) {
        try {
          const derivedTitle = deriveSessionTitle(payload.content);
          const session = await sessionService.createSession(
            get().selectedProjectPath ?? get().taskWorkspaceInfo?.cwd ?? undefined,
            derivedTitle || undefined
          );
          addSession(session);
          if (!isCurrentSend()) return false;
          sessionRef = sessionRefFromSession(session);
          sessionId = session.sessionId;
          set({
            currentSessionId: session.sessionId,
            currentSessionRef: sessionRef,
            isTemporarySession: false,
          });
          expectedRef = sessionRef;
        } catch (err) {
          if (!isCurrentSend()) return false;
          set({ error: (err as Error).message });
          return false;
        }
      }

      if (!sessionRef || !sessionId || sessionId === TEMP_SESSION_ID) {
        if (!isCurrentSend()) return false;
        set({ error: 'Failed to create session' });
        return false;
      }

      try {
        if (!isStreaming) {
          preparedUnsubscribe = await get().prepareEventSubscription(sessionRef);
          if (!isCurrentSend()) {
            closePreparedSubscription(preparedUnsubscribe);
            preparedUnsubscribe = null;
            return false;
          }
          get().replaceEventSubscription(preparedUnsubscribe);
          preparedUnsubscribe = null;
        }

        if (!isCurrentSend()) return false;
        const trimmedInput = payload.content.trim();
        if (trimmedInput.startsWith('!')) {
          if ((payload.attachments?.length ?? 0) > 0) {
            throw new Error('User shell commands do not accept image attachments');
          }
          const command = trimmedInput.slice(1).trim();
          if (!command) throw new Error('User shell command cannot be empty');
          if (!isStreaming) {
            set({
              isStreaming: true,
              agentPhase: 'running',
              error: null,
              errorContext: null,
            });
          }
          const response = await sessionService.executeUserShellCommand(
            sessionRef,
            command
          );
          if (!isCurrentSend()) return false;
          if (!response.auxiliary) {
            set({
              isStreaming: false,
              agentPhase: 'idle',
              pendingResume: null,
            });
          }
          if (response.delivery) {
            set({
              pendingSteeringCount: response.queued ?? 0,
              pendingInputDelivery:
                response.delivery === 'current_turn' ? 'current_turn' : 'next_turn',
            });
          }
          return true;
        }
        if (
          (payload.attachments?.length ?? 0) === 0 &&
          (trimmedInput === '/goal' || trimmedInput.startsWith('/goal '))
        ) {
          optimisticMessageId = `goal-command-${Date.now()}`;
          addMessage({
            id: optimisticMessageId,
            role: 'user',
            content: trimmedInput,
            timestamp: Date.now(),
          });
          const args = trimmedInput
            .slice('/goal'.length)
            .trim()
            .split(/\s+/)
            .filter(Boolean);
          const subcommand = args[0]?.toLowerCase();
          if (!subcommand || subcommand === 'status') {
            const goal = await sessionService.getGoal(sessionRef);
            if (isCurrentSend()) set({ goal });
            return isCurrentSend();
          }
          if (subcommand === 'clear') {
            await sessionService.clearGoal(sessionRef);
            if (isCurrentSend()) set({ goal: null });
            return isCurrentSend();
          }

          let response;
          if (subcommand === 'pause') {
            response = await sessionService.updateGoal(sessionRef, {
              action: 'pause',
            });
          } else if (subcommand === 'resume') {
            response = await sessionService.updateGoal(sessionRef, {
              action: 'resume',
            });
          } else if (subcommand === 'edit') {
            const objective = args.slice(1).join(' ').trim();
            if (!objective) throw new Error('Usage: /goal edit <objective>');
            response = await sessionService.updateGoal(sessionRef, {
              action: 'edit',
              objective,
            });
          } else {
            const budgetIndex = args.lastIndexOf('--budget');
            let tokenBudget: number | undefined;
            if (budgetIndex >= 0) {
              const rawBudget = args[budgetIndex + 1];
              if (!rawBudget || !/^[1-9]\d*$/.test(rawBudget)) {
                throw new Error('--budget requires a positive integer');
              }
              tokenBudget = Number(rawBudget);
              args.splice(budgetIndex, 2);
            }
            const objective = args.join(' ').trim();
            if (!objective) throw new Error('Usage: /goal <objective>');
            const { currentMode } = useConfigStore.getState();
            response = await sessionService.createGoal(
              sessionRef,
              objective,
              tokenBudget,
              currentMode
            );
          }

          if (!isCurrentSend()) return false;
          set({
            goal: response.goal,
            ...(response.runId
              ? {
                  currentRunId: response.runId,
                  isStreaming: true,
                  agentPhase: 'running' as const,
                }
              : {}),
          });
          return true;
        }

        optimisticMessageId = `temp-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`;
        addMessage({
          id: optimisticMessageId,
          role: 'user',
          content: buildOptimisticUserContent(payload),
          timestamp: Date.now(),
        });

        set({
          isStreaming: true,
          error: null,
          errorContext: null,
          recoveredSteeringCount: isStreaming ? get().recoveredSteeringCount : 0,
        });

        const { currentMode, currentModelId } = useConfigStore.getState();
        const { modelId: payloadModelId, ...payloadWithoutModel } = payload;
        const selectedModelId = payloadModelId ?? currentModelId ?? undefined;
        const selectedReasoningEffort = payload.reasoningEffort;
        const selectedServiceTier = payload.serviceTier;
        const selectedResponseVerbosity = payload.responseVerbosity;
        const selectedCommunicationStyle = payload.communicationStyle;
        const requestPayload =
          selectedModelId && !isStreaming
            ? { ...payloadWithoutModel, modelId: selectedModelId }
            : payloadWithoutModel;
        const response = await sessionService.sendMessage(
          sessionRef,
          requestPayload,
          currentMode
        );
        if (!isCurrentSend()) return false;
        set({
          currentRunId: response.runId,
          pendingSteeringCount:
            response.status === 'steering_queued' ||
            response.status === 'follow_up_queued'
              ? Math.max(0, response.queued ?? 1)
              : get().pendingSteeringCount,
          pendingInputDelivery:
            response.status === 'steering_queued'
              ? 'current_turn'
              : response.status === 'follow_up_queued'
                ? 'next_turn'
                : get().pendingInputDelivery,
          sessions:
            (selectedModelId ||
              selectedReasoningEffort ||
              selectedServiceTier ||
              selectedResponseVerbosity ||
              selectedCommunicationStyle) &&
            !isStreaming
              ? get().sessions.map((session) =>
                  session.sessionId === sessionRef.sessionId &&
                  session.projectPath === sessionRef.projectPath
                    ? {
                        ...session,
                        ...(selectedModelId ? { selectedModelId } : {}),
                        ...(selectedReasoningEffort
                          ? { reasoningEffort: selectedReasoningEffort }
                          : {}),
                        ...(selectedServiceTier
                          ? { serviceTier: selectedServiceTier }
                          : {}),
                        ...(selectedResponseVerbosity
                          ? { responseVerbosity: selectedResponseVerbosity }
                          : {}),
                        ...(selectedCommunicationStyle
                          ? { communicationStyle: selectedCommunicationStyle }
                          : {}),
                      }
                    : session
                )
              : get().sessions,
        });
        return true;
      } catch (err) {
        if (preparedUnsubscribe) {
          closePreparedSubscription(preparedUnsubscribe);
        }
        if (!isCurrentSend()) return false;
        if (
          optimisticMessageId &&
          !get().messages.some((message) => message.id === optimisticMessageId) &&
          !isHttpResponseError(err)
        ) {
          return true;
        }
        const failureCode =
          isHttpResponseError(err) && err.code === 'SESSION_WORKSPACE_UNAVAILABLE'
            ? 'workspace_unavailable'
            : undefined;
        set((state) => ({
          error: (err as Error).message,
          errorContext: {
            kind: 'submission',
            sessionRef,
            ...(failureCode ? { failureCode } : {}),
          },
          messages: optimisticMessageId
            ? state.messages.filter((message) => message.id !== optimisticMessageId)
            : state.messages,
          ...originalStreamingState,
        }));
        return false;
      }
    },

    dismissSideConversation: () => {
      sideConversationController?.abort('side-conversation-dismissed');
      sideConversationController = null;
      set({ sideConversation: null });
    },

    loadTeams: async (ref) => {
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        return;
      }
      const target = ref ?? get().currentSessionRef;
      if (!target || !useSettingsStore.getState().agentTeamsEnabled) {
        set({ teams: [] });
        return;
      }
      const key = sessionRefKey(target);
      const existing = teamLoads.get(key);
      if (existing) return existing;
      let load!: Promise<void>;
      load = (async () => {
        try {
          const teams = await fetchTeams(target);
          if (!sameSessionRef(get().currentSessionRef, target)) return;
          set({ teams });
        } catch {
          if (sameSessionRef(get().currentSessionRef, target)) set({ teams: [] });
        } finally {
          if (teamLoads.get(key) === load) teamLoads.delete(key);
        }
      })();
      teamLoads.set(key, load);
      await load;
    },

    abortSession: async () => {
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        return false;
      }
      const { currentSessionRef, isStopping } = get();
      if (!currentSessionRef || isStopping) return false;

      set({ isStopping: true, error: null, errorContext: null });
      try {
        await sessionService.abortSession(currentSessionRef);
        if (!sameSessionRef(get().currentSessionRef, currentSessionRef)) return false;
        await get().resyncSessionMessages(currentSessionRef);
        if (!sameSessionRef(get().currentSessionRef, currentSessionRef)) return false;
        get().unsubscribeFromEvents();
        set({
          isStreaming: false,
          isStopping: false,
          agentPhase: 'idle',
          providerAdmission: null,
          providerCircuit: null,
          providerRetry: null,
          pendingResume: null,
          providerStall: null,
          actionStationarity: null,
          turnRecovery: null,
          currentRunId: null,
          pendingSteeringCount: 0,
          pendingInputDelivery: null,
          recoveredSteeringCount: 0,
          pendingSubagentCompletions: {},
          currentAssistantMessageId: null,
          hasToolCalls: false,
        });
        return true;
      } catch (error) {
        if (!sameSessionRef(get().currentSessionRef, currentSessionRef)) return false;
        set({
          isStopping: false,
          error: error instanceof Error ? error.message : 'Failed to stop task',
          errorContext: { kind: 'task_action', sessionRef: currentSessionRef },
        });
        return false;
      }
    },

    pauseGoal: async () => {
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        return;
      }
      const { currentSessionRef, isTemporarySession } = get();
      if (!currentSessionRef || isTemporarySession) {
        set({ error: 'No persisted session is available for this goal' });
        return;
      }
      try {
        const response = await sessionService.updateGoal(currentSessionRef, {
          action: 'pause',
        });
        if (!sameSessionRef(get().currentSessionRef, currentSessionRef)) return;
        set({ goal: response.goal, error: null });
      } catch (err) {
        if (!sameSessionRef(get().currentSessionRef, currentSessionRef)) return;
        set({ error: (err as Error).message });
      }
    },

    resumeGoal: async () => {
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        return;
      }
      const { currentSessionRef, isTemporarySession } = get();
      if (!currentSessionRef || isTemporarySession) {
        set({ error: 'No persisted session is available for this goal' });
        return;
      }
      try {
        const response = await sessionService.updateGoal(currentSessionRef, {
          action: 'resume',
        });
        if (!sameSessionRef(get().currentSessionRef, currentSessionRef)) return;
        set({
          goal: response.goal,
          error: null,
          ...(response.runId
            ? {
                currentRunId: response.runId,
                isStreaming: true,
                agentPhase: 'running' as const,
              }
            : {}),
        });
      } catch (err) {
        if (!sameSessionRef(get().currentSessionRef, currentSessionRef)) return;
        set({ error: (err as Error).message });
      }
    },

    editGoal: async (objective: string) => {
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        return;
      }
      const { currentSessionRef, isTemporarySession } = get();
      if (!currentSessionRef || isTemporarySession) {
        set({ error: 'No persisted session is available for this goal' });
        return;
      }
      try {
        const response = await sessionService.updateGoal(currentSessionRef, {
          action: 'edit',
          objective,
        });
        if (!sameSessionRef(get().currentSessionRef, currentSessionRef)) return;
        set({
          goal: response.goal,
          error: null,
          ...(response.runId
            ? {
                currentRunId: response.runId,
                isStreaming: true,
                agentPhase: 'running' as const,
              }
            : {}),
        });
      } catch (err) {
        if (!sameSessionRef(get().currentSessionRef, currentSessionRef)) return;
        set({ error: (err as Error).message });
      }
    },

    clearGoal: async () => {
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        return;
      }
      const { currentSessionRef, isTemporarySession } = get();
      if (!currentSessionRef || isTemporarySession) {
        set({ error: 'No persisted session is available for this goal' });
        return;
      }
      try {
        await sessionService.clearGoal(currentSessionRef);
        if (!sameSessionRef(get().currentSessionRef, currentSessionRef)) return;
        set({ goal: null, error: null });
      } catch (err) {
        if (!sameSessionRef(get().currentSessionRef, currentSessionRef)) return;
        set({ error: (err as Error).message });
      }
    },
  };
};
