/**
 * GPT OpenAI Platform ChatService
 * 字节跳动内部 GPT 平台专用的 ChatService 实现
 *
 * 主要特点：
 * 1. 每次请求自动生成 x-tt-logid header
 * 2. 支持可选的 apiVersion 配置
 */

import { randomUUID } from 'node:crypto';
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
  StreamChunk,
} from './ChatServiceInterface.js';

const _logger = createLogger(LogCategory.CHAT);

/**
 * 生成 x-tt-logid
 * 格式：32位 hex + "01" 后缀
 */
function generateLogId(): string {
  return randomUUID().replace(/-/g, '') + '01';
}

/**
 * 检查是否是 Gemini 模型
 */
function isGeminiModel(model: string): boolean {
  return model.toLowerCase().includes('gemini');
}

/**
 * 清理工具参数中 Gemini API 不支持的字段
 * Gemini 不支持: $schema, additionalProperties
 */
// biome-ignore lint/suspicious/noExplicitAny: 需要处理任意 JSON Schema 结构
function cleanToolParametersForGemini(params: any): any {
  if (!params || typeof params !== 'object') {
    return params;
  }

  if (Array.isArray(params)) {
    return params.map(cleanToolParametersForGemini);
  }

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    // 跳过 Gemini 不支持的字段
    if (key === '$schema' || key === 'additionalProperties') {
      continue;
    }
    cleaned[key] = cleanToolParametersForGemini(value);
  }
  return cleaned;
}

/**
 * 为 Gemini 修复消息，确保 tool_call 和 tool_result 一一对应
 *
 * Gemini API 要求：
 * 1. 每个 tool_call 必须有对应的 tool result
 * 2. 每个 tool result 必须有对应的 tool_call
 *
 * 策略：
 * - 孤儿 tool results（没有对应 tool_call）：删除
 * - 孤儿 tool_calls（没有对应 result）：添加占位符 result
 * 这样可以保留上下文，避免死循环
 */
function fixMessagesForGemini(messages: Message[]): Message[] {
  // 1. 收集所有 tool_call IDs 及其位置
  const toolCallMap = new Map<string, number>(); // id -> assistant message index
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolCallMap.set(tc.id, i);
      }
    }
  }

  // 2. 收集所有 tool result 的 tool_call_ids
  const toolResultIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.tool_call_id) {
      toolResultIds.add(msg.tool_call_id);
    }
  }

  // 3. 找到需要补充的 tool_call IDs（有 tool_call 但没有 result）
  const missingResultIds: string[] = [];
  for (const id of toolCallMap.keys()) {
    if (!toolResultIds.has(id)) {
      missingResultIds.push(id);
    }
  }

  // 4. 构建修复后的消息列表
  const fixed: Message[] = [];
  for (const msg of messages) {
    if (msg.role === 'tool') {
      // 只保留有对应 tool_call 的 tool results
      if (msg.tool_call_id && toolCallMap.has(msg.tool_call_id)) {
        fixed.push(msg);
      }
      // 孤儿 tool results 被丢弃
    } else {
      fixed.push(msg);

      // 如果是 assistant 消息且有 tool_calls，检查是否需要补充 results
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (missingResultIds.includes(tc.id)) {
            // 添加占位符 tool result
            fixed.push({
              role: 'tool',
              content: '[Result lost due to context compression]',
              tool_call_id: tc.id,
            });
          }
        }
      }
    }
  }

  if (missingResultIds.length > 0) {
    _logger.debug(
      `🔧 [GptOpenaiPlatformChatService] Gemini 修复：补充 ${missingResultIds.length} 个缺失的 tool results`
    );
  }

  return fixed;
}

export class GptOpenaiPlatformChatService implements IChatService {
  private config: ChatConfig;

  constructor(config: ChatConfig) {
    _logger.debug('🚀 [GptOpenaiPlatformChatService] Initializing');
    _logger.debug('⚙️ [GptOpenaiPlatformChatService] Config:', {
      model: config.model,
      baseUrl: config.baseUrl,
      apiVersion: config.apiVersion,
      temperature: config.temperature,
      maxContextTokens: config.maxContextTokens,
      timeout: config.timeout,
      hasApiKey: !!config.apiKey,
    });

    if (!config.baseUrl) {
      _logger.error('❌ [GptOpenaiPlatformChatService] baseUrl is required');
      throw new Error('baseUrl is required in ChatConfig');
    }
    if (!config.apiKey) {
      _logger.error('❌ [GptOpenaiPlatformChatService] apiKey is required');
      throw new Error('apiKey is required in ChatConfig');
    }
    if (!config.model) {
      _logger.error('❌ [GptOpenaiPlatformChatService] model is required');
      throw new Error('model is required in ChatConfig');
    }

    this.config = config;
    _logger.debug('✅ [GptOpenaiPlatformChatService] Initialized successfully');
  }

