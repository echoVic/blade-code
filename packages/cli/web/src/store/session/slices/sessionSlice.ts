import { sessionService } from '@/services';
import { useConfigStore } from '@/store/ConfigStore';
import { initialTokenUsage, TEMP_SESSION_ID } from '../constants';
import {
  removeSessionByRef,
  sameSessionRef,
  sessionRefFromSession,
  upsertSessionByRef,
} from '../sessionIdentity';
import type {
  MessageContentPart,
  SendMessagePayload,
  SessionSlice,
  SliceCreator,
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
  isStreaming: false,
  agentPhase: 'idle' as const,
  currentRunId: null,
  pendingSteeringCount: 0,
  recoveredSteeringCount: 0,
  currentAssistantMessageId: null,
  hasToolCalls: false,
});

export const createSessionSlice: SliceCreator<SessionSlice> = (set, get) => {
  let navigationGeneration = 0;

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
    currentSessionId: null,
    currentSessionRef: null,
    forkingSessionRef: null,
    isTemporarySession: false,
    isLoading: false,
    error: null,

    setSessions: (sessions) => set({ sessions }),

    addSession: (session) =>
      set((state) => ({
        sessions: upsertSessionByRef(state.sessions, session),
      })),

    removeSession: (ref) => {
      const state = get();
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

    setError: (error) => set({ error }),

    clearError: () => set({ error: null }),

    startTemporarySession: () => {
      beginNavigation();
      get().unsubscribeFromEvents();
      set({
        currentSessionId: TEMP_SESSION_ID,
        currentSessionRef: null,
        isTemporarySession: true,
        forkingSessionRef: null,
        isLoading: false,
        messages: [],
        tokenUsage: { ...initialTokenUsage },
        error: null,
        ...resetStreamingState(),
      });
    },

    loadSessions: async () => {
      set({ isLoading: true, error: null });
      try {
        const sessions = await sessionService.listSessions();
        set({ sessions, isLoading: false });
      } catch (err) {
        set({ error: (err as Error).message, isLoading: false });
      }
    },

    selectSession: async (ref) => {
      const generation = beginNavigation();
      set({ isLoading: true, error: null, forkingSessionRef: null });
      try {
        const rawMessages = await sessionService.getMessages(ref);
        if (!isCurrentNavigation(generation)) return;
        const messages = aggregateMessages(rawMessages);
        const unsubscribe = await get().prepareEventSubscription(ref);
        if (!isCurrentNavigation(generation)) {
          closePreparedSubscription(unsubscribe);
          return;
        }
        set({
          currentSessionId: ref.sessionId,
          currentSessionRef: ref,
          isTemporarySession: false,
          messages,
          isLoading: false,
          tokenUsage: { ...initialTokenUsage },
        });
        get().replaceEventSubscription(unsubscribe);
      } catch (err) {
        if (!isCurrentNavigation(generation)) return;
        set({ error: (err as Error).message, isLoading: false });
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

      let sessionRef = currentSessionRef;
      let sessionId = currentSessionId;
      let expectedRef = originRef;
      let preparedUnsubscribe: (() => void) | null = null;
      const isCurrentSend = (): boolean =>
        isCurrentNavigation(generation) &&
        sameSessionRef(get().currentSessionRef, expectedRef);

      if (isTemporarySession || !sessionId || sessionId === TEMP_SESSION_ID) {
        try {
          const session = await sessionService.createSession();
          addSession(session);
          if (!isCurrentSend()) return;
          sessionRef = sessionRefFromSession(session);
          sessionId = session.sessionId;
          set({
            currentSessionId: session.sessionId,
            currentSessionRef: sessionRef,
            isTemporarySession: false,
          });
          expectedRef = sessionRef;
        } catch (err) {
          if (!isCurrentSend()) return;
          set({ error: (err as Error).message });
          return;
        }
      }

      if (!sessionRef || !sessionId || sessionId === TEMP_SESSION_ID) {
        if (!isCurrentSend()) return;
        set({ error: 'Failed to create session' });
        return;
      }

      try {
        if (!isStreaming) {
          preparedUnsubscribe = await get().prepareEventSubscription(sessionRef);
          if (!isCurrentSend()) {
            closePreparedSubscription(preparedUnsubscribe);
            preparedUnsubscribe = null;
            return;
          }
          get().replaceEventSubscription(preparedUnsubscribe);
          preparedUnsubscribe = null;
        }

        if (!isCurrentSend()) return;
        addMessage({
          id: `temp-${Date.now()}`,
          role: 'user',
          content: buildOptimisticUserContent(payload),
          timestamp: Date.now(),
        });

        set({
          isStreaming: true,
          error: null,
          recoveredSteeringCount: isStreaming ? get().recoveredSteeringCount : 0,
        });

        const { currentMode } = useConfigStore.getState();
        const response = await sessionService.sendMessage(
          sessionRef,
          payload,
          currentMode
        );
        if (!isCurrentSend()) return;
        set({
          currentRunId: response.runId,
          pendingSteeringCount:
            response.status === 'steering_queued' ||
            response.status === 'follow_up_queued'
              ? Math.max(0, response.queued ?? 1)
              : get().pendingSteeringCount,
        });
      } catch (err) {
        if (preparedUnsubscribe) {
          closePreparedSubscription(preparedUnsubscribe);
        }
        if (!isCurrentSend()) return;
        set({ error: (err as Error).message, isStreaming: false });
      }
    },

    abortSession: async () => {
      const { currentSessionRef, unsubscribeFromEvents } = get();

      unsubscribeFromEvents();
      set({
        isStreaming: false,
        currentRunId: null,
        pendingSteeringCount: 0,
      });

      if (currentSessionRef) {
        try {
          await sessionService.abortSession(currentSessionRef);
        } catch {
          // Ignore abort errors
        }
      }
    },
  };
};
