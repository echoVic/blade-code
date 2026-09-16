import type { Api, Model } from '@earendil-works/pi-ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChatConfig,
  StreamChunk,
} from '../../../src/services/ChatServiceInterface.js';
import {
  type ProviderCircuitEvent,
  ProviderCircuitRegistry,
  type ProviderCircuitScope,
} from '../../../src/services/pi/providerCircuitBreaker.js';
import {
  DEFAULT_PROVIDER_REQUEST_PENDING_BYTES,
  type ProviderAdmissionPermit,
  type ProviderAdmissionRequest,
  ProviderRequestAdmissionScheduler,
  resetProviderRequestAdmissionSchedulerForTests,
} from '../../../src/services/pi/providerRequestAdmission.js';
import { providerReplayBoundaryCrossed } from '../../../src/services/pi/providerRetry.js';

// pi-ai runtime metadata fixture, not Blade's persisted ModelConfig.
const piModelFixture: Model<Api> = {
  id: 'test-model',
  name: 'Test Model',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: 'https://example.test/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
};

const createPiContext = vi.fn(async () => ({ messages: [] }));
const createFallbackModel = vi.fn((_config, ref: { model: string }) => ({
  ...piModelFixture,
  id: ref.model,
}));
const createPiRuntime = vi.fn(() => ({
  models: {},
  model: piModelFixture,
}));
const buildPiOptions = vi.fn(() => ({}));
const observePiProviderResponses = vi.fn();
const streamPiModel = vi.fn();
const estimateProviderRequestPendingBytes = vi.fn(() => 1);

vi.mock('../../../src/logging/Logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  LogCategory: { CHAT: 'CHAT' },
}));

vi.mock('../../../src/services/pi/contextAdapter.js', () => ({
  createPiContext,
  filterOrphanToolMessages: (messages: unknown[]) => messages,
  hasNonThinkingToolHistory: () => false,
}));

vi.mock('../../../src/services/pi/modelRuntime.js', () => ({
  createFallbackModel,
  createPiRuntime,
}));

vi.mock('../../../src/services/pi/requestOptions.js', () => ({
  buildPiOptions,
  observePiProviderResponses,
}));

vi.mock('../../../src/services/pi/providerRequestFootprint.js', () => ({
  estimateProviderRequestPendingBytes,
}));

vi.mock('../../../src/services/pi/streamAdapter.js', () => ({
  DEFAULT_STREAM_IDLE_TIMEOUT_MS: 300_000,
  streamPiModel,
}));

function config(overrides: Partial<ChatConfig> = {}): ChatConfig {
  return {
    provider: 'openai-compatible',
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1',
    model: 'test-model',
    maxRetries: 0,
    providerCircuitBreakerOpenMs: 0,
    providerRequestAdmissionScheduler: new ProviderRequestAdmissionScheduler({
      processSecret: new Uint8Array(32).fill(15),
    }),
    ...overrides,
  };
}

async function* chunks(
  values: Array<StreamChunk | Error>
): AsyncGenerator<StreamChunk> {
  for (const value of values) {
    if (value instanceof Error) throw value;
    yield value;
  }
}

