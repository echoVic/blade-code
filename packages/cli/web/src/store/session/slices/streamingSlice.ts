import { sessionService } from '@/services';
import { createEventDispatcher } from '../handlers/eventHandlers';
import { globalStreamingBuffer } from '../handlers/streamingBuffer';
import type { SliceCreator, StreamingSlice, TaskEventConnectionState } from '../types';

export const createStreamingSlice: SliceCreator<StreamingSlice> = (set, get) => {
  const connectionStates = new WeakMap<() => void, TaskEventConnectionState>();
  let activeConnection: (() => void) | null = null;

  return {
    isStreaming: false,
    isStopping: false,
    agentPhase: 'idle',
    providerCircuit: null,
    providerRetry: null,
    providerStall: null,
    actionStationarity: null,
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
        providerCircuit: null,
        providerRetry: null,
        providerStall: null,
        actionStationarity: null,
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
        providerCircuit: null,
        providerRetry: null,
        providerStall: null,
        actionStationarity: null,
        currentRunId: null,
        pendingSteeringCount: 0,
        pendingInputDelivery: null,
      });
    },

    subscribeToEvents: async (ref) => {
      const unsubscribe = await get().prepareEventSubscription(ref);
      get().replaceEventSubscription(unsubscribe);
    },

    reconnectSessionEvents: async () => {
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
