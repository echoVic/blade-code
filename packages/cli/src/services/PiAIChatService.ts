import type { Api, Model, MutableModels } from '@earendil-works/pi-ai';
import { createLogger, LogCategory } from '../logging/Logger.js';
import { abortableSleep, combineAbortSignals } from '../utils/abort.js';
import type {
  ChatCompletionMessageToolCall,
  ChatConfig,
  ChatRequestOptions,
  ChatResponse,
  ChatToolDefinition,
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
import {
  classifyProviderRetry,
  computeProviderRetryDelay,
  type ProviderResponseMetadata,
} from './pi/providerRetry.js';
import { buildPiOptions, observePiProviderResponses } from './pi/requestOptions.js';
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, streamPiModel } from './pi/streamAdapter.js';

const logger = createLogger(LogCategory.CHAT);

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
    tools?: ChatToolDefinition[],
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
    tools?: ChatToolDefinition[],
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
    let responseMetadata: ProviderResponseMetadata | undefined;
    const streamFrom = (model: Model<Api>) => {
      responseMetadata = undefined;
      const watchdogController = new AbortController();
      const requestSignal = signal
        ? combineAbortSignals(signal, watchdogController.signal)
        : watchdogController.signal;
      const piOptions = buildPiOptions(
        this.config,
        model,
        requestSignal,
        requestOptions,
        disableThinking
      );
      observePiProviderResponses(piOptions, model, (response) => {
        responseMetadata = response;
      });
      return streamPiModel(this.models, model, context, piOptions, {
        idleTimeoutMs: this.config.streamIdleTimeout ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
        signal: requestSignal,
        abort: (reason) => watchdogController.abort(reason),
      });
    };

    const maxRetries = this.config.maxRetries ?? 2;
    const service = this;
    const streamWithRetries = async function* (
      model: Model<Api>,
      onRealChunk: () => void
    ): AsyncGenerator<StreamChunk, void, unknown> {
      let lastRetryError: unknown;
      let emitted = false;
      let retryReason: ReturnType<typeof classifyProviderRetry>['reason'];
      let retryStatusCode: number | undefined;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          let recoveredEmitted = false;
          for await (const chunk of streamFrom(model)) {
            if (chunk.providerStall) {
              yield chunk;
              continue;
            }
            if (attempt > 0 && retryReason && !recoveredEmitted) {
              recoveredEmitted = true;
              yield {
                providerRetry: {
                  phase: 'recovered',
                  attempt,
                  maxRetries,
                  reason: retryReason,
                  ...(retryStatusCode !== undefined
                    ? { statusCode: retryStatusCode }
                    : {}),
                },
              };
            }
            emitted = true;
            onRealChunk();
            yield chunk;
          }
          return;
        } catch (error) {
          lastRetryError = error;
          service.logIdleTimeout(error, emitted, model);
          await service.handleAbort(signal);
          const classification = classifyProviderRetry(error, responseMetadata);
          if (emitted) throw error;
          if (!classification.retryable || !classification.reason) {
            if (attempt > 0 && retryReason) {
              yield {
                providerRetry: {
                  phase: 'exhausted',
                  attempt,
                  maxRetries,
                  reason: retryReason,
                  ...(retryStatusCode !== undefined
                    ? { statusCode: retryStatusCode }
                    : {}),
                },
              };
            }
            throw error;
          }
          retryReason = classification.reason;
          retryStatusCode = classification.statusCode;
          if (attempt < maxRetries) {
            const retryAttempt = attempt + 1;
            const delayMs = computeProviderRetryDelay(retryAttempt, responseMetadata);
            yield {
              providerRetry: {
                phase: 'scheduled',
                attempt: retryAttempt,
                maxRetries,
                reason: classification.reason,
                ...(classification.statusCode !== undefined
                  ? { statusCode: classification.statusCode }
                  : {}),
                delayMs,
                nextRetryAt: Date.now() + delayMs,
              },
            };
            await abortableSleep(delayMs, signal, { throwOnAbort: true });
            yield {
              providerRetry: {
                phase: 'attempt',
                attempt: retryAttempt,
                maxRetries,
                reason: classification.reason,
                ...(classification.statusCode !== undefined
                  ? { statusCode: classification.statusCode }
                  : {}),
              },
            };
          } else {
            yield {
              providerRetry: {
                phase: 'exhausted',
                attempt,
                maxRetries,
                reason: classification.reason,
                ...(classification.statusCode !== undefined
                  ? { statusCode: classification.statusCode }
                  : {}),
              },
            };
          }
        }
      }
      throw lastRetryError;
    };

    let lastError: unknown;
    let primaryEmitted = false;
    try {
      for await (const chunk of streamWithRetries(this.model, () => {
        primaryEmitted = true;
      })) {
        yield chunk;
      }
      return;
    } catch (error) {
      lastError = error;
      if (primaryEmitted || !classifyProviderRetry(error, responseMetadata).retryable) {
        throw error;
      }
    }

    for (const fallback of this.config.fallbackModels ?? []) {
      yield { modelFallback: true };
      let fallbackEmitted = false;
      try {
        const fallbackModel = createFallbackModel(this.config, fallback);
        for await (const chunk of streamWithRetries(fallbackModel, () => {
          fallbackEmitted = true;
        })) {
          yield chunk;
        }
        return;
      } catch (error) {
        lastError = error;
        if (
          fallbackEmitted ||
          !classifyProviderRetry(error, responseMetadata).retryable
        ) {
          throw error;
        }
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
