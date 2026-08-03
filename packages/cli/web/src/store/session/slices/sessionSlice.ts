import { sessionService } from '@/services';
import { useConfigStore } from '@/store/ConfigStore';
import { initialTokenUsage, TEMP_SESSION_ID } from '../constants';
import {
  removeSessionByRef,
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

export const createSessionSlice: SliceCreator<SessionSlice> = (set, get) => ({
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

  removeSession: (ref) =>
    set((state) => {
      const isCurrent =
        state.currentSessionRef?.sessionId === ref.sessionId &&
        state.currentSessionRef?.projectPath === ref.projectPath;
      return {
        sessions: removeSessionByRef(state.sessions, ref),
        currentSessionId: isCurrent ? null : state.currentSessionId,
        currentSessionRef: isCurrent ? null : state.currentSessionRef,
        messages: isCurrent ? [] : state.messages,
      };
    }),

  setCurrentSession: (ref) =>
    set({
      currentSessionId: ref?.sessionId ?? null,
      currentSessionRef: ref,
      isTemporarySession: false,
    }),

  setTemporarySession: (isTemp) => set({ isTemporarySession: isTemp }),

  setLoading: (loading) => set({ isLoading: loading }),

  setError: (error) => set({ error }),

  clearError: () => set({ error: null }),

  startTemporarySession: () =>
    set({
      currentSessionId: TEMP_SESSION_ID,
      currentSessionRef: null,
      isTemporarySession: true,
      messages: [],
      tokenUsage: { ...initialTokenUsage },
      error: null,
    }),

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
    set({ isLoading: true, error: null });
    try {
      const rawMessages = await sessionService.getMessages(ref);
      const messages = aggregateMessages(rawMessages);
      const unsubscribe = await get().prepareEventSubscription(ref);
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
      set({ error: (err as Error).message, isLoading: false });
    }
  },

  deleteSession: async (ref) => {
    try {
      await sessionService.deleteSession(ref);
      set((state) => ({
        sessions: removeSessionByRef(state.sessions, ref),
        currentSessionId:
          state.currentSessionRef?.sessionId === ref.sessionId &&
          state.currentSessionRef?.projectPath === ref.projectPath
            ? null
            : state.currentSessionId,
        currentSessionRef:
          state.currentSessionRef?.sessionId === ref.sessionId &&
          state.currentSessionRef?.projectPath === ref.projectPath
            ? null
            : state.currentSessionRef,
        messages:
          state.currentSessionRef?.sessionId === ref.sessionId &&
          state.currentSessionRef?.projectPath === ref.projectPath
            ? []
            : state.messages,
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  updateSession: async (ref, title) => {
    try {
      await sessionService.updateSession(ref, title);
      set((state) => ({
        sessions: state.sessions.map((session) =>
          session.sessionId === ref.sessionId && session.projectPath === ref.projectPath
            ? { ...session, title }
            : session
        ),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  forkSession: async (session) => {
    const sourceRef = sessionRefFromSession(session);
    set({ forkingSessionRef: sourceRef, error: null });

    let preparedUnsubscribe: (() => void) | null = null;
    try {
      const forked = await sessionService.forkSession(session);
      const childRef = sessionRefFromSession(forked.session);
      const messages = aggregateMessages(forked.messages);
      preparedUnsubscribe = await get().prepareEventSubscription(childRef);

      set((state) => ({
        sessions: upsertSessionByRef(
          upsertSessionByRef(state.sessions, session),
          forked.session
        ),
        currentSessionId: childRef.sessionId,
        currentSessionRef: childRef,
        isTemporarySession: false,
        messages,
        tokenUsage: { ...initialTokenUsage },
        error: null,
        forkingSessionRef: null,
      }));
      get().replaceEventSubscription(preparedUnsubscribe);
      preparedUnsubscribe = null;
    } catch (err) {
      preparedUnsubscribe?.();
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
      subscribeToEvents,
      addSession,
      addMessage,
    } = get();

    let sessionRef = currentSessionRef;
    let sessionId = currentSessionId;

    if (isTemporarySession || !sessionId || sessionId === TEMP_SESSION_ID) {
      try {
        const session = await sessionService.createSession();
        addSession(session);
        sessionRef = sessionRefFromSession(session);
        sessionId = session.sessionId;
        set({
          currentSessionId: session.sessionId,
          currentSessionRef: sessionRef,
          isTemporarySession: false,
        });
      } catch (err) {
        set({ error: (err as Error).message });
        return;
      }
    }

    if (!sessionRef || !sessionId || sessionId === TEMP_SESSION_ID) {
      set({ error: 'Failed to create session' });
      return;
    }

    try {
      if (!isStreaming) {
        await subscribeToEvents(sessionRef);
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
      set({
        currentRunId: response.runId,
        pendingSteeringCount:
          response.status === 'steering_queued' ||
          response.status === 'follow_up_queued'
            ? Math.max(0, response.queued ?? 1)
            : get().pendingSteeringCount,
      });
    } catch (err) {
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
});