async function* chunksUntilAbort(
  signal: AbortSignal,
  values: StreamChunk[] = []
): AsyncGenerator<StreamChunk> {
  for (const value of values) yield value;
  await new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function service(overrides: Partial<ChatConfig> = {}) {
  const { PiAIChatService } = await import('../../../src/services/PiAIChatService.js');
  return new PiAIChatService(config(overrides));
}

function circuitOverrides(
  circuitRegistry: ProviderCircuitRegistry,
  overrides: Partial<ChatConfig> = {}
): Partial<ChatConfig> {
  return {
    providerCircuitBreakerOpenMs: 2_000,
    providerCircuitRegistry: circuitRegistry,
    ...overrides,
  } as Partial<ChatConfig>;
}

function circuitScope(
  overrides: Partial<ProviderCircuitScope> = {}
): ProviderCircuitScope {
  return {
    provider: piModelFixture.provider,
    api: piModelFixture.api,
    baseUrl: piModelFixture.baseUrl,
    model: piModelFixture.id,
    apiKey: 'test-key',
    openDurationMs: 2_000,
    probeLeaseMs: 300_000,
    ...overrides,
  };
}

function tripCircuit(
  circuitRegistry: ProviderCircuitRegistry,
  overrides: Partial<ProviderCircuitScope> = {}
) {
  const handle = circuitRegistry.get(circuitScope(overrides));
  for (let index = 0; index < 4; index++) {
    const admission = handle.check();
    expect(admission.allowed).toBe(true);
    if (!admission.allowed) throw new Error('expected circuit admission');
    handle.recordFailure(admission.token, {
      reason: 'server_error',
      statusCode: 503,
    });
  }
  expect(handle.snapshot().state).toBe('open');
  return handle;
}

function circuitEvents(events: readonly StreamChunk[]): ProviderCircuitEvent[] {
  return events.flatMap((event) =>
    event.providerCircuit ? [event.providerCircuit] : []
  );
}

function providerAdmissionRequest(
  ownerId: string,
  overrides: Partial<ProviderAdmissionRequest> = {}
): ProviderAdmissionRequest {
  return {
    scope: {
      provider: piModelFixture.provider,
      api: piModelFixture.api,
      baseUrl: piModelFixture.baseUrl,
      model: piModelFixture.id,
      apiKey: 'test-key',
      maxConcurrent: 1,
      maxPendingBytes: DEFAULT_PROVIDER_REQUEST_PENDING_BYTES,
    },
    sessionId: `${ownerId}-session`,
    ownerId,
    requestClass: 'foreground',
    maxWaitMs: 120_000,
    pendingBytes: 1,
    ...overrides,
  };
}

describe('PiAIChatService', () => {
  beforeEach(() => {
    resetProviderRequestAdmissionSchedulerForTests();
    vi.clearAllMocks();
    createPiRuntime.mockReturnValue({ models: {}, model: piModelFixture });
    observePiProviderResponses.mockReset();
    streamPiModel.mockReset();
    estimateProviderRequestPendingBytes.mockReset();
    estimateProviderRequestPendingBytes.mockReturnValue(1);
  });

  it('creates admission only when a concurrency limit is explicit', async () => {
    const chat = await service({
      providerRequestAdmissionScheduler: undefined,
      providerOwnerConcurrency: 7,
    });

    expect(
      (
        chat as unknown as {
          providerAdmissionScheduler?: ProviderRequestAdmissionScheduler;
        }
      ).providerAdmissionScheduler
    ).toBeInstanceOf(ProviderRequestAdmissionScheduler);
  });

  it('rejects a required tool that is unavailable', async () => {
    const chat = await service();
    await expect(
      chat.chat([{ role: 'user', content: 'delegate' }], [], undefined, {
        toolChoice: { type: 'tool', toolName: 'Task' },
      })
    ).rejects.toThrow('Required tool is unavailable: Task');
    expect(streamPiModel).not.toHaveBeenCalled();
  });

  it('rejects image input anywhere in history for a text-only model', async () => {
    const chat = await service();
    await expect(
      chat.chat([
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,abc' },
            },
          ],
        },
        { role: 'assistant', content: 'I saw an image.' },
        { role: 'user', content: 'Continue without looking again.' },
      ])
    ).rejects.toThrow('Test Model does not support image input');

    expect(createPiContext).not.toHaveBeenCalled();
    expect(streamPiModel).not.toHaveBeenCalled();
  });

  it('aggregates pi stream chunks into a chat response', async () => {
    streamPiModel.mockReturnValue(
      chunks([
        { reasoningContent: 'think' },
        { content: 'done' },
        {
          toolCalls: [
            {
              index: 0,
              id: 'call-1',
              type: 'function',
              function: { name: 'Read', arguments: '{"file_path":"/tmp/a"}' },
            },
          ],
        },
        {
          finishReason: 'toolUse',
          usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
        },
      ])
    );

    const result = await (await service()).chat([{ role: 'user', content: 'read' }]);

    expect(result).toMatchObject({
      content: 'done',
      reasoningContent: 'think',
      finishReason: 'toolUse',
      usage: { totalTokens: 12 },
    });
    const toolCall = result.toolCalls?.[0];
    expect(
      toolCall && 'function' in toolCall ? toolCall.function.name : undefined
    ).toBe('Read');
  });

  it('rejects an overweight waiting request before creating Provider traffic', async () => {
    const admissionScheduler = new ProviderRequestAdmissionScheduler({
      processSecret: new Uint8Array(32).fill(16),
      globalMaxInFlight: 1,
      globalMaxPendingBytes: 64,
      domainMaxPendingBytes: 64,
      ownerMaxPendingBytes: 64,
    });
    const held = await admissionScheduler.admit(
      providerAdmissionRequest('holder', {
        scope: {
          ...providerAdmissionRequest('holder').scope,
          maxPendingBytes: 64,
        },
      })
    ).ready;
    estimateProviderRequestPendingBytes.mockReturnValue(65);
    const stream = (
      await service({
        providerRequestConcurrency: 1,
        providerRequestAdmissionMs: 120_000,
        providerRequestPendingBytes: 64,
        providerRequestAdmissionScheduler: admissionScheduler,
      })
    ).streamChat(
      [{ role: 'user', content: 'overweight while waiting' }],
      undefined,
      undefined,
      {
        providerAdmission: {
          sessionId: 'waiting-session',
          ownerId: 'waiting-owner',
          requestClass: 'foreground',
        },
      }
    );

    await expect(stream.next()).resolves.toMatchObject({
      value: {
        providerAdmission: {
          phase: 'rejected',
          requestClass: 'foreground',
          resource: 'pending_bytes',
          scope: 'global',
          reason: 'queue_full',
        },
      },
    });
    await expect(stream.next()).rejects.toMatchObject({
      code: 'PROVIDER_ADMISSION_BUSY',
      resource: 'pending_bytes',
    });
    expect(estimateProviderRequestPendingBytes).toHaveBeenCalledOnce();
    expect(streamPiModel).not.toHaveBeenCalled();
    expect(admissionScheduler.getStats()).toMatchObject({
      inFlight: 1,
      queued: 0,
      pendingBytes: 0,
      domainCount: 1,
      ownerCount: 1,
    });
    held.release();
  });

  it('rechecks the circuit after capacity admission and sends no raced request', async () => {
    const admissionScheduler = new ProviderRequestAdmissionScheduler({
      processSecret: new Uint8Array(32).fill(13),
    });
    const circuitRegistry = new ProviderCircuitRegistry({
      processSecret: new Uint8Array(32).fill(14),
    });
    const held = await admissionScheduler.admit(providerAdmissionRequest('holder'))
      .ready;
    const stream = (
      await service({
        ...circuitOverrides(circuitRegistry, {
          maxRetries: 0,
          providerRequestConcurrency: 1,
          providerRequestAdmissionMs: 120_000,
          providerRequestAdmissionScheduler: admissionScheduler,
        }),
      })
    ).streamChat(
      [{ role: 'user', content: 'respect the raced circuit' }],
      undefined,
      undefined,
      {
        providerAdmission: {
          sessionId: 'waiting-session',
          ownerId: 'waiting-owner',
          requestClass: 'foreground',
        },
      }
    );

    await expect(stream.next()).resolves.toMatchObject({
      value: { providerAdmission: { phase: 'queued' } },
    });
    tripCircuit(circuitRegistry);
    held.release();
    await expect(stream.next()).resolves.toMatchObject({
      value: { providerAdmission: { phase: 'admitted' } },
    });
    await expect(stream.next()).resolves.toMatchObject({
      value: { providerCircuit: { phase: 'rejected' } },
    });
    await expect(stream.next()).rejects.toMatchObject({
      code: 'PROVIDER_CIRCUIT_OPEN',
    });
    expect(streamPiModel).not.toHaveBeenCalled();
    expect(admissionScheduler.getStats()).toMatchObject({
      inFlight: 0,
      queued: 0,
    });
  });

  it('removes a queued caller abort without emitting an admission rejection', async () => {
    const admissionScheduler = new ProviderRequestAdmissionScheduler({
      processSecret: new Uint8Array(32).fill(17),
      globalMaxInFlight: 1,
    });
    const held = await admissionScheduler.admit(
      providerAdmissionRequest('holder', {
        scope: {
          ...providerAdmissionRequest('holder').scope,
          model: 'other-model',
        },
      })
    ).ready;
    const controller = new AbortController();
    const reason = new Error('user cancelled capacity wait');
    const stream = (
      await service({
        providerRequestAdmissionScheduler: admissionScheduler,
      })
    ).streamChat(
      [{ role: 'user', content: 'cancel while queued' }],
      undefined,
      controller.signal,
      {
        providerAdmission: {
          sessionId: 'waiting-session',
          ownerId: 'waiting-owner',
          requestClass: 'foreground',
        },
      }
    );

    await expect(stream.next()).resolves.toMatchObject({
      value: { providerAdmission: { phase: 'queued' } },
    });
    controller.abort(reason);
    await expect(stream.next()).rejects.toBe(reason);
    expect(streamPiModel).not.toHaveBeenCalled();
    expect(admissionScheduler.getStats()).toMatchObject({
      inFlight: 1,
      queued: 0,
    });
    held.release();
  });

  it('falls back after primary admission timeout without a primary request', async () => {
    const admissionScheduler = new ProviderRequestAdmissionScheduler({
      processSecret: new Uint8Array(32).fill(18),
    });
    const held = await admissionScheduler.admit(providerAdmissionRequest('holder'))
      .ready;
    streamPiModel.mockReturnValue(chunks([{ content: 'fallback-admitted' }]));
    const stream = (
      await service({
        maxRetries: 0,
        fallbackModels: [{ provider: 'test', model: 'backup' }],
        providerRequestConcurrency: 1,
        providerRequestAdmissionMs: 10,
        providerRequestAdmissionScheduler: admissionScheduler,
      })
    ).streamChat(
      [{ role: 'user', content: 'use capacity fallback' }],
      undefined,
      undefined,
      {
        providerAdmission: {
          sessionId: 'waiting-session',
          ownerId: 'waiting-owner',
          requestClass: 'foreground',
        },
      }
    );

    await expect(stream.next()).resolves.toMatchObject({
      value: { providerAdmission: { phase: 'queued' } },
    });
    await expect(stream.next()).resolves.toMatchObject({
      value: {
        providerAdmission: {
          phase: 'rejected',
          reason: 'wait_timeout',
        },
      },
    });
    await expect(stream.next()).resolves.toEqual({
      value: {
        modelFallback: {
          from: { provider: 'test', model: 'test-model' },
          to: { provider: 'test', model: 'backup' },
          candidate: 1,
          candidateCount: 1,
          trigger: { source: 'admission', reason: 'wait_timeout' },
        },
      },
      done: false,
    });
    await expect(stream.next()).resolves.toMatchObject({
      value: { content: 'fallback-admitted' },
    });
    await expect(stream.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
    expect(streamPiModel).toHaveBeenCalledOnce();
    expect(streamPiModel.mock.calls[0]?.[1]).toMatchObject({ id: 'backup' });
    held.release();
  });

  it('lets the foreground recovery deadline win over admission timeout', async () => {
    vi.useFakeTimers({ now: 1_000 });
    const admissionScheduler = new ProviderRequestAdmissionScheduler({
      processSecret: new Uint8Array(32).fill(21),
    });
    streamPiModel.mockReturnValueOnce(chunks([new Error('status 503')]));
    const stream = (
      await service({
        maxRetries: undefined,
        providerRequestConcurrency: 1,
        providerRequestAdmissionMs: 180_000,
        providerRequestAdmissionScheduler: admissionScheduler,
      })
    ).streamChat([{ role: 'user', content: 'budget' }], undefined, undefined, {
      providerRecovery: {
        mode: 'bounded_foreground',
        budgetMs: 30_000,
      },
      providerAdmission: {
        sessionId: 'budget-session',
        ownerId: 'budget-owner',
        requestClass: 'foreground',
      },
    });

    let held: ProviderAdmissionPermit | undefined;
    try {
      const scheduled = await stream.next();
      expect(scheduled.value).toMatchObject({
        providerRetry: { phase: 'scheduled' },
      });
      held = await admissionScheduler.admit(
        providerAdmissionRequest('holder', { maxWaitMs: 180_000 })
      ).ready;
      const retryAttempt = stream.next();
      const delayMs = scheduled.value?.providerRetry?.delayMs ?? 0;
      await vi.advanceTimersByTimeAsync(delayMs);
      await expect(retryAttempt).resolves.toMatchObject({
        value: { providerRetry: { phase: 'attempt' } },
      });
      await expect(stream.next()).resolves.toMatchObject({
        value: { providerAdmission: { phase: 'queued' } },
      });

      const remainingEvents: StreamChunk[] = [];
      let observed: unknown;
      const consume = (async () => {
        try {
          for await (const event of stream) remainingEvents.push(event);
        } catch (error) {
          observed = error;
        }
      })();
      await vi.runAllTimersAsync();
      await consume;
      expect(
        remainingEvents.some((event) => event.providerAdmission?.phase === 'rejected')
      ).toBe(false);
      expect(remainingEvents).toContainEqual(
        expect.objectContaining({
          providerRetry: expect.objectContaining({
            phase: 'exhausted',
            exhaustedBy: 'recovery_budget',
            recoveryRemainingMs: 0,
          }),
        })
      );
      expect(observed).toMatchObject({
        code: 'PROVIDER_RECOVERY_BUDGET_EXCEEDED',
      });
      expect(streamPiModel).toHaveBeenCalledOnce();
    } finally {
      held?.release();
      await stream.return(undefined);
      vi.useRealTimers();
    }
  });

  it('uses the previously failed fallback as the next fallback source', async () => {
    streamPiModel
      .mockReturnValueOnce(chunks([new Error('status 503')]))
      .mockReturnValueOnce(chunks([new Error('status 503')]))
      .mockReturnValueOnce(chunks([{ content: 'second fallback' }]));

    const events: StreamChunk[] = [];
    const stream = (
      await service({
        maxRetries: 0,
        fallbackModels: [
          { provider: 'test', model: 'backup-one' },
          { provider: 'test', model: 'backup-two' },
        ],
      })
    ).streamChat([{ role: 'user', content: 'use the second fallback' }]);
    for await (const event of stream) events.push(event);

    expect(events.flatMap((event) => event.modelFallback ?? [])).toEqual([
      expect.objectContaining({
        from: { provider: 'test', model: 'test-model' },
        to: { provider: 'test', model: 'backup-one' },
        candidate: 1,
        candidateCount: 2,
      }),
      expect.objectContaining({
        from: { provider: 'test', model: 'backup-one' },
        to: { provider: 'test', model: 'backup-two' },
        candidate: 2,
        candidateCount: 2,
      }),
    ]);
  });

  it('switches providers after a pre-output idle timeout without retrying primary', async () => {
    const idleTimeout = Object.assign(new Error('provider stream idle timeout'), {
      code: 'STREAM_IDLE_TIMEOUT',
    });
    const scheduler = new ProviderRequestAdmissionScheduler({
      processSecret: new Uint8Array(32).fill(19),
    });
    const admit = vi.spyOn(scheduler, 'admit');
    streamPiModel
      .mockReturnValueOnce(chunks([idleTimeout]))
      .mockReturnValueOnce(chunks([{ content: 'fallback' }]));

    const result = await (
      await service({
        maxRetries: 2,
        providerRequestAdmissionScheduler: scheduler,
        fallbackModels: [
          {
            provider: 'fallback-provider',
            model: 'backup',
            channel: {
              apiKey: 'fallback-key',
              baseUrl: 'https://fallback.example.test/v1',
            },
          },
        ],
      })
    ).chat([{ role: 'user', content: 'hello' }]);

    expect(result.content).toBe('fallback');
    expect(streamPiModel).toHaveBeenCalledTimes(2);
    expect(buildPiOptions).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        apiKey: 'test-key',
        baseUrl: 'https://example.test/v1',
      }),
      expect.any(Object),
      expect.any(AbortSignal),
      undefined,
      false
    );
    expect(buildPiOptions).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        apiKey: 'fallback-key',
        baseUrl: 'https://fallback.example.test/v1',
      }),
      expect.any(Object),
      expect.any(AbortSignal),
      undefined,
      false
    );
    expect(admit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        scope: expect.objectContaining({ apiKey: 'test-key' }),
      })
    );
    expect(admit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        scope: expect.objectContaining({ apiKey: 'fallback-key' }),
      })
    );
  });

  it('hard-stops foreground recovery when its monotonic budget expires', async () => {
    vi.useFakeTimers();
    observePiProviderResponses.mockImplementation(
      (
        _options: unknown,
        _model: unknown,
        onResponse: (response: { statusCode: number; retryAfter?: string }) => void
      ) => onResponse({ statusCode: 503, retryAfter: '60' })
    );
    streamPiModel.mockImplementation(() => chunks([new Error('status 503')]));
    const stream = (await service({ maxRetries: undefined })).streamChat(
      [{ role: 'user', content: 'continue' }],
      undefined,
      undefined,
      {
        providerRecovery: {
          mode: 'bounded_foreground',
          budgetMs: 30_000,
        },
      }
    );
    const events: StreamChunk[] = [];
    let observed: unknown;
    const consume = (async () => {
      try {
        for await (const event of stream) events.push(event);
      } catch (error) {
        observed = error;
      }
    })();

    try {
      await vi.runAllTimersAsync();
      await consume;
      expect(streamPiModel).toHaveBeenCalledOnce();
      expect(observed).toMatchObject({
        name: 'ProviderRecoveryBudgetExceededError',
        budgetMs: 30_000,
      });
      expect(
        events.flatMap((event) =>
          event.providerRetry?.phase === 'exhausted' ? [event.providerRetry] : []
        )
      ).toEqual([
        expect.objectContaining({
          mode: 'bounded_foreground',
          exhaustedBy: 'recovery_budget',
          recoveryRemainingMs: 0,
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts an in-flight retry stream when the recovery deadline wins', async () => {
    vi.useFakeTimers();
    let retryIteratorClosed = false;
    let retryAbortReason: unknown;
    streamPiModel
      .mockReturnValueOnce(chunks([new Error('status 503')]))
      .mockImplementationOnce(
        (
          _models: unknown,
          _model: unknown,
          _context: unknown,
          _options: unknown,
          watchdog: { signal?: AbortSignal }
        ) =>
          (async function* () {
            try {
              await new Promise<void>((_resolve, reject) => {
                const signal = watchdog.signal;
                if (!signal) {
                  reject(new Error('retry watchdog signal missing'));
                  return;
                }
                const abort = () => {
                  retryAbortReason = signal.reason;
                  reject(signal.reason);
                };
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted) abort();
              });
              yield { content: 'forbidden' };
            } finally {
              retryIteratorClosed = true;
            }
          })()
      );
    const stream = (
      await service({ maxRetries: undefined, timeout: 30_000 })
    ).streamChat([{ role: 'user', content: 'continue' }], undefined, undefined, {
      providerRecovery: {
        mode: 'bounded_foreground',
        budgetMs: 30_000,
      },
    });

    try {
      await expect(stream.next()).resolves.toMatchObject({
        value: { providerRetry: { phase: 'scheduled' } },
      });
      const attempt = stream.next();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(attempt).resolves.toMatchObject({
        value: { providerRetry: { phase: 'attempt' } },
      });
      const exhausted = stream.next();
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(exhausted).resolves.toMatchObject({
        value: {
          providerRetry: {
            phase: 'exhausted',
            exhaustedBy: 'recovery_budget',
            recoveryRemainingMs: 0,
          },
        },
      });
      await expect(stream.next()).rejects.toMatchObject({
        name: 'ProviderRecoveryBudgetExceededError',
      });
      expect(retryAbortReason).toMatchObject({
        name: 'ProviderRecoveryBudgetExceededError',
      });
      expect(retryIteratorClosed).toBe(true);
      expect(streamPiModel).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares one recovery deadline across primary and fallback models', async () => {
    vi.useFakeTimers();
    let fallbackClosed = false;
    streamPiModel
      .mockReturnValueOnce(chunks([new Error('status 503')]))
      .mockReturnValueOnce(chunks([new Error('status 503')]))
      .mockReturnValueOnce(chunks([new Error('status 503')]))
      .mockImplementationOnce(
        (
          _models: unknown,
          _model: unknown,
          _context: unknown,
          _options: unknown,
          watchdog: { signal?: AbortSignal }
        ) =>
          (async function* () {
            try {
              await new Promise<void>((_resolve, reject) => {
                const signal = watchdog.signal;
                if (!signal) {
                  reject(new Error('fallback watchdog signal missing'));
                  return;
                }
                const abort = () => reject(signal.reason);
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted) abort();
              });
            } finally {
              fallbackClosed = true;
            }
          })()
      );
    const stream = (
      await service({
        maxRetries: undefined,
        fallbackModels: [{ provider: 'test', model: 'backup' }],
      })
    ).streamChat([{ role: 'user', content: 'continue' }], undefined, undefined, {
      providerRecovery: {
        mode: 'bounded_foreground',
        budgetMs: 30_000,
      },
    });
    const events: StreamChunk[] = [];
    let observed: unknown;
    const consume = (async () => {
      try {
        for await (const event of stream) events.push(event);
      } catch (error) {
        observed = error;
      }
    })();

    try {
      await vi.runAllTimersAsync();
      await consume;
      expect(observed).toMatchObject({
        name: 'ProviderRecoveryBudgetExceededError',
        budgetMs: 30_000,
        elapsedMs: 30_000,
      });
      expect(streamPiModel).toHaveBeenCalledTimes(4);
      expect(createFallbackModel).toHaveBeenCalledOnce();
      expect(events).toContainEqual({
        modelFallback: {
          from: { provider: 'test', model: 'test-model' },
          to: { provider: 'test', model: 'backup' },
          candidate: 1,
          candidateCount: 1,
          trigger: { source: 'retry', reason: 'server_error', statusCode: 503 },
        },
      });
      expect(fallbackClosed).toBe(true);
      expect(
        events.flatMap((event) =>
          event.providerRetry?.exhaustedBy === 'recovery_budget'
            ? [event.providerRetry]
            : []
        )
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rebuilds the total-attempt deadline for a retry before output', async () => {
    vi.useFakeTimers();
    streamPiModel
      .mockImplementationOnce(
        (
          _models: unknown,
          _model: unknown,
          _context: unknown,
          _options: unknown,
          watchdog: { signal: AbortSignal }
        ) => chunksUntilAbort(watchdog.signal)
      )
      .mockReturnValueOnce(
        chunks([{ content: 'recovered' }, { finishReason: 'stop' }])
      );
    const events: StreamChunk[] = [];
    const stream = (await service({ timeout: 100, maxRetries: 1 })).streamChat([
      { role: 'user', content: 'continue' },
    ]);
    const consume = (async () => {
      for await (const event of stream) events.push(event);
    })();

    try {
      await vi.runAllTimersAsync();
      await consume;
      expect(streamPiModel).toHaveBeenCalledTimes(2);
      expect(
        events
          .filter((event) => event.providerRetry)
          .map((event) => event.providerRetry?.phase)
      ).toEqual(['scheduled', 'attempt', 'recovered']);
      expect(
        events.find((event) => event.providerRetry?.phase === 'scheduled')
      ).toEqual({
        providerRetry: expect.objectContaining({
          reason: 'timeout',
          attempt: 1,
        }),
      });
      expect(events).toContainEqual({ content: 'recovered' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps explicit maxRetries=0 authoritative for a foreground request', async () => {
    streamPiModel.mockReturnValue(chunks([new Error('status 503')]));

    await expect(
      (await service({ maxRetries: 0 })).chat(
        [{ role: 'user', content: 'continue' }],
        undefined,
        undefined,
        {
          providerRecovery: {
            mode: 'bounded_foreground',
            budgetMs: 600_000,
          },
        }
      )
    ).rejects.toThrow('status 503');
    expect(streamPiModel).toHaveBeenCalledOnce();
  });

  it('shares the first authoritative 429 cooldown before another service requests', async () => {
    vi.useFakeTimers({ now: 1_000 });
    const circuitRegistry = new ProviderCircuitRegistry({
      processSecret: new Uint8Array(32).fill(21),
    });
    observePiProviderResponses.mockImplementation(
      (
        _options: unknown,
        _model: unknown,
        onResponse: (response: { statusCode: number; retryAfter?: string }) => void
      ) => onResponse({ statusCode: 429, retryAfter: '30' })
    );
    streamPiModel.mockReturnValue(chunks([new Error('status 429')]));

    try {
      await expect(
        (
          await service(
            circuitOverrides(circuitRegistry, {
              maxRetries: 0,
            })
          )
        ).chat([{ role: 'user', content: 'establish cooldown' }])
      ).rejects.toThrow('status 429');
      expect(streamPiModel).toHaveBeenCalledOnce();

      const second = (
        await service(
          circuitOverrides(circuitRegistry, {
            maxRetries: 0,
          })
        )
      ).streamChat([{ role: 'user', content: 'do not hit the provider' }]);
      await expect(second.next()).resolves.toMatchObject({
        value: {
          providerCircuit: {
            phase: 'rejected',
            reason: 'rate_limit',
            statusCode: 429,
            retryAfterMs: 30_000,
          },
        },
      });
      await expect(second.next()).rejects.toMatchObject({
        code: 'PROVIDER_CIRCUIT_OPEN',
      });
      expect(streamPiModel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['standard', undefined],
    [
      'bounded foreground',
      {
        providerRecovery: {
          mode: 'bounded_foreground' as const,
          budgetMs: 600_000,
        },
      },
    ],
  ] as const)(
    'skips an open non-terminal primary to fallback for %s',
    async (_name, requestOptions) => {
      const circuitRegistry = new ProviderCircuitRegistry({
        processSecret: new Uint8Array(32).fill(3),
      });
      tripCircuit(circuitRegistry);
      streamPiModel.mockReturnValue(chunks([{ content: 'healthy-fallback' }]));

      const stream = (
        await service(
          circuitOverrides(circuitRegistry, {
            maxRetries: 0,
            fallbackModels: [{ provider: 'test', model: 'backup' }],
          })
        )
      ).streamChat(
        [{ role: 'user', content: 'use fallback' }],
        undefined,
        undefined,
        requestOptions
      );
      const events: StreamChunk[] = [];
      for await (const event of stream) events.push(event);

      expect(events).toEqual([
        expect.objectContaining({
          providerCircuit: expect.objectContaining({ phase: 'rejected' }),
        }),
        {
          modelFallback: {
            from: { provider: 'test', model: 'test-model' },
            to: { provider: 'test', model: 'backup' },
            candidate: 1,
            candidateCount: 1,
            trigger: {
              source: 'circuit',
              reason: 'server_error',
              statusCode: 503,
            },
          },
        },
        { content: 'healthy-fallback' },
      ]);
      expect(streamPiModel).toHaveBeenCalledOnce();
      expect(streamPiModel.mock.calls[0]?.[1]).toMatchObject({ id: 'backup' });
    }
  );

  it('charges terminal circuit waiting to the foreground recovery deadline', async () => {
    vi.useFakeTimers({ now: 1_000 });
    const circuitRegistry = new ProviderCircuitRegistry({
      processSecret: new Uint8Array(32).fill(4),
    });
    tripCircuit(circuitRegistry, { openDurationMs: 300_000 });
    const stream = (
      await service(
        circuitOverrides(circuitRegistry, {
          maxRetries: undefined,
          providerCircuitBreakerOpenMs: 300_000,
        })
      )
    ).streamChat(
      [{ role: 'user', content: 'wait within budget' }],
      undefined,
      undefined,
      {
        providerRecovery: {
          mode: 'bounded_foreground',
          budgetMs: 30_000,
        },
      }
    );

    try {
      await expect(stream.next()).resolves.toMatchObject({
        value: {
          providerCircuit: {
            phase: 'waiting',
            retryAfterMs: 300_000,
            recoveryRemainingMs: 30_000,
          },
        },
      });
      const heartbeat = stream.next();
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(heartbeat).resolves.toMatchObject({
        value: {
          providerCircuit: {
            phase: 'waiting',
            recoveryRemainingMs: 15_000,
          },
        },
      });
      const exhausted = stream.next();
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(exhausted).resolves.toMatchObject({
        value: {
          providerRetry: {
            phase: 'exhausted',
            exhaustedBy: 'recovery_budget',
            recoveryRemainingMs: 0,
          },
        },
      });
      await expect(stream.next()).rejects.toMatchObject({
        code: 'PROVIDER_RECOVERY_BUDGET_EXCEEDED',
      });
      expect(streamPiModel).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits typed circuit heartbeats throughout a long open interval', async () => {
    vi.useFakeTimers({ now: 1_000 });
    const circuitRegistry = new ProviderCircuitRegistry({
      processSecret: new Uint8Array(32).fill(7),
    });
    streamPiModel
      .mockReturnValueOnce(chunks([new Error('status 503')]))
      .mockReturnValueOnce(chunks([new Error('status 503')]))
      .mockReturnValueOnce(chunks([new Error('status 503')]))
      .mockReturnValueOnce(chunks([new Error('status 503')]))
      .mockReturnValueOnce(chunks([{ content: 'recovered' }]));
    const stream = (
      await service(
        circuitOverrides(circuitRegistry, {
          maxRetries: undefined,
          providerCircuitBreakerOpenMs: 30_000,
        })
      )
    ).streamChat(
      [{ role: 'user', content: 'wait for recovery' }],
      undefined,
      undefined,
      {
        providerRecovery: {
          mode: 'bounded_foreground',
          budgetMs: 600_000,
        },
      }
    );
    const events: StreamChunk[] = [];
    const consume = (async () => {
      for await (const event of stream) events.push(event);
    })();

    try {
      await vi.runAllTimersAsync();
      await consume;
      const waiting = circuitEvents(events).filter(
        (event) => event.phase === 'waiting'
      );
      expect(waiting).toHaveLength(2);
      expect(waiting[0]).toMatchObject({
        retryAfterMs: 30_000,
      });
      expect(waiting[1]).toMatchObject({
        retryAfterMs: 15_000,
      });
      expect(
        (waiting[0]?.recoveryRemainingMs ?? 0) - (waiting[1]?.recoveryRemainingMs ?? 0)
      ).toBe(15_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('abandons a cancelled probe so another waiter can recover immediately', async () => {
    vi.useFakeTimers({ now: 1_000 });
    const circuitRegistry = new ProviderCircuitRegistry({
      processSecret: new Uint8Array(32).fill(8),
    });
    const handle = tripCircuit(circuitRegistry);
    await vi.advanceTimersByTimeAsync(2_000);
    const controller = new AbortController();
    streamPiModel.mockImplementationOnce(
      (
        _models: unknown,
        _model: unknown,
        _context: unknown,
        _options: unknown,
        watchdog: { signal?: AbortSignal }
      ) =>
        (async function* () {
          await new Promise<void>((_resolve, reject) => {
            const requestSignal = watchdog.signal;
            if (!requestSignal) {
              reject(new Error('probe signal missing'));
              return;
            }
            const abort = () => reject(requestSignal.reason);
            requestSignal.addEventListener('abort', abort, { once: true });
            if (requestSignal.aborted) abort();
          });
          yield { content: 'forbidden' };
        })()
    );
    const stream = (
      await service(circuitOverrides(circuitRegistry, { maxRetries: 0 }))
    ).streamChat(
      [{ role: 'user', content: 'cancel probe' }],
      undefined,
      controller.signal,
      {
        providerRecovery: {
          mode: 'bounded_foreground',
          budgetMs: 600_000,
        },
      }
    );

    try {
      await expect(stream.next()).resolves.toMatchObject({
        value: { providerCircuit: { phase: 'probe' } },
      });
      const pending = stream.next();
      controller.abort(new DOMException('Stopped', 'AbortError'));
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(handle.snapshot().state).toBe('half_open');
      expect(handle.check()).toMatchObject({ allowed: true, probe: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
