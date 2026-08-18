/**
 * ChatService 接口抽象
 * 定义统一的聊天服务接口，支持多种 API 提供商
 */

import type {
  ConstrainedSamplingConfig,
  ModelThinkingLevel,
} from '@earendil-works/pi-ai';

/** OpenAI-compatible tool call (function variant only — custom tools not used) */
export interface ToolCallFunction {
  arguments: string;
  name: string;
}

export interface ChatCompletionMessageToolCall {
  id: string;
  function: ToolCallFunction;
  type: 'function';
}

/** Partial tool call received during streaming (fields optional) */
export interface StreamToolCallDelta {
  index: number;
  id?: string;
  function?: { arguments?: string; name?: string };
  type?: 'function';
}

import type { ModelRef, ProviderType } from '../config/types.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import type { JsonValue, MessageRole } from '../store/types.js';
import { getProviderHeaders } from '../ui/components/model-config/types.js';
import { PiAIChatService } from './PiAIChatService.js';
import type { PiModelCatalog } from './pi/PiModelCatalog.js';
import type {
  ProviderCircuitEvent,
  ProviderCircuitRegistry,
} from './pi/providerCircuitBreaker.js';
import type {
  ProviderAdmissionEvent,
  ProviderRequestAdmissionScheduler,
  ProviderRequestClass,
} from './pi/providerRequestAdmission.js';
import type { ProviderRetryEvent } from './pi/providerRetry.js';
import type { ProviderStallEvent } from './pi/providerStall.js';

const logger = createLogger(LogCategory.SERVICE);

/**
 * Anthropic Prompt Caching 配置
 * 用于标记可缓存的内容，减少 token 消耗（成本降低 90%，延迟降低 85%）
 */
export interface AnthropicCacheControl {
  type: 'ephemeral';
}

/**
 * Provider 特定选项
 */
export interface ProviderOptions {
  anthropic?: {
    cacheControl?: AnthropicCacheControl;
  };
}

/**
 * 多模态内容部分 - 文本
 */
interface TextContentPart {
  type: 'text';
  text: string;
  providerOptions?: ProviderOptions;
}

/**
 * 多模态内容部分 - 图片 (OpenAI Vision API 格式)
 */
interface ImageContentPart {
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
  metadata?: JsonValue;
};

/**
 * ChatConfig - 聊天服务所需的配置
 * 注意：这些字段现在从 ModelConfig 中获取，而非直接从 BladeConfig
 */
export interface ChatConfig {
  provider: ProviderType;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  temperature?: number;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  timeout?: number;
  streamIdleTimeout?: number;
  apiVersion?: string;
  reasoningEnabled?: boolean;
  reasoningEffort?: Exclude<ModelThinkingLevel, 'off'>;
  reasoningLevel?: 'low' | 'medium' | 'high';
  serviceTier?: 'default' | 'priority' | 'flex' | 'fast';
  responseVerbosity?: 'low' | 'medium' | 'high';
  customHeaders?: Record<string, string>;
  fallbackModels?: ModelRef[];
  enablePromptCaching?: boolean;
  maxRetries?: number;
  providerCircuitBreakerOpenMs?: number;
  providerRequestConcurrency?: number;
  providerRequestAdmissionMs?: number;
  providerRequestPendingBytes?: number;
  /** Process-shared runtime coordinator. Never serialize this field. */
  providerCircuitRegistry?: ProviderCircuitRegistry;
  /** Process-shared physical Provider stream scheduler. Never serialize this field. */
  providerRequestAdmissionScheduler?: ProviderRequestAdmissionScheduler;
  /** Session-owned model/provider catalog. Never serialize this field. */
  modelCatalog?: PiModelCatalog;
}

/**
 * 聊天响应
 */
export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number; // Thinking 模型消耗的推理 tokens
  cacheCreationInputTokens?: number; // Provider 报告的缓存写入 tokens
  cacheReadInputTokens?: number; // Provider 报告的缓存读取 tokens
  costUsd?: number; // pi-ai 根据模型价格、缓存类型和阶梯价格计算的本次调用费用
}

export interface ChatResponse {
  content: string;
  reasoningContent?: string; // Thinking 模型的推理过程（如 DeepSeek R1）
  toolCalls?: ChatCompletionMessageToolCall[];
  usage?: UsageInfo;
  finishReason?: string;
}

export interface ChatRequestOptions {
  /** Stable identity used for Provider prompt-cache routing and affinity. */
  providerSessionId?: string;
  toolChoice?: {
    type: 'tool';
    toolName: string;
  };
  providerRecovery?: {
    mode: 'bounded_foreground';
    budgetMs: number;
  };
  providerAdmission?: {
    sessionId: string;
    ownerId: string;
    requestClass: ProviderRequestClass;
  };
  maxOutputTokens?: number;
  temperature?: number;
}

export interface ChatToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
  constrainedSampling?: false | ConstrainedSamplingConfig;
}

/**
 * 流式 tool_calls 的统一类型：
 * - OpenAI/Azure 流式 delta 期间的 tool call（id 等字段可能是可选的）
 * - 以及收敛后的完整 tool call
 */
export type StreamToolCall = ChatCompletionMessageToolCall | StreamToolCallDelta;

/**
 * 流式响应块
 */
export interface StreamChunk {
  content?: string;
  reasoningContent?: string;
  toolCalls?: StreamToolCall[];
  finishReason?: string;
  usage?: UsageInfo;
  modelFallback?: boolean;
  providerAdmission?: ProviderAdmissionEvent;
  providerCircuit?: ProviderCircuitEvent;
  providerRetry?: ProviderRetryEvent;
  providerStall?: ProviderStallEvent;
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
    tools?: ChatToolDefinition[],
    signal?: AbortSignal,
    options?: ChatRequestOptions
  ): Promise<ChatResponse>;

  /**
   * 发送聊天请求（流式）
   */
  streamChat(
    messages: Message[],
    tools?: ChatToolDefinition[],
    signal?: AbortSignal,
    options?: ChatRequestOptions
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
export async function createChatServiceAsync(
  config: ChatConfig
): Promise<IChatService> {
  let resolvedConfig = config;

  // 自动注入 Provider 特定的 Headers
  if (resolvedConfig.provider) {
    const providerHeaders = getProviderHeaders(resolvedConfig.provider);
    if (Object.keys(providerHeaders).length > 0) {
      resolvedConfig = {
        ...resolvedConfig,
        customHeaders: {
          ...providerHeaders,
          ...resolvedConfig.customHeaders, // 用户配置优先
        },
      };
      logger.debug(
        `Injected ${resolvedConfig.provider} specific headers:`,
        Object.keys(providerHeaders)
      );
    }
  }

  return createChatServiceInternal(resolvedConfig);
}

function createChatServiceInternal(config: ChatConfig): IChatService {
  return new PiAIChatService(config);
}
