import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from 'openai/resources/chat';
import { createLogger, LogCategory } from '../logging/Logger.js';
import type {
  ChatConfig,
  ChatResponse,
  IChatService,
  Message,
  ReasoningFieldName,
  StreamChunk,
} from './ChatServiceInterface.js';

const _logger = createLogger(LogCategory.CHAT);

/**
 * 支持的 reasoning 字段名列表（按优先级排序）
 * 不同 API 代理使用不同的字段名：
 * - reasoning_content: DeepSeek 官方 API
 * - reasoning: zenmux.ai 等代理
 * - reasoningContent: 某些代理使用驼峰命名
 * - thinking_content: 某些代理使用这个名称
 */
const REASONING_FIELD_NAMES: ReasoningFieldName[] = [
  'reasoning_content',
  'reasoning',
  'reasoningContent',
  'thinking_content',
];

/**
 * 带 reasoning 字段的扩展消息类型
 */
type ExtendedMessageWithReasoning = {
  reasoning_content?: string;
  reasoning?: string;
  reasoningContent?: string;
  thinking_content?: string;
};

/**
 * 从扩展消息中提取 reasoning 内容
 * @returns { content, fieldName } 或 undefined
 */
function extractReasoningFromMessage(
  message: ExtendedMessageWithReasoning
): { content: string; fieldName: ReasoningFieldName } | undefined {
  for (const fieldName of REASONING_FIELD_NAMES) {
    const value = message[fieldName];
    if (value) {
      return { content: value, fieldName };
    }
  }
  return undefined;
}

/**
 * 过滤孤儿 tool 消息
 *
 * 孤儿 tool 消息是指 tool_call_id 对应的 assistant 消息不存在的 tool 消息。
 * 这种情况通常发生在上下文压缩后，导致 OpenAI API 返回 400 错误。
 */
function filterOrphanToolMessages(messages: Message[]): Message[] {
  // 收集所有可用的 tool_call ID
  const availableToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        availableToolCallIds.add(tc.id);
      }
    }
  }

  // 过滤掉孤儿 tool 消息
  return messages.filter((msg) => {
    if (msg.role === 'tool') {
      // 缺失 tool_call_id 的 tool 消息直接丢弃
      if (!msg.tool_call_id) {
        return false;
      }
      return availableToolCallIds.has(msg.tool_call_id);
    }
    return true;
  });
}

export class OpenAIChatService implements IChatService {
  private client: OpenAI;
  // 自动检测到的 reasoning 字段名（API 代理可能使用不同的字段名）
  private detectedReasoningFieldName: ReasoningFieldName | null = null;

