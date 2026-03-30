import { buildSystemPrompt } from '../prompts/index.js';
import type { LoopExecutionInput } from './loopExecutionInput.js';
import type { UserMessageContent } from './types.js';

export async function buildDefaultLoopExecutionInput({
  message,
  contextSystemPrompt,
  runtimeSystemPrompt,
  runtimeAppendSystemPrompt,
  language,
  environmentContext,
}: {
  message: UserMessageContent;
  contextSystemPrompt?: string;
  runtimeSystemPrompt?: string;
  runtimeAppendSystemPrompt?: string;
  language: string;
  environmentContext: string;
}): Promise<LoopExecutionInput> {
  const basePrompt =
    contextSystemPrompt ??
    (
      await buildSystemPrompt({
        projectPath: process.cwd(),
        replaceDefault: runtimeSystemPrompt,
        append: runtimeAppendSystemPrompt,
        includeEnvironment: false,
        language,
      })
    ).prompt;

  return {
    message,
    systemPrompt: basePrompt
      ? `${environmentContext}\n\n---\n\n${basePrompt}`
      : environmentContext,
  };
}
