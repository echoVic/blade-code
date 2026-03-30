import type { ChatCompletionMessageFunctionToolCall } from 'openai/resources/chat';
import { createLogger, LogCategory } from '../logging/Logger.js';
import { persistLoopMessage } from './loopMessagePersistence.js';
import type {
  LoopLookupRegistry,
  LoopMessageExecutionEngine,
} from './loopRuntimeTypes.js';
import type { ChatContext, LoopOptions } from './types.js';
import type { ChatResponse, Message } from '../services/ChatServiceInterface.js';

const logger = createLogger(LogCategory.AGENT);

function isFunctionToolCall(
  toolCall: NonNullable<ChatResponse['toolCalls']>[number]
): toolCall is ChatCompletionMessageFunctionToolCall {
  return toolCall.type === 'function';
}

export async function prepareToolCallTurn({
  turnResult,
  messages,
  context,
  options,
  lastMessageUuid,
  registry,
  executionEngine,
}: {
  turnResult: Pick<ChatResponse, 'content' | 'reasoningContent' | 'toolCalls'>;
  messages: Message[];
  context: ChatContext;
  options?: LoopOptions;
  lastMessageUuid: string | null;
  registry: LoopLookupRegistry;
  executionEngine?: LoopMessageExecutionEngine;
}): Promise<{
  functionCalls: ChatCompletionMessageFunctionToolCall[];
  lastMessageUuid: string | null;
}> {
  messages.push({
    role: 'assistant',
    content: turnResult.content || '',
    reasoningContent: turnResult.reasoningContent,
    tool_calls: turnResult.toolCalls,
  });

  const nextMessageUuid = await persistLoopMessage({
    context,
    role: 'assistant',
    content: turnResult.content,
    previousId: lastMessageUuid,
    executionEngine,
    emptyLogMessage: '[Agent] 跳过保存空响应（工具调用时）',
    failureLogMessage: '[Agent] 保存助手工具调用消息失败:',
  });

  const functionCalls = (turnResult.toolCalls || []).filter(isFunctionToolCall);

  if (options?.onToolStart && !options.signal?.aborted) {
    for (const toolCall of functionCalls) {
      const toolDef = registry.get(toolCall.function.name);
      const toolKind = toolDef?.kind as 'readonly' | 'write' | 'execute' | undefined;
      options.onToolStart(toolCall, toolKind);
    }
  }

  return {
    functionCalls,
    lastMessageUuid: nextMessageUuid,
  };
}
