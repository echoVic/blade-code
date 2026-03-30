import type { UserMessageContent } from './types.js';

export interface LoopExecutionInput {
  message: UserMessageContent;
  systemPrompt: string;
}
