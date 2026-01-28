import { initialTokenUsage } from '../constants'
import type { SliceCreator, UiSlice } from '../types'

export const createUiSlice: SliceCreator<UiSlice> = (set) => ({
  tokenUsage: initialTokenUsage,

  updateTokenUsage: (usage) =>
    set((state) => ({
      tokenUsage: { ...state.tokenUsage, ...usage },
    })),

  setMaxContextTokens: (tokens, isDefault = false) =>
    set((state) => ({
      tokenUsage: { ...state.tokenUsage, maxContextTokens: tokens, isDefaultMaxTokens: isDefault },
    })),
})
