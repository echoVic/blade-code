/**
 * GitHub Copilot Chat Service
 *
 * 通过 GitHub Copilot API 提供聊天服务。
 * API 格式与 OpenAI 兼容，但使用 Copilot Token 认证。
 */

import { isPlainObject } from 'lodash-es';
import type { ChatCompletionMessageFunctionToolCall } from 'openai/resources/chat';
import { createLogger, LogCategory } from '../logging/Logger.js';
import { proxyFetch } from '../utils/proxyFetch.js';
import type {
  ChatConfig,
  ChatResponse,
  IChatService,
  Message,
  StreamChunk,
} from './ChatServiceInterface.js';
import { CopilotAuth } from './copilot/CopilotAuth.js';
import {
  COPILOT_API_ENDPOINTS,
  type CopilotChatRequest,
  type CopilotChatResponse,
  type CopilotStreamChunk,
} from './copilot/types.js';

const logger = createLogger(LogCategory.CHAT);

/**
 * GitHub Copilot Chat Service
 * 实现 IChatService 接口
 */
export class CopilotChatService implements IChatService {
  private config: ChatConfig;
  private auth: CopilotAuth;

  constructor(config: ChatConfig) {
    this.config = config;
    this.auth = CopilotAuth.getInstance();
  }

  /**
   * 获取当前配置
   */
  getConfig(): ChatConfig {
    return this.config;
  }

  /**
   * 更新配置
   */
  updateConfig(newConfig: Partial<ChatConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * 发送聊天请求（非流式）
   */
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
    logger.debug('🚀 [CopilotChatService] Starting chat request');
    logger.debug(`📝 [CopilotChatService] Messages count: ${messages.length}`);

    try {
      // 获取 Copilot token
      const copilotToken = await this.auth.getCopilotToken();

      // 构建请求
      const request = this.buildRequest(messages, tools, false);

      // 发送请求
      const response = await this.makeRequest(copilotToken, request, signal);

      const elapsed = Date.now() - startTime;
      logger.debug(`✅ [CopilotChatService] Chat completed in ${elapsed} ms`);

      return this.parseResponse(response);
    } catch (error) {
      const elapsed = Date.now() - startTime;
      logger.error(`❌ [CopilotChatService] Chat failed after ${elapsed} ms`);
      logger.error(`❌ [CopilotChatService] Error: ${error}`);
      throw error;
    }
  }

  /**
   * 发送聊天请求（流式）
   */
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
    logger.debug('🚀 [CopilotChatService] Starting stream chat request');
    logger.debug(`📝 [CopilotChatService] Messages count: ${messages.length}`);

