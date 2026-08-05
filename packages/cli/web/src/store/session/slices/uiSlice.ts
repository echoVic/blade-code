import { initialTokenUsage } from '../constants';
import type { SliceCreator, UiSlice } from '../types';

export const createUiSlice: SliceCreator<UiSlice> = (set) => ({
  tokenUsage: initialTokenUsage,

  updateTokenUsage: (usage) =>
    set((state) => {
      const { costUsd, ...currentUsage } = usage;
      return {
        tokenUsage: {
          ...state.tokenUsage,
          ...currentUsage,
          totalInputTokens:
            state.tokenUsage.totalInputTokens + Math.max(0, usage.inputTokens ?? 0),
          totalOutputTokens:
            state.tokenUsage.totalOutputTokens + Math.max(0, usage.outputTokens ?? 0),
          cacheReadTokens:
            state.tokenUsage.cacheReadTokens + Math.max(0, usage.cacheReadTokens ?? 0),
          cacheWriteTokens:
            state.tokenUsage.cacheWriteTokens +
            Math.max(0, usage.cacheWriteTokens ?? 0),
          estimatedCostUsd:
            state.tokenUsage.estimatedCostUsd + Math.max(0, costUsd ?? 0),
        },
      };
    }),

  resetContextUsage: () =>
    set((state) => ({
      tokenUsage: {
        ...state.tokenUsage,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    })),

  setMaxContextTokens: (tokens, isDefault = false) =>
    set((state) => ({
      tokenUsage: {
        ...state.tokenUsage,
        maxContextTokens: tokens,
        isDefaultMaxTokens: isDefault,
      },
    })),
});
