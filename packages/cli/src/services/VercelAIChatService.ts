import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, jsonSchema, type LanguageModel, streamText } from 'ai';
import type { ChatCompletionMessageToolCall } from 'openai/resources/chat';
import { createLogger, LogCategory } from '../logging/Logger.js';
import type {
  ChatConfig,
  ChatResponse,
  ContentPart,
  IChatService,
  Message,
  StreamChunk,
  UsageInfo,
} from './ChatServiceInterface.js';

const logger = createLogger(LogCategory.CHAT);

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
      if (!msg.tool_call_id) return false;
      return availableToolCallIds.has(msg.tool_call_id);
    }
    return true;
  });
}

function getTextContent(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

type AIProviderOptions = Record<string, Record<string, unknown>>;

type AITextPart = {
  type: 'text';
  text: string;
  providerOptions?: AIProviderOptions;
};

type AIMessage =
  | { role: 'system'; content: string; providerOptions?: AIProviderOptions }
  | { role: 'user'; content: string | Array<AITextPart | { type: 'image'; image: string }> }
  | { role: 'assistant'; content: string | Array<{ type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }> }
  | { role: 'tool'; content: Array<{ type: 'tool-result'; toolCallId: string; toolName: string; output: { type: 'text'; value: string } }> };

type AITool = {
  description?: string;
  inputSchema: unknown;
};

function safeJsonParse(str: string, fallback: unknown = {}): unknown {
  try {
    return JSON.parse(str);
  } catch {
    logger.warn('⚠️ [VercelAIChatService] Failed to parse JSON, using fallback', { str });
    return fallback;
  }
}

export class VercelAIChatService implements IChatService {
  private model: LanguageModel;
  private config: ChatConfig;

  constructor(config: ChatConfig) {
    this.config = config;
    this.model = this.createModel(config);
    logger.debug('🚀 [VercelAIChatService] Initialized', {
      provider: config.provider,
      model: config.model,
      providerId: config.providerId,
    });
  }

  private createModel(config: ChatConfig): LanguageModel {
    const { provider, apiKey, baseUrl, model, customHeaders, providerId, apiVersion } = config;

    switch (provider) {
      case 'anthropic': {
        const anthropic = createAnthropic({
          apiKey,
          baseURL: baseUrl || undefined,
          headers: customHeaders,
        });
        return anthropic(model);
      }

      case 'gemini': {
        if (baseUrl && !this.isGeminiOfficialUrl(baseUrl)) {
          const compatible = createOpenAICompatible({
            name: 'gemini',
            apiKey,
            baseURL: baseUrl,
            headers: customHeaders,
          });
          return compatible(model);
        }
        const google = createGoogleGenerativeAI({
          apiKey,
          baseURL: baseUrl || undefined,
        });
        return google(model);
      }

      case 'azure-openai': {
        const resourceName = this.extractAzureResourceName(baseUrl);
        if (resourceName) {
          const azure = createAzure({
            apiKey,
            resourceName,
            apiVersion: apiVersion || '2024-08-01-preview',
          });
          return azure(model);
        }
        const azureBaseUrl = this.buildAzureBaseUrl(baseUrl, model);
        const compatible = createOpenAICompatible({
          name: 'azure-openai',
          apiKey,
          baseURL: azureBaseUrl,
          headers: {
            ...customHeaders,
            'api-key': apiKey,
          },
          queryParams: {
            'api-version': apiVersion || '2024-08-01-preview',
          },
        });
        return compatible(model);
      }

      default: {
        if (providerId === 'deepseek') {
          const deepseek = createDeepSeek({
            apiKey,
            baseURL: baseUrl || undefined,
            headers: customHeaders,
          });
          return deepseek(model);
        }

        const compatible = createOpenAICompatible({
          name: providerId || 'custom',
          apiKey,
          baseURL: baseUrl,
          headers: customHeaders,
        });
        return compatible(model);
      }
    }
  }

  private extractAzureResourceName(baseUrl?: string): string | undefined {
    if (!baseUrl) return undefined;
    const match = baseUrl.match(/https:\/\/([^.]+)\.openai\.azure(?:\.com|\.us|\.cn|\.de)/);
    return match ? match[1] : undefined;
  }

  private buildAzureBaseUrl(baseUrl?: string, deployment?: string): string {
    if (!baseUrl) return '';
    const url = baseUrl.replace(/\/$/, '').replace(/\?.*$/, '');
    if (url.includes('/openai/deployments/')) {
      return url;
    }
    return `${url}/openai/deployments/${deployment}`;
  }

  private isGeminiOfficialUrl(baseUrl: string): boolean {
    return baseUrl.includes('generativelanguage.googleapis.com') || baseUrl.includes('aiplatform.googleapis.com');
  }

  private convertMessages(messages: Message[]): AIMessage[] {
    const result: AIMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        // 处理 system 消息的 providerOptions（用于 Anthropic Prompt Caching）
        if (Array.isArray(msg.content)) {
          // 多部分内容：提取 providerOptions
          const textPart = msg.content.find((p) => p.type === 'text') as
            | { type: 'text'; text: string; providerOptions?: AIProviderOptions }
            | undefined;
          const systemMsg: AIMessage = {
            role: 'system',
            content: getTextContent(msg.content),
          };
          if (textPart?.providerOptions) {
            (systemMsg as { providerOptions?: AIProviderOptions }).providerOptions =
              textPart.providerOptions as AIProviderOptions;
          }
          result.push(systemMsg);
        } else {
          result.push({ role: 'system', content: msg.content });
        }
      } else if (msg.role === 'user') {
        if (Array.isArray(msg.content)) {
          const parts = msg.content.map((part) => {
            if (part.type === 'text') {
              const textPart: AITextPart = { type: 'text', text: part.text };
              // 传递 providerOptions（用于 Anthropic Prompt Caching）
              if (part.providerOptions) {
                textPart.providerOptions = part.providerOptions as AIProviderOptions;
              }
              return textPart;
            }
            return { type: 'image' as const, image: part.image_url.url };
          });
          result.push({ role: 'user', content: parts });
        } else {
          result.push({ role: 'user', content: msg.content });
        }
      } else if (msg.role === 'assistant') {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const toolCalls = msg.tool_calls.map((tc) => {
            const fn = (tc as { function?: { name: string; arguments?: string } }).function;
            return {
              type: 'tool-call' as const,
              toolCallId: tc.id,
              toolName: fn?.name || '',
              input: safeJsonParse(fn?.arguments || '{}', {}),
            };
          });
          const text = getTextContent(msg.content);
          if (text) {
            result.push({
              role: 'assistant',
              content: [{ type: 'text', text }, ...toolCalls],
            });
          } else {
            result.push({ role: 'assistant', content: toolCalls });
          }
        } else {
          result.push({ role: 'assistant', content: getTextContent(msg.content) });
        }
      } else if (msg.role === 'tool') {
        result.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: msg.tool_call_id!,
              toolName: msg.name || 'unknown',
              output: { type: 'text', value: getTextContent(msg.content) },
            },
          ],
        });
      }
    }

    return result;
  }

  private convertTools(
    tools?: Array<{ name: string; description: string; parameters: unknown }>
  ): Record<string, AITool> | undefined {
    if (!tools || tools.length === 0) return undefined;

    const result: Record<string, AITool> = {};
    for (const tool of tools) {
      result[tool.name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as Parameters<typeof jsonSchema>[0]),
      };
    }
    return result;
  }

  private convertToolCalls(
    toolCalls: Array<{ toolCallId: string; toolName: string; args?: unknown; input?: unknown }>
  ): ChatCompletionMessageToolCall[] {
    return toolCalls.map((tc) => ({
      id: tc.toolCallId,
      type: 'function' as const,
      function: {
        name: tc.toolName,
        arguments: JSON.stringify(tc.args ?? tc.input ?? {}),
      },
    }));
  }

  private convertUsage(
    usage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    },
    providerMetadata?: {
      anthropic?: {
        cacheCreationInputTokens?: number;
        cacheReadInputTokens?: number;
      };
    }
  ): UsageInfo | undefined {
    if (!usage) return undefined;
    const prompt = usage.promptTokens ?? 0;
    const completion = usage.completionTokens ?? 0;
    const result: UsageInfo = {
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: usage.totalTokens ?? prompt + completion,
    };
    // 添加 Anthropic 缓存统计（如果有）
    if (providerMetadata?.anthropic) {
      if (providerMetadata.anthropic.cacheCreationInputTokens !== undefined) {
        result.cacheCreationInputTokens = providerMetadata.anthropic.cacheCreationInputTokens;
      }
      if (providerMetadata.anthropic.cacheReadInputTokens !== undefined) {
        result.cacheReadInputTokens = providerMetadata.anthropic.cacheReadInputTokens;
      }
    }
    return result;
  }

  async chat(
    messages: Message[],
    tools?: Array<{ name: string; description: string; parameters: unknown }>,
    signal?: AbortSignal
  ): Promise<ChatResponse> {
    const startTime = Date.now();
    logger.debug('🚀 [VercelAIChatService] Starting chat request');

    const filteredMessages = filterOrphanToolMessages(messages);
    const coreMessages = this.convertMessages(filteredMessages);
    const coreTools = this.convertTools(tools);

    try {
      const result = await generateText({
        model: this.model,
        messages: coreMessages as never,
        tools: coreTools as never,
        maxOutputTokens: this.config.maxOutputTokens,
        temperature: this.config.temperature ?? 0,
        abortSignal: signal,
      });

      const duration = Date.now() - startTime;
      logger.debug('📥 [VercelAIChatService] Response received in', duration, 'ms');

      const toolCalls =
        result.toolCalls && result.toolCalls.length > 0
          ? this.convertToolCalls(result.toolCalls as Array<{ toolCallId: string; toolName: string; args?: unknown }>)
          : undefined;

      const reasoningText = Array.isArray(result.reasoning)
        ? result.reasoning.map((r) => r.text).join('')
        : undefined;

      return {
        content: result.text,
        reasoningContent: reasoningText,
        toolCalls,
        usage: this.convertUsage(
          result.usage as { promptTokens?: number; completionTokens?: number; totalTokens?: number },
          result.providerMetadata as {
            anthropic?: { cacheCreationInputTokens?: number; cacheReadInputTokens?: number };
          }
        ),
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('❌ [VercelAIChatService] Chat failed after', duration, 'ms');
      throw error;
    }
  }

  async *streamChat(
    messages: Message[],
    tools?: Array<{ name: string; description: string; parameters: unknown }>,
    signal?: AbortSignal
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const startTime = Date.now();
    logger.debug('🚀 [VercelAIChatService] Starting stream request');

    const filteredMessages = filterOrphanToolMessages(messages);
    const coreMessages = this.convertMessages(filteredMessages);
    const coreTools = this.convertTools(tools);

    try {
      const result = streamText({
        model: this.model,
        messages: coreMessages as never,
        tools: coreTools as never,
        maxOutputTokens: this.config.maxOutputTokens,
        temperature: this.config.temperature ?? 0,
        abortSignal: signal,
      });

      logger.debug('📥 [VercelAIChatService] Stream started');

      let toolCallIndex = 0;
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            yield { content: (part as { text?: string; textDelta?: string }).text ?? (part as { textDelta?: string }).textDelta };
            break;

          case 'reasoning-delta':
            yield { reasoningContent: (part as { textDelta?: string }).textDelta };
            break;

          case 'tool-call':
            yield {
              toolCalls: [
                {
                  index: toolCallIndex++,
                  id: (part as { toolCallId: string }).toolCallId,
                  type: 'function' as const,
                  function: {
                    name: (part as { toolName: string }).toolName,
                    arguments: JSON.stringify((part as { args?: unknown; input?: unknown }).args ?? (part as { input?: unknown }).input ?? {}),
                  },
                },
              ],
            };
            break;

          case 'finish':
            yield {
              finishReason: (part as { finishReason?: string }).finishReason,
              usage: this.convertUsage(
                (part as { totalUsage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } }).totalUsage,
                (part as { providerMetadata?: { anthropic?: { cacheCreationInputTokens?: number; cacheReadInputTokens?: number } } }).providerMetadata
              ),
            };
            break;
        }
      }

      const duration = Date.now() - startTime;
      logger.debug('✅ [VercelAIChatService] Stream completed in', duration, 'ms');
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('❌ [VercelAIChatService] Stream failed after', duration, 'ms');
      throw error;
    }
  }

  getConfig(): ChatConfig {
    return { ...this.config };
  }

  updateConfig(newConfig: Partial<ChatConfig>): void {
    logger.debug('🔄 [VercelAIChatService] Updating configuration');
    this.config = { ...this.config, ...newConfig };
    this.model = this.createModel(this.config);
    logger.debug('✅ [VercelAIChatService] Configuration updated');
  }
}
