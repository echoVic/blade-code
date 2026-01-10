/**
 * Anthropic Chat Service
 *
 * 使用 @anthropic-ai/sdk 实现 Anthropic Claude API 的聊天服务
 *
 * 主要差异（与 OpenAI API 相比）：
 * 1. System 消息是独立字段，不在 messages 数组中
 * 2. Tool calls 使用 tool_use content block 格式
 * 3. Tool results 使用 user 消息 + tool_result block 格式
 * 4. 流式响应中工具参数是 JSON 片段，需要累积
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlock,
  ImageBlockParam,
  MessageParam,
  TextBlockParam,
  Tool,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages';
import type { ChatCompletionMessageToolCall } from 'openai/resources/chat';
import { createLogger, LogCategory } from '../logging/Logger.js';
import type {
  ChatConfig,
  ChatResponse,
  ContentPart,
  IChatService,
  Message,
  StreamChunk,
} from './ChatServiceInterface.js';

const _logger = createLogger(LogCategory.CHAT);

/**
 * 从 data URL 或 base64 字符串中提取媒体类型
 */
function extractMediaType(
  url: string
): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
  if (url.startsWith('data:')) {
    const match = url.match(/^data:([^;,]+)/);
    if (match) {
      const mediaType = match[1];
      if (
        mediaType === 'image/jpeg' ||
        mediaType === 'image/png' ||
        mediaType === 'image/gif' ||
        mediaType === 'image/webp'
      ) {
        return mediaType;
      }
    }
  }
  // 默认 PNG
  return 'image/png';
}

/**
 * 从 data URL 中提取 base64 数据
 */
function extractBase64Data(url: string): string {
  if (url.startsWith('data:')) {
    const commaIndex = url.indexOf(',');
    if (commaIndex !== -1) {
      return url.slice(commaIndex + 1);
    }
  }
  return url;
}

/**
 * 过滤孤儿 tool 消息
 *
 * 孤儿 tool 消息是指 tool_call_id 对应的 assistant 消息不存在的 tool 消息。
 * 这种情况通常发生在上下文压缩后。
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
      if (!msg.tool_call_id) {
        return false;
      }
      return availableToolCallIds.has(msg.tool_call_id);
    }
    return true;
  });
}

/**
 * 将内部 Message 内容转为纯文本
 */
function getTextContent(content: string | ContentPart[]): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

export class AnthropicChatService implements IChatService {
  private client: Anthropic;
  private config: ChatConfig;

