import { PermissionMode } from '../config/types.js';
import { buildSystemPrompt, createPlanModeReminder } from '../prompts/index.js';
import { transformUserMessageText } from './transformUserMessageText.js';
import type { LoopExecutionInput } from './loopExecutionInput.js';
import type { UserMessageContent } from './types.js';

export async function buildPlanLoopExecutionInput({
  message,
  language,
}: {
  message: UserMessageContent;
  language: string;
}): Promise<LoopExecutionInput> {
  const { prompt: systemPrompt } = await buildSystemPrompt({
    projectPath: process.cwd(),
    mode: PermissionMode.PLAN,
    includeEnvironment: true,
    language,
  });

  return {
    systemPrompt,
    message: transformUserMessageText(message, (text) => createPlanModeReminder(text)),
  };
}
