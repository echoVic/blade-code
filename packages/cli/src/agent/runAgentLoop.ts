import { createLogger, LogCategory } from '../logging/Logger.js';
import {
  type Message,
} from '../services/ChatServiceInterface.js';
import { type FunctionDeclaration, type ToolResult } from '../tools/types/index.js';
import type { AgentLoopDependencies } from './agentLoopDependencyTypes.js';
import { executeLoopIteration } from './executeLoopIteration.js';
import { executeLoopTurn } from './executeLoopTurn.js';
import { initializeAgentLoopRuntime } from './initializeAgentLoopRuntime.js';
import { initializeLoopConversation } from './loopConversationInit.js';
import {
  createAbortedLoopResult,
  createUnexpectedLoopErrorResult,
  isAbortLikeError,
} from './loopErrorHandling.js';
import type {
  LoopResult,
  RunAgentLoopRequest,
} from './types.js';

const logger = createLogger(LogCategory.AGENT);

export async function runAgentLoop({
  message,
  context,
  options,
  systemPrompt,
  dependencies,
}: RunAgentLoopRequest): Promise<LoopResult> {
  const startTime = Date.now();
  const runtime = initializeAgentLoopRuntime({
    context,
    options,
    dependencies,
  });
  const loopControl = runtime.loopControl;
  const {
    configuredMaxTurns,
    actualMaxTurns: maxTurns,
    hitSafetyLimit,
    isYoloMode,
  } = loopControl;
  const { tools, createLoopMetadata, createErrorResult, createSuccessResult } = runtime;

  try {
    const {
      messages,
      lastMessageUuid: initialMessageUuid,
      prependedSystemPrompt,
    } = await initializeLoopConversation({
      message,
      context,
      systemPrompt,
      executionEngine: dependencies.executionEngine,
    });
    let lastMessageUuid: string | null = initialMessageUuid;

    if (configuredMaxTurns === 0) {
      return createErrorResult({
        type: 'chat_disabled',
        message:
          '对话功能已被禁用 (maxTurns=0)。如需启用，请调整配置：\n' +
          '  • CLI 参数: blade --max-turns -1\n' +
          '  • 配置文件: ~/.blade/config.json 中设置 "maxTurns": -1\n' +
          '  • 环境变量: export BLADE_MAX_TURNS=-1',
        metadata: createLoopMetadata({
          turnsCount: 0,
          toolCallsCount: 0,
          duration: 0,
        }),
      });
    }

    if (dependencies.config.debug) {
      logger.debug(
        `[MaxTurns] runtimeOptions: ${dependencies.runtimeOptions.maxTurns}, options: ${options?.maxTurns}, config: ${dependencies.config.maxTurns}, 最终: ${configuredMaxTurns} → ${maxTurns}, YOLO: ${isYoloMode}`
      );
    }

    let turnsCount = 0;
    const allToolResults: ToolResult[] = [];
    let totalTokens = 0;
    let lastPromptTokens: number | undefined;

    while (true) {
      const iterationOutcome = await executeLoopIteration({
        loopState: {
          turnsCount,
          totalTokens,
          lastPromptTokens,
          lastMessageUuid,
        },
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
        dependencies: {
          ...dependencies,
          executeLoopTurn,
        },
      });

      if (iterationOutcome.action === 'return') {
        return iterationOutcome.result;
      }

      ({
        turnsCount,
        totalTokens,
        lastPromptTokens,
        lastMessageUuid,
      } = iterationOutcome.loopState);
    }
  } catch (error) {
    if (isAbortLikeError(error)) {
      return createAbortedLoopResult(createErrorResult, {
        turnsCount: 0,
        toolCallsCount: 0,
        duration: Date.now() - startTime,
      });
    }

    logger.error('Enhanced chat processing error:', error);
    return createUnexpectedLoopErrorResult(createErrorResult, {
      error,
      turnsCount: 0,
      toolCallsCount: 0,
      duration: Date.now() - startTime,
    });
  }
}
