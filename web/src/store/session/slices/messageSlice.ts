import type { Message, MessageSlice, SliceCreator } from '../types'

export const createMessageSlice: SliceCreator<MessageSlice> = (set) => ({
  messages: [],

  setMessages: (messages) => set({ messages }),

  addMessage: (message) =>
    set((state) => ({
      messages: [...state.messages, message],
    })),

  updateMessage: (id, updates) =>
    set((state) => ({
      messages: state.messages.map((m) => (m.id === id ? { ...m, ...updates } : m)),
    })),

  appendDelta: (id, delta) =>
    set((state) => {
      const existing = state.messages.find((m) => m.id === id)
      if (existing) {
        return {
          messages: state.messages.map((m) =>
            m.id === id ? { ...m, content: m.content + delta } : m
          ),
        }
      }
      const newMsg: Message = {
        id,
        role: 'assistant',
        content: delta,
        timestamp: Date.now(),
      }
      return { messages: [...state.messages, newMsg] }
    }),

  replaceTemp: (content, message) =>
    set((state) => {
      const tempIndex = state.messages.findIndex(
        (m) => m.role === 'user' && m.id?.startsWith('temp-') && m.content === content
      )
      if (tempIndex >= 0) {
        const newMessages = [...state.messages]
        newMessages[tempIndex] = message
        return { messages: newMessages }
      }
      return { messages: [...state.messages, message] }
    }),
})
