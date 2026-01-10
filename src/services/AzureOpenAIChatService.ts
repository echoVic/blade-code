/**
 * Azure OpenAI Chat Service
 *
 * 使用 OpenAI SDK 的 Azure 配置实现 Azure OpenAI API 的聊天服务
 *
 * 主要差异（与标准 OpenAI API 相比）：
 * 1. 端点格式不同：https://{resource}.openai.azure.com/openai/deployments/{deployment}
 * 2. 使用 api-key 头而非 Authorization 头
 * 3. 需要指定 api-version 参数
 * 4. model 参数是部署名称而非模型 ID
 */

import { AzureOpenAI } from 'openai';
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
  StreamChunk,
} from './ChatServiceInterface.js';

const _logger = createLogger(LogCategory.CHAT);

/**
 * 过滤孤儿 tool 消息
 */
function filterOrphanToolMessages(messages: Message[]): Message[] {
  const availableToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        availableToolCallIds.add(tc.id);
      }
    }
  }

  return messages.filter((msg) => {
    if (msg.role === 'tool') {
      if (!msg.tool_call_id) {
        return false;
      }
      return availableToolCallIds.has(msg.tool_call_id);
    }
    return true;
  });
}

export class AzureOpenAIChatService implements IChatService {
  private client: AzureOpenAI;
  private config: ChatConfig;

  constructor(config: ChatConfig) {
    this.config = config;

    _logger.debug('🚀 [AzureOpenAIChatService] Initializing');
    _logger.debug('⚙️ [AzureOpenAIChatService] Config:', {
      model: config.model,
      baseUrl: config.baseUrl,
      temperature: config.temperature,
      maxContextTokens: config.maxContextTokens,
      timeout: config.timeout,
      apiVersion: config.apiVersion,
      hasApiKey: !!config.apiKey,
    });

    if (!config.apiKey) {
      _logger.error('❌ [AzureOpenAIChatService] apiKey is required');
      throw new Error('apiKey is required in ChatConfig');
    }
    if (!config.baseUrl) {
      _logger.error('❌ [AzureOpenAIChatService] baseUrl is required');
      throw new Error('baseUrl is required in ChatConfig');
    }
    if (!config.model) {
      _logger.error('❌ [AzureOpenAIChatService] model (deployment) is required');
      throw new Error('model (deployment) is required in ChatConfig');
    }

    // Azure OpenAI 需要配置 endpoint 和 apiVersion
    // baseUrl 应该是 Azure OpenAI 端点，如 https://{resource}.openai.azure.com
    this.client = new AzureOpenAI({
      apiKey: config.apiKey,
      endpoint: config.baseUrl,
      apiVersion: config.apiVersion || '2024-08-01-preview',
      timeout: config.timeout ?? 180000,
      maxRetries: 3,
    });

    _logger.debug('✅ [AzureOpenAIChatService] Initialized successfully');
  }

  /**
   * 将内部 Message 转换为 OpenAI API 格式
   */
  private convertToOpenAIMessages(messages: Message[]): ChatCompletionMessageParam[] {
    return messages.map((msg) => {
      if (msg.role === 'tool') {
        const toolContent =
          typeof msg.content === 'string'
            ? msg.content
            : msg.content
                .filter((p) => p.type === 'text')
                .map((p) => p.text)
                .join('\n');
        return {
          role: 'tool',
          content: toolContent,
          tool_call_id: msg.tool_call_id!,
        };
      }

      if (msg.role === 'assistant' && msg.tool_calls) {
        const assistantContent =
          typeof msg.content === 'string'
            ? msg.content
            : msg.content
                .filter((p) => p.type === 'text')
                .map((p) => p.text)
                .join('\n');

        return {
          role: 'assistant',
          content: assistantContent || null,
          tool_calls: msg.tool_calls,
        };
      }

      if (msg.role === 'user' && Array.isArray(msg.content)) {
        return {
          role: 'user',
          content: msg.content.map((part) => {
            if (part.type === 'text') {
              return { type: 'text' as const, text: part.text };
            }
            return {
              type: 'image_url' as const,
              image_url: { url: part.image_url.url },
            };
          }),
        };
      }

      return {
        role: msg.role as 'user' | 'assistant' | 'system',
        content:
          typeof msg.content === 'string'
            ? msg.content
            : msg.content
                .filter((p) => p.type === 'text')
                .map((p) => p.text)
                .join('\n'),
      };
    });
  }

