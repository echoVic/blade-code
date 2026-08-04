import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, jsonSchema, type LanguageModel, streamText } from 'ai';
import type { ChatCompletionMessageToolCall } from 'openai/resources/chat';
import { createLogger, LogCategory } from '../logging/Logger.js';
import { abortableSleep } from '../utils/abort.js';
import type {
  ChatConfig,
  ChatRequestOptions,
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

type AIReasoningPart = {
  type: 'reasoning';
  text: string;
  providerOptions?: AIProviderOptions;
};

type AIMessage =
  | { role: 'system'; content: string; providerOptions?: AIProviderOptions }
  | {
      role: 'user';
      content: string | Array<AITextPart | { type: 'image'; image: string }>;
    }
  | {
      role: 'assistant';
      providerOptions?: AIProviderOptions;
      content:
        | string
        | Array<
            | { type: 'text'; text: string }
            | AIReasoningPart
            | {
                type: 'tool-call';
                toolCallId: string;
                toolName: string;
                input: unknown;
              }
          >;
    }
  | {
      role: 'tool';
      content: Array<{
        type: 'tool-result';
        toolCallId: string;
        toolName: string;
        output: { type: 'text'; value: string };
      }>;
    };

type AITool = {
  description?: string;
  inputSchema: unknown;
};

function getDeltaText(part: unknown): string | undefined {
  const candidate = part as {
    text?: string;
    textDelta?: string;
    delta?: string;
  };
  return candidate.text ?? candidate.textDelta ?? candidate.delta;
}

function safeJsonParse(str: string, fallback: unknown = {}): unknown {
  try {
    return JSON.parse(str);
  } catch {
    logger.warn('[VercelAIChatService] Failed to parse JSON, using fallback', { str });
    return fallback;
  }
}

export class VercelAIChatService implements IChatService {
  private model: LanguageModel;
  private config: ChatConfig;

  constructor(config: ChatConfig) {
    this.config = config;
    this.model = this.createModel(config);
    logger.debug('[VercelAIChatService] Initialized', {
      provider: config.provider,
      model: config.model,
    });
  }

  private createModel(config: ChatConfig): LanguageModel {
    const { provider, apiKey, baseUrl, model, customHeaders, apiVersion } = config;

    switch (provider) {
      case 'openai': {
        const openai = createOpenAI({
          apiKey,
          baseURL: baseUrl || undefined,
          headers: customHeaders,
        });
        return openai(model);
      }

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

      case 'google':
      case 'google-generative-ai':
      case 'google-vertex': {
        if (baseUrl && !this.isGeminiOfficialUrl(baseUrl)) {
          const compatible = createOpenAICompatible({
            name: provider,
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

      case 'azure': {
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

      case 'deepseek': {
        const deepseek = createDeepSeek({
          apiKey,
          baseURL: baseUrl || undefined,
          headers: customHeaders,
        });
        return deepseek(model);
      }

      default: {
        const compatible = createOpenAICompatible({
          name: provider,
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
    const match = baseUrl.match(
      /https:\/\/([^.]+)\.openai\.azure(?:\.com|\.us|\.cn|\.de)/
    );
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
    return (
      baseUrl.includes('generativelanguage.googleapis.com') ||
      baseUrl.includes('aiplatform.googleapis.com')
    );
  }

  private needsThinkingReplayMetadata(): boolean {
    return /deepseek/i.test(
      [this.config.provider, this.config.model, this.config.baseUrl].join(' ')
    );
  }

  private getThinkingReplayProviderOptions(
    reasoningContent?: string
  ): AIProviderOptions | undefined {
    const thinking = reasoningContent?.trim();
    if (!thinking || !this.needsThinkingReplayMetadata()) return undefined;
    return {
      openaiCompatible: {
        reasoning_content: thinking,
      },
    };
  }

  private shouldFlattenDeepSeekThinkingToolHistory(): boolean {
    return this.needsThinkingReplayMetadata();
  }

  private hasNonThinkingToolHistory(messages: readonly Message[]): boolean {
    if (!this.needsThinkingReplayMetadata()) return false;
    return messages.some(
      (message) =>
        message.role === 'assistant' &&
        Boolean(message.tool_calls?.length) &&
        !message.reasoningContent?.trim()
    );
  }

  private flattenDeepSeekThinkingToolHistory(messages: Message[]): Message[] {
    const result: Message[] = [];
    let pendingAssistant: Message | undefined;

    const flushAssistant = () => {
      if (!pendingAssistant) return;
      result.push({
        role: 'assistant',
        content:
          getTextContent(pendingAssistant.content).trim() ||
          'I will use the requested tool and continue from its result.',
      });
      pendingAssistant = undefined;
    };

    for (const msg of messages) {
      if (msg.role === 'system') {
        flushAssistant();
        result.push({
          role: 'user',
          content: `<system>\n${getTextContent(msg.content)}\n</system>`,
        });
        continue;
      }

      if (
        msg.role === 'assistant' &&
        msg.tool_calls &&
        msg.tool_calls.length > 0 &&
        msg.reasoningContent?.trim()
      ) {
        flushAssistant();
        pendingAssistant = msg;
        continue;
      }

      if (msg.role === 'tool' && pendingAssistant) {
        const toolCall = pendingAssistant.tool_calls?.find(
          (tc) => tc.id === msg.tool_call_id
        );
        const fn = toolCall?.type === 'function' ? toolCall.function : undefined;
        result.push({
          role: 'user',
          content:
            `Tool result for ${msg.name || fn?.name || 'tool'}${fn?.arguments ? `(${fn.arguments})` : ''}:\n` +
            `${getTextContent(msg.content)}\n\nContinue from this tool result.`,
        });
        continue;
      }

      flushAssistant();
      result.push(msg);
    }

    flushAssistant();
    return result;
  }

  private convertMessages(messages: Message[]): AIMessage[] {
    const result: AIMessage[] = [];
    const canReplayReasoning = this.needsThinkingReplayMetadata();

    const sourceMessages = this.shouldFlattenDeepSeekThinkingToolHistory()
      ? this.flattenDeepSeekThinkingToolHistory(messages)
      : messages;

    for (const msg of sourceMessages) {
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
            const fn = (tc as { function?: { name: string; arguments?: string } })
              .function;
            return {
              type: 'tool-call' as const,
              toolCallId: tc.id,
              toolName: fn?.name || '',
              input: safeJsonParse(fn?.arguments || '{}', {}),
            };
          });
          const text = getTextContent(msg.content);
          const reasoningParts =
            canReplayReasoning && msg.reasoningContent?.trim()
              ? [{ type: 'reasoning' as const, text: msg.reasoningContent }]
              : [];
          const providerOptions = this.getThinkingReplayProviderOptions(
            msg.reasoningContent
          );
          if (text) {
            const assistantMsg: AIMessage = {
              role: 'assistant',
              content: [...reasoningParts, { type: 'text', text }, ...toolCalls],
            };
            if (providerOptions) {
              assistantMsg.providerOptions = providerOptions;
            }
            result.push(assistantMsg);
          } else if (reasoningParts.length > 0) {
            const assistantMsg: AIMessage = {
              role: 'assistant',
              content: [...reasoningParts, ...toolCalls],
            };
            if (providerOptions) {
              assistantMsg.providerOptions = providerOptions;
            }
            result.push(assistantMsg);
          } else {
            result.push({ role: 'assistant', content: toolCalls });
          }
        } else if (canReplayReasoning && msg.reasoningContent?.trim()) {
          const text = getTextContent(msg.content);
          const content: Array<{ type: 'text'; text: string } | AIReasoningPart> = [
            { type: 'reasoning', text: msg.reasoningContent },
          ];
          if (text) {
            content.push({ type: 'text', text });
          }
          const assistantMsg: AIMessage = { role: 'assistant', content };
          const providerOptions = this.getThinkingReplayProviderOptions(
            msg.reasoningContent
          );
          if (providerOptions) {
            assistantMsg.providerOptions = providerOptions;
          }
          result.push(assistantMsg);
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

    if (this.config.enablePromptCaching && this.config.provider === 'anthropic') {
      let systemCount = 0;
      for (const msg of result) {
        if (msg.role === 'system' && systemCount < 2) {
          (msg as { providerOptions?: AIProviderOptions }).providerOptions = {
            anthropic: { cacheControl: { type: 'ephemeral' } },
          };
          systemCount++;
        }
      }
      for (let i = result.length - 1; i >= 0; i--) {
        if (result[i].role === 'user') {
          (result[i] as { providerOptions?: AIProviderOptions }).providerOptions = {
            anthropic: { cacheControl: { type: 'ephemeral' } },
          };
          break;
        }
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
    toolCalls: Array<{
      toolCallId: string;
      toolName: string;
      args?: unknown;
      input?: unknown;
    }>
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
      inputTokens?: number;
      outputTokens?: number;
      reasoningTokens?: number;
    },
    providerMetadata?: {
      anthropic?: {
        cacheCreationInputTokens?: number;
        cacheReadInputTokens?: number;
      };
    }
  ): UsageInfo | undefined {
    if (!usage) return undefined;
    const prompt = usage.promptTokens ?? usage.inputTokens ?? 0;
    const completion = usage.completionTokens ?? usage.outputTokens ?? 0;
    const result: UsageInfo = {
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: usage.totalTokens ?? prompt + completion,
    };
    if (usage.reasoningTokens) {
      result.reasoningTokens = usage.reasoningTokens;
    }
    if (providerMetadata?.anthropic) {
      if (providerMetadata.anthropic.cacheCreationInputTokens !== undefined) {
        result.cacheCreationInputTokens =
          providerMetadata.anthropic.cacheCreationInputTokens;
      }
      if (providerMetadata.anthropic.cacheReadInputTokens !== undefined) {
        result.cacheReadInputTokens = providerMetadata.anthropic.cacheReadInputTokens;
      }
    }
    return result;
  }

  private isFallbackableError(error: unknown): boolean {
    const chain: unknown[] = [];
    const visited = new Set<unknown>();
    let current: unknown = error;

    while (current && !visited.has(current)) {
      chain.push(current);
      visited.add(current);
      if (typeof current !== 'object') break;
      const candidate = current as { lastError?: unknown; cause?: unknown };
      current = candidate.lastError ?? candidate.cause;
    }

    const messages = chain
      .filter((candidate): candidate is Error => candidate instanceof Error)
      .map((candidate) => candidate.message.toLowerCase());
    const combinedMessage = messages.join('\n');

    if (
      [
        'prompt_too_long',
        'prompt is too long',
        'maximum context length',
        'context length exceeded',
        'context_length_exceeded',
        'request too large',
      ].some((marker) => combinedMessage.includes(marker))
    ) {
      return false;
    }

    const networkMarkers = [
      'timeout',
      'timed out',
      'econnreset',
      'econnrefused',
      'enotfound',
      'eai_again',
      'etimedout',
      'fetch failed',
      'network error',
      'socket hang up',
      'connection reset',
      'connection refused',
    ];
    if (networkMarkers.some((marker) => combinedMessage.includes(marker))) {
      return true;
    }

    for (const candidate of chain) {
      if (!candidate || typeof candidate !== 'object') continue;
      const details = candidate as {
        status?: number;
        statusCode?: number;
        code?: unknown;
        response?: { status?: number; statusCode?: number };
      };
      const status =
        details.status ??
        details.statusCode ??
        details.response?.status ??
        details.response?.statusCode;
      if (status !== undefined && ([408, 409, 429].includes(status) || status >= 500)) {
        return true;
      }
      const code = details.code;
      if (
        typeof code === 'string' &&
        networkMarkers.some((marker) => code.toLowerCase().includes(marker))
      ) {
        return true;
      }
    }

    for (const message of messages) {
      const statusMatch = message.match(/\bstatus(?:\s+code)?[:\s]*(\d{3})\b/);
      const status = statusMatch ? Number(statusMatch[1]) : undefined;
      if (status !== undefined && ([408, 409, 429].includes(status) || status >= 500)) {
        return true;
      }
    }

    return false;
  }

  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    signal?: AbortSignal,
    maxRetries = 2,
    baseDelayMs = 1000
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (signal?.aborted) {
          await abortableSleep(0, signal, { throwOnAbort: true });
        }
        if (attempt >= maxRetries) break;
        if (!this.isFallbackableError(error)) throw error;
        const delay = baseDelayMs * Math.pow(2, attempt);
        logger.debug(
          `[VercelAIChatService] Retry ${attempt + 1}/${maxRetries} after ${delay}ms`
        );
        await abortableSleep(delay, signal, { throwOnAbort: true });
      }
    }
    throw lastError;
  }

  private getFallbackModelIds(): string[] {
    const models: string[] = [];
    if (this.config.fallbackModels && this.config.fallbackModels.length > 0) {
      models.push(...this.config.fallbackModels);
    } else if (this.config.fallbackModel) {
      models.push(this.config.fallbackModel);
    }
    return models;
  }

  private getThinkingProviderOptions(): Record<string, unknown> | undefined {
    if (!this.config.supportsThinking) return undefined;

    const mode = this.config.thinkingMode ?? 'budget';
    if (mode === 'off') return undefined;

    const isAdaptive = mode === 'adaptive';
    const budget = this.config.thinkingBudget ?? 10000;

    if (this.config.provider === 'anthropic') {
      return {
        anthropic: {
          thinking: isAdaptive
            ? { type: 'enabled', budgetTokens: 0 }
            : { type: 'enabled', budgetTokens: budget },
        },
      };
    }
    if (this.config.provider === 'deepseek' || /deepseek/i.test(this.config.model)) {
      return {
        deepseek: {
          thinking: isAdaptive
            ? { type: 'enabled', budgetTokens: 0 }
            : { type: 'enabled', budgetTokens: budget },
        },
      };
    }
    return undefined;
  }

  private getStreamTextOptions(
    model: LanguageModel,
    coreMessages: unknown,
    coreTools: unknown,
    signal?: AbortSignal,
    requestOptions?: ChatRequestOptions,
    disableThinkingForRequest = Boolean(requestOptions?.toolChoice)
  ): Record<string, unknown> {
    let effectiveSignal = signal;
    if (this.config.timeout && this.config.timeout > 0) {
      const timeoutSignal = AbortSignal.timeout(this.config.timeout);
      if (signal) {
        effectiveSignal = AbortSignal.any([signal, timeoutSignal]);
      } else {
        effectiveSignal = timeoutSignal;
      }
    }

    const opts: Record<string, unknown> = {
      model,
      messages: coreMessages,
      tools: coreTools,
      maxOutputTokens: this.config.maxOutputTokens,
      maxRetries: 0,
      temperature: this.config.temperature ?? 0,
      abortSignal: effectiveSignal,
      allowSystemInMessages: true,
      ...(requestOptions?.toolChoice ? { toolChoice: requestOptions.toolChoice } : {}),
    };
    if (requestOptions?.toolChoice && !coreTools) {
      throw new Error(
        `Required tool is unavailable: ${requestOptions.toolChoice.toolName}`
      );
    }
    const providerOptions = disableThinkingForRequest
      ? this.getRequiredToolProviderOptions()
      : this.getThinkingProviderOptions();
    if (providerOptions) {
      opts.providerOptions = providerOptions;
    }
    return opts;
  }

  private getRequiredToolProviderOptions(): Record<string, unknown> | undefined {
    if (this.config.provider !== 'deepseek' && !/deepseek/i.test(this.config.model)) {
      return undefined;
    }
    return {
      deepseek: {
        thinking: { type: 'disabled' },
      },
    };
  }

  async chat(
    messages: Message[],
    tools?: Array<{ name: string; description: string; parameters: unknown }>,
    signal?: AbortSignal,
    requestOptions?: ChatRequestOptions
  ): Promise<ChatResponse> {
    const startTime = Date.now();
    logger.debug('[VercelAIChatService] Starting chat request');

    const filteredMessages = filterOrphanToolMessages(messages);
    const coreMessages = this.convertMessages(filteredMessages);
    const coreTools = this.convertTools(tools);
    const requestNeedsThinkingDisabled =
      Boolean(requestOptions?.toolChoice) ||
      this.hasNonThinkingToolHistory(filteredMessages);

    const attempt = async (model: LanguageModel): Promise<ChatResponse> => {
      const result = await generateText(
        this.getStreamTextOptions(
          model,
          coreMessages,
          coreTools,
          signal,
          requestOptions,
          requestNeedsThinkingDisabled
        ) as never
      );

      const toolCalls =
        result.toolCalls && result.toolCalls.length > 0
          ? this.convertToolCalls(
              result.toolCalls as Array<{
                toolCallId: string;
                toolName: string;
                args?: unknown;
              }>
            )
          : undefined;

      const reasoningText = Array.isArray(result.reasoning)
        ? result.reasoning.map((r) => r.text).join('')
        : undefined;

      return {
        content: result.text,
        reasoningContent: reasoningText,
        toolCalls,
        usage: this.convertUsage(
          result.usage as {
            promptTokens?: number;
            completionTokens?: number;
            totalTokens?: number;
          },
          result.providerMetadata as {
            anthropic?: {
              cacheCreationInputTokens?: number;
              cacheReadInputTokens?: number;
            };
          }
        ),
        finishReason: result.finishReason,
      };
    };

    try {
      return await this.retryWithBackoff(
        () => attempt(this.model),
        signal,
        this.config.maxRetries
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('[VercelAIChatService] Chat failed after', duration, 'ms');

      if (signal?.aborted) {
        await abortableSleep(0, signal, { throwOnAbort: true });
      }
      if (!this.isFallbackableError(error)) throw error;

      const fallbackIds = this.getFallbackModelIds();
      if (fallbackIds.length === 0) throw error;

      for (const modelId of fallbackIds) {
        logger.warn(`[VercelAIChatService] Trying fallback model: ${modelId}`);
        const fallbackModel = this.createModel({ ...this.config, model: modelId });
        try {
          return await attempt(fallbackModel);
        } catch (fallbackError) {
          logger.warn(
            `[VercelAIChatService] Fallback ${modelId} failed: ${fallbackError instanceof Error ? fallbackError.message : fallbackError}`
          );
          if (signal?.aborted) {
            await abortableSleep(0, signal, { throwOnAbort: true });
          }
          if (!this.isFallbackableError(fallbackError)) throw fallbackError;
        }
      }
      throw error;
    }
  }

  async *streamChat(
    messages: Message[],
    tools?: Array<{ name: string; description: string; parameters: unknown }>,
    signal?: AbortSignal,
    requestOptions?: ChatRequestOptions
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const startTime = Date.now();
    logger.debug('[VercelAIChatService] Starting stream request');

    const filteredMessages = filterOrphanToolMessages(messages);
    const coreMessages = this.convertMessages(filteredMessages);
    const coreTools = this.convertTools(tools);
    const requestNeedsThinkingDisabled =
      Boolean(requestOptions?.toolChoice) ||
      this.hasNonThinkingToolHistory(filteredMessages);

    const streamFrom = async function* (
      self: VercelAIChatService,
      model: LanguageModel
    ): AsyncGenerator<StreamChunk, void, unknown> {
      const result = streamText(
        self.getStreamTextOptions(
          model,
          coreMessages,
          coreTools,
          signal,
          requestOptions,
          requestNeedsThinkingDisabled
        ) as never
      );

      let toolCallIndex = 0;
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            yield { content: getDeltaText(part) };
            break;
          case 'reasoning-delta':
            yield { reasoningContent: getDeltaText(part) };
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
                    arguments: JSON.stringify(
                      (part as { args?: unknown; input?: unknown }).args ??
                        (part as { input?: unknown }).input ??
                        {}
                    ),
                  },
                },
              ],
            };
            break;
          case 'finish':
            yield {
              finishReason: (part as { finishReason?: string }).finishReason,
              usage: self.convertUsage(
                (
                  part as {
                    totalUsage?: {
                      promptTokens?: number;
                      completionTokens?: number;
                      totalTokens?: number;
                      inputTokens?: number;
                      outputTokens?: number;
                    };
                  }
                ).totalUsage,
                (
                  part as {
                    providerMetadata?: {
                      anthropic?: {
                        cacheCreationInputTokens?: number;
                        cacheReadInputTokens?: number;
                      };
                    };
                  }
                ).providerMetadata
              ),
            };
            break;
        }
      }
    };

    const maxRetries = this.config.maxRetries ?? 2;
    let lastError: unknown;
    let primaryEmitted = false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        for await (const chunk of streamFrom(this, this.model)) {
          primaryEmitted = true;
          yield chunk;
        }
        const duration = Date.now() - startTime;
        logger.debug('[VercelAIChatService] Stream completed in', duration, 'ms');
        return;
      } catch (error) {
        lastError = error;
        if (signal?.aborted) {
          await abortableSleep(0, signal, { throwOnAbort: true });
        }
        if (primaryEmitted) throw error;
        if (!this.isFallbackableError(error)) throw error;
        if (attempt < maxRetries) {
          const delay = 1000 * Math.pow(2, attempt);
          logger.debug(
            `[VercelAIChatService] Stream retry ${attempt + 1}/${maxRetries} after ${delay}ms`
          );
          await abortableSleep(delay, signal, { throwOnAbort: true });
          continue;
        }
      }
    }

    const duration = Date.now() - startTime;
    logger.error('[VercelAIChatService] Stream failed after', duration, 'ms');

    const fallbackIds = this.getFallbackModelIds();
    if (fallbackIds.length === 0) throw lastError;

    for (const modelId of fallbackIds) {
      logger.warn(`[VercelAIChatService] Stream fallback: ${modelId}`);
      yield { modelFallback: true };
      const fallbackModel = this.createModel({ ...this.config, model: modelId });
      let fallbackEmitted = false;
      try {
        for await (const chunk of streamFrom(this, fallbackModel)) {
          fallbackEmitted = true;
          yield chunk;
        }
        return;
      } catch (fallbackError) {
        logger.warn(`[VercelAIChatService] Stream fallback ${modelId} failed`);
        if (signal?.aborted) {
          await abortableSleep(0, signal, { throwOnAbort: true });
        }
        if (fallbackEmitted) throw fallbackError;
        if (!this.isFallbackableError(fallbackError)) throw fallbackError;
      }
    }
    throw lastError;
  }

  getConfig(): ChatConfig {
    return { ...this.config };
  }

  updateConfig(newConfig: Partial<ChatConfig>): void {
    logger.debug('[VercelAIChatService] Updating configuration');
    this.config = { ...this.config, ...newConfig };
    this.model = this.createModel(this.config);
    logger.debug('[VercelAIChatService] Configuration updated');
  }
}
