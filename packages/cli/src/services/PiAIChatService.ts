import type { Api, Model, MutableModels } from '@earendil-works/pi-ai';
import { createLogger, LogCategory } from '../logging/Logger.js';
import { abortableSleep, combineAbortSignals } from '../utils/abort.js';
import type {
  ChatCompletionMessageToolCall,
  ChatConfig,
  ChatRequestOptions,
  ChatResponse,
  IChatService,
  Message,
  StreamChunk,
  UsageInfo,
} from './ChatServiceInterface.js';
import { createPiContext } from './pi/contextAdapter.js';
import {
  filterOrphanToolMessages,
  hasNonThinkingToolHistory,
} from './pi/messageHistory.js';
import { createFallbackModel, createPiRuntime } from './pi/modelRuntime.js';
import { buildPiOptions, isFallbackablePiError } from './pi/requestOptions.js';
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, streamPiModel } from './pi/streamAdapter.js';

const logger = createLogger(LogCategory.CHAT);
type ToolDefinition = { name: string; description: string; parameters: unknown };

function hasImageContent(message: Message | undefined): boolean {
  return Boolean(
    message &&
      message.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'image_url')
  );
}

export class PiAIChatService implements IChatService {
  private config: ChatConfig;
  private models: MutableModels;
  private model: Model<Api>;

  constructor(config: ChatConfig) {
    const runtime = createPiRuntime(config);
    this.config = {
      ...config,
      maxContextTokens: runtime.model.contextWindow,
      maxOutputTokens: config.maxOutputTokens ?? runtime.model.maxTokens,
    };
    this.models = runtime.models;
    this.model = runtime.model;
    logger.debug('[PiAIChatService] Initialized', {
      provider: this.model.provider,
      model: this.model.id,
      api: this.model.api,
    });
  }

  async chat(
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
    requestOptions?: ChatRequestOptions
  ): Promise<ChatResponse> {
    let content = '';
    let reasoningContent = '';
    const toolCalls: ChatCompletionMessageToolCall[] = [];
    let usage: UsageInfo | undefined;
    let finishReason: string | undefined;

    for await (const chunk of this.streamChat(
      messages,
      tools,
      signal,
      requestOptions
    )) {
      content += chunk.content ?? '';
      reasoningContent += chunk.reasoningContent ?? '';
      for (const call of chunk.toolCalls ?? []) {
        if (call.id && call.type === 'function' && call.function?.name) {
          toolCalls.push(call as ChatCompletionMessageToolCall);
        }
      }
      usage = chunk.usage ?? usage;
      finishReason = chunk.finishReason ?? finishReason;
    }

    return {
      content,
      ...(reasoningContent ? { reasoningContent } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      usage,
      finishReason,
    };
  }

  async *streamChat(
    messages: Message[],
    tools?: ToolDefinition[],
    signal?: AbortSignal,
    requestOptions?: ChatRequestOptions
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const requiredTool = requestOptions?.toolChoice?.toolName;
    if (requiredTool && !tools?.some((tool) => tool.name === requiredTool)) {
      throw new Error(`Required tool is unavailable: ${requiredTool}`);
    }

    const filtered = filterOrphanToolMessages(messages);
    if (
      filtered.some((message) => hasImageContent(message)) &&
      !this.model.input.includes('image')
    ) {
      throw new Error(`${this.model.name} does not support image input`);
    }
    const disableThinking =
      Boolean(requiredTool) || hasNonThinkingToolHistory(filtered);
    const context = await createPiContext(
      filtered,
      this.model,
      tools,
      signal,
      requiredTool
    );
    const streamFrom = (model: Model<Api>) => {
      const watchdogController = new AbortController();
      const requestSignal = signal
        ? combineAbortSignals(signal, watchdogController.signal)
        : watchdogController.signal;
      return streamPiModel(
        this.models,
        model,
        context,
        buildPiOptions(
          this.config,
          model,
          requestSignal,
          requestOptions,
          disableThinking
        ),
        {
          idleTimeoutMs:
            this.config.streamIdleTimeout ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
          signal: requestSignal,
          abort: (reason) => watchdogController.abort(reason),
        }
      );
    };

    const maxRetries = this.config.maxRetries ?? 2;
    let lastError: unknown;
    let emitted = false;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        for await (const chunk of streamFrom(this.model)) {
          emitted = true;
          yield chunk;
        }
        return;
      } catch (error) {
        lastError = error;
        this.logIdleTimeout(error, emitted, this.model);
        await this.handleAbort(signal);
        if (emitted || !isFallbackablePiError(error)) throw error;
        if (attempt < maxRetries) {
          await abortableSleep(1000 * 2 ** attempt, signal, {
            throwOnAbort: true,
          });
        }
      }
    }

    for (const fallback of this.config.fallbackModels ?? []) {
      yield { modelFallback: true };
      let fallbackEmitted = false;
      let fallbackModel: Model<Api> | undefined;
      try {
        fallbackModel = createFallbackModel(this.config, fallback);
        for await (const chunk of streamFrom(fallbackModel)) {
          fallbackEmitted = true;
          yield chunk;
        }
        return;
      } catch (error) {
        lastError = error;
        if (fallbackModel) {
          this.logIdleTimeout(error, fallbackEmitted, fallbackModel);
        }
        await this.handleAbort(signal);
        if (fallbackEmitted || !isFallbackablePiError(error)) throw error;
      }
    }
    throw lastError;
  }

  private async handleAbort(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      await abortableSleep(0, signal, { throwOnAbort: true });
    }
  }

  private logIdleTimeout(error: unknown, emitted: boolean, model: Model<Api>): void {
    if (
      error === null ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'STREAM_IDLE_TIMEOUT' ||
      !('timeoutMs' in error) ||
      typeof error.timeoutMs !== 'number'
    ) {
      return;
    }
    logger.warn('[PiAIChatService] Provider stream idle timeout', {
      provider: model.provider,
      model: model.id,
      timeoutMs: error.timeoutMs,
      replayBoundaryCrossed: emitted,
    });
  }

  getConfig(): ChatConfig {
    return { ...this.config };
  }

  updateConfig(newConfig: Partial<ChatConfig>): void {
    const nextConfig = { ...this.config, ...newConfig };
    const runtime = createPiRuntime(nextConfig);
    this.config = {
      ...nextConfig,
      maxContextTokens: runtime.model.contextWindow,
      maxOutputTokens: nextConfig.maxOutputTokens ?? runtime.model.maxTokens,
    };
    this.models = runtime.models;
    this.model = runtime.model;
  }
}
