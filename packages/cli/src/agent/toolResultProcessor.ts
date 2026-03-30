import type { JsonValue } from '../store/types.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import type { LoopToolResultExecutionEngine } from './loopRuntimeTypes.js';
import type {
  ChatContext,
  LoopOptions,
  LoopResult,
  LoopResultMetadataInput,
} from './types.js';
import type { TodoItem } from '../tools/builtin/todo/types.js';
import type { ExecutedToolCall } from './toolCallExecutor.js';

const logger = createLogger(LogCategory.AGENT);

function toJsonValue(value: string | object): JsonValue {
  if (typeof value === 'string') return value;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

function isSubagentStatus(
  value: unknown
): value is 'running' | 'completed' | 'failed' | 'cancelled' {
  return (
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  );
}

export async function processToolExecutionResult({
  executionResult,
  messages,
  context,
  options,
  turnsCount,
  allToolResultsCount,
  duration,
  lastMessageUuid,
  createSuccessResult,
  createErrorResult,
  dependencies,
}: {
  executionResult: ExecutedToolCall;
  messages: Array<{
    role: 'tool';
    tool_call_id: string;
    name: string;
    content: string;
  } | { role: string; content: unknown }>;
  context: ChatContext;
  options?: LoopOptions;
  turnsCount: number;
  allToolResultsCount: number;
  duration: number;
  lastMessageUuid: string | null;
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
    executionEngine?: LoopToolResultExecutionEngine;
    activateSkillContext(metadata: Record<string, unknown>): void;
    switchModelIfNeeded(modelId: string): Promise<void>;
    setTodos(todos: TodoItem[]): void;
  };
}): Promise<
  | { action: 'continue'; lastMessageUuid: string | null }
  | { action: 'return'; result: LoopResult }
> {
  const { toolCall, result, toolUseUuid } = executionResult;

  if (result.metadata?.shouldExitLoop) {
    logger.debug('🚪 检测到退出循环标记，结束 Agent 循环');
    const finalMessage =
      typeof result.llmContent === 'string' ? result.llmContent : '循环已退出';

    return {
      action: 'return',
      result: result.success
        ? createSuccessResult({
            finalMessage,
            metadata: {
              turnsCount,
              toolCallsCount: allToolResultsCount,
              duration,
              shouldExitLoop: true,
              targetMode: result.metadata?.targetMode,
            },
          })
        : createErrorResult({
            type: 'api_error',
            message: finalMessage,
            metadata: {
              turnsCount,
              toolCallsCount: allToolResultsCount,
              duration,
              shouldExitLoop: true,
              targetMode: result.metadata?.targetMode,
            },
          }),
    };
  }

  if (options?.onToolResult && !options.signal?.aborted) {
    logger.debug('[Agent] Calling onToolResult:', {
      toolName: toolCall.function.name,
      hasCallback: true,
      resultSuccess: result.success,
      resultKeys: Object.keys(result),
      hasMetadata: !!result.metadata,
      metadataKeys: result.metadata ? Object.keys(result.metadata) : [],
      hasSummary: !!result.metadata?.summary,
      summary: result.metadata?.summary,
    });
    try {
      await options.onToolResult(toolCall, result);
      logger.debug('[Agent] onToolResult callback completed successfully');
    } catch (error) {
      logger.error('[Agent] onToolResult callback error:', error);
    }
  }

  let nextMessageUuid = lastMessageUuid;
  try {
    const contextManager = dependencies.executionEngine?.getContextManager();
    if (contextManager && context.sessionId) {
      const metadata =
        result.metadata && typeof result.metadata === 'object'
          ? (result.metadata as Record<string, unknown>)
          : undefined;
      const subagentStatus = isSubagentStatus(metadata?.subagentStatus)
        ? metadata.subagentStatus
        : 'completed';
      const subagentRef =
        metadata && typeof metadata.subagentSessionId === 'string'
          ? {
              subagentSessionId: metadata.subagentSessionId,
              subagentType:
                typeof metadata.subagentType === 'string'
                  ? metadata.subagentType
                  : toolCall.function.name,
              subagentStatus,
              subagentSummary:
                typeof metadata.subagentSummary === 'string'
                  ? metadata.subagentSummary
                  : undefined,
            }
          : undefined;
      nextMessageUuid = await contextManager.saveToolResult(
        context.sessionId,
        toolCall.id,
        toolCall.function.name,
        result.success ? toJsonValue(result.llmContent) : null,
        toolUseUuid,
        result.success ? undefined : result.error?.message,
        context.subagentInfo,
        subagentRef
      );
    }
  } catch (error) {
    logger.warn('[Agent] 保存工具结果失败:', error);
  }

  if (toolCall.function.name === 'TodoWrite' && result.success && result.llmContent) {
    const content = typeof result.llmContent === 'object' ? result.llmContent : {};
    const todos = Array.isArray(content)
      ? content
      : ((content as Record<string, unknown>).todos as unknown[]) || [];
    const typedTodos = todos as TodoItem[];
    dependencies.setTodos(typedTodos);
    options?.onTodoUpdate?.(typedTodos);
  }

  if (toolCall.function.name === 'Skill' && result.success && result.metadata) {
    dependencies.activateSkillContext(result.metadata as Record<string, unknown>);
  }

  const modelId = result.metadata?.modelId?.trim() || result.metadata?.model?.trim() || undefined;
  if (modelId) {
    await dependencies.switchModelIfNeeded(modelId);
  }

  let toolResultContent = result.success
    ? result.llmContent || result.displayContent || ''
    : result.error?.message || '执行失败';

  if (typeof toolResultContent === 'object' && toolResultContent !== null) {
    toolResultContent = JSON.stringify(toolResultContent, null, 2);
  }

  const finalContent =
    typeof toolResultContent === 'string'
      ? toolResultContent
      : JSON.stringify(toolResultContent);

  messages.push({
    role: 'tool',
    tool_call_id: toolCall.id,
    name: toolCall.function.name,
    content: finalContent,
  });

  return {
    action: 'continue',
    lastMessageUuid: nextMessageUuid,
  };
}
