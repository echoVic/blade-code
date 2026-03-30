import { createAbortedLoopResult } from './loopErrorHandling.js';
import { rebuildLoopMessagesAfterCompaction } from './loopContinuation.js';
import { executeLoopTurn } from './executeLoopTurn.js';
import { handleTurnLimitReached } from './turnLimitHandler.js';
import type { AgentLoopIterationDependencies } from './agentLoopDependencyTypes.js';
import type { FunctionDeclaration, ToolResult } from '../tools/types/index.js';
import type { Message } from '../services/ChatServiceInterface.js';
import type {
  ChatContext,
  LoopOptions,
  LoopResult,
  LoopResultMetadataInput,
} from './types.js';

export async function executeLoopIteration({
  loopState,
  messages,
  tools,
  context,
  options,
  prependedSystemPrompt,
  maxTurns,
  isYoloMode,
  hitSafetyLimit,
  allToolResults,
  startTime,
  createSuccessResult,
  createErrorResult,
  dependencies,
}: {
  loopState: {
    turnsCount: number;
    totalTokens: number;
    lastPromptTokens?: number;
    lastMessageUuid: string | null;
  };
  messages: Message[];
  tools: FunctionDeclaration[];
  context: ChatContext;
  options?: LoopOptions;
  prependedSystemPrompt: boolean;
  maxTurns: number;
  isYoloMode: boolean;
  hitSafetyLimit: boolean;
  allToolResults: ToolResult[];
  startTime: number;
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
  dependencies: AgentLoopIterationDependencies & {
    executeLoopTurn?: typeof executeLoopTurn;
    handleTurnLimitReached?: typeof handleTurnLimitReached;
  };
}): Promise<
  | {
      action: 'continue';
      loopState: {
        turnsCount: number;
        totalTokens: number;
        lastPromptTokens?: number;
        lastMessageUuid: string | null;
      };
    }
  | {
      action: 'return';
      result: LoopResult;
    }
> {
  if (options?.signal?.aborted) {
    return {
      action: 'return',
      result: createAbortedLoopResult(createErrorResult, {
        turnsCount: loopState.turnsCount,
        toolCallsCount: allToolResults.length,
        duration: Date.now() - startTime,
      }),
    };
  }

  const preCompactLength = context.messages.length;
  const didCompact = await dependencies.checkAndCompactInLoop(
    context,
    loopState.turnsCount,
    loopState.lastPromptTokens,
    options?.onCompacting
  );

  if (didCompact) {
    const rebuiltMessages = rebuildLoopMessagesAfterCompaction({
      messages,
      compactedMessages: context.messages,
      prependedSystemPrompt,
      previousHistoryLength: preCompactLength,
    });

    messages.length = 0;
    messages.push(...rebuiltMessages);
  }

  const nextTurnsCount = loopState.turnsCount + 1;

  if (options?.signal?.aborted) {
    return {
      action: 'return',
      result: createAbortedLoopResult(createErrorResult, {
        turnsCount: nextTurnsCount - 1,
        toolCallsCount: allToolResults.length,
        duration: Date.now() - startTime,
      }),
    };
  }

  options?.onTurnStart?.({ turn: nextTurnsCount, maxTurns });

  const runTurn = dependencies.executeLoopTurn ?? executeLoopTurn;
  const turnOutcome = await runTurn({
    turnsCount: nextTurnsCount,
    messages,
    tools,
    context,
    options,
    totalTokens: loopState.totalTokens,
    lastMessageUuid: loopState.lastMessageUuid,
    allToolResults,
    startTime,
    createSuccessResult,
    createErrorResult,
    dependencies: {
      currentModelMaxContextTokens: dependencies.currentModelMaxContextTokens,
      processStreamResponse: dependencies.processStreamResponse,
      chatService: dependencies.chatService,
      executionPipeline: dependencies.executionPipeline,
      executionEngine: dependencies.executionEngine,
      activateSkillContext: dependencies.activateSkillContext,
      switchModelIfNeeded: dependencies.switchModelIfNeeded,
      setTodos: dependencies.setTodos,
      log: dependencies.log,
      error: dependencies.error,
    },
  });

  const nextLoopState = {
    turnsCount: nextTurnsCount,
    totalTokens: turnOutcome.totalTokens,
    lastPromptTokens: turnOutcome.lastPromptTokens,
    lastMessageUuid:
      turnOutcome.lastMessageUuid !== undefined
        ? turnOutcome.lastMessageUuid
        : loopState.lastMessageUuid,
  };

  if (turnOutcome.action === 'return') {
    return {
      action: 'return',
      result: turnOutcome.result,
    };
  }

  if (nextTurnsCount >= maxTurns && !isYoloMode) {
    const applyTurnLimit = dependencies.handleTurnLimitReached ?? handleTurnLimitReached;
    const turnLimitAction = await applyTurnLimit({
      turnsCount: nextTurnsCount,
      maxTurns,
      isYoloMode,
      hitSafetyLimit,
      totalTokens: nextLoopState.totalTokens,
      lastPromptTokens: nextLoopState.lastPromptTokens,
      duration: Date.now() - startTime,
      allToolResultsCount: allToolResults.length,
      messages,
      context,
      options,
      createSuccessResult,
      createErrorResult,
      dependencies: {
        config: dependencies.config,
        chatService: dependencies.chatService,
        executionEngine: dependencies.executionEngine,
      },
    });

    if (turnLimitAction.action === 'return') {
      return {
        action: 'return',
        result: turnLimitAction.result,
      };
    }

    if (turnLimitAction.action === 'continue') {
      return {
        action: 'continue',
        loopState: {
          ...nextLoopState,
          turnsCount: turnLimitAction.turnsCount,
        },
      };
    }
  }

  return {
    action: 'continue',
    loopState: nextLoopState,
  };
}
