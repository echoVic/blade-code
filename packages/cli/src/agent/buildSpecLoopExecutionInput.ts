import { buildSpecModePrompt, createSpecModeReminder } from '../prompts/spec.js';
import type { SpecMetadata } from '../spec/types.js';
import { transformUserMessageText } from './transformUserMessageText.js';
import type { LoopExecutionInput } from './loopExecutionInput.js';
import type { UserMessageContent } from './types.js';

export function buildSpecLoopExecutionInput({
  message,
  currentSpec,
  steeringContext,
}: {
  message: UserMessageContent;
  currentSpec: SpecMetadata | null;
  steeringContext: string | null;
}): LoopExecutionInput {
  const phase = currentSpec?.phase || 'init';

  return {
    systemPrompt: buildSpecModePrompt(currentSpec, steeringContext),
    message: transformUserMessageText(
      message,
      (text) => `${createSpecModeReminder(phase)}\n\n${text}`
    ),
  };
}
