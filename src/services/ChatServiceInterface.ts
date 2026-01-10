/**
 * ChatService 接口抽象
 * 定义统一的聊天服务接口，支持多种 API 提供商
 */

import type { ChatCompletionChunk, ChatCompletionMessageToolCall } from 'openai/resources/chat';
import { isBuiltinApiKey } from '../config/builtinModels.js';
import type { ProviderType } from '../config/types.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import type { MessageRole } from '../store/types.js';
import { AnthropicChatService } from './AnthropicChatService.js';
import { AntigravityChatService } from './AntigravityChatService.js';
import { AzureOpenAIChatService } from './AzureOpenAIChatService.js';
import { resolveBuiltinApiKey } from './BuiltinKeyService.js';
import { CopilotChatService } from './CopilotChatService.js';
import { GeminiChatService } from './GeminiChatService.js';
import { OpenAIChatService } from './OpenAIChatService.js';

const logger = createLogger(LogCategory.SERVICE);

/**
 * 多模态内容部分 - 文本
 */
export interface TextContentPart {
  type: 'text';
  text: string;
}

/**
 * 多模态内容部分 - 图片 (OpenAI Vision API 格式)
 */
export interface ImageContentPart {
  type: 'image_url';
  image_url: {
    url: string; // data:image/png;base64,... 或 https://...
  };
}

/**
 * 多模态内容部分
 */
export type ContentPart = TextContentPart | ImageContentPart;

/**
 * 消息类型
 * content 支持纯文本或多模态内容（文本+图片）
 */
export type Message = {
  role: MessageRole;
  content: string | ContentPart[];
  reasoningContent?: string; // Thinking 模型的推理过程（如 DeepSeek Reasoner）
  tool_call_id?: string; // tool 角色必需
  name?: string; // 工具名称
  tool_calls?: ChatCompletionMessageToolCall[]; // assistant 返回工具调用时需要
};

/**
 * ChatConfig - 聊天服务所需的配置
 * 注意：这些字段现在从 ModelConfig 中获取，而非直接从 BladeConfig
 */
export interface ChatConfig {
  provider: ProviderType;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  maxContextTokens?: number; // 上下文窗口大小（用于压缩判断）
  maxOutputTokens?: number; // 输出 token 限制（传给 API 的 max_tokens）
  timeout?: number;
  apiVersion?: string; // GPT OpenAI Platform 专用：API 版本（如 '2024-03-01-preview'）
  supportsThinking?: boolean; // 是否支持 thinking 模式（DeepSeek Reasoner 等）
}

/**
 * Thinking 模型的 reasoning 字段名
 * 不同 API 代理使用不同的字段名：
 * - DeepSeek 官方 API: reasoning_content
 * - zenmux.ai 等代理: reasoning
 */
export type ReasoningFieldName =
  | 'reasoning_content'
  | 'reasoning'
  | 'reasoningContent'
  | 'thinking_content';

/**
 * 聊天响应
 */
export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number; // Thinking 模型消耗的推理 tokens
}

export interface ChatResponse {
  content: string;
  reasoningContent?: string; // Thinking 模型的推理过程（如 DeepSeek R1）
  toolCalls?: ChatCompletionMessageToolCall[];
  usage?: UsageInfo;
}

/**
 * 流式 tool_calls 的统一类型：
 * - OpenAI/Azure 流式 delta 期间的 tool call（id 等字段可能是可选的）
 * - 以及收敛后的完整 tool call
 */
export type StreamToolCall =
  | ChatCompletionMessageToolCall
  | ChatCompletionChunk.Choice.Delta.ToolCall;

/**
 * 流式响应块
 */
export interface StreamChunk {
  content?: string;
  reasoningContent?: string; // Thinking 模型的推理过程片段
  toolCalls?: StreamToolCall[];
  finishReason?: string;
  usage?: UsageInfo; // 流式响应的使用统计（通常仅在结束时提供）
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
      parameters: unknown;
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
      parameters: unknown;
    }>,
    signal?: AbortSignal
  ): AsyncGenerator<StreamChunk, void, unknown>;

  /**
   * 获取当前配置
   */
  getConfig(): ChatConfig;

  /**
   * 更新配置
   */
  updateConfig(newConfig: Partial<ChatConfig>): void;
}

/**
 * ChatService 工厂函数（异步版本）
 * 支持内置 API Key 解析
 *
 * @param config ChatConfig + provider 字段
 * @returns Promise<IChatService> 实例
 */
export async function createChatServiceAsync(config: ChatConfig): Promise<IChatService> {
  let resolvedConfig = config;

  if (isBuiltinApiKey(config.apiKey)) {
    logger.info('🔑 检测到内置 API Key，正在获取...');
    const realApiKey = await resolveBuiltinApiKey(config.apiKey);
    resolvedConfig = { ...config, apiKey: realApiKey };
  }

  return createChatServiceInternal(resolvedConfig);
}

function createChatServiceInternal(config: ChatConfig): IChatService {
  switch (config.provider) {
    case 'openai-compatible':
      return new OpenAIChatService(config);

    case 'anthropic':
      return new AnthropicChatService(config);

    case 'gemini':
      return new GeminiChatService(config);

    case 'azure-openai':
      return new AzureOpenAIChatService(config);

    case 'antigravity':
      return new AntigravityChatService(config);

    case 'copilot':
      return new CopilotChatService(config);

    default:
      logger.warn(`⚠️  未知的 provider: ${config.provider}, 回退到 openai-compatible`);
      return new OpenAIChatService(config);
  }
}
