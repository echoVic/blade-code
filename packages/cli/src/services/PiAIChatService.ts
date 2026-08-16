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
  DEFAULT_PROVIDER_CIRCUIT_OPEN_MS,
  getProviderCircuitRegistry,
  isProviderCircuitOpenError,
  MAX_PROVIDER_CIRCUIT_PROBE_LEASE_MS,
  MIN_PROVIDER_CIRCUIT_PROBE_LEASE_MS,
  type ProviderCircuitAdmission,
  type ProviderCircuitEvent,
  type ProviderCircuitFailure,
  ProviderCircuitOpenError,
  type ProviderCircuitPreflight,
  type ProviderCircuitTransition,
} from './pi/providerCircuitBreaker.js';
import {
  DEFAULT_PROVIDER_REQUEST_ADMISSION_MS,
  DEFAULT_PROVIDER_REQUEST_CONCURRENCY,
  getProviderRequestAdmissionScheduler,
  isProviderAdmissionError,
  PROVIDER_ADMISSION_HEARTBEAT_MS,
  type ProviderAdmissionError,
  type ProviderAdmissionEvent,
  type ProviderAdmissionPermit,
  type ProviderAdmissionQueueSnapshot,
} from './pi/providerRequestAdmission.js';
import {
  classifyProviderRetry,
  computeProviderRetryDelay,
  getProviderRetryAfterMs,
  markProviderReplayBoundary,
  ProviderRecoveryBudgetExceededError,
  type ProviderResponseMetadata,
  type ProviderRetryEvent,
  type ProviderRetryMode,
} from './pi/providerRetry.js';
import { buildPiOptions, observePiProviderResponses } from './pi/requestOptions.js';
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, streamPiModel } from './pi/streamAdapter.js';

const logger = createLogger(LogCategory.CHAT);
let nextServiceAdmissionOwner = 1;

function hasImageContent(message: Message | undefined): boolean {
  return Boolean(
    message &&
      message.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'image_url')
  );
}

