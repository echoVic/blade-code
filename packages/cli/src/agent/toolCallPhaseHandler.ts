import { createLogger, LogCategory } from '../logging/Logger.js';
import type { Message, ChatResponse } from '../services/ChatServiceInterface.js';
import type { ToolResult } from '../tools/types/index.js';
import type { LoopExecutionEngine, LoopLookupRegistry, LoopExecutionPipeline } from './loopRuntimeTypes.js';
import { executeToolCall } from './toolCallExecutor.js';
import { prepareToolCallTurn } from './toolCallTurnHandler.js';
import { processToolExecutionResult } from './toolResultProcessor.js';
import type {
  ChatContext,
  LoopOptions,
  LoopResult,
  LoopResultMetadataInput,
} from './types.js';

const logger = createLogger(LogCategory.AGENT);

export async function handleToolCallPhase({
  turnResult,
  messages,
  context,
  options,
  turnsCount,
  duration,
  lastMessageUuid,
  allToolResults,
  createSuccessResult,
  createErrorResult,
  dependencies,
}: {
  turnResult: Pick<ChatResponse, 'content' | 'reasoningContent' | 'toolCalls'>;
  messages: Message[];
  context: ChatContext;
  options?: LoopOptions;
  turnsCount: number;
  duration: number;
  lastMessageUuid: string | null;
  allToolResults: ToolResult[];
  createSuccessResult(params: {
    finalMessage?: string;
    metadata: LoopResultMetadataInput;
  }): LoopResult;
  createErrorResult(params: {
    type: NonNullable<LoopResult['error']>['type'];
    message: string;
    details?: unknown;
    metadata: LoopResultMetadataInput;
  }): LoopResult;
  dependencies: {
    registry: LoopLookupRegistry;
    executionPipeline: LoopExecutionPipeline;
    executionEngine?: LoopExecutionEngine;
    activateSkillContext(metadata: Record<string, unknown>): void;
    switchModelIfNeeded(modelId: string): Promise<void>;
    setTodos(todos: Parameters<NonNullable<LoopOptions['onTodoUpdate']>>[0]): void;
    log(message: string): void;
    error(message: string): void;
  };
}): Promise<
  | { action: 'continue'; lastMessageUuid: string | null }
  | { action: 'return'; result: LoopResult }
> {
  const toolCallTurn = await prepareToolCallTurn({
    turnResult,
    messages,
    context,
    options,
    lastMessageUuid,
    registry: dependencies.registry,
    executionEngine: dependencies.executionEngine,
  });

  const nextLastMessageUuid = toolCallTurn.lastMessageUuid;

  if (options?.signal?.aborted) {
    logger.info('[Agent] Aborting before tool execution due to signal.aborted=true');
    return {
      action: 'return',
      result: createErrorResult({
        type: 'aborted',
        message: '任务已被用户中止',
        metadata: {
          turnsCount,
          toolCallsCount: allToolResults.length,
          duration,
        },
      }),
    };
  }

  const { functionCalls } = toolCallTurn;

  logger.info(`[Agent] Executing ${functionCalls.length} tool calls in parallel`);
  const executionResults = await Promise.all(
    functionCalls.map((toolCall) =>
      executeToolCall({
        toolCall,
        context,
        options,
        lastMessageUuid: nextLastMessageUuid,
        executionPipeline: dependencies.executionPipeline,
        executionEngine: dependencies.executionEngine,
        dependencies: {
          log: dependencies.log,
          error: dependencies.error,
        },
      })
    )
  );

  let processedLastMessageUuid = nextLastMessageUuid;
  for (const executionResult of executionResults) {
    allToolResults.push(executionResult.result);
    const processedResult = await processToolExecutionResult({
      executionResult,
      messages,
      context,
      options,
      turnsCount,
      allToolResultsCount: allToolResults.length,
      duration,
      lastMessageUuid: processedLastMessageUuid,
      createSuccessResult,
      createErrorResult,
      dependencies: {
        executionEngine: dependencies.executionEngine,
        activateSkillContext: dependencies.activateSkillContext,
        switchModelIfNeeded: dependencies.switchModelIfNeeded,
        setTodos: dependencies.setTodos,
      },
    });

    if (processedResult.action === 'return') {
      return processedResult;
    }

    processedLastMessageUuid = processedResult.lastMessageUuid;
  }

  return {
    action: 'continue',
    lastMessageUuid: processedLastMessageUuid,
  };
}
