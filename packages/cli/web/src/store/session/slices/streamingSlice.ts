import { sessionService } from '@/services';
import { createEventDispatcher } from '../handlers/eventHandlers';
import { globalStreamingBuffer } from '../handlers/streamingBuffer';
import type { SliceCreator, StreamingSlice } from '../types';

export const createStreamingSlice: SliceCreator<StreamingSlice> = (set, get) => ({
  isStreaming: false,
  agentPhase: 'idle',
  currentRunId: null,
  pendingSteeringCount: 0,
  eventUnsubscribe: null,
  currentAssistantMessageId: null,
  hasToolCalls: false,

  setStreaming: (streaming) => set({ isStreaming: streaming }),

  setAgentPhase: (phase) => set({ agentPhase: phase }),

  setRunId: (runId) => set({ currentRunId: runId }),

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

  subscribeToEvents: (sessionId: string) => {
    const { eventUnsubscribe } = get();
    if (eventUnsubscribe) {
      eventUnsubscribe();
    }

    globalStreamingBuffer.reset();
    const dispatch = createEventDispatcher(get, set);
    const unsubscribe = sessionService.subscribeEvents(sessionId, dispatch);
    set({ eventUnsubscribe: unsubscribe });
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
