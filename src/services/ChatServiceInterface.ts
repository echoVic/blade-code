/**
 * ChatService 接口抽象
 * 定义统一的聊天服务接口，支持多种 API 提供商
 */

import type { ChatCompletionMessageToolCall } from 'openai/resources/chat';
import type { BladeConfig } from '../config/types.js';
import { LogCategory, createLogger } from '../logging/Logger.js';
import { OpenAIChatService } from './OpenAIChatService.js';

const logger = createLogger(LogCategory.SERVICE);

/**
 * 消息类型
 */
export type Message = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_call_id?: string; // tool 角色必需
  name?: string; // 工具名称
  tool_calls?: ChatCompletionMessageToolCall[]; // assistant 返回工具调用时需要
};

/**
 * ChatConfig - 从 BladeConfig 派生的聊天配置
 * 使用 Pick 直接选择所需字段，保持类型一致性
 */
export type ChatConfig = Pick<
  BladeConfig,
  'apiKey' | 'model' | 'baseUrl' | 'temperature' | 'maxTokens' | 'timeout' | 'provider'
>;

/**
 * 聊天响应
 */
export interface ChatResponse {
  content: string;
  toolCalls?: ChatCompletionMessageToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * 流式响应块
 */
export interface StreamChunk {
  content?: string;
  // biome-ignore lint/suspicious/noExplicitAny: 不同 provider 的 tool call 类型不同
  toolCalls?: any[];
  finishReason?: string;
}

/**
 * 聊天服务接口
 * 所有 Provider 实现必须实现此接口
 */
export interface IChatService {
  /**
   * 发送聊天请求（非流式）
   */
  chat(
    messages: Message[],
    tools?: Array<{
      name: string;
      description: string;
      // biome-ignore lint/suspicious/noExplicitAny: 工具参数格式不确定
      parameters: any;
    }>,
    signal?: AbortSignal
  ): Promise<ChatResponse>;

  /**
   * 发送聊天请求（流式）
   */
  streamChat(
    messages: Message[],
    tools?: Array<{
      name: string;
      description: string;
      // biome-ignore lint/suspicious/noExplicitAny: 工具参数格式不确定
      parameters: any;
    }>,
    signal?: AbortSignal
  ): AsyncGenerator<StreamChunk, void, unknown>;
}

/**
 * ChatService 工厂函数
 * 根据配置中的 provider 创建对应的服务实例
 *
 * @param config ChatConfig + provider 字段
 * @returns IChatService 实例
 */
export function createChatService(config: ChatConfig): IChatService {
  switch (config.provider) {
    case 'openai-compatible':
      return new OpenAIChatService(config);

    case 'anthropic':
      // Anthropic 暂未实现，抛出友好错误
      throw new Error(
        '❌ Anthropic provider 暂未实现\n\n' +
          '请使用 "openai-compatible" 提供商，或者:\n' +
          '1. 等待官方实现\n' +
          '2. 贡献代码实现此功能: https://github.com/echoVic/blade-code\n'
      );

    default:
      logger.warn(`⚠️  未知的 provider: ${config.provider}, 回退到 openai-compatible`);
      return new OpenAIChatService(config);
  }
}
