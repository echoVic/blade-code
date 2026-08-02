import type { TokenUsage } from './types';

export const TEMP_SESSION_ID = '__temp__';

export const initialTokenUsage: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  maxContextTokens: 128000,
  isDefaultMaxTokens: true,
};
