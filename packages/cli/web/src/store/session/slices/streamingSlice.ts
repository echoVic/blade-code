import { sessionService } from '@/services';
import { createEventDispatcher } from '../handlers/eventHandlers';
import { globalStreamingBuffer } from '../handlers/streamingBuffer';
import type { SliceCreator, StreamingSlice } from '../types';

export const createStreamingSlice: SliceCreator<StreamingSlice> = (set, get) => ({
  isStreaming: false,
  agentPhase: 'idle',
  currentRunId: null,
  pendingSteeringCount: 0,
  recoveredSteeringCount: 0,
  eventUnsubscribe: null,
  currentAssistantMessageId: null,
  hasToolCalls: false,

  setStreaming: (streaming) => set({ isStreaming: streaming }),

  setAgentPhase: (phase) => set({ agentPhase: phase }),

  setRunId: (runId) => set({ currentRunId: runId }),

  prepareEventSubscription: async (ref) => {
    const dispatch = createEventDispatcher(get, set);
    return sessionService.openEventSubscription(ref, dispatch);
  },

  replaceEventSubscription: (next) => {
    const previous = get().eventUnsubscribe;
    set({ eventUnsubscribe: next });
    globalStreamingBuffer.reset();
    if (previous) {
      previous();
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
    });
  },

  endAgentResponse: () => {
    globalStreamingBuffer.drainAll();
    set({
      currentAssistantMessageId: null,
      hasToolCalls: false,
      isStreaming: false,
      agentPhase: 'idle',
      currentRunId: null,
      pendingSteeringCount: 0,
    });
  },

  subscribeToEvents: async (ref) => {
    const unsubscribe = await get().prepareEventSubscription(ref);
    get().replaceEventSubscription(unsubscribe);
  },

  unsubscribeFromEvents: () => {
    const { eventUnsubscribe } = get();
    if (eventUnsubscribe) {
      globalStreamingBuffer.drainAll();
      eventUnsubscribe();
      set({ eventUnsubscribe: null });
    }
  },

  handleEvent: (event) => {
    const dispatch = createEventDispatcher(get, set);
    dispatch(event);
  },
});
