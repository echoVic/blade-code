import { sessionService } from '@/services'
import { createEventDispatcher } from '../handlers/eventHandlers'
import type { SliceCreator, StreamingSlice } from '../types'

export const createStreamingSlice: SliceCreator<StreamingSlice> = (set, get) => ({
  isStreaming: false,
  currentRunId: null,
  eventUnsubscribe: null,
  currentAssistantMessageId: null,
  hasToolCalls: false,

  setStreaming: (streaming) => set({ isStreaming: streaming }),

  setRunId: (runId) => set({ currentRunId: runId }),

  setCurrentAssistantMessageId: (id) => set({ currentAssistantMessageId: id }),

  setHasToolCalls: (has) => set({ hasToolCalls: has }),

  startAgentResponse: (messageId) => {
    set({
      currentAssistantMessageId: messageId,
      hasToolCalls: false,
      isStreaming: true,
    })
  },

  endAgentResponse: () => {
    set({
      currentAssistantMessageId: null,
      hasToolCalls: false,
      isStreaming: false,
      currentRunId: null,
    })
  },

  subscribeToEvents: (sessionId: string) => {
    const { eventUnsubscribe } = get()
    if (eventUnsubscribe) {
      eventUnsubscribe()
    }

    const dispatch = createEventDispatcher(get, set)
    const unsubscribe = sessionService.subscribeEvents(sessionId, dispatch)
    set({ eventUnsubscribe: unsubscribe })
  },

  unsubscribeFromEvents: () => {
    const { eventUnsubscribe } = get()
    if (eventUnsubscribe) {
      eventUnsubscribe()
      set({ eventUnsubscribe: null })
    }
  },

  handleEvent: (event) => {
    const dispatch = createEventDispatcher(get, set)
    dispatch(event)
  },
})