  /**
   * 将内部 Message 转换为 OpenAI API 格式
   * 统一处理 tool 消息、assistant 消息（含 tool_calls）、普通消息
   * 支持多模态内容（文本 + 图片）
   */
  private convertToOpenAIMessages(messages: Message[]): ChatCompletionMessageParam[] {
    return messages.map((msg) => {
      if (msg.role === 'tool') {
        // tool 消息的 content 始终是字符串
        const toolContent = typeof msg.content === 'string'
          ? msg.content
          : msg.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
        return {
          role: 'tool',
          content: toolContent,
          tool_call_id: msg.tool_call_id!,
        };
      }

      if (msg.role === 'assistant' && msg.tool_calls) {
        // assistant 消息的 content 始终是字符串或 null
        const assistantContent = typeof msg.content === 'string'
          ? msg.content
          : msg.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');

        const baseMessage: any = {
          role: 'assistant',
          content: assistantContent || null,
          tool_calls: msg.tool_calls,
        };

        // 只有 thinking 模型才需要 reasoning 字段
        // DeepSeek API 要求：包含 tool_calls 的 assistant 消息必须有 reasoning 字段
        // 参考：https://api-docs.deepseek.com/guides/thinking_mode#tool-calls
        if (this.config.supportsThinking) {
          const reasoningValue =
            'reasoningContent' in msg && msg.reasoningContent ? msg.reasoningContent : '';

          if (this.detectedReasoningFieldName) {
            // 已检测到字段名，使用检测到的字段名
            baseMessage[this.detectedReasoningFieldName] = reasoningValue;
          } else {
            // 未检测到字段名，同时发送所有可能的字段名，避免死锁
            // 这样无论代理接受哪个字段名都能正常工作
            for (const fieldName of REASONING_FIELD_NAMES) {
              baseMessage[fieldName] = reasoningValue;
            }
          }
        }

        return baseMessage;
      }

      // 处理 user/system/assistant 消息
      // user 消息可能包含多模态内容（文本 + 图片）
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        // 多模态 user 消息：转换为 OpenAI Vision API 格式
        return {
          role: 'user',
          content: msg.content.map((part) => {
            if (part.type === 'text') {
              return { type: 'text' as const, text: part.text };
            }
            // image_url 类型
            return {
              type: 'image_url' as const,
              image_url: { url: part.image_url.url },
            };
          }),
        };
      }

      // 普通文本消息
      return {
        role: msg.role as 'user' | 'assistant' | 'system',
        content: typeof msg.content === 'string'
          ? msg.content
          : msg.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n'),
      };
    });
  }

  /**
   * 将工具定义转换为 OpenAI API 格式
   */
  private convertToOpenAITools(
    tools?: Array<{ name: string; description: string; parameters: any }>
  ): ChatCompletionTool[] | undefined {
    return tools?.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  /**
   * 从 API 响应中提取 reasoning 并更新检测到的字段名
   */
  private extractAndDetectReasoning(message: ExtendedMessageWithReasoning): string | undefined {
    const result = extractReasoningFromMessage(message);
    if (result) {
      // 保存检测到的字段名（用于后续发送请求时使用相同的字段名）
      if (!this.detectedReasoningFieldName) {
        this.detectedReasoningFieldName = result.fieldName;
        _logger.debug(`🧠 [ChatService] Detected reasoning field: ${result.fieldName}`);
      }
      return result.content;
    }
    return undefined;
  }

  constructor(private config: ChatConfig) {
    _logger.debug('🚀 [ChatService] Initializing ChatService');
    _logger.debug('⚙️ [ChatService] Config:', {
      model: config.model,
      baseUrl: config.baseUrl,
      temperature: config.temperature,
      maxContextTokens: config.maxContextTokens,
      timeout: config.timeout,
      hasApiKey: !!config.apiKey,
    });

    if (!config.baseUrl) {
      _logger.error('❌ [ChatService] baseUrl is required in ChatConfig');
      throw new Error('baseUrl is required in ChatConfig');
    }
    if (!config.apiKey) {
      _logger.error('❌ [ChatService] apiKey is required in ChatConfig');
      throw new Error('apiKey is required in ChatConfig');
    }
    if (!config.model) {
      _logger.error('❌ [ChatService] model is required in ChatConfig');
      throw new Error('model is required in ChatConfig');
    }

    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl, // OpenAI SDK 使用 baseURL
      timeout: config.timeout ?? 180000, // 180秒超时（长上下文场景需要更长时间）
      maxRetries: 3,
    });

    _logger.debug('✅ [ChatService] ChatService initialized successfully');
  }

  async chat(
    messages: Message[],
    tools?: Array<{
      name: string;
      description: string;
      parameters: any;
    }>,
    signal?: AbortSignal
  ): Promise<ChatResponse> {
    const startTime = Date.now();
    _logger.debug('🚀 [ChatService] Starting chat request');
    _logger.debug('📝 [ChatService] Messages count:', messages.length);

    // 过滤孤儿 tool 消息
    const filteredMessages = filterOrphanToolMessages(messages);
    if (filteredMessages.length < messages.length) {
      _logger.debug(
        `🔧 [ChatService] 过滤掉 ${messages.length - filteredMessages.length} 条孤儿 tool 消息`
      );
    }

    _logger.debug(
      '📝 [ChatService] Messages preview:',
      filteredMessages.map((m) => ({
        role: m.role,
        contentLength: typeof m.content === 'string' ? m.content.length : m.content.length,
        isMultimodal: Array.isArray(m.content),
      }))
    );

    const openaiMessages = this.convertToOpenAIMessages(filteredMessages);
    const openaiTools = this.convertToOpenAITools(tools);

    _logger.debug('🔧 [ChatService] Tools count:', openaiTools?.length || 0);
    if (openaiTools && openaiTools.length > 0) {
      _logger.debug(
        '🔧 [ChatService] Available tools:',
        openaiTools.map((t) => (t.type === 'function' ? t.function.name : 'unknown'))
      );
    }

    const requestParams = {
      model: this.config.model,
      messages: openaiMessages,
      tools: openaiTools,
      tool_choice:
        openaiTools && openaiTools.length > 0 ? ('auto' as const) : undefined,
      max_tokens: this.config.maxOutputTokens ?? 32768,
      temperature: this.config.temperature ?? 0.0,
    };

    _logger.debug('📤 [ChatService] Request params:', {
      model: requestParams.model,
      messagesCount: requestParams.messages.length,
      toolsCount: requestParams.tools?.length || 0,
      tool_choice: requestParams.tool_choice,
      max_tokens: requestParams.max_tokens,
      temperature: requestParams.temperature,
    });

    try {
      const completion = await this.client.chat.completions.create(requestParams, {
        signal,
      });
      const requestDuration = Date.now() - startTime;

      _logger.debug('📥 [ChatService] Response received in', requestDuration, 'ms');

      // ✅ 验证响应格式
      if (!completion) {
        _logger.error('❌ [ChatService] API returned null/undefined response');
        throw new Error('API returned null/undefined response');
      }

      if (!completion.choices || !Array.isArray(completion.choices)) {
        _logger.error(
          '❌ [ChatService] Invalid API response format - missing choices array'
        );
        _logger.error(
          '❌ [ChatService] Response object:',
          JSON.stringify(completion, null, 2)
        );
        throw new Error(
          `Invalid API response: missing choices array. Response: ${JSON.stringify(completion)}`
        );
      }

      if (completion.choices.length === 0) {
        _logger.error('❌ [ChatService] API returned empty choices array');
        throw new Error('API returned empty choices array');
      }

      _logger.debug('📊 [ChatService] Response usage:', completion.usage);
      _logger.debug(
        '📊 [ChatService] Response choices count:',
        completion.choices.length
      );

      const choice = completion.choices[0];
      if (!choice) {
        _logger.error('❌ [ChatService] No completion choice returned');
        throw new Error('No completion choice returned');
      }

      _logger.debug('📝 [ChatService] Response choice:', {
        finishReason: choice.finish_reason,
        contentLength: choice.message.content?.length || 0,
        hasToolCalls: !!choice.message.tool_calls,
        toolCallsCount: choice.message.tool_calls?.length || 0,
      });

      if (choice.message.tool_calls) {
        _logger.debug(
          '🔧 [ChatService] Tool calls:',
          choice.message.tool_calls.map((tc) => ({
            id: tc.id,
            type: tc.type,
            functionName: tc.type === 'function' ? tc.function?.name : 'unknown',
            functionArgsLength:
              tc.type === 'function' ? tc.function?.arguments?.length || 0 : 0,
          }))
        );
      }

      const toolCalls = choice.message.tool_calls?.filter(
        (tc): tc is ChatCompletionMessageToolCall => tc.type === 'function'
      );

      // 提取 reasoning（DeepSeek R1 等 thinking 模型的扩展字段）
      const extendedMessage = choice.message as typeof choice.message & ExtendedMessageWithReasoning;
      const reasoningContent = this.extractAndDetectReasoning(extendedMessage);

      // 调试日志：检查 API 实际返回的字段
      if (this.config.supportsThinking) {
        _logger.debug('🧠 [ChatService] Thinking model response:', {
          reasoningContentLength: reasoningContent?.length || 0,
          detectedFieldName: this.detectedReasoningFieldName,
          messageKeys: Object.keys(choice.message),
        });
      }

      // 提取 reasoning_tokens（thinking 模型的扩展 usage 字段）
      const extendedUsage = completion.usage as typeof completion.usage & {
        reasoning_tokens?: number;
      };

      const response = {
        content: choice.message.content || '',
        reasoningContent,
        toolCalls: toolCalls,
        usage: {
          promptTokens: completion.usage?.prompt_tokens || 0,
          completionTokens: completion.usage?.completion_tokens || 0,
          totalTokens: completion.usage?.total_tokens || 0,
          reasoningTokens: extendedUsage?.reasoning_tokens,
        },
      };

      _logger.debug('✅ [ChatService] Chat completed successfully');
      _logger.debug('📊 [ChatService] Final response:', {
        contentLength: response.content.length,
        toolCallsCount: response.toolCalls?.length || 0,
        usage: response.usage,
      });

      return response;
    } catch (error) {
      const requestDuration = Date.now() - startTime;
      _logger.error(
        '❌ [ChatService] Chat request failed after',
        requestDuration,
        'ms'
      );
      _logger.error('❌ [ChatService] Error details:', error);
      throw error;
    }
  }

  async *streamChat(
    messages: Message[],
    tools?: Array<{
      name: string;
      description: string;
      // biome-ignore lint/suspicious/noExplicitAny: 工具参数格式不确定
      parameters: any;
    }>,
    signal?: AbortSignal
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const startTime = Date.now();
    _logger.debug('🚀 [ChatService] Starting chat stream request');
    _logger.debug('📝 [ChatService] Messages count:', messages.length);

    // 过滤孤儿 tool 消息
    const filteredMessages = filterOrphanToolMessages(messages);
    if (filteredMessages.length < messages.length) {
      _logger.debug(
        `🔧 [ChatService] 过滤掉 ${messages.length - filteredMessages.length} 条孤儿 tool 消息`
      );
    }

    _logger.debug(
      '📝 [ChatService] Messages preview:',
      filteredMessages.map((m) => ({
        role: m.role,
        contentLength: typeof m.content === 'string' ? m.content.length : m.content.length,
        isMultimodal: Array.isArray(m.content),
      }))
    );

    const openaiMessages = this.convertToOpenAIMessages(filteredMessages);
    const openaiTools = this.convertToOpenAITools(tools);

    _logger.debug('🔧 [ChatService] Stream tools count:', openaiTools?.length || 0);
    if (openaiTools && openaiTools.length > 0) {
      _logger.debug(
        '🔧 [ChatService] Stream available tools:',
        openaiTools.map((t) => (t.type === 'function' ? t.function.name : 'unknown'))
      );
    }

    const requestParams = {
      model: this.config.model,
      messages: openaiMessages,
      tools: openaiTools,
      tool_choice:
        openaiTools && openaiTools.length > 0 ? ('auto' as const) : ('none' as const),
      max_tokens: this.config.maxOutputTokens ?? 32768,
      temperature: this.config.temperature ?? 0.0,
      stream: true as const,
    };

    _logger.debug('📤 [ChatService] Stream request params:', {
      model: requestParams.model,
      messagesCount: requestParams.messages.length,
      toolsCount: requestParams.tools?.length || 0,
      tool_choice: requestParams.tool_choice,
      max_tokens: requestParams.max_tokens,
      temperature: requestParams.temperature,
      stream: requestParams.stream,
    });

    try {
      const stream = await this.client.chat.completions.create(requestParams, {
        signal,
      });
      const requestDuration = Date.now() - startTime;
      _logger.debug('📥 [ChatService] Stream started in', requestDuration, 'ms');

      let chunkCount = 0;
      let totalContent = '';
      let totalReasoningContent = '';
      let toolCallsReceived = false;

      for await (const chunk of stream) {
        chunkCount++;

        // ✅ 验证 chunk 格式
        if (!chunk || !chunk.choices || !Array.isArray(chunk.choices)) {
          _logger.warn('⚠️ [ChatService] Invalid chunk format in stream', chunkCount);
          continue;
        }

        const delta = chunk.choices[0]?.delta;
        if (!delta) {
          _logger.warn('⚠️ [ChatService] Empty delta in chunk', chunkCount);
          continue;
        }

        // 提取 reasoning（DeepSeek R1 等 thinking 模型的扩展字段）
        const extendedDelta = delta as typeof delta & ExtendedMessageWithReasoning;
        const reasoningChunk = this.extractAndDetectReasoning(extendedDelta);

        if (delta.content) {
          totalContent += delta.content;
        }

        if (reasoningChunk) {
          totalReasoningContent += reasoningChunk;
        }

        if (delta.tool_calls && !toolCallsReceived) {
          toolCallsReceived = true;
          _logger.debug('🔧 [ChatService] Tool calls detected in stream');
        }

        const finishReason = chunk.choices[0]?.finish_reason;
        if (finishReason) {
          _logger.debug('🏁 [ChatService] Stream finished with reason:', finishReason);
          _logger.debug('📊 [ChatService] Stream summary:', {
            totalChunks: chunkCount,
            totalContentLength: totalContent.length,
            totalReasoningContentLength: totalReasoningContent.length,
            hadToolCalls: toolCallsReceived,
            duration: Date.now() - startTime + 'ms',
          });
        }

        yield {
          content: delta.content || undefined,
          reasoningContent: reasoningChunk,
          toolCalls: delta.tool_calls,
          finishReason: finishReason || undefined,
        };
      }

      _logger.debug('✅ [ChatService] Stream completed successfully');
    } catch (error) {
      const requestDuration = Date.now() - startTime;
      _logger.error(
        '❌ [ChatService] Stream request failed after',
        requestDuration,
        'ms'
      );
      _logger.error('❌ [ChatService] Stream error details:', error);
      throw error;
    }
  }

  getConfig(): ChatConfig {
    return { ...this.config };
  }

  updateConfig(newConfig: Partial<ChatConfig>): void {
    _logger.debug('🔄 [ChatService] Updating configuration');
    _logger.debug('🔄 [ChatService] New config:', {
      model: newConfig.model,
      baseUrl: newConfig.baseUrl,
      temperature: newConfig.temperature,
      maxContextTokens: newConfig.maxContextTokens,
      timeout: newConfig.timeout,
      hasApiKey: !!newConfig.apiKey,
    });

    const oldConfig = { ...this.config };
    this.config = { ...this.config, ...newConfig };

    // 如果 baseUrl 变化，重置检测到的字段名（不同代理可能使用不同字段名）
    if (oldConfig.baseUrl !== this.config.baseUrl) {
      this.detectedReasoningFieldName = null;
      _logger.debug('🔄 [ChatService] Reset detectedReasoningFieldName due to baseUrl change');
    }

    this.client = new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseUrl, // OpenAI SDK 使用 baseURL
      timeout: this.config.timeout ?? 180000, // 180秒超时（长上下文场景需要更长时间）
      maxRetries: 2, // 2次重试，平衡稳定性和响应速度
    });

    _logger.debug('✅ [ChatService] Configuration updated successfully');
    _logger.debug('📊 [ChatService] Config changes:', {
      modelChanged: oldConfig.model !== this.config.model,
      baseUrlChanged: oldConfig.baseUrl !== this.config.baseUrl,
      temperatureChanged: oldConfig.temperature !== this.config.temperature,
      maxContextTokensChanged:
        oldConfig.maxContextTokens !== this.config.maxContextTokens,
      timeoutChanged: oldConfig.timeout !== this.config.timeout,
      apiKeyChanged: oldConfig.apiKey !== this.config.apiKey,
    });
  }
}

/**
 * 向后兼容导出
 */
export { OpenAIChatService as ChatService };