  /**
   * 将工具定义转换为 OpenAI API 格式
   */
  private convertToOpenAITools(
    tools?: Array<{ name: string; description: string; parameters: unknown }>
  ): ChatCompletionTool[] | undefined {
    return tools?.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as Record<string, unknown>,
      },
    }));
  }

  async chat(
    messages: Message[],
    tools?: Array<{
      name: string;
      description: string;
      parameters: unknown;
    }>,
    signal?: AbortSignal
  ): Promise<ChatResponse> {
    const startTime = Date.now();
    _logger.debug('🚀 [AzureOpenAIChatService] Starting chat request');
    _logger.debug('📝 [AzureOpenAIChatService] Messages count:', messages.length);

    const filteredMessages = filterOrphanToolMessages(messages);
    if (filteredMessages.length < messages.length) {
      _logger.debug(
        `🔧 [AzureOpenAIChatService] 过滤掉 ${messages.length - filteredMessages.length} 条孤儿 tool 消息`
      );
    }

    const openaiMessages = this.convertToOpenAIMessages(filteredMessages);
    const openaiTools = this.convertToOpenAITools(tools);

    _logger.debug('🔧 [AzureOpenAIChatService] Tools count:', openaiTools?.length || 0);

    const requestParams = {
      model: this.config.model, // Azure 中这是部署名称
      messages: openaiMessages,
      tools: openaiTools,
      tool_choice:
        openaiTools && openaiTools.length > 0 ? ('auto' as const) : undefined,
      max_tokens: this.config.maxOutputTokens ?? 32768,
      temperature: this.config.temperature ?? 0.0,
    };

    _logger.debug('📤 [AzureOpenAIChatService] Request params:', {
      model: requestParams.model,
      messagesCount: requestParams.messages.length,
      toolsCount: requestParams.tools?.length || 0,
      max_tokens: requestParams.max_tokens,
      temperature: requestParams.temperature,
    });

    try {
      const completion = await this.client.chat.completions.create(requestParams, {
        signal,
      });
      const requestDuration = Date.now() - startTime;

      _logger.debug(
        '📥 [AzureOpenAIChatService] Response received in',
        requestDuration,
        'ms'
      );

      if (!completion || !completion.choices || completion.choices.length === 0) {
        throw new Error('Invalid API response: missing choices');
      }

      const choice = completion.choices[0];
      if (!choice) {
        throw new Error('No completion choice returned');
      }

      const toolCalls = choice.message.tool_calls?.filter(
        (tc): tc is ChatCompletionMessageToolCall => tc.type === 'function'
      );

      const response = {
        content: choice.message.content || '',
        toolCalls: toolCalls,
        usage: {
          promptTokens: completion.usage?.prompt_tokens || 0,
          completionTokens: completion.usage?.completion_tokens || 0,
          totalTokens: completion.usage?.total_tokens || 0,
        },
      };

      _logger.debug('✅ [AzureOpenAIChatService] Chat completed successfully');
      _logger.debug('📊 [AzureOpenAIChatService] Final response:', {
        contentLength: response.content.length,
        toolCallsCount: response.toolCalls?.length || 0,
        usage: response.usage,
      });

      return response;
    } catch (error) {
      const requestDuration = Date.now() - startTime;
      _logger.error(
        '❌ [AzureOpenAIChatService] Chat request failed after',
        requestDuration,
        'ms'
      );
      _logger.error('❌ [AzureOpenAIChatService] Error details:', error);
      throw error;
    }
  }

  async *streamChat(
    messages: Message[],
    tools?: Array<{
      name: string;
      description: string;
      parameters: unknown;
    }>,
    signal?: AbortSignal
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const startTime = Date.now();
    _logger.debug('🚀 [AzureOpenAIChatService] Starting stream request');
    _logger.debug('📝 [AzureOpenAIChatService] Messages count:', messages.length);

    const filteredMessages = filterOrphanToolMessages(messages);
    if (filteredMessages.length < messages.length) {
      _logger.debug(
        `🔧 [AzureOpenAIChatService] 过滤掉 ${messages.length - filteredMessages.length} 条孤儿 tool 消息`
      );
    }

    const openaiMessages = this.convertToOpenAIMessages(filteredMessages);
    const openaiTools = this.convertToOpenAITools(tools);

    _logger.debug(
      '🔧 [AzureOpenAIChatService] Stream tools count:',
      openaiTools?.length || 0
    );

    const requestParams = {
      model: this.config.model,
      messages: openaiMessages,
      tools: openaiTools,
      tool_choice:
        openaiTools && openaiTools.length > 0 ? ('auto' as const) : undefined,
      max_tokens: this.config.maxOutputTokens ?? 32768,
      temperature: this.config.temperature ?? 0.0,
      stream: true as const,
    };

    _logger.debug('📤 [AzureOpenAIChatService] Stream request params:', {
      model: requestParams.model,
      messagesCount: requestParams.messages.length,
      toolsCount: requestParams.tools?.length || 0,
      max_tokens: requestParams.max_tokens,
      temperature: requestParams.temperature,
    });

    try {
      const stream = await this.client.chat.completions.create(requestParams, {
        signal,
      });
      const requestDuration = Date.now() - startTime;
      _logger.debug(
        '📥 [AzureOpenAIChatService] Stream started in',
        requestDuration,
        'ms'
      );

      let chunkCount = 0;
      let totalContent = '';
      let toolCallsReceived = false;

      for await (const chunk of stream) {
        chunkCount++;

        if (!chunk || !chunk.choices || !Array.isArray(chunk.choices)) {
          _logger.warn(
            '⚠️ [AzureOpenAIChatService] Invalid chunk format in stream',
            chunkCount
          );
          continue;
        }

        const delta = chunk.choices[0]?.delta;
        if (!delta) {
          _logger.warn('⚠️ [AzureOpenAIChatService] Empty delta in chunk', chunkCount);
          continue;
        }

        if (delta.content) {
          totalContent += delta.content;
        }

        if (delta.tool_calls && !toolCallsReceived) {
          toolCallsReceived = true;
          _logger.debug('🔧 [AzureOpenAIChatService] Tool calls detected in stream');
        }

        const finishReason = chunk.choices[0]?.finish_reason;
        if (finishReason) {
          _logger.debug(
            '🏁 [AzureOpenAIChatService] Stream finished with reason:',
            finishReason
          );
          _logger.debug('📊 [AzureOpenAIChatService] Stream summary:', {
            totalChunks: chunkCount,
            totalContentLength: totalContent.length,
            hadToolCalls: toolCallsReceived,
            duration: Date.now() - startTime + 'ms',
          });
        }

        yield {
          content: delta.content || undefined,
          toolCalls: delta.tool_calls,
          finishReason: finishReason || undefined,
        };
      }

      _logger.debug('✅ [AzureOpenAIChatService] Stream completed successfully');
    } catch (error) {
      const requestDuration = Date.now() - startTime;
      _logger.error(
        '❌ [AzureOpenAIChatService] Stream request failed after',
        requestDuration,
        'ms'
      );
      _logger.error('❌ [AzureOpenAIChatService] Stream error details:', error);
      throw error;
    }
  }

  getConfig(): ChatConfig {
    return { ...this.config };
  }

  updateConfig(newConfig: Partial<ChatConfig>): void {
    _logger.debug('🔄 [AzureOpenAIChatService] Updating configuration');

    this.config = { ...this.config, ...newConfig };

    this.client = new AzureOpenAI({
      apiKey: this.config.apiKey,
      endpoint: this.config.baseUrl,
      apiVersion: this.config.apiVersion || '2024-08-01-preview',
      timeout: this.config.timeout ?? 180000,
      maxRetries: 3,
    });

    _logger.debug('✅ [AzureOpenAIChatService] Configuration updated successfully');
  }
}
