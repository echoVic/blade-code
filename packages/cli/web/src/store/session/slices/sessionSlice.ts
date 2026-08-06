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
    goal: null,

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

    setError: (error) => set({ error }),

    clearError: () => set({ error: null }),

    setGoal: (goal) => set({ goal }),

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
        goal: null,
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
        const [rawMessages, goal] = await Promise.all([
          sessionService.getMessages(ref),
          sessionService.getGoal(ref).catch(() => null),
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
        set({
          currentSessionId: ref.sessionId,
          currentSessionRef: ref,
          isTemporarySession: false,
          messages,
          goal,
          isLoading: false,
          tokenUsage: { ...initialTokenUsage },
        });
        subscriptionCommitted = true;
        get().replaceEventSubscription(unsubscribe);
        for (const event of pendingEvents) {
          get().handleEvent(event);
        }
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
        const trimmedInput = payload.content.trim();
        if (
          (payload.attachments?.length ?? 0) === 0 &&
          (trimmedInput === '/goal' || trimmedInput.startsWith('/goal '))
        ) {
          addMessage({
            id: `goal-command-${Date.now()}`,
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
            return;
          }
          if (subcommand === 'clear') {
            await sessionService.clearGoal(sessionRef);
            if (isCurrentSend()) set({ goal: null });
            return;
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

          if (!isCurrentSend()) return;
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
          return;
        }

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
