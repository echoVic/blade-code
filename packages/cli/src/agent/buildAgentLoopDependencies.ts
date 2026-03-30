import type {
  AgentLoopDependencies,
  AgentLoopRuntimeState,
} from './agentLoopDependencyTypes.js';
import type { FunctionDeclaration } from '../tools/types/index.js';
import type { AgentLoopController } from './createAgentLoopController.js';
import { checkAndCompactInLoop } from './loopCompaction.js';
import { processStreamResponse } from './streamResponse.js';
import type { TodoItem } from '../tools/builtin/todo/types.js';

export function buildAgentLoopDependencies({
  runtimeState,
  loopController,
}: {
  runtimeState: AgentLoopRuntimeState;
  loopController: AgentLoopController;
}): AgentLoopDependencies {
  const {
    config,
    runtimeOptions,
    currentModelMaxContextTokens,
    executionPipeline,
    executionEngine,
    chatService,
  } = runtimeState;

  return {
    config,
    runtimeOptions,
    currentModelMaxContextTokens,
    executionPipeline,
    executionEngine,
    chatService,
    applySkillToolRestrictions: (tools: FunctionDeclaration[]) =>
      loopController.applySkillToolRestrictions(tools),
    processStreamResponse: (messages, tools, options) =>
      processStreamResponse({
        chatService,
        messages,
        tools,
        options,
      }),
    checkAndCompactInLoop: (context, currentTurn, actualPromptTokens, onCompacting) =>
      checkAndCompactInLoop({
        context,
        currentTurn,
        actualPromptTokens,
        onCompacting,
        chatService,
        config,
        executionEngine,
      }),
    switchModelIfNeeded: (modelId) =>
      loopController.switchModelIfNeeded(modelId),
    activateSkillContext: (metadata) =>
      loopController.activateSkillContext(metadata),
    setTodos: (todos: TodoItem[]) => loopController.setTodos(todos),
    log: (message: string) => loopController.log(message),
    error: (message: string) => loopController.error(message),
  };
}
