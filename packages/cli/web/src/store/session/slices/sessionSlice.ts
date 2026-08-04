import { sessionService } from '@/services';
import { useConfigStore } from '@/store/ConfigStore';
import { initialTokenUsage, TEMP_SESSION_ID } from '../constants';
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
  isTemporarySession: false,
  isLoading: false,
  error: null,
  goal: null,

  setSessions: (sessions) => set({ sessions }),

  addSession: (session) =>
    set((state) => ({
      sessions: [...state.sessions, session],
    })),

  removeSession: (sessionId) =>
    set((state) => ({
      sessions: state.sessions.filter((s) => s.sessionId !== sessionId),
      currentSessionId:
        state.currentSessionId === sessionId ? null : state.currentSessionId,
      messages: state.currentSessionId === sessionId ? [] : state.messages,
    })),

  setCurrentSession: (sessionId) =>
    set({
      currentSessionId: sessionId,
      isTemporarySession: false,
    }),

  setTemporarySession: (isTemp) => set({ isTemporarySession: isTemp }),

  setLoading: (loading) => set({ isLoading: loading }),

  setError: (error) => set({ error }),

  clearError: () => set({ error: null }),
  setGoal: (goal) => set({ goal }),

  startTemporarySession: () =>
    set({
      currentSessionId: TEMP_SESSION_ID,
      isTemporarySession: true,
      messages: [],
      tokenUsage: { ...initialTokenUsage },
      error: null,
      goal: null,
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

  selectSession: async (sessionId: string) => {
    set({
      isLoading: true,
      error: null,
      currentSessionId: sessionId,
      isTemporarySession: false,
    });
    try {
      const [rawMessages, goal] = await Promise.all([
        sessionService.getMessages(sessionId),
        sessionService.getGoal(sessionId).catch(() => null),
      ]);
      const messages = aggregateMessages(rawMessages);
      set({
        messages,
        goal,
        isLoading: false,
        tokenUsage: { ...initialTokenUsage },
      });
      if (get().currentSessionId === sessionId) {
        get().subscribeToEvents(sessionId);
      }
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
    }
  },

  forkSession: async (sessionId: string) => {
    set({ isLoading: true, error: null });
    try {
      const child = await sessionService.forkSession(sessionId);
      set((state) => ({
        sessions: [
          ...state.sessions.filter((session) => session.sessionId !== child.sessionId),
          child,
        ],
      }));
      await get().selectSession(child.sessionId);
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false });
    }
  },

  deleteSession: async (sessionId: string) => {
    try {
      await sessionService.deleteSession(sessionId);
      set((state) => ({
        sessions: state.sessions.filter((s) => s.sessionId !== sessionId),
        currentSessionId:
          state.currentSessionId === sessionId ? null : state.currentSessionId,
        messages: state.currentSessionId === sessionId ? [] : state.messages,
        goal: state.currentSessionId === sessionId ? null : state.goal,
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  sendMessage: async (payload: SendMessagePayload) => {
    const {
      currentSessionId,
      isTemporarySession,
      isStreaming,
      subscribeToEvents,
      addSession,
      addMessage,
    } = get();

    let sessionId = currentSessionId;

    if (
      isTemporarySession ||
      !currentSessionId ||
      currentSessionId === TEMP_SESSION_ID
    ) {
      try {
        const session = await sessionService.createSession();
        addSession(session);
        set({
          currentSessionId: session.sessionId,
          isTemporarySession: false,
        });
        sessionId = session.sessionId;
      } catch (err) {
        set({ error: (err as Error).message });
        return;
      }
    }

    if (!sessionId || sessionId === TEMP_SESSION_ID) {
      set({ error: 'Failed to create session' });
      return;
    }

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
      try {
        if (!subcommand || subcommand === 'status') {
          set({ goal: await sessionService.getGoal(sessionId) });
          return;
        }
        if (subcommand === 'clear') {
          await sessionService.clearGoal(sessionId);
          set({ goal: null });
          return;
        }

        let response;
        if (subcommand === 'pause') {
          response = await sessionService.updateGoal(sessionId, {
            action: 'pause',
          });
        } else if (subcommand === 'resume') {
          response = await sessionService.updateGoal(sessionId, {
            action: 'resume',
          });
        } else if (subcommand === 'edit') {
          const objective = args.slice(1).join(' ').trim();
          if (!objective) throw new Error('Usage: /goal edit <objective>');
          response = await sessionService.updateGoal(sessionId, {
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
            sessionId,
            objective,
            tokenBudget,
            currentMode
          );
        }

        set({
          goal: response.goal,
          currentRunId: response.runId ?? null,
          isStreaming: Boolean(response.runId),
          agentPhase: response.runId ? 'running' : get().agentPhase,
        });
        if (response.runId) subscribeToEvents(sessionId);
      } catch (err) {
        set({ error: (err as Error).message, isStreaming: false });
      }
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
    if (!isStreaming) {
      subscribeToEvents(sessionId);
    }

    try {
      const { currentMode } = useConfigStore.getState();
      const response = await sessionService.sendMessage(
        sessionId,
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
    const { currentSessionId, unsubscribeFromEvents } = get();

    unsubscribeFromEvents();
    set({
      isStreaming: false,
      currentRunId: null,
      pendingSteeringCount: 0,
    });

    if (currentSessionId) {
      try {
        await sessionService.abortSession(currentSessionId);
      } catch {
        // Ignore abort errors
      }
    }
  },
});