  constructor(config: ChatConfig) {
    this.config = config;

    _logger.debug('🚀 [AnthropicChatService] Initializing');
    _logger.debug('⚙️ [AnthropicChatService] Config:', {
      model: config.model,
      baseUrl: config.baseUrl,
      temperature: config.temperature,
      maxContextTokens: config.maxContextTokens,
      timeout: config.timeout,
      hasApiKey: !!config.apiKey,
    });

    if (!config.apiKey) {
      _logger.error('❌ [AnthropicChatService] apiKey is required');
      throw new Error('apiKey is required in ChatConfig');
    }
    if (!config.model) {
      _logger.error('❌ [AnthropicChatService] model is required');
      throw new Error('model is required in ChatConfig');
    }

    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl || undefined, // Anthropic 默认使用官方 API
      timeout: config.timeout ?? 180000,
      maxRetries: 3,
    });

    _logger.debug('✅ [AnthropicChatService] Initialized successfully');
  }

  /**
   * 将内部 Message[] 转换为 Anthropic API 格式
   *
   * 关键差异处理：
   * 1. system 消息提取到独立字段
   * 2. tool 消息转为 user + tool_result block
   * 3. assistant 的 tool_calls 转为 tool_use blocks
   */
  private convertToAnthropicMessages(messages: Message[]): {
    system: string | undefined;
    messages: MessageParam[];
  } {
    // 1. 提取 system 消息
    const systemMsg = messages.find((m) => m.role === 'system');
    const system = systemMsg ? getTextContent(systemMsg.content) : undefined;

    // 2. 转换其他消息
    const anthropicMessages: MessageParam[] = [];
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    for (let i = 0; i < nonSystemMessages.length; i++) {
      const msg = nonSystemMessages[i];

      if (msg.role === 'assistant') {
        // assistant 消息：可能包含 text 和 tool_use blocks
        // 使用 ContentBlockParam 代替具体类型以获得更好的类型兼容性
        const contentBlocks: Array<
          | { type: 'text'; text: string }
          | {
              type: 'tool_use';
              id: string;
              name: string;
              input: Record<string, unknown>;
            }
        > = [];

        // 添加文本内容
        const text = getTextContent(msg.content);
        if (text) {
          contentBlocks.push({ type: 'text', text });
        }

        // 转换 tool_calls 为 tool_use blocks
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            // 类型守卫：确保是 function 类型的 tool call
            if (tc.type !== 'function') continue;

            let input: Record<string, unknown> = {};
            try {
              input = JSON.parse(tc.function.arguments || '{}');
            } catch {
              _logger.warn(
                `⚠️ [AnthropicChatService] Failed to parse tool arguments: ${tc.function.arguments}`
              );
            }

            contentBlocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input,
            });
          }
        }

        if (contentBlocks.length > 0) {
          anthropicMessages.push({
            role: 'assistant',
            content: contentBlocks,
          });
        }
      } else if (msg.role === 'tool') {
        // tool 消息：转换为 user + tool_result block
        // Anthropic 要求 tool_result 必须在 user 消息中
        const toolResult: ToolResultBlockParam = {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id!,
          content: getTextContent(msg.content),
        };

        // 检查上一条是否是 user 消息（含 tool_result）
        const lastMsg = anthropicMessages[anthropicMessages.length - 1];
        if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
          // 追加到现有 user 消息
          (lastMsg.content as ToolResultBlockParam[]).push(toolResult);
        } else {
          // 创建新的 user 消息
          anthropicMessages.push({
            role: 'user',
            content: [toolResult],
          });
        }
      } else if (msg.role === 'user') {
        // user 消息：支持多模态（文本 + 图片）
        if (Array.isArray(msg.content)) {
          const contentBlocks: (TextBlockParam | ImageBlockParam)[] = [];

          for (const part of msg.content) {
            if (part.type === 'text') {
              contentBlocks.push({ type: 'text', text: part.text });
            } else if (part.type === 'image_url') {
              // 转换 OpenAI Vision 格式到 Anthropic 格式
              const url = part.image_url.url;
              contentBlocks.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: extractMediaType(url),
                  data: extractBase64Data(url),
                },
              });
            }
          }

          anthropicMessages.push({ role: 'user', content: contentBlocks });
        } else {
          anthropicMessages.push({ role: 'user', content: msg.content });
        }
      }
    }

    // 3. Anthropic 要求消息必须以 user 开始
    // 如果第一条不是 user，添加一个占位 user 消息
    if (anthropicMessages.length > 0 && anthropicMessages[0].role !== 'user') {
      anthropicMessages.unshift({
        role: 'user',
        content: '[System initialized]',
      });
    }

    // 4. Anthropic 要求消息必须交替（user/assistant/user/assistant...）
    // 合并相邻的同角色消息
    const mergedMessages: MessageParam[] = [];
    for (const msg of anthropicMessages) {
      const lastMsg = mergedMessages[mergedMessages.length - 1];
      if (lastMsg?.role === msg.role) {
        // 合并相同角色的消息
        if (typeof lastMsg.content === 'string' && typeof msg.content === 'string') {
          lastMsg.content = `${lastMsg.content}\n\n${msg.content}`;
        } else if (Array.isArray(lastMsg.content) && Array.isArray(msg.content)) {
          lastMsg.content = [
            ...lastMsg.content,
            ...msg.content,
          ] as typeof lastMsg.content;
        } else if (typeof lastMsg.content === 'string' && Array.isArray(msg.content)) {
          lastMsg.content = [
            { type: 'text', text: lastMsg.content } as TextBlockParam,
            ...(msg.content as (TextBlockParam | ImageBlockParam)[]),
          ];
        } else if (Array.isArray(lastMsg.content) && typeof msg.content === 'string') {
          (lastMsg.content as (TextBlockParam | ImageBlockParam)[]).push({
            type: 'text',
            text: msg.content,
          });
        }
      } else {
        mergedMessages.push(msg);
      }
    }

    return { system, messages: mergedMessages };
  }

  /**
   * 将工具定义转换为 Anthropic API 格式
   */
  private convertToAnthropicTools(
    tools?: Array<{ name: string; description: string; parameters: unknown }>
  ): Tool[] | undefined {
    if (!tools || tools.length === 0) {
      return undefined;
    }

    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as Tool['input_schema'],
    }));
  }

  /**
   * 将 Anthropic 响应转换为统一的 ChatResponse 格式
   */
  private parseAnthropicResponse(
    content: ContentBlock[],
    usage: { input_tokens: number; output_tokens: number }
  ): ChatResponse {
    let textContent = '';
    const toolCalls: ChatCompletionMessageToolCall[] = [];

    for (const block of content) {
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }

    return {
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens: usage.input_tokens,
        completionTokens: usage.output_tokens,
        totalTokens: usage.input_tokens + usage.output_tokens,
      },
    };
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
    _logger.debug('🚀 [AnthropicChatService] Starting chat request');
    _logger.debug('📝 [AnthropicChatService] Messages count:', messages.length);

    // 过滤孤儿 tool 消息
    const filteredMessages = filterOrphanToolMessages(messages);
    if (filteredMessages.length < messages.length) {
      _logger.debug(
        `🔧 [AnthropicChatService] 过滤掉 ${messages.length - filteredMessages.length} 条孤儿 tool 消息`
      );
    }

    const { system, messages: anthropicMessages } =
      this.convertToAnthropicMessages(filteredMessages);
    const anthropicTools = this.convertToAnthropicTools(tools);

    _logger.debug(
      '🔧 [AnthropicChatService] Tools count:',
      anthropicTools?.length || 0
    );
    _logger.debug('📤 [AnthropicChatService] Request params:', {
      model: this.config.model,
      messagesCount: anthropicMessages.length,
      hasSystem: !!system,
      toolsCount: anthropicTools?.length || 0,
      max_tokens: this.config.maxOutputTokens ?? 4096,
      temperature: this.config.temperature ?? 0.0,
    });

    try {
      const response = await this.client.messages.create(
        {
          model: this.config.model,
          max_tokens: this.config.maxOutputTokens ?? 4096,
          system,
          messages: anthropicMessages,
          tools: anthropicTools,
          temperature: this.config.temperature ?? 0.0,
        },
        { signal }
      );

      const requestDuration = Date.now() - startTime;
      _logger.debug(
        '📥 [AnthropicChatService] Response received in',
        requestDuration,
        'ms'
      );

      _logger.debug('📊 [AnthropicChatService] Response:', {
        stopReason: response.stop_reason,
        contentBlocksCount: response.content.length,
        usage: response.usage,
      });

      const result = this.parseAnthropicResponse(response.content, response.usage);

      _logger.debug('✅ [AnthropicChatService] Chat completed successfully');
      _logger.debug('📊 [AnthropicChatService] Final response:', {
        contentLength: result.content.length,
        toolCallsCount: result.toolCalls?.length || 0,
        usage: result.usage,
      });

      return result;
    } catch (error) {
      const requestDuration = Date.now() - startTime;
      _logger.error(
        '❌ [AnthropicChatService] Chat request failed after',
        requestDuration,
        'ms'
      );
      _logger.error('❌ [AnthropicChatService] Error details:', error);
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
    _logger.debug('🚀 [AnthropicChatService] Starting stream request');
    _logger.debug('📝 [AnthropicChatService] Messages count:', messages.length);

    // 过滤孤儿 tool 消息
    const filteredMessages = filterOrphanToolMessages(messages);
    if (filteredMessages.length < messages.length) {
      _logger.debug(
        `🔧 [AnthropicChatService] 过滤掉 ${messages.length - filteredMessages.length} 条孤儿 tool 消息`
      );
    }

    const { system, messages: anthropicMessages } =
      this.convertToAnthropicMessages(filteredMessages);
    const anthropicTools = this.convertToAnthropicTools(tools);

    _logger.debug(
      '🔧 [AnthropicChatService] Stream tools count:',
      anthropicTools?.length || 0
    );
    _logger.debug('📤 [AnthropicChatService] Stream request params:', {
      model: this.config.model,
      messagesCount: anthropicMessages.length,
      hasSystem: !!system,
      toolsCount: anthropicTools?.length || 0,
      max_tokens: this.config.maxOutputTokens ?? 4096,
      temperature: this.config.temperature ?? 0.0,
    });

    try {
      const stream = await this.client.messages.create(
        {
          model: this.config.model,
          max_tokens: this.config.maxOutputTokens ?? 4096,
          system,
          messages: anthropicMessages,
          tools: anthropicTools,
          temperature: this.config.temperature ?? 0.0,
          stream: true,
        },
        { signal }
      );

      const requestDuration = Date.now() - startTime;
      _logger.debug(
        '📥 [AnthropicChatService] Stream started in',
        requestDuration,
        'ms'
      );

      // 工具调用累积器：按 index 存储
      const toolCallAccumulator = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();

      let eventCount = 0;
      let totalContent = '';
      let toolCallsReceived = false;

      for await (const event of stream) {
        eventCount++;

        if (event.type === 'content_block_start') {
          // 内容块开始
          if (event.content_block.type === 'tool_use') {
            // 工具调用开始，初始化累积器
            toolCallAccumulator.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              arguments: '',
            });
            toolCallsReceived = true;
            _logger.debug(
              `🔧 [AnthropicChatService] Tool use started: ${event.content_block.name}`
            );
          }
        } else if (event.type === 'content_block_delta') {
          // 内容块增量
          if (event.delta.type === 'text_delta') {
            // 文本增量
            totalContent += event.delta.text;
            yield { content: event.delta.text };
          } else if (event.delta.type === 'input_json_delta') {
            // 工具参数 JSON 增量，累积到对应的工具调用
            const tool = toolCallAccumulator.get(event.index);
            if (tool) {
              tool.arguments += event.delta.partial_json;
            }
          }
        } else if (event.type === 'content_block_stop') {
          // 内容块结束
          // 如果是工具调用块，发出完整的工具调用
          const tool = toolCallAccumulator.get(event.index);
          if (tool && tool.id) {
            _logger.debug(`🔧 [AnthropicChatService] Tool use completed: ${tool.name}`);
            yield {
              toolCalls: [
                {
                  id: tool.id,
                  type: 'function',
                  function: {
                    name: tool.name,
                    arguments: tool.arguments,
                  },
                },
              ],
            };
          }
        } else if (event.type === 'message_delta') {
          // 消息级别增量（包含 stop_reason）
          const stopReason = event.delta.stop_reason;
          if (stopReason) {
            _logger.debug('🏁 [AnthropicChatService] Stream finished:', stopReason);
            _logger.debug('📊 [AnthropicChatService] Stream summary:', {
              totalEvents: eventCount,
              totalContentLength: totalContent.length,
              hadToolCalls: toolCallsReceived,
              duration: Date.now() - startTime + 'ms',
            });

            // 将 Anthropic 的 stop_reason 映射到统一格式
            let finishReason: string | undefined;
            if (stopReason === 'end_turn') {
              finishReason = 'stop';
            } else if (stopReason === 'tool_use') {
              finishReason = 'tool_calls';
            } else if (stopReason === 'max_tokens') {
              finishReason = 'length';
            } else {
              finishReason = stopReason;
            }

            yield { finishReason };
          }
        }
      }

      _logger.debug('✅ [AnthropicChatService] Stream completed successfully');
    } catch (error) {
      const requestDuration = Date.now() - startTime;
      _logger.error(
        '❌ [AnthropicChatService] Stream request failed after',
        requestDuration,
        'ms'
      );
      _logger.error('❌ [AnthropicChatService] Stream error details:', error);
      throw error;
    }
  }

  getConfig(): ChatConfig {
    return { ...this.config };
  }

  updateConfig(newConfig: Partial<ChatConfig>): void {
    _logger.debug('🔄 [AnthropicChatService] Updating configuration');

    this.config = { ...this.config, ...newConfig };

    this.client = new Anthropic({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseUrl || undefined,
      timeout: this.config.timeout ?? 180000,
      maxRetries: 3,
    });

    _logger.debug('✅ [AnthropicChatService] Configuration updated successfully');
  }
}
