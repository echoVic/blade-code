import { buildDefaultLoopExecutionInput } from './buildDefaultLoopExecutionInput.js';
import { buildPlanLoopExecutionInput } from './buildPlanLoopExecutionInput.js';
import { buildSpecLoopExecutionInput } from './buildSpecLoopExecutionInput.js';
import { loadSpecLoopContext } from './loadSpecLoopContext.js';
import type { LoopExecutionInput } from './loopExecutionInput.js';
import type { SpecManager } from '../spec/SpecManager.js';
import type { AgentOptions, ChatContext, UserMessageContent } from './types.js';

export async function buildContextualLoopExecutionInput({
  message,
  context,
  runtimeOptions,
  language,
  environmentContext,
  specManager,
  onSpecInitializationWarning,
}: {
  message: UserMessageContent;
  context: ChatContext;
  runtimeOptions: Pick<AgentOptions, 'systemPrompt' | 'appendSystemPrompt'>;
  language: string;
  environmentContext: string;
  specManager: Pick<
    SpecManager,
    'initialize' | 'getCurrentSpec' | 'getSteeringContextString'
  >;
  onSpecInitializationWarning: (error: unknown) => void;
}): Promise<LoopExecutionInput> {
  if (context.permissionMode === 'plan') {
    return buildPlanLoopExecutionInput({
      message,
      language,
    });
  }

  if (context.permissionMode === 'spec') {
    const specContext = await loadSpecLoopContext({
      specManager,
      workspaceRoot: context.workspaceRoot || process.cwd(),
      onInitializationWarning: onSpecInitializationWarning,
    });

    return buildSpecLoopExecutionInput({
      message,
      currentSpec: specContext.currentSpec,
      steeringContext: specContext.steeringContext,
    });
  }

  return buildDefaultLoopExecutionInput({
    message,
    contextSystemPrompt: context.systemPrompt,
    runtimeSystemPrompt: runtimeOptions.systemPrompt,
    runtimeAppendSystemPrompt: runtimeOptions.appendSystemPrompt,
    language,
    environmentContext,
  });
}
