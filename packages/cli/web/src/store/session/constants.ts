import type { TokenUsage } from './types';

export const TEMP_SESSION_ID = '__temp__';

export const initialTokenUsage: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  maxContextTokens: 0,
  isDefaultMaxTokens: true,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estimatedCostUsd: 0,
};