function classifyProviderCircuitFailure(
  error: unknown,
  response?: ProviderResponseMetadata
): ProviderCircuitFailure | undefined {
  const classification = classifyProviderRetry(error, response);
  if (!classification.retryable || !classification.reason) return undefined;
  const statusCode = classification.statusCode;
  switch (classification.reason) {
    case 'rate_limit':
      if (statusCode !== 429) return undefined;
      break;
    case 'server_error':
      if (statusCode === undefined || statusCode < 500 || statusCode > 599) {
        return undefined;
      }
      break;
    case 'transport':
    case 'stream_closed':
      break;
    case 'timeout':
      return undefined;
  }
  const retryAfterMs = getProviderRetryAfterMs(response, Date.now());
  return {
    reason: classification.reason,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

function isProviderStreamIdleTimeout(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'STREAM_IDLE_TIMEOUT'
  );
}

export class PiAIChatService implements IChatService {
  private config: ChatConfig;
  private models: MutableModels;
  private model: Model<Api>;
  private readonly admissionFallbackOwnerId =
    `pi-service-${process.pid}-${nextServiceAdmissionOwner++}`;

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
    const circuitRegistry =
      this.config.providerCircuitRegistry ?? getProviderCircuitRegistry();
    const circuitOpenDurationMs =
      this.config.providerCircuitBreakerOpenMs ?? DEFAULT_PROVIDER_CIRCUIT_OPEN_MS;
    const circuitProbeLeaseMs = Math.max(
      MIN_PROVIDER_CIRCUIT_PROBE_LEASE_MS,
      Math.min(
        this.config.streamIdleTimeout ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
        MAX_PROVIDER_CIRCUIT_PROBE_LEASE_MS
      )
    );
    const providerAdmissionScheduler =
      this.config.providerRequestAdmissionScheduler ??
      getProviderRequestAdmissionScheduler();
    const providerRequestConcurrency =
      this.config.providerRequestConcurrency ?? DEFAULT_PROVIDER_REQUEST_CONCURRENCY;
    const providerRequestAdmissionMs =
      this.config.providerRequestAdmissionMs ?? DEFAULT_PROVIDER_REQUEST_ADMISSION_MS;
    const providerAdmissionIdentity = requestOptions?.providerAdmission ?? {
      sessionId: this.admissionFallbackOwnerId,
      ownerId: this.admissionFallbackOwnerId,
      requestClass: 'internal' as const,
    };

    const circuitFor = (model: Model<Api>) =>
      circuitRegistry.get({
        provider: model.provider,
        api: model.api,
        baseUrl: model.baseUrl ?? this.config.baseUrl ?? '',
        model: model.id,
        serviceTier: this.config.serviceTier,
        apiVersion: this.config.apiVersion,
        apiKey: this.config.apiKey,
        customHeaders: this.config.customHeaders,
        openDurationMs: circuitOpenDurationMs,
        probeLeaseMs: circuitProbeLeaseMs,
      });
    const admissionScopeFor = (model: Model<Api>) => ({
      provider: model.provider,
      api: model.api,
      baseUrl: model.baseUrl ?? this.config.baseUrl ?? '',
      model: model.id,
      serviceTier: this.config.serviceTier,
      apiVersion: this.config.apiVersion,
      apiKey: this.config.apiKey,
      customHeaders: this.config.customHeaders,
      maxConcurrent: providerRequestConcurrency,
    });

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
    const admissionEventFromSnapshot = (
      phase: 'queued' | 'admitted',
      snapshot: ProviderAdmissionQueueSnapshot
    ): ProviderAdmissionEvent => {
      const { state: _state, ...event } = snapshot;
      return {
        phase,
        ...event,
        ...(recoverySnapshot()
          ? { recoveryRemainingMs: recoverySnapshot()?.recoveryRemainingMs }
          : {}),
      };
    };
    const admissionEventFromError = (
      error: ProviderAdmissionError
    ): ProviderAdmissionEvent => ({
      phase: 'rejected',
      requestClass: error.requestClass,
      scope: error.scope,
      reason: error.reason,
      queuePosition: 0,
      queueDepth: Math.max(0, error.queued),
      inFlight: Math.max(0, error.inFlight),
      limit: Math.max(0, error.limit),
      waitMs: error.reason === 'wait_timeout' ? error.maxWaitMs : 0,
      maxWaitMs: error.maxWaitMs,
      ...(recoverySnapshot()
        ? { recoveryRemainingMs: recoverySnapshot()?.recoveryRemainingMs }
        : {}),
    });
    const acquireProviderPermit = async function* (
      model: Model<Api>
    ): AsyncGenerator<StreamChunk, ProviderAdmissionPermit, unknown> {
      const recoveryRemainingMs = recoverySnapshot()?.recoveryRemainingMs;
      const maxWaitMs =
        recoveryRemainingMs !== undefined && boundedRecovery?.startedAt !== undefined
          ? Math.min(providerRequestAdmissionMs, recoveryRemainingMs)
          : providerRequestAdmissionMs;
      let ticket;
      try {
        ticket = providerAdmissionScheduler.admit({
          scope: admissionScopeFor(model),
          sessionId: providerAdmissionIdentity.sessionId,
          ownerId: providerAdmissionIdentity.ownerId,
          requestClass: providerAdmissionIdentity.requestClass,
          maxWaitMs,
          signal,
        });
      } catch (error) {
        if (isProviderAdmissionError(error)) {
          if (
            error.reason === 'wait_timeout' &&
            boundedRecovery?.startedAt !== undefined &&
            (recoverySnapshot()?.recoveryRemainingMs ?? 0) <= 0
          ) {
            throw budgetError();
          }
          yield { providerAdmission: admissionEventFromError(error) };
        }
        throw error;
      }
      const initial = ticket.getSnapshot();
      if (initial.state === 'admitted') return await ticket.ready;
      yield {
        providerAdmission: admissionEventFromSnapshot('queued', initial),
      };

      const ready = ticket.ready.then(
        (permit) => ({ kind: 'ready' as const, permit }),
        (error) => ({ kind: 'error' as const, error })
      );
      while (true) {
        const snapshot = ticket.getSnapshot();
        const heartbeatMs = Math.max(
          1,
          Math.min(
            PROVIDER_ADMISSION_HEARTBEAT_MS,
            Math.max(1, maxWaitMs - snapshot.waitMs)
          )
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        const heartbeat = new Promise<{ kind: 'heartbeat' }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: 'heartbeat' }), heartbeatMs);
          timer.unref?.();
        });
        const outcome = await Promise.race([ready, heartbeat]);
        if (timer) clearTimeout(timer);
        if (outcome.kind === 'heartbeat') {
          yield {
            providerAdmission: admissionEventFromSnapshot(
              'queued',
              ticket.getSnapshot()
            ),
          };
          continue;
        }
        if (outcome.kind === 'error') {
          if (isProviderAdmissionError(outcome.error)) {
            if (
              outcome.error.reason === 'wait_timeout' &&
              boundedRecovery?.startedAt !== undefined &&
              (recoverySnapshot()?.recoveryRemainingMs ?? 0) <= 0
            ) {
              throw budgetError();
            }
            yield {
              providerAdmission: admissionEventFromError(outcome.error),
            };
          }
          throw outcome.error;
        }
        yield {
          providerAdmission: admissionEventFromSnapshot(
            'admitted',
            ticket.getSnapshot()
          ),
        };
        return outcome.permit;
      }
    };

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
    const circuitEventFromTransition = (
      transition: ProviderCircuitTransition
    ): ProviderCircuitEvent => ({
      phase: transition.phase,
      reason: transition.reason,
      ...(transition.statusCode !== undefined
        ? { statusCode: transition.statusCode }
        : {}),
      ...(transition.retryAfterMs !== undefined
        ? { retryAfterMs: transition.retryAfterMs }
        : {}),
      ...(transition.nextProbeAt !== undefined
        ? { nextProbeAt: transition.nextProbeAt }
        : {}),
      openDurationMs: transition.openDurationMs,
      sampleCount: transition.sampleCount,
      failureCount: transition.failureCount,
      ...(recoverySnapshot()
        ? { recoveryRemainingMs: recoverySnapshot()?.recoveryRemainingMs }
        : {}),
    });
    const circuitEventFromBlocked = (
      phase: 'waiting' | 'rejected',
      admission:
        | Extract<ProviderCircuitAdmission, { allowed: false }>
        | Extract<ProviderCircuitPreflight, { eligible: false }>
    ): ProviderCircuitEvent => ({
      phase,
      reason: admission.reason,
      ...(admission.statusCode !== undefined
        ? { statusCode: admission.statusCode }
        : {}),
      retryAfterMs: admission.retryAfterMs,
      ...(admission.nextProbeAt !== undefined
        ? { nextProbeAt: admission.nextProbeAt }
        : {}),
      openDurationMs: admission.openDurationMs,
      sampleCount: admission.sampleCount,
      failureCount: admission.failureCount,
      ...(recoverySnapshot()
        ? { recoveryRemainingMs: recoverySnapshot()?.recoveryRemainingMs }
        : {}),
    });
    const circuitEventFromProbe = (
      admission: Extract<ProviderCircuitAdmission, { allowed: true }>
    ): ProviderCircuitEvent => ({
      phase: 'probe',
      reason: admission.reason ?? 'server_error',
      ...(admission.statusCode !== undefined
        ? { statusCode: admission.statusCode }
        : {}),
      openDurationMs: admission.openDurationMs ?? circuitOpenDurationMs,
      ...(admission.sampleCount !== undefined
        ? { sampleCount: admission.sampleCount }
        : {}),
      ...(admission.failureCount !== undefined
        ? { failureCount: admission.failureCount }
        : {}),
      ...(recoverySnapshot()
        ? { recoveryRemainingMs: recoverySnapshot()?.recoveryRemainingMs }
        : {}),
    });
    const recoveryExhausted = (
      attempt: number,
      reason: ProviderRetryEvent['reason'],
      statusCode?: number
    ): StreamChunk => ({
      providerRetry: {
        phase: 'exhausted',
        attempt,
        maxRetries,
        reason,
        ...(statusCode !== undefined ? { statusCode } : {}),
        ...recoveryFields(),
        exhaustedBy: 'recovery_budget',
      },
    });

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
      const circuit = circuitFor(model);
      for (let attempt = 0; attempt <= candidateMaxRetries; attempt++) {
        if (!hasLogicalAttemptCapacity()) break;
        let admission: Extract<ProviderCircuitAdmission, { allowed: true }> | undefined;
        let providerPermit: ProviderAdmissionPermit | undefined;
        while (!admission) {
          let preflight = circuit.preflight();
          while (!preflight.eligible) {
            retryReason = preflight.reason;
            retryStatusCode = preflight.statusCode;
            if (!boundedRecovery || !terminalCandidate) {
              const event = circuitEventFromBlocked('rejected', preflight);
              yield { providerCircuit: event };
              throw new ProviderCircuitOpenError(event);
            }

            beginRecovery();
            const beforeWait = recoverySnapshot();
            const remainingBudgetMs = beforeWait?.recoveryRemainingMs ?? 0;
            if (remainingBudgetMs <= 0) {
              const error = budgetError();
              yield recoveryExhausted(
                sharedAttemptLimit ? Math.max(0, logicalPhysicalAttempts - 1) : attempt,
                preflight.reason,
                preflight.statusCode
              );
              throw error;
            }
            yield {
              providerCircuit: circuitEventFromBlocked('waiting', preflight),
            };
            const waitMs = Math.min(
              Math.max(1, preflight.retryAfterMs),
              PROVIDER_RECOVERY_HEARTBEAT_MS,
              remainingBudgetMs
            );
            await abortableSleep(waitMs, signal, { throwOnAbort: true });
            if ((recoverySnapshot()?.recoveryRemainingMs ?? 0) <= 0) {
              const error = budgetError();
              yield recoveryExhausted(
                sharedAttemptLimit ? Math.max(0, logicalPhysicalAttempts - 1) : attempt,
                preflight.reason,
                preflight.statusCode
              );
              throw error;
            }
            preflight = circuit.preflight();
          }

          try {
            providerPermit = yield* acquireProviderPermit(model);
          } catch (error) {
            if (error instanceof ProviderRecoveryBudgetExceededError) {
              yield recoveryExhausted(
                sharedAttemptLimit ? Math.max(0, logicalPhysicalAttempts - 1) : attempt,
                retryReason ?? 'timeout',
                retryStatusCode
              );
            }
            throw error;
          }
          const checked = circuit.check();
          if (checked.allowed) {
            admission = checked;
          } else {
            providerPermit.release();
            providerPermit = undefined;
          }
        }

        const circuitToken = admission.token;
        if (admission.probe) {
          yield {
            providerCircuit: circuitEventFromProbe(admission),
          };
        }
        try {
          let recoveredEmitted = false;
          let circuitSuccessRecorded = false;
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
            if (!circuitSuccessRecorded) {
              circuitSuccessRecorded = true;
              const transition = circuit.recordSuccess(circuitToken);
              if (transition) {
                yield {
                  providerCircuit: circuitEventFromTransition(transition),
                };
              }
            }
            emitted = true;
            onRealChunk();
            yield chunk;
          }
          if (!circuitSuccessRecorded) {
            const transition = circuit.recordSuccess(circuitToken);
            if (transition) {
              yield {
                providerCircuit: circuitEventFromTransition(transition),
              };
            }
          }
          return;
        } catch (error) {
          providerPermit?.release();
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
          const circuitFailure = classifyProviderCircuitFailure(
            error,
            responseMetadata
          );
          const circuitTransition = circuitFailure
            ? circuit.recordFailure(circuitToken, circuitFailure)
            : responseMetadata && !isProviderStreamIdleTimeout(error)
              ? circuit.recordNeutral(circuitToken)
              : undefined;
          if (circuitTransition) {
            yield {
              providerCircuit: circuitEventFromTransition(circuitTransition),
            };
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
          if (
            circuitTransition &&
            circuitTransition.phase !== 'closed' &&
            canRetry &&
            (!boundedRecovery || !terminalCandidate)
          ) {
            const event: ProviderCircuitEvent = {
              ...circuitEventFromTransition(circuitTransition),
              phase: 'rejected',
            };
            yield { providerCircuit: event };
            throw new ProviderCircuitOpenError(event);
          }
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
            const circuitDelayMs =
              circuitTransition && circuitTransition.phase !== 'closed'
                ? (circuitTransition.retryAfterMs ?? 0)
                : 0;
            if (boundedRecovery && circuitDelayMs > 0 && circuitTransition) {
              yield {
                providerCircuit: {
                  ...circuitEventFromTransition(circuitTransition),
                  phase: 'waiting',
                },
              };
            }
            const beforeWait = recoverySnapshot();
            const requestedEffectiveDelayMs = Math.max(
              requestedDelayMs,
              circuitDelayMs
            );
            const delayMs = boundedRecovery
              ? Math.min(
                  requestedEffectiveDelayMs,
                  beforeWait?.recoveryRemainingMs ?? requestedEffectiveDelayMs
                )
              : requestedEffectiveDelayMs;
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
                  if (
                    circuitTransition &&
                    circuitTransition.phase !== 'closed' &&
                    circuitTransition.nextProbeAt !== undefined
                  ) {
                    const circuitRemainingMs = Math.max(
                      0,
                      circuitTransition.nextProbeAt - Date.now()
                    );
                    if (circuitRemainingMs > 0) {
                      yield {
                        providerCircuit: {
                          ...circuitEventFromTransition(circuitTransition),
                          phase: 'waiting',
                          retryAfterMs: circuitRemainingMs,
                        },
                      };
                    }
                  }
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
        } finally {
          circuit.abandon(circuitToken);
          providerPermit?.release();
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
      if (
        primaryEmitted ||
        (!isProviderAdmissionError(error) &&
          !isProviderCircuitOpenError(error) &&
          !classifyProviderRetry(error, responseMetadata).retryable)
      ) {
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
          (!isProviderAdmissionError(error) &&
            !isProviderCircuitOpenError(error) &&
            !classifyProviderRetry(error, responseMetadata).retryable)
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
