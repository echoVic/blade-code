import { sessionService } from '@/services';
import { createEventDispatcher } from '../handlers/eventHandlers';
import { globalStreamingBuffer } from '../handlers/streamingBuffer';
import {
  HISTORY_SURFACE_READ_ONLY_ERROR,
  isHistorySurfaceActive,
} from '../historySurfaceGuard';
import type { SliceCreator, StreamingSlice, TaskEventConnectionState } from '../types';

export const createStreamingSlice: SliceCreator<StreamingSlice> = (set, get) => {
  const connectionStates = new WeakMap<() => void, TaskEventConnectionState>();
  let activeConnection: (() => void) | null = null;

  return {
    isStreaming: false,
    isStopping: false,
    agentPhase: 'idle',
    providerAdmission: null,
    providerCircuit: null,
    providerRetry: null,
    pendingResume: null,
    providerStall: null,
    providerRecovery: null,
    turnActivity: null,
    memoryConsolidation: null,
    actionStationarity: null,
    turnRecovery: null,
    sessionEventConnectionState: 'idle',
    currentRunId: null,
    pendingSteeringCount: 0,
    pendingInputDelivery: null,
    recoveredSteeringCount: 0,
    pendingSubagentCompletions: {},
    eventUnsubscribe: null,
    currentAssistantMessageId: null,
    hasToolCalls: false,

    setStreaming: (streaming) => set({ isStreaming: streaming }),

    setAgentPhase: (phase) => set({ agentPhase: phase }),

    setRunId: (runId) => set({ currentRunId: runId }),

    prepareEventSubscription: async (ref, onEvent) => {
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        throw new Error(HISTORY_SURFACE_READ_ONLY_ERROR);
      }
      const dispatch = onEvent ?? createEventDispatcher(get, set);
      let connection: (() => void) | null = null;
      let connectionState: TaskEventConnectionState = 'connecting';
      connection = await sessionService.openEventSubscription(ref, dispatch, {
        onConnectionStateChange: (nextState) => {
          connectionState = nextState;
          if (connection && activeConnection === connection) {
            set({ sessionEventConnectionState: nextState });
          }
        },
      });
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        connection();
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        throw new Error(HISTORY_SURFACE_READ_ONLY_ERROR);
      }
      connectionStates.set(connection, connectionState);
      return connection;
    },

    replaceEventSubscription: (next) => {
      const previous = get().eventUnsubscribe;
      activeConnection = next;
      set({
        eventUnsubscribe: next,
        sessionEventConnectionState: next
          ? (connectionStates.get(next) ?? 'connected')
          : 'idle',
      });
      globalStreamingBuffer.reset();
      if (previous && previous !== next) {
        try {
          previous();
        } catch (error) {
          console.warn('Failed to clean up previous event subscription', error);
        }
      }
    },

    setCurrentAssistantMessageId: (id) => set({ currentAssistantMessageId: id }),

    setHasToolCalls: (has) => set({ hasToolCalls: has }),

    startAgentResponse: (messageId) => {
      set({
        currentAssistantMessageId: messageId,
        hasToolCalls: false,
        isStreaming: true,
        agentPhase: 'running',
        providerAdmission: null,
        providerCircuit: null,
        providerRetry: null,
        providerStall: null,
        providerRecovery: null,
        memoryConsolidation: null,
        actionStationarity: null,
        turnRecovery: null,
      });
    },

    endAgentResponse: () => {
      globalStreamingBuffer.drainAll();
      set({
        currentAssistantMessageId: null,
        hasToolCalls: false,
        isStreaming: false,
        isStopping: false,
        agentPhase: 'idle',
        providerAdmission: null,
        providerCircuit: null,
        providerRetry: null,
        pendingResume: null,
        providerStall: null,
        providerRecovery: null,
        turnActivity: null,
        memoryConsolidation: null,
        actionStationarity: null,
        currentRunId: null,
        pendingSteeringCount: 0,
        pendingInputDelivery: null,
      });
    },

    subscribeToEvents: async (ref) => {
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        throw new Error(HISTORY_SURFACE_READ_ONLY_ERROR);
      }
      const unsubscribe = await get().prepareEventSubscription(ref);
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        unsubscribe();
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        throw new Error(HISTORY_SURFACE_READ_ONLY_ERROR);
      }
      get().replaceEventSubscription(unsubscribe);
    },

    reconnectSessionEvents: async () => {
      if (isHistorySurfaceActive(get().historySurfaceSelection)) {
        set({ error: HISTORY_SURFACE_READ_ONLY_ERROR });
        return;
      }
      const ref = get().currentSessionRef;
      if (!ref) return;
      get().unsubscribeFromEvents();
      set({ sessionEventConnectionState: 'connecting' });
      try {
        await get().subscribeToEvents(ref);
      } catch (error) {
        set({ sessionEventConnectionState: 'offline' });
        throw error;
      }
    },

    unsubscribeFromEvents: () => {
      const { eventUnsubscribe } = get();
      activeConnection = null;
      set({
        eventUnsubscribe: null,
        sessionEventConnectionState: 'idle',
      });
      try {
        eventUnsubscribe?.();
      } catch (error) {
        console.warn('Failed to clean up event subscription', error);
      } finally {
        globalStreamingBuffer.reset();
      }
    },

    handleEvent: (event) => {
      const dispatch = createEventDispatcher(get, set);
      dispatch(event);
    },
  };
};
