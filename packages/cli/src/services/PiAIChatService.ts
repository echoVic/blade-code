import type { Api, Model, MutableModels } from '@earendil-works/pi-ai';
import {
  DEFAULT_FOREGROUND_PROVIDER_MAX_RETRIES,
  isValidForegroundProviderRecoveryMs,
  MAX_FOREGROUND_PROVIDER_RETRY_DELAY_MS,
  PROVIDER_RECOVERY_HEARTBEAT_MS,
} from '../config/foregroundProviderRecovery.js';
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
  markProviderReplayBoundary,
  ProviderRecoveryBudgetExceededError,
  type ProviderResponseMetadata,
  type ProviderRetryEvent,
  type ProviderRetryMode,
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
    const requestedRecovery = requestOptions?.providerRecovery;
    if (
      requestedRecovery &&
      !isValidForegroundProviderRecoveryMs(requestedRecovery.budgetMs)
    ) {
      throw new Error('Invalid bounded foreground Provider recovery budget');
    }
    const boundedRecovery =
      requestedRecovery?.mode === 'bounded_foreground' && requestedRecovery.budgetMs > 0
        ? {
            budgetMs: requestedRecovery.budgetMs,
            startedAt: undefined as number | undefined,
          }
        : undefined;
    const retryMode: ProviderRetryMode = boundedRecovery
      ? 'bounded_foreground'
      : 'standard';
    const standardMaxRetries = this.config.maxRetries ?? 2;
    const maxRetries =
      this.config.maxRetries ??
      (boundedRecovery ? DEFAULT_FOREGROUND_PROVIDER_MAX_RETRIES : 2);
    const sharedAttemptLimit =
      boundedRecovery !== undefined && this.config.maxRetries === undefined;
    let logicalPhysicalAttempts = 0;
    let responseMetadata: ProviderResponseMetadata | undefined;

    const recoverySnapshot = (now = Date.now()) => {
      if (!boundedRecovery) return undefined;
      const elapsedMs =
        boundedRecovery.startedAt === undefined
          ? 0
          : Math.min(
              boundedRecovery.budgetMs,
              Math.max(0, now - boundedRecovery.startedAt)
            );
      return {
        recoveryBudgetMs: boundedRecovery.budgetMs,
        recoveryElapsedMs: elapsedMs,
        recoveryRemainingMs: Math.max(0, boundedRecovery.budgetMs - elapsedMs),
      };
    };
    const recoveryFields = (): Pick<
      ProviderRetryEvent,
      'mode' | 'recoveryBudgetMs' | 'recoveryElapsedMs' | 'recoveryRemainingMs'
    > => ({
      mode: retryMode,
      ...(recoverySnapshot() ?? {}),
    });
    const beginRecovery = () => {
      if (boundedRecovery && boundedRecovery.startedAt === undefined) {
        boundedRecovery.startedAt = Date.now();
      }
    };
    const budgetError = () => {
      const snapshot = recoverySnapshot();
      return new ProviderRecoveryBudgetExceededError(
        boundedRecovery?.budgetMs ?? 0,
        snapshot?.recoveryElapsedMs ?? 0
      );
    };
    const hasLogicalAttemptCapacity = () =>
      !sharedAttemptLimit || logicalPhysicalAttempts < maxRetries + 1;

    const streamFrom = (model: Model<Api>) => {
      if (!hasLogicalAttemptCapacity()) throw budgetError();
      if (sharedAttemptLimit) logicalPhysicalAttempts++;
      responseMetadata = undefined;
      const watchdogController = new AbortController();
      const requestSignal = signal
        ? combineAbortSignals(signal, watchdogController.signal)
        : watchdogController.signal;
      let budgetTimer: NodeJS.Timeout | undefined;
      if (boundedRecovery?.startedAt !== undefined) {
        const remainingMs = recoverySnapshot()?.recoveryRemainingMs ?? 0;
        if (remainingMs <= 0) throw budgetError();
        const error = new ProviderRecoveryBudgetExceededError(
          boundedRecovery.budgetMs,
          boundedRecovery.budgetMs
        );
        budgetTimer = setTimeout(() => watchdogController.abort(error), remainingMs);
        budgetTimer.unref?.();
      }
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
      const stream = streamPiModel(this.models, model, context, piOptions, {
        idleTimeoutMs: this.config.streamIdleTimeout ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
        signal: requestSignal,
        abort: (reason) => watchdogController.abort(reason),
      });
      return (async function* () {
        try {
          yield* stream;
        } finally {
          if (budgetTimer) clearTimeout(budgetTimer);
        }
      })();
    };

    const service = this;
    const streamWithRetries = async function* (
      model: Model<Api>,
      onRealChunk: () => void,
      candidateMaxRetries: number,
      terminalCandidate: boolean
    ): AsyncGenerator<StreamChunk, void, unknown> {
      let lastRetryError: unknown;
      let emitted = false;
      let retryReason: ReturnType<typeof classifyProviderRetry>['reason'];
      let retryStatusCode: number | undefined;
      for (let attempt = 0; attempt <= candidateMaxRetries; attempt++) {
        if (!hasLogicalAttemptCapacity()) break;
        try {
          let recoveredEmitted = false;
          for await (const chunk of streamFrom(model)) {
            if (chunk.providerStall) {
              yield chunk;
              continue;
            }
            const recoveredAttempt = sharedAttemptLimit
              ? logicalPhysicalAttempts - 1
              : attempt;
            if (recoveredAttempt > 0 && retryReason && !recoveredEmitted) {
              recoveredEmitted = true;
              yield {
                providerRetry: {
                  phase: 'recovered',
                  attempt: recoveredAttempt,
                  maxRetries,
                  reason: retryReason,
                  ...(retryStatusCode !== undefined
                    ? { statusCode: retryStatusCode }
                    : {}),
                  ...recoveryFields(),
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
          if (error instanceof ProviderRecoveryBudgetExceededError) {
            if (emitted) {
              markProviderReplayBoundary(error);
              throw error;
            }
            yield {
              providerRetry: {
                phase: 'exhausted',
                attempt: sharedAttemptLimit
                  ? Math.max(0, logicalPhysicalAttempts - 1)
                  : attempt,
                maxRetries,
                reason: retryReason ?? 'timeout',
                ...(retryStatusCode !== undefined
                  ? { statusCode: retryStatusCode }
                  : {}),
                ...recoveryFields(),
                exhaustedBy: 'recovery_budget',
              },
            };
            throw error;
          }
          const classification = classifyProviderRetry(error, responseMetadata);
          if (emitted) {
            markProviderReplayBoundary(error);
            throw error;
          }
          if (!classification.retryable || !classification.reason) {
            if (attempt > 0 && retryReason) {
              yield {
                providerRetry: {
                  phase: 'exhausted',
                  attempt: sharedAttemptLimit
                    ? Math.max(0, logicalPhysicalAttempts - 1)
                    : attempt,
                  maxRetries,
                  reason: retryReason,
                  ...(retryStatusCode !== undefined
                    ? { statusCode: retryStatusCode }
                    : {}),
                  ...recoveryFields(),
                },
              };
            }
            throw error;
          }
          retryReason = classification.reason;
          retryStatusCode = classification.statusCode;
          const canRetry = attempt < candidateMaxRetries && hasLogicalAttemptCapacity();
          if (canRetry) {
            beginRecovery();
            const retryAttempt = sharedAttemptLimit
              ? logicalPhysicalAttempts
              : attempt + 1;
            const requestedDelayMs = computeProviderRetryDelay(
              retryAttempt,
              responseMetadata,
              boundedRecovery
                ? {
                    maxDelayMs: MAX_FOREGROUND_PROVIDER_RETRY_DELAY_MS,
                    maxExponentialDelayMs: MAX_FOREGROUND_PROVIDER_RETRY_DELAY_MS,
                  }
                : undefined
            );
            const beforeWait = recoverySnapshot();
            const delayMs = boundedRecovery
              ? Math.min(
                  requestedDelayMs,
                  beforeWait?.recoveryRemainingMs ?? requestedDelayMs
                )
              : requestedDelayMs;
            const retryEvent = {
              attempt: retryAttempt,
              maxRetries,
              reason: classification.reason,
              ...(classification.statusCode !== undefined
                ? { statusCode: classification.statusCode }
                : {}),
            };
            yield {
              providerRetry: {
                phase: 'scheduled',
                ...retryEvent,
                delayMs,
                nextRetryAt: Date.now() + delayMs,
                ...recoveryFields(),
              },
            };
            if (boundedRecovery) {
              let remainingDelayMs = delayMs;
              while (remainingDelayMs > 0) {
                const chunkMs = Math.min(
                  remainingDelayMs,
                  PROVIDER_RECOVERY_HEARTBEAT_MS
                );
                await abortableSleep(chunkMs, signal, { throwOnAbort: true });
                remainingDelayMs -= chunkMs;
                const snapshot = recoverySnapshot();
                if ((snapshot?.recoveryRemainingMs ?? 0) <= 0) {
                  const error = budgetError();
                  yield {
                    providerRetry: {
                      phase: 'exhausted',
                      ...retryEvent,
                      ...recoveryFields(),
                      exhaustedBy: 'recovery_budget',
                    },
                  };
                  throw error;
                }
                if (remainingDelayMs > 0) {
                  yield {
                    providerRetry: {
                      phase: 'waiting',
                      ...retryEvent,
                      delayMs,
                      nextRetryAt: Date.now() + remainingDelayMs,
                      ...recoveryFields(),
                    },
                  };
                }
              }
            } else {
              await abortableSleep(delayMs, signal, { throwOnAbort: true });
            }
            yield {
              providerRetry: {
                phase: 'attempt',
                ...retryEvent,
                ...recoveryFields(),
              },
            };
          } else {
            yield {
              providerRetry: {
                phase: 'exhausted',
                attempt: sharedAttemptLimit
                  ? Math.max(0, logicalPhysicalAttempts - 1)
                  : attempt,
                maxRetries,
                reason: classification.reason,
                ...(classification.statusCode !== undefined
                  ? { statusCode: classification.statusCode }
                  : {}),
                ...recoveryFields(),
                ...(boundedRecovery &&
                (terminalCandidate || !hasLogicalAttemptCapacity())
                  ? { exhaustedBy: 'attempt_limit' as const }
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
    const fallbackModels = this.config.fallbackModels ?? [];
    const primaryRetryLimit =
      boundedRecovery && fallbackModels.length > 0
        ? Math.min(standardMaxRetries, maxRetries)
        : maxRetries;
    try {
      for await (const chunk of streamWithRetries(
        this.model,
        () => {
          primaryEmitted = true;
        },
        primaryRetryLimit,
        fallbackModels.length === 0
      )) {
        yield chunk;
      }
      return;
    } catch (error) {
      lastError = error;
      if (primaryEmitted || !classifyProviderRetry(error, responseMetadata).retryable) {
        throw error;
      }
    }

    for (const [index, fallback] of fallbackModels.entries()) {
      if (!hasLogicalAttemptCapacity()) break;
      yield { modelFallback: true };
      let fallbackEmitted = false;
      try {
        const fallbackModel = createFallbackModel(this.config, fallback);
        const terminalCandidate = index === fallbackModels.length - 1;
        const candidateRetryLimit =
          boundedRecovery && !terminalCandidate
            ? Math.min(standardMaxRetries, maxRetries)
            : maxRetries;
        for await (const chunk of streamWithRetries(
          fallbackModel,
          () => {
            fallbackEmitted = true;
          },
          candidateRetryLimit,
          terminalCandidate
        )) {
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
