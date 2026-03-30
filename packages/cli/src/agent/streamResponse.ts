import { createLogger, LogCategory } from '../logging/Logger.js';
import { streamDebug } from '../logging/StreamDebugLogger.js';
import type {
  ChatResponse,
  IChatService,
  Message,
  StreamToolCall,
} from '../services/ChatServiceInterface.js';
import type { LoopOptions } from './types.js';

const logger = createLogger(LogCategory.AGENT);

function accumulateToolCall(
  accumulator: Map<number, { id: string; name: string; arguments: string }>,
  chunk: StreamToolCall
): void {
  const tc = chunk as {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  };
  const index = tc.index ?? 0;

  if (!accumulator.has(index)) {
    accumulator.set(index, {
      id: tc.id || '',
      name: tc.function?.name || '',
      arguments: '',
    });
  }

  const entry = accumulator.get(index)!;

  if (tc.id && !entry.id) entry.id = tc.id;
  if (tc.function?.name && !entry.name) entry.name = tc.function.name;
  if (tc.function?.arguments) {
    entry.arguments += tc.function.arguments;
  }
}

function buildFinalToolCalls(
  accumulator: Map<number, { id: string; name: string; arguments: string }>
): ChatResponse['toolCalls'] | undefined {
  if (accumulator.size === 0) return undefined;

  return Array.from(accumulator.values())
    .filter((tc) => tc.id && tc.name)
    .map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.name,
        arguments: tc.arguments,
      },
    }));
}

function isStreamingNotSupportedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const streamErrors = [
    'stream not supported',
    'streaming is not available',
    'sse not supported',
    'does not support streaming',
  ];

  return streamErrors.some((message) =>
    error.message.toLowerCase().includes(message.toLowerCase())
  );
}

export async function processStreamResponse({
  chatService,
  messages,
  tools,
  options,
}: {
  chatService: Pick<IChatService, 'chat' | 'streamChat'>;
  messages: Message[];
  tools: Array<{ name: string; description: string; parameters: unknown }>;
  options?: LoopOptions;
}): Promise<ChatResponse> {
  let fullContent = '';
  let fullReasoningContent = '';
  let streamUsage: ChatResponse['usage'];
  const toolCallAccumulator = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();

  try {
    const stream = chatService.streamChat(messages, tools, options?.signal);

    let chunkCount = 0;
    for await (const chunk of stream) {
      chunkCount++;

      if (options?.signal?.aborted) {
        break;
      }

      if (chunk.content) {
        const chunkLen = chunk.content.length;
        fullContent += chunk.content;
        streamDebug('processStreamResponse', 'onContentDelta BEFORE', {
          chunkLen,
          accumulatedLen: fullContent.length,
        });
        options?.onContentDelta?.(chunk.content);
        streamDebug('processStreamResponse', 'onContentDelta AFTER', {
          chunkLen,
          accumulatedLen: fullContent.length,
        });
      }

      if (chunk.reasoningContent) {
        fullReasoningContent += chunk.reasoningContent;
        options?.onThinkingDelta?.(chunk.reasoningContent);
      }

      if (chunk.usage) {
        streamUsage = chunk.usage;
      }

      if (chunk.toolCalls) {
        for (const toolCall of chunk.toolCalls) {
          accumulateToolCall(toolCallAccumulator, toolCall);
        }
      }

      if (chunk.finishReason) {
        streamDebug('processStreamResponse', 'finishReason received', {
          finishReason: chunk.finishReason,
          fullContentLen: fullContent.length,
          fullReasoningContentLen: fullReasoningContent.length,
          toolCallAccumulatorSize: toolCallAccumulator.size,
        });
        break;
      }
    }

    streamDebug('processStreamResponse', 'stream ended', {
      fullContentLen: fullContent.length,
      fullReasoningContentLen: fullReasoningContent.length,
      toolCallAccumulatorSize: toolCallAccumulator.size,
    });

    if (
      chunkCount === 0 &&
      !options?.signal?.aborted &&
      fullContent.length === 0 &&
      toolCallAccumulator.size === 0
    ) {
      logger.warn('[Agent] 流式响应返回0个chunk，回退到非流式模式');
      return chatService.chat(messages, tools, options?.signal);
    }

    return {
      content: fullContent,
      reasoningContent: fullReasoningContent || undefined,
      toolCalls: buildFinalToolCalls(toolCallAccumulator),
      usage: streamUsage,
    };
  } catch (error) {
    if (isStreamingNotSupportedError(error)) {
      logger.warn('[Agent] 流式请求失败，降级到非流式模式');
      return chatService.chat(messages, tools, options?.signal);
    }

    throw error;
  }
}
