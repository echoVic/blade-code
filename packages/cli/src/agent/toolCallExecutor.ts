import { nanoid } from 'nanoid';
import type { ChatCompletionMessageFunctionToolCall } from 'openai/resources/chat';
import { createLogger, LogCategory } from '../logging/Logger.js';
import type {
  LoopToolExecutionPipeline,
  LoopToolUseExecutionEngine,
} from './loopRuntimeTypes.js';
import type { ChatContext, LoopOptions } from './types.js';
import { ToolErrorType, type ToolResult } from '../tools/types/index.js';

const logger = createLogger(LogCategory.AGENT);

export type ExecutedToolCall = {
  toolCall: ChatCompletionMessageFunctionToolCall;
  result: ToolResult;
  toolUseUuid: string | null;
  error?: Error;
};

export async function executeToolCall({
  toolCall,
  context,
  options,
  lastMessageUuid,
  executionPipeline,
  executionEngine,
  dependencies,
}: {
  toolCall: ChatCompletionMessageFunctionToolCall;
  context: ChatContext;
  options?: LoopOptions;
  lastMessageUuid: string | null;
  executionPipeline: LoopToolExecutionPipeline;
  executionEngine?: LoopToolUseExecutionEngine;
  dependencies: {
    log(message: string): void;
    error(message: string): void;
  };
}): Promise<ExecutedToolCall> {
  try {
    const params = JSON.parse(toolCall.function.arguments);
    if (
      toolCall.function.name === 'Task' &&
      (typeof params.subagent_session_id !== 'string' ||
        params.subagent_session_id.length === 0)
    ) {
      params.subagent_session_id =
        typeof params.resume === 'string' && params.resume.length > 0
          ? params.resume
          : nanoid();
    }

    if (params.todos && typeof params.todos === 'string') {
      try {
        params.todos = JSON.parse(params.todos);
        dependencies.log('[Agent] 自动修复了字符串化的 todos 参数');
      } catch {
        dependencies.error('[Agent] todos 参数格式异常,将由验证层处理');
      }
    }

    let toolUseUuid: string | null = null;
    try {
      const contextManager = executionEngine?.getContextManager();
      if (contextManager && context.sessionId) {
        toolUseUuid = await contextManager.saveToolUse(
          context.sessionId,
          toolCall.function.name,
          params,
          lastMessageUuid,
          context.subagentInfo
        );
      }
    } catch (error) {
      logger.warn('[Agent] 保存工具调用失败:', error);
    }

    const signalToUse = options?.signal;
    if (!signalToUse) {
      logger.error('[Agent] Missing signal in tool execution, this should not happen');
    }

    logger.debug('[Agent] Passing confirmationHandler to ExecutionPipeline.execute:', {
      toolName: toolCall.function.name,
      hasHandler: !!context.confirmationHandler,
      hasMethod: !!context.confirmationHandler?.requestConfirmation,
      methodType: typeof context.confirmationHandler?.requestConfirmation,
    });

    const result = await executionPipeline.execute(toolCall.function.name, params, {
      sessionId: context.sessionId,
      userId: context.userId || 'default',
      workspaceRoot: context.workspaceRoot || process.cwd(),
      signal: signalToUse,
      confirmationHandler: context.confirmationHandler,
      permissionMode: context.permissionMode,
    });

    logger.debug('\n========== 工具执行结果 ==========');
    logger.debug('工具名称:', toolCall.function.name);
    logger.debug('成功:', result.success);
    logger.debug('LLM Content:', result.llmContent);
    logger.debug('Display Content:', result.displayContent);
    if (result.error) {
      logger.debug('错误:', result.error);
    }
    logger.debug('==================================\n');

    return { toolCall, result, toolUseUuid };
  } catch (error) {
    logger.error(`Tool execution failed for ${toolCall.function.name}:`, error);
    return {
      toolCall,
      result: {
        success: false,
        llmContent: '',
        displayContent: '',
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      },
      toolUseUuid: null,
      error: error instanceof Error ? error : new Error('Unknown error'),
    };
  }
}
