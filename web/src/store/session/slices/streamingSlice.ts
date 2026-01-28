import { sessionService } from '@/services'
import { createEventDispatcher } from '../handlers/eventHandlers'
import type { SliceCreator, StreamingSlice } from '../types'

export const createStreamingSlice: SliceCreator<StreamingSlice> = (set, get) => ({
  isStreaming: false,
  currentRunId: null,
  eventUnsubscribe: null,

  setStreaming: (streaming) => set({ isStreaming: streaming }),

  setRunId: (runId) => set({ currentRunId: runId }),

  subscribeToEvents: (sessionId) => {
    const { eventUnsubscribe } = get()
    if (eventUnsubscribe) {
      eventUnsubscribe()
    }

    const dispatcher = createEventDispatcher(get, set)
    const unsubscribe = sessionService.subscribeEvents(sessionId, dispatcher)
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
    const dispatcher = createEventDispatcher(get, set)
    dispatcher(event)
  },
})