  /**
   * 创建一个新的 OpenAI 客户端（每次请求都创建，以生成新的 logid）
   */
  private createClient(): OpenAI {
    const logId = generateLogId();
    _logger.debug('🔑 [GptOpenaiPlatformChatService] Generated logid:', logId);

    const defaultQuery: Record<string, string> = {};
    const defaultHeaders: Record<string, string> = {
      'api-key': this.config.apiKey,
      'x-tt-logid': logId,
    };

    // 如果配置了 apiVersion，添加到 query 参数中
    if (this.config.apiVersion) {
      defaultQuery['api-version'] = this.config.apiVersion;
    }

    return new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseUrl,
      timeout: this.config.timeout ?? 180000,
      maxRetries: 3,
      defaultQuery,
      defaultHeaders,
    });
  }

  async chat(
    messages: Message[],
    tools?: Array<{
      name: string;
      description: string;
      // biome-ignore lint/suspicious/noExplicitAny: 工具参数格式不确定
      parameters: any;
    }>,
    signal?: AbortSignal
  ): Promise<ChatResponse> {
    const startTime = Date.now();
    _logger.debug('🚀 [GptOpenaiPlatformChatService] Starting chat request');
    _logger.debug('📝 [GptOpenaiPlatformChatService] Messages count:', messages.length);

    const client = this.createClient();
    const isGemini = isGeminiModel(this.config.model);

    // Gemini 需要修复消息确保 tool_call/result 配对（补充缺失的 results 而非删除）
    const filteredMessages = isGemini ? fixMessagesForGemini(messages) : messages;

    const openaiMessages: ChatCompletionMessageParam[] = filteredMessages.map((msg) => {
      if (msg.role === 'tool') {
        // tool 消息的 content 需要是字符串
        const toolContent = typeof msg.content === 'string'
          ? msg.content
          : msg.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
        return {
          role: 'tool',
          content: toolContent,
          tool_call_id: msg.tool_call_id!,
        };
      }
      if (msg.role === 'assistant' && msg.tool_calls) {
        // assistant 消息的 content 需要是字符串或 null
        const assistantContent = typeof msg.content === 'string'
          ? msg.content
          : msg.content?.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
        return {
          role: 'assistant',
          content: assistantContent || null,
          tool_calls: msg.tool_calls,
        };
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
          : msg.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n'),
      };
    });

    const openaiTools: ChatCompletionTool[] | undefined = tools?.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: isGemini
          ? cleanToolParametersForGemini(tool.parameters)
          : tool.parameters,
      },
    }));

    _logger.debug(
      '🔧 [GptOpenaiPlatformChatService] Tools count:',
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
    };

    _logger.debug('📤 [GptOpenaiPlatformChatService] Request params:', {
      model: requestParams.model,
      messagesCount: requestParams.messages.length,
      toolsCount: requestParams.tools?.length || 0,
      tool_choice: requestParams.tool_choice,
      max_tokens: requestParams.max_tokens,
      temperature: requestParams.temperature,
    });

    try {
      const completion = await client.chat.completions.create(requestParams, {
        signal,
      });
      const requestDuration = Date.now() - startTime;

      _logger.debug(
        '📥 [GptOpenaiPlatformChatService] Response received in',
        requestDuration,
        'ms'
      );

      // 验证响应格式
      if (!completion) {
        _logger.error(
          '❌ [GptOpenaiPlatformChatService] API returned null/undefined response'
        );
        throw new Error('API returned null/undefined response');
      }

      if (!completion.choices || !Array.isArray(completion.choices)) {
        _logger.error(
          '❌ [GptOpenaiPlatformChatService] Invalid API response format - missing choices array'
        );
        throw new Error(
          `Invalid API response: missing choices array. Response: ${JSON.stringify(completion)}`
        );
      }

      if (completion.choices.length === 0) {
        _logger.error(
          '❌ [GptOpenaiPlatformChatService] API returned empty choices array'
        );
        throw new Error('API returned empty choices array');
      }

      const choice = completion.choices[0];
      if (!choice) {
        _logger.error(
          '❌ [GptOpenaiPlatformChatService] No completion choice returned'
        );
        throw new Error('No completion choice returned');
      }

      _logger.debug('📝 [GptOpenaiPlatformChatService] Response choice:', {
        finishReason: choice.finish_reason,
        contentLength: choice.message.content?.length || 0,
        hasToolCalls: !!choice.message.tool_calls,
        toolCallsCount: choice.message.tool_calls?.length || 0,
      });

      const toolCalls = choice.message.tool_calls?.filter(
        (tc): tc is ChatCompletionMessageToolCall => tc.type === 'function'
      );

      // 提取 reasoning_content（如果有）
      const extendedMessage = choice.message as typeof choice.message & {
        reasoning_content?: string;
      };
      const reasoningContent = extendedMessage.reasoning_content || undefined;

      // 提取 reasoning_tokens
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

      _logger.debug('✅ [GptOpenaiPlatformChatService] Chat completed successfully');
      return response;
    } catch (error) {
      const requestDuration = Date.now() - startTime;
      _logger.error(
        '❌ [GptOpenaiPlatformChatService] Chat request failed after',
        requestDuration,
        'ms'
      );
      _logger.error('❌ [GptOpenaiPlatformChatService] Error details:', error);
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
    _logger.debug('🚀 [GptOpenaiPlatformChatService] Starting stream request');
    _logger.debug('📝 [GptOpenaiPlatformChatService] Messages count:', messages.length);

    const client = this.createClient();
    const isGemini = isGeminiModel(this.config.model);

    // Gemini 需要修复消息确保 tool_call/result 配对（补充缺失的 results 而非删除）
    const filteredMessages = isGemini ? fixMessagesForGemini(messages) : messages;

    const openaiMessages: ChatCompletionMessageParam[] = filteredMessages.map((msg) => {
      if (msg.role === 'tool') {
        // tool 消息的 content 需要是字符串
        const toolContent = typeof msg.content === 'string'
          ? msg.content
          : msg.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
        return {
          role: 'tool',
          content: toolContent,
          tool_call_id: msg.tool_call_id!,
        };
      }
      if (msg.role === 'assistant' && msg.tool_calls) {
        // assistant 消息的 content 需要是字符串或 null
        const assistantContent = typeof msg.content === 'string'
          ? msg.content
          : msg.content?.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
        return {
          role: 'assistant',
          content: assistantContent || null,
          tool_calls: msg.tool_calls,
        };
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
          : msg.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n'),
      };
    });

    const openaiTools: ChatCompletionTool[] | undefined = tools?.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: isGemini
          ? cleanToolParametersForGemini(tool.parameters)
          : tool.parameters,
      },
    }));

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

    _logger.debug('📤 [GptOpenaiPlatformChatService] Stream request params:', {
      model: requestParams.model,
      messagesCount: requestParams.messages.length,
      toolsCount: requestParams.tools?.length || 0,
    });

    try {
      const stream = await client.chat.completions.create(requestParams, {
        signal,
      });
      const requestDuration = Date.now() - startTime;
      _logger.debug(
        '📥 [GptOpenaiPlatformChatService] Stream started in',
        requestDuration,
        'ms'
      );

      let chunkCount = 0;
      let totalContent = '';
      let totalReasoningContent = '';
      let toolCallsReceived = false;

      for await (const chunk of stream) {
        chunkCount++;

        if (!chunk || !chunk.choices || !Array.isArray(chunk.choices)) {
          _logger.warn(
            '⚠️ [GptOpenaiPlatformChatService] Invalid chunk format in stream',
            chunkCount
          );
          continue;
        }

        const delta = chunk.choices[0]?.delta;
        if (!delta) {
          continue;
        }

        const extendedDelta = delta as typeof delta & {
          reasoning_content?: string;
        };

        if (delta.content) {
          totalContent += delta.content;
        }

        if (extendedDelta.reasoning_content) {
          totalReasoningContent += extendedDelta.reasoning_content;
        }

        if (delta.tool_calls && !toolCallsReceived) {
          toolCallsReceived = true;
          _logger.debug(
            '🔧 [GptOpenaiPlatformChatService] Tool calls detected in stream'
          );
        }

        const finishReason = chunk.choices[0]?.finish_reason;
        if (finishReason) {
          _logger.debug(
            '🏁 [GptOpenaiPlatformChatService] Stream finished with reason:',
            finishReason
          );
          _logger.debug('📊 [GptOpenaiPlatformChatService] Stream summary:', {
            totalChunks: chunkCount,
            totalContentLength: totalContent.length,
            totalReasoningContentLength: totalReasoningContent.length,
            hadToolCalls: toolCallsReceived,
            duration: Date.now() - startTime + 'ms',
          });
        }

        yield {
          content: delta.content || undefined,
          reasoningContent: extendedDelta.reasoning_content || undefined,
          toolCalls: delta.tool_calls,
          finishReason: finishReason || undefined,
        };
      }

      _logger.debug('✅ [GptOpenaiPlatformChatService] Stream completed successfully');
    } catch (error) {
      const requestDuration = Date.now() - startTime;
      _logger.error(
        '❌ [GptOpenaiPlatformChatService] Stream request failed after',
        requestDuration,
        'ms'
      );
      _logger.error('❌ [GptOpenaiPlatformChatService] Stream error details:', error);
      throw error;
    }
  }

  getConfig(): ChatConfig {
    return { ...this.config };
  }

  updateConfig(newConfig: Partial<ChatConfig>): void {
    _logger.debug('🔄 [GptOpenaiPlatformChatService] Updating configuration');
    this.config = { ...this.config, ...newConfig };
    _logger.debug(
      '✅ [GptOpenaiPlatformChatService] Configuration updated successfully'
    );
  }
}
