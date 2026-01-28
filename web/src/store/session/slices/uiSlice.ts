import { initialTokenUsage } from '../constants'
import type { SliceCreator, UiSlice } from '../types'

export const createUiSlice: SliceCreator<UiSlice> = (set) => ({
  tokenUsage: { ...initialTokenUsage },
  currentThinkingContent: null,
  thinkingExpanded: false,
  todos: [],
  subagentProgress: null,

  updateTokenUsage: (usage) =>
    set((state) => ({
      tokenUsage: { ...state.tokenUsage, ...usage },
    })),

  appendThinking: (delta) =>
    set((state) => ({
      currentThinkingContent: (state.currentThinkingContent || '') + delta,
    })),

  clearThinking: () => set({ currentThinkingContent: null }),

  toggleThinkingExpanded: () =>
    set((state) => ({ thinkingExpanded: !state.thinkingExpanded })),

  setTodos: (todos) => set({ todos }),

  setSubagentProgress: (progress) => set({ subagentProgress: progress }),

  setMaxContextTokens: (tokens, isDefault = false) =>
    set((state) => ({
      tokenUsage: {
        ...state.tokenUsage,
        maxContextTokens: tokens,
        isDefaultMaxTokens: isDefault,
      },
    })),
})