    try {
      // 获取 Copilot token
      const copilotToken = await this.auth.getCopilotToken();

      // 构建请求
      const request = this.buildRequest(messages, tools, true);

      // 发送流式请求
      const response = await proxyFetch(COPILOT_API_ENDPOINTS.chatCompletions, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${copilotToken}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'Copilot-Integration-Id': 'vscode-chat',
          'Editor-Version': 'vscode/1.95.0',
          'Editor-Plugin-Version': 'copilot-chat/0.22.2024',
          'User-Agent': 'GitHubCopilotChat/0.22.2024',
        },
        body: JSON.stringify(request),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Copilot API error: ${response.status} - ${errorText}`);
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      // 解析 SSE 流
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // 用于累积 tool calls
      const toolCallsAccumulator: Map<number, ChatCompletionMessageFunctionToolCall> =
        new Map();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // 处理 SSE 事件
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            // 流结束，如果有累积的 tool calls，发送最终块
            if (toolCallsAccumulator.size > 0) {
              yield {
                toolCalls: Array.from(toolCallsAccumulator.values()),
                finishReason: 'tool_calls',
              };
            }
            continue;
          }

          try {
            const chunk = JSON.parse(data) as CopilotStreamChunk;
            const choice = chunk.choices[0];

            if (choice) {
              const streamChunk: StreamChunk = {};

              // 处理文本内容
              if (choice.delta.content) {
                streamChunk.content = choice.delta.content;
              }

              // 处理 tool calls
              if (choice.delta.tool_calls) {
                for (const tc of choice.delta.tool_calls) {
                  const existing = toolCallsAccumulator.get(tc.index);
                  if (existing) {
                    // 累积 arguments
                    if (tc.function?.arguments) {
                      existing.function.arguments += tc.function.arguments;
                    }
                  } else {
                    // 新的 tool call
                    toolCallsAccumulator.set(tc.index, {
                      id: tc.id || '',
                      type: 'function',
                      function: {
                        name: tc.function?.name || '',
                        arguments: tc.function?.arguments || '',
                      },
                    });
                  }
                }
              }

              // 处理结束原因
              if (choice.finish_reason) {
                streamChunk.finishReason = choice.finish_reason;
              }

              // 只有有内容时才 yield
              if (streamChunk.content || streamChunk.finishReason === 'stop') {
                yield streamChunk;
              }
            }
          } catch {
            // 忽略解析错误
          }
        }
      }

      const elapsed = Date.now() - startTime;
      logger.debug(`✅ [CopilotChatService] Stream completed in ${elapsed} ms`);
    } catch (error) {
      const elapsed = Date.now() - startTime;
      logger.error(`❌ [CopilotChatService] Stream failed after ${elapsed} ms`);
      logger.error(`❌ [CopilotChatService] Error: ${error}`);
      throw error;
    }
  }

  /**
   * 验证并修复消息序列
   * Copilot API 要求：tool 消息必须紧跟在带有 tool_calls 的 assistant 消息之后
   */
  private sanitizeMessages(messages: Message[]): Message[] {
    const result: Message[] = [];
    const toolCallIds = new Set<string>();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const validToolCallIds: string[] = [];
        for (const tc of msg.tool_calls) {
          let hasMatchingToolResponse = false;
          for (let j = i + 1; j < messages.length; j++) {
            if (messages[j].role === 'tool' && messages[j].tool_call_id === tc.id) {
              hasMatchingToolResponse = true;
              break;
            }
            if (messages[j].role === 'assistant' || messages[j].role === 'user') {
              break;
            }
          }
          if (hasMatchingToolResponse) {
            validToolCallIds.push(tc.id);
            toolCallIds.add(tc.id);
          }
        }

        if (validToolCallIds.length > 0) {
          result.push({
            ...msg,
            tool_calls: msg.tool_calls.filter((tc) => validToolCallIds.includes(tc.id)),
          });
        } else {
          result.push({
            role: msg.role,
            content: msg.content || '',
            reasoningContent: msg.reasoningContent,
          });
        }
      } else if (msg.role === 'tool') {
        if (msg.tool_call_id && toolCallIds.has(msg.tool_call_id)) {
          result.push(msg);
        }
      } else {
        result.push(msg);
      }
    }

    if (result.length !== messages.length) {
      logger.debug(
        `[CopilotChatService] Sanitized messages: ${messages.length} -> ${result.length}`
      );
    }

    return result;
  }

  /**
   * 构建请求体
   */
  private buildRequest(
    messages: Message[],
    tools?: Array<{
      name: string;
      description: string;
      parameters: unknown;
    }>,
    stream = false
  ): CopilotChatRequest {
    const sanitizedMessages = this.sanitizeMessages(messages);

    const convertedMessages = sanitizedMessages.map((msg) => {
      // 处理 content
      let content: string | null;
      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        // 多模态内容，提取文本部分
        content = msg.content
          .filter((part) => part.type === 'text')
          .map((part) => (part as { type: 'text'; text: string }).text)
          .join('\n');
      } else {
        content = null;
      }

      // 基础消息
      const baseMsg: CopilotChatRequest['messages'][0] = {
        role: msg.role as 'system' | 'user' | 'assistant' | 'tool',
        content,
      };

      // 添加 tool_call_id（tool 角色需要）
      if (msg.tool_call_id) {
        baseMsg.tool_call_id = msg.tool_call_id;
      }

      // 添加工具名称
      if (msg.name) {
        baseMsg.name = msg.name;
      }

      // 添加 tool_calls（assistant 返回工具调用时）
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        baseMsg.tool_calls = msg.tool_calls
          .filter((tc) => tc.type === 'function' && 'function' in tc)
          .map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: (tc as { function: { name: string; arguments: string } }).function
                .name,
              arguments: (tc as { function: { name: string; arguments: string } })
                .function.arguments,
            },
          }));
      }

      return baseMsg;
    });

    // 构建请求
    const request: CopilotChatRequest = {
      model: this.config.model,
      messages: convertedMessages,
      stream,
    };

    // 添加可选参数
    if (this.config.temperature !== undefined) {
      request.temperature = this.config.temperature;
    }

    if (this.config.maxOutputTokens) {
      request.max_tokens = this.config.maxOutputTokens;
    }

    // 添加工具
    if (tools && tools.length > 0) {
      request.tools = tools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: this.cleanParameters(tool.parameters),
        },
      }));
      request.tool_choice = 'auto';
    }

    return request;
  }

  /**
   * 清理参数中不支持的字段
   */
  private cleanParameters(params: unknown): Record<string, unknown> {
    if (!isPlainObject(params)) return {};

    const cleaned: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
      // 跳过不支持的字段
      if (['$ref', 'const', 'default'].includes(key)) {
        continue;
      }

      if (key === 'properties' && isPlainObject(value)) {
        // 递归清理 properties
        const cleanedProps: Record<string, unknown> = {};
        for (const [propKey, propValue] of Object.entries(
          value as Record<string, unknown>
        )) {
          cleanedProps[propKey] = isPlainObject(propValue)
            ? this.cleanParameters(propValue)
            : propValue;
        }
        cleaned[key] = cleanedProps;
      } else if (key === 'items' && isPlainObject(value)) {
        // 递归清理 items
        cleaned[key] = this.cleanParameters(value);
      } else {
        cleaned[key] = value;
      }
    }

    return cleaned;
  }

  /**
   * 发送请求
   */
  private async makeRequest(
    copilotToken: string,
    request: CopilotChatRequest,
    signal?: AbortSignal
  ): Promise<CopilotChatResponse> {
    const response = await proxyFetch(COPILOT_API_ENDPOINTS.chatCompletions, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${copilotToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Copilot-Integration-Id': 'vscode-chat',
        'Editor-Version': 'vscode/1.95.0',
        'Editor-Plugin-Version': 'copilot-chat/0.22.2024',
        'User-Agent': 'GitHubCopilotChat/0.22.2024',
      },
      body: JSON.stringify(request),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`Copilot API error: ${response.status} - ${errorText}`);

      if (response.status === 401) {
        throw new Error(
          'Copilot token expired or invalid. Please run /login copilot again.'
        );
      }
      if (response.status === 403) {
        throw new Error(
          'Permission denied. Please ensure you have an active GitHub Copilot subscription.'
        );
      }
      if (response.status === 429) {
        throw new Error('Rate limit exceeded. Please wait and try again.');
      }

      throw new Error(`Copilot API error: ${response.status} - ${errorText}`);
    }

    return (await response.json()) as CopilotChatResponse;
  }

  /**
   * 解析响应
   */
  private parseResponse(response: CopilotChatResponse): ChatResponse {
    const choice = response.choices[0];

    if (!choice) {
      throw new Error('No response from Copilot API');
    }

    const result: ChatResponse = {
      content: choice.message.content || '',
    };

    // 处理 tool calls
    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      result.toolCalls = choice.message.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));
    }

    // 处理 usage
    if (response.usage) {
      result.usage = {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      };
    }

    return result;
  }
}
