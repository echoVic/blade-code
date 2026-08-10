import { deriveSessionTitle } from '@api/sessionTitle';
import { projectPathOf } from '@/lib/projectIdentity';
import { sessionService } from '@/services';
import { DEFAULT_WEB_PERMISSION_MODE, useConfigStore } from '@/store/ConfigStore';
import { initialTokenUsage, TEMP_SESSION_ID } from '../constants';
import {
  findSessionByRef,
  removeSessionByRef,
  sameSessionRef,
  sessionRefFromSession,
  sessionRefKey,
  upsertSessionByRef,
} from '../sessionIdentity';
import { persistUnreadTaskKeys, pruneUnreadTaskKeys } from '../taskAttention';
import type {
  MessageContentPart,
  SendMessagePayload,
  SessionSlice,
  SliceCreator,
  StreamEvent,
} from '../types';
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

const resetStreamingState = () => ({
  eventUnsubscribe: null,
  sessionEventConnectionState: 'idle' as const,
  isStreaming: false,
  isStopping: false,
  agentPhase: 'idle' as const,
  currentRunId: null,
  pendingSteeringCount: 0,
  pendingInputDelivery: null,
  recoveredSteeringCount: 0,
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

export const createSessionSlice: SliceCreator<SessionSlice> = (set, get) => {
  let navigationGeneration = 0;
  let catalogGeneration = 0;
  let archivedCatalogGeneration = 0;

  const beginNavigation = (): number => {
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

    setSessions: (sessions) => set({ sessions }),

    addSession: (session) =>
      set((state) => ({
        sessions: upsertSessionByRef(state.sessions, session),
      })),

    removeSession: (ref) => {
      const state = get();
      state.markTaskRead(ref);
      const isCurrent = sameSessionRef(state.currentSessionRef, ref);
      const cancelsFork = sameSessionRef(state.forkingSessionRef, ref);
      if (isCurrent || cancelsFork) {
        beginNavigation();
      }
      if (isCurrent) {
        state.unsubscribeFromEvents();
      }
      set((currentState) => {
        return {
          sessions: removeSessionByRef(currentState.sessions, ref),
          currentSessionId: isCurrent ? null : currentState.currentSessionId,
          currentSessionRef: isCurrent ? null : currentState.currentSessionRef,
          messages: isCurrent ? [] : currentState.messages,
          goal: isCurrent ? null : currentState.goal,
          forkingSessionRef: cancelsFork ? null : currentState.forkingSessionRef,
          ...(isCurrent ? resetStreamingState() : {}),
        };
      });
    },

    setCurrentSession: (ref) => {
      beginNavigation();
      set({
        currentSessionId: ref?.sessionId ?? null,
        currentSessionRef: ref,
        isTemporarySession: false,
      });
    },

    setTemporarySession: (isTemp) => set({ isTemporarySession: isTemp }),

    setLoading: (loading) => set({ isLoading: loading }),

    setError: (error) => set({ error, errorContext: null }),

    getNavigationVersion: () => navigationGeneration,

    clearError: () => set({ error: null, errorContext: null }),

    setGoal: (goal) => set({ goal }),

    startTemporarySession: (projectPath) => {
      beginNavigation();
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
        tokenUsage: { ...initialTokenUsage },
        error: null,
        errorContext: null,
        ...resetStreamingState(),
      });
    },

    loadSessions: async () => {
      const generation = ++catalogGeneration;
      const initialSessionKeys = new Set(
        get().sessions.map((session) => sessionRefKey(sessionRefFromSession(session)))
      );
      const catalogSessionKeys = new Set<string>();
      set({ catalogLoadState: 'loading', catalogError: null });
      try {
        let cursor: string | undefined;
        let firstPage = true;
        do {
          const page = await sessionService.listSessionPage(cursor);
          if (generation !== catalogGeneration) return;
          for (const session of page.sessions) {
            catalogSessionKeys.add(sessionRefKey(sessionRefFromSession(session)));
          }
          set((state) => {
            const incomingKeys = new Set(
              page.sessions.map((session) =>
                sessionRefKey(sessionRefFromSession(session))
              )
            );
            const sessions = firstPage
              ? [
                  ...page.sessions,
                  ...state.sessions.filter(
                    (session) =>
                      !incomingKeys.has(sessionRefKey(sessionRefFromSession(session)))
                  ),
                ]
              : page.sessions.reduce(
                  (current, session) => upsertSessionByRef(current, session),
                  state.sessions
                );
            return {
              sessions,
              catalogLoadState: page.nextCursor ? 'hydrating' : 'ready',
            };
          });
          firstPage = false;
          cursor = page.nextCursor;
          if (cursor) {
            await waitForCatalogContinuation();
            if (generation !== catalogGeneration) return;
          }
        } while (cursor);

        if (generation !== catalogGeneration) return;
        const sessions = get().sessions.filter((session) => {
          const key = sessionRefKey(sessionRefFromSession(session));
          return catalogSessionKeys.has(key) || !initialSessionKeys.has(key);
        });
        const unreadTaskKeys = pruneUnreadTaskKeys(get().unreadTaskKeys, sessions);
        persistUnreadTaskKeys(unreadTaskKeys);
        set({
          sessions,
          unreadTaskKeys,
          catalogLoadState: 'ready',
          catalogError: null,
        });
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
      set({
        isLoading: true,
        error: null,
        errorContext: null,
        forkingSessionRef: null,
      });
      try {
        const existingSession = findSessionByRef(get().sessions, ref);
        const [rawMessages, goal, exactSession] = await Promise.all([
          sessionService.getMessages(ref),
          sessionService.getGoal(ref).catch(() => null),
          existingSession
            ? Promise.resolve(existingSession)
            : sessionService.getSession(ref),
        ]);
        if (!isCurrentNavigation(generation)) return;
        const messages = aggregateMessages(rawMessages);
        const pendingEvents: StreamEvent[] = [];
        let subscriptionCommitted = false;
        const unsubscribe = await get().prepareEventSubscription(ref, (event) => {
          if (subscriptionCommitted) {
            get().handleEvent(event);
          } else {
            pendingEvents.push(event);
          }
        });
        if (!isCurrentNavigation(generation)) {
          closePreparedSubscription(unsubscribe);
          return;
        }
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
          isLoading: false,
          tokenUsage: { ...initialTokenUsage },
          isStreaming: false,
          isStopping: false,
          agentPhase: 'idle',
          currentRunId: null,
          pendingSteeringCount: 0,
          pendingInputDelivery: null,
          recoveredSteeringCount: 0,
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
        get().replaceEventSubscription(unsubscribe);
        for (const event of pendingEvents) {
          get().handleEvent(event);
        }
      } catch (err) {
        if (!isCurrentNavigation(generation)) return;
        set({
          error: (err as Error).message,
          errorContext: { kind: 'navigation', sessionRef: ref },
          isLoading: false,
        });
      }
    },

    archiveSession: async (ref) => {
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
        set((currentState) => {
          const sessions = currentState.sessions.filter(
            (session) =>
              session.projectPath !== ref.projectPath ||
              !archivedIds.has(session.sessionId)
          );
          const unreadTaskKeys = pruneUnreadTaskKeys(
            currentState.unreadTaskKeys,
            sessions
          );
          persistUnreadTaskKeys(unreadTaskKeys);
          return {
            sessions,
            archivedSessions: upsertSessionByRef(
              currentState.archivedSessions,
              result.session
            ),
            unreadTaskKeys,
            currentSessionId: archivesCurrent ? null : currentState.currentSessionId,
            currentSessionRef: archivesCurrent ? null : currentState.currentSessionRef,
            messages: archivesCurrent ? [] : currentState.messages,
            goal: archivesCurrent ? null : currentState.goal,
            ...(archivesCurrent ? resetStreamingState() : {}),
          };
        });
        await get().loadArchivedSessions();
      } catch (err) {
        set({
          error: (err as Error).message,
          errorContext: { kind: 'task_action', sessionRef: ref },
        });
      }
    },

    unarchiveSession: async (ref) => {
      try {
        const result = await sessionService.unarchiveSession(ref);
        const restoredIds = new Set(result.restoredSessionIds);
        set((state) => ({
          archivedSessions: state.archivedSessions.filter(
            (session) =>
              session.projectPath !== ref.projectPath ||
              !restoredIds.has(session.sessionId)
          ),
          sessions: upsertSessionByRef(state.sessions, result.session),
        }));
        await Promise.all([get().loadSessions(), get().loadArchivedSessions()]);
      } catch (err) {
        set({
          error: (err as Error).message,
          errorContext: { kind: 'task_action', sessionRef: ref },
        });
      }
    },

    deleteSession: async (ref) => {
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
        get().markTaskRead(ref);
        const state = get();
        const shouldClearCurrent =
          sameSessionRef(state.currentSessionRef, ref) &&
          (generation === null || isCurrentNavigation(generation));
        if (shouldClearCurrent) {
          beginNavigation();
          state.unsubscribeFromEvents();
        }
        set((state) => ({
          sessions: removeSessionByRef(state.sessions, ref),
          currentSessionId: shouldClearCurrent ? null : state.currentSessionId,
          currentSessionRef: shouldClearCurrent ? null : state.currentSessionRef,
          messages: shouldClearCurrent ? [] : state.messages,
          goal: shouldClearCurrent ? null : state.goal,
          ...(shouldClearCurrent ? resetStreamingState() : {}),
        }));
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
      const generation = beginNavigation();
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
        if (!isCurrentNavigation(generation)) return;

        preparedUnsubscribe = await get().prepareEventSubscription(childRef);
        if (!isCurrentNavigation(generation)) {
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
        if (!isCurrentNavigation(generation)) return;
        set({
          error: (err as Error).message,
          forkingSessionRef: null,
        });
      }
    },

    rewindSession: async (targetMessageId, mode) => {
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
          pendingSteeringCount: 0,
          pendingInputDelivery: null,
          recoveredSteeringCount: 0,
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
        sameSessionRef(get().currentSessionRef, expectedRef);

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
          !get().messages.some((message) => message.id === optimisticMessageId)
        ) {
          return true;
        }
        set((state) => ({
          error: (err as Error).message,
          errorContext: { kind: 'submission', sessionRef },
          messages: optimisticMessageId
            ? state.messages.filter((message) => message.id !== optimisticMessageId)
            : state.messages,
          ...originalStreamingState,
        }));
        return false;
      }
    },

    abortSession: async () => {
      const { currentSessionRef, isStopping } = get();
      if (!currentSessionRef || isStopping) return false;

      set({ isStopping: true, error: null, errorContext: null });
      try {
        await sessionService.abortSession(currentSessionRef);
        if (!sameSessionRef(get().currentSessionRef, currentSessionRef)) return false;
        get().unsubscribeFromEvents();
        set({
          isStreaming: false,
          isStopping: false,
          agentPhase: 'idle',
          currentRunId: null,
          pendingSteeringCount: 0,
          pendingInputDelivery: null,
          recoveredSteeringCount: 0,
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
