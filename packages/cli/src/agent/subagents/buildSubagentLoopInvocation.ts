import type { AgentLoopInvocation, LoopOptions } from '../types.js';
import { buildSubagentChatContext } from './buildSubagentChatContext.js';

export function buildSubagentLoopInvocation({
  prompt,
  loopOptions,
  ...chatContextParams
}: Parameters<typeof buildSubagentChatContext>[0] & {
  prompt: string;
  loopOptions?: Partial<LoopOptions>;
}): AgentLoopInvocation {
  return {
    message: prompt,
    context: buildSubagentChatContext(chatContextParams),
    options: loopOptions,
  };
}
