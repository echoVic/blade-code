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

  it('rejects a required tool that is unavailable', async () => {
    const chat = await service();
    await expect(
      chat.chat([{ role: 'user', content: 'delegate' }], [], undefined, {
        toolChoice: { type: 'tool', toolName: 'Task' },
      })
    ).rejects.toThrow('Required tool is unavailable: Task');
    expect(streamPiModel).not.toHaveBeenCalled();
  });

  it('rejects a new image before calling a text-only model', async () => {
    const chat = await service();
    await expect(
      chat.chat([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe this' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,abc' },
            },
          ],
        },
      ])
    ).rejects.toThrow('Test Model does not support image input');

    expect(createPiContext).not.toHaveBeenCalled();
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

  it('accepts image input when the active model advertises vision', async () => {
    const visionModel = {
      ...piModelFixture,
      name: 'Vision Model',
      input: ['text', 'image'] as Array<'text' | 'image'>,
    };
    createPiRuntime.mockReturnValue({
      models: {},
      model: visionModel,
    });
    streamPiModel.mockReturnValue(chunks([{ content: 'described' }]));

    const result = await (await service()).chat([
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,abc' },
          },
        ],
      },
    ]);

    expect(result.content).toBe('described');
    expect(createPiContext).toHaveBeenCalledWith(
      expect.any(Array),
      visionModel,
      undefined,
      undefined,
      undefined
    );
  });

  it('passes the exact tool requirement to context and request adapters', async () => {
    streamPiModel.mockReturnValue(chunks([{ finishReason: 'toolUse' }]));
    const chat = await service();
    const tools = [{ name: 'Task', description: 'Delegate', parameters: {} }];

    await chat.chat([{ role: 'user', content: 'delegate' }], tools, undefined, {
      toolChoice: { type: 'tool', toolName: 'Task' },
    });

    expect(createPiContext).toHaveBeenCalledWith(
      expect.any(Array),
      piModelFixture,
      tools,
      undefined,
      'Task'
    );
    expect(buildPiOptions).toHaveBeenCalledWith(
      expect.any(Object),
      piModelFixture,
      expect.any(AbortSignal),
      expect.objectContaining({
        toolChoice: { type: 'tool', toolName: 'Task' },
      }),
      true
    );
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

  it('queues before creating a physical Provider stream and projects admission', async () => {
    const admissionScheduler = new ProviderRequestAdmissionScheduler({
      processSecret: new Uint8Array(32).fill(12),
    });
    const held = await admissionScheduler.admit(providerAdmissionRequest('holder'))
      .ready;
    streamPiModel.mockReturnValue(chunks([{ content: 'admitted-response' }]));
    const stream = (
      await service({
        providerRequestConcurrency: 1,
        providerRequestAdmissionMs: 120_000,
        providerRequestAdmissionScheduler: admissionScheduler,
      })
    ).streamChat(
      [{ role: 'user', content: 'wait for capacity' }],
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
          phase: 'queued',
          requestClass: 'foreground',
          resource: 'stream',
          scope: 'domain',
          queuePosition: 1,
          inFlight: 1,
          limit: 1,
        },
      },
    });
    expect(streamPiModel).not.toHaveBeenCalled();

    held.release();
    await expect(stream.next()).resolves.toMatchObject({
      value: {
        providerAdmission: {
          phase: 'admitted',
          resource: 'stream',
          queuePosition: 0,
        },
      },
    });
    await expect(stream.next()).resolves.toEqual({
      value: { content: 'admitted-response' },
      done: false,
    });
    await expect(stream.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
    expect(streamPiModel).toHaveBeenCalledOnce();
    expect(admissionScheduler.getStats()).toMatchObject({
      inFlight: 0,
      queued: 0,
      pendingBytes: 0,
    });
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

  it('holds admission through the complete Provider iterator lifetime', async () => {
    const admissionScheduler = new ProviderRequestAdmissionScheduler({
      processSecret: new Uint8Array(32).fill(16),
      globalMaxInFlight: 1,
    });
    let releaseTail!: () => void;
    const tail = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    streamPiModel
      .mockReturnValueOnce(
        (async function* () {
          yield { content: 'first-chunk' };
          await tail;
          yield { finishReason: 'stop' };
        })()
      )
      .mockReturnValueOnce(chunks([{ content: 'second-response' }]));
    const first = (
      await service({
        providerRequestAdmissionScheduler: admissionScheduler,
      })
    ).streamChat([{ role: 'user', content: 'first' }], undefined, undefined, {
      providerAdmission: {
        sessionId: 'first-session',
        ownerId: 'first-owner',
        requestClass: 'foreground',
      },
    });
    const second = (
      await service({
        providerRequestAdmissionScheduler: admissionScheduler,
      })
    ).streamChat([{ role: 'user', content: 'second' }], undefined, undefined, {
      providerAdmission: {
        sessionId: 'second-session',
        ownerId: 'second-owner',
        requestClass: 'foreground',
      },
    });

    await expect(first.next()).resolves.toMatchObject({
      value: { content: 'first-chunk' },
    });
    await expect(second.next()).resolves.toMatchObject({
      value: { providerAdmission: { phase: 'queued', scope: 'global' } },
    });
    expect(streamPiModel).toHaveBeenCalledOnce();

    releaseTail();
    await expect(first.next()).resolves.toMatchObject({
      value: { finishReason: 'stop' },
    });
    await expect(first.next()).resolves.toEqual({ value: undefined, done: true });
    await expect(second.next()).resolves.toMatchObject({
      value: { providerAdmission: { phase: 'admitted' } },
    });
    await expect(second.next()).resolves.toMatchObject({
      value: { content: 'second-response' },
    });
    await expect(second.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
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
      value: { modelFallback: true },
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

  it('emits a fresh Provider admission heartbeat every fifteen seconds', async () => {
    vi.useFakeTimers({ now: 1_000 });
    const admissionScheduler = new ProviderRequestAdmissionScheduler({
      processSecret: new Uint8Array(32).fill(19),
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
    streamPiModel.mockReturnValue(chunks([{ content: 'after-heartbeat' }]));
    const stream = (
      await service({
        providerRequestAdmissionScheduler: admissionScheduler,
      })
    ).streamChat([{ role: 'user', content: 'heartbeat' }], undefined, undefined, {
      providerAdmission: {
        sessionId: 'waiting-session',
        ownerId: 'waiting-owner',
        requestClass: 'foreground',
      },
    });

    try {
      await expect(stream.next()).resolves.toMatchObject({
        value: {
          providerAdmission: {
            phase: 'queued',
            waitMs: 0,
          },
        },
      });
      const heartbeat = stream.next();
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(heartbeat).resolves.toMatchObject({
        value: {
          providerAdmission: {
            phase: 'queued',
            waitMs: 15_000,
          },
        },
      });
      held.release();
      await expect(stream.next()).resolves.toMatchObject({
        value: { providerAdmission: { phase: 'admitted' } },
      });
      await expect(stream.next()).resolves.toMatchObject({
        value: { content: 'after-heartbeat' },
      });
      await expect(stream.next()).resolves.toEqual({
        value: undefined,
        done: true,
      });
    } finally {
      held.release();
      await stream.return(undefined);
      vi.useRealTimers();
    }
  });

  it('releases Provider admission before retry backoff', async () => {
    vi.useFakeTimers({ now: 1_000 });
    const admissionScheduler = new ProviderRequestAdmissionScheduler({
      processSecret: new Uint8Array(32).fill(20),
      globalMaxInFlight: 1,
    });
    streamPiModel
      .mockReturnValueOnce(chunks([new Error('status 503')]))
      .mockReturnValueOnce(chunks([{ content: 'unrelated-response' }]))
      .mockReturnValueOnce(chunks([{ content: 'retry-response' }]));
    const retrying = (
      await service({
        maxRetries: 1,
        providerRequestAdmissionScheduler: admissionScheduler,
      })
    ).streamChat([{ role: 'user', content: 'retry' }], undefined, undefined, {
      providerAdmission: {
        sessionId: 'retry-session',
        ownerId: 'retry-owner',
        requestClass: 'foreground',
      },
    });

    try {
      const scheduled = await retrying.next();
      expect(scheduled.value).toMatchObject({
        providerRetry: { phase: 'scheduled' },
      });
      const unrelated = (
        await service({
          maxRetries: 0,
          providerRequestAdmissionScheduler: admissionScheduler,
        })
      ).streamChat([{ role: 'user', content: 'unrelated' }], undefined, undefined, {
        providerAdmission: {
          sessionId: 'unrelated-session',
          ownerId: 'unrelated-owner',
          requestClass: 'foreground',
        },
      });
      await expect(unrelated.next()).resolves.toMatchObject({
        value: { content: 'unrelated-response' },
      });
      await expect(unrelated.next()).resolves.toEqual({
        value: undefined,
        done: true,
      });

      const retryAttempt = retrying.next();
      const delayMs =
        scheduled.value?.providerRetry?.delayMs ??
        (() => {
          throw new Error('missing retry delay');
        })();
      await vi.advanceTimersByTimeAsync(delayMs);
      await expect(retryAttempt).resolves.toMatchObject({
        value: { providerRetry: { phase: 'attempt' } },
      });
      await expect(retrying.next()).resolves.toMatchObject({
        value: { providerRetry: { phase: 'recovered' } },
      });
      await expect(retrying.next()).resolves.toMatchObject({
        value: { content: 'retry-response' },
      });
      await expect(retrying.next()).resolves.toEqual({
        value: undefined,
        done: true,
      });
    } finally {
      await retrying.return(undefined);
      vi.useRealTimers();
    }
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

  it('retries a fallbackable error before emitting output', async () => {
    streamPiModel
      .mockReturnValueOnce(chunks([new Error('status 503')]))
      .mockReturnValueOnce(chunks([{ content: 'recovered' }]));

    const result = await (await service({ maxRetries: 1 })).chat([
      { role: 'user', content: 'hello' },
    ]);

    expect(result.content).toBe('recovered');
    expect(streamPiModel).toHaveBeenCalledTimes(2);
  });

  it('does not replay a provider failure after partial output was emitted', async () => {
    streamPiModel.mockReturnValue(
      chunks([
        { content: 'partial' },
        new Error('Provider stream idle timeout after 20ms without an event'),
      ])
    );

    await expect(
      (await service({ maxRetries: 2 })).chat([{ role: 'user', content: 'hello' }])
    ).rejects.toThrow('stream idle timeout');
    expect(streamPiModel).toHaveBeenCalledOnce();
  });

  it.each([
    ['reasoning', { reasoningContent: 'thinking' }],
    [
      'tool call',
      {
        toolCalls: [
          {
            index: 0,
            id: 'call-1',
            type: 'function',
            function: { name: 'Read', arguments: '{}' },
          },
        ],
      },
    ],
    [
      'usage',
      {
        usage: {
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      },
    ],
    ['finish', { finishReason: 'stop' }],
  ] satisfies Array<[string, StreamChunk]>)(
    'does not replay after a %s chunk crosses the boundary',
    async (_name, boundaryChunk) => {
      const failure = new Error('status 503');
      streamPiModel.mockReturnValue(chunks([boundaryChunk, failure]));
      const stream = (await service({ maxRetries: undefined })).streamChat(
        [{ role: 'user', content: 'continue' }],
        undefined,
        undefined,
        {
          providerRecovery: {
            mode: 'bounded_foreground',
            budgetMs: 600_000,
          },
        }
      );

      await expect(stream.next()).resolves.toMatchObject({ value: boundaryChunk });
      await expect(stream.next()).rejects.toBe(failure);
      expect(providerReplayBoundaryCrossed(failure)).toBe(true);
      expect(streamPiModel).toHaveBeenCalledOnce();
    }
  );

  it('marks a context error after partial output as replay-unsafe', async () => {
    const failure = new Error('maximum context length exceeded; status 413');
    streamPiModel.mockReturnValue(chunks([{ content: 'partial' }, failure]));

    let observed: unknown;
    try {
      await (await service({ maxRetries: 2 })).chat([
        { role: 'user', content: 'hello' },
      ]);
    } catch (error) {
      observed = error;
    }

    expect(observed).toBe(failure);
    expect(providerReplayBoundaryCrossed(observed)).toBe(true);
    expect(streamPiModel).toHaveBeenCalledOnce();
  });

  it('uses configured fallback models after primary retries fail', async () => {
    streamPiModel
      .mockReturnValueOnce(chunks([new Error('status 503')]))
      .mockReturnValueOnce(chunks([{ content: 'fallback' }]));

    const result = await (
      await service({
        fallbackModels: [{ provider: 'test', model: 'backup' }],
      })
    ).chat([{ role: 'user', content: 'hello' }]);

    expect(result.content).toBe('fallback');
    expect(createFallbackModel).toHaveBeenCalledWith(expect.any(Object), {
      provider: 'test',
      model: 'backup',
    });
    expect(estimateProviderRequestPendingBytes).toHaveBeenCalledOnce();
  });

  it('preserves fallback when an explicit retry override is exhausted', async () => {
    streamPiModel
      .mockReturnValueOnce(chunks([new Error('status 503')]))
      .mockReturnValueOnce(chunks([{ content: 'fallback' }]));

    const result = await (
      await service({
        maxRetries: 0,
        fallbackModels: [{ provider: 'test', model: 'backup' }],
      })
    ).chat([{ role: 'user', content: 'hello' }], undefined, undefined, {
      providerRecovery: {
        mode: 'bounded_foreground',
        budgetMs: 600_000,
      },
    });

    expect(result.content).toBe('fallback');
    expect(streamPiModel).toHaveBeenCalledTimes(2);
    expect(createFallbackModel).toHaveBeenCalledOnce();
  });

  it('emits an observable retry lifecycle before the replay boundary', async () => {
    vi.useFakeTimers();
    streamPiModel
      .mockReturnValueOnce(chunks([new Error('status 503')]))
      .mockReturnValueOnce(chunks([{ content: 'recovered' }]));
    const stream = (await service({ maxRetries: 1 })).streamChat([
      { role: 'user', content: 'hello' },
    ]);

    try {
      await expect(stream.next()).resolves.toMatchObject({
        value: {
          providerRetry: {
            phase: 'scheduled',
            attempt: 1,
            maxRetries: 1,
            reason: 'server_error',
            statusCode: 503,
          },
        },
      });
      const attempt = stream.next();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(attempt).resolves.toMatchObject({
        value: {
          providerRetry: {
            phase: 'attempt',
            attempt: 1,
            maxRetries: 1,
            reason: 'server_error',
          },
        },
      });
      await expect(stream.next()).resolves.toMatchObject({
        value: {
          providerRetry: {
            phase: 'recovered',
            attempt: 1,
            maxRetries: 1,
            reason: 'server_error',
          },
        },
      });
      await expect(stream.next()).resolves.toMatchObject({
        value: { content: 'recovered' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers a foreground turn after the ordinary retry count is exceeded', async () => {
    vi.useFakeTimers();
    streamPiModel
      .mockReturnValueOnce(chunks([new Error('status 503')]))
      .mockReturnValueOnce(chunks([new Error('status 503')]))
      .mockReturnValueOnce(chunks([new Error('status 503')]))
      .mockReturnValueOnce(chunks([new Error('status 503')]))
      .mockReturnValueOnce(chunks([{ content: 'recovered-after-outage' }]));
    const stream = (await service({ maxRetries: undefined })).streamChat(
      [{ role: 'user', content: 'continue the coding task' }],
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
      expect(streamPiModel).toHaveBeenCalledTimes(5);
      expect(events.at(-1)).toEqual({ content: 'recovered-after-outage' });
      const retryEvents = events.flatMap((event) =>
        event.providerRetry ? [event.providerRetry] : []
      );
      expect(retryEvents.filter((event) => event.phase === 'attempt')).toHaveLength(4);
      expect(retryEvents.at(-1)).toMatchObject({
        phase: 'recovered',
        attempt: 4,
        maxRetries: 12,
        mode: 'bounded_foreground',
        recoveryBudgetMs: 600_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits bounded waiting heartbeats during a long foreground backoff', async () => {
    vi.useFakeTimers();
    observePiProviderResponses.mockImplementation(
      (
        _options: unknown,
        _model: unknown,
        onResponse: (response: { statusCode: number; retryAfter?: string }) => void
      ) => onResponse({ statusCode: 503, retryAfter: '30' })
    );
    streamPiModel
      .mockReturnValueOnce(chunks([new Error('status 503')]))
      .mockReturnValueOnce(chunks([{ content: 'recovered' }]));
    const stream = (await service({ maxRetries: undefined })).streamChat(
      [{ role: 'user', content: 'continue' }],
      undefined,
      undefined,
      {
        providerRecovery: {
          mode: 'bounded_foreground',
          budgetMs: 600_000,
        },
      }
    );

    try {
      await expect(stream.next()).resolves.toMatchObject({
        value: {
          providerRetry: {
            phase: 'scheduled',
            delayMs: 30_000,
            mode: 'bounded_foreground',
          },
        },
      });
      const heartbeat = stream.next();
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(heartbeat).resolves.toMatchObject({
        value: {
          providerRetry: {
            phase: 'waiting',
            attempt: 1,
            recoveryBudgetMs: 600_000,
            recoveryElapsedMs: 15_000,
            recoveryRemainingMs: 585_000,
          },
        },
      });
      const attempt = stream.next();
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(attempt).resolves.toMatchObject({
        value: {
          providerRetry: {
            phase: 'attempt',
            attempt: 1,
            mode: 'bounded_foreground',
          },
        },
      });
    } finally {
      await stream.return(undefined);
      vi.useRealTimers();
    }
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
      expect(events).toContainEqual({ modelFallback: true });
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

  it('caps default foreground recovery at twelve physical retries', async () => {
    vi.useFakeTimers();
    streamPiModel.mockImplementation(() => chunks([new Error('status 503')]));
    const stream = (await service({ maxRetries: undefined })).streamChat(
      [{ role: 'user', content: 'continue' }],
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
      expect(streamPiModel).toHaveBeenCalledTimes(13);
      expect(observed).toMatchObject({ message: 'status 503' });
      expect(
        events.flatMap((event) =>
          event.providerRetry?.phase === 'attempt' ? [event.providerRetry.attempt] : []
        )
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      expect(
        events.flatMap((event) =>
          event.providerRetry?.phase === 'exhausted' ? [event.providerRetry] : []
        )
      ).toEqual([
        expect.objectContaining({
          attempt: 12,
          maxRetries: 12,
          exhaustedBy: 'attempt_limit',
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the hard-deadline timer after a retry succeeds', async () => {
    vi.useFakeTimers();
    streamPiModel
      .mockReturnValueOnce(chunks([new Error('status 503')]))
      .mockReturnValueOnce(chunks([{ content: 'recovered' }]));
    const stream = (await service({ maxRetries: undefined })).streamChat(
      [{ role: 'user', content: 'continue' }],
      undefined,
      undefined,
      {
        providerRecovery: {
          mode: 'bounded_foreground',
          budgetMs: 600_000,
        },
      }
    );
    const consume = (async () => {
      for await (const _event of stream) {
        // Drain the complete logical request.
      }
    })();

    try {
      await vi.runAllTimersAsync();
      await consume;
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

  it('cancels an in-flight retry backoff without replaying the request', async () => {
    vi.useFakeTimers();
    streamPiModel.mockReturnValue(chunks([new Error('status 503')]));
    const controller = new AbortController();
    const stream = (await service({ maxRetries: 2 })).streamChat(
      [{ role: 'user', content: 'hello' }],
      undefined,
      controller.signal,
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
          providerRetry: {
            phase: 'scheduled',
            mode: 'bounded_foreground',
          },
        },
      });
      const pendingAttempt = stream.next();
      controller.abort(new DOMException('Stopped', 'AbortError'));
      await expect(pendingAttempt).rejects.toMatchObject({ name: 'AbortError' });
      expect(streamPiModel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a stall warning cross the safe replay boundary', async () => {
    vi.useFakeTimers();
    streamPiModel
      .mockReturnValueOnce(
        chunks([
          {
            providerStall: {
              phase: 'detected',
              stallCount: 1,
              durationMs: 100,
              warningAfterMs: 100,
              timeoutMs: 200,
              outputStarted: false,
            },
          },
          new Error('status 503'),
        ])
      )
      .mockReturnValueOnce(chunks([{ content: 'recovered' }]));
    const stream = (await service({ maxRetries: 1 })).streamChat([
      { role: 'user', content: 'hello' },
    ]);

    try {
      await expect(stream.next()).resolves.toMatchObject({
        value: { providerStall: { phase: 'detected' } },
      });
      await expect(stream.next()).resolves.toMatchObject({
        value: { providerRetry: { phase: 'scheduled', attempt: 1 } },
      });
      const attempt = stream.next();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(attempt).resolves.toMatchObject({
        value: { providerRetry: { phase: 'attempt', attempt: 1 } },
      });
      await expect(stream.next()).resolves.toMatchObject({
        value: { providerRetry: { phase: 'recovered', attempt: 1 } },
      });
      await expect(stream.next()).resolves.toMatchObject({
        value: { content: 'recovered' },
      });
      expect(streamPiModel).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens, waits for, probes, and closes the shared Provider circuit', async () => {
    vi.useFakeTimers({ now: 1_000 });
    const circuitRegistry = new ProviderCircuitRegistry({
      processSecret: new Uint8Array(32).fill(1),
    });
    streamPiModel
      .mockReturnValueOnce(chunks([new Error('status 503')]))
      .mockReturnValueOnce(chunks([new Error('status 503')]))
      .mockReturnValueOnce(chunks([new Error('status 503')]))
      .mockReturnValueOnce(chunks([new Error('status 503')]))
      .mockReturnValueOnce(chunks([{ content: 'recovered-through-probe' }]));
    const stream = (
      await service(
        circuitOverrides(circuitRegistry, {
          maxRetries: undefined,
        })
      )
    ).streamChat([{ role: 'user', content: 'continue' }], undefined, undefined, {
      providerRecovery: {
        mode: 'bounded_foreground',
        budgetMs: 600_000,
      },
    });
    const events: StreamChunk[] = [];
    const consume = (async () => {
      for await (const event of stream) events.push(event);
    })();

    try {
      await vi.runAllTimersAsync();
      await consume;
      expect(streamPiModel).toHaveBeenCalledTimes(5);
      expect(circuitEvents(events).map((event) => event.phase)).toEqual([
        'opened',
        'waiting',
        'probe',
        'closed',
      ]);
      expect(events.at(-1)).toEqual({ content: 'recovered-through-probe' });
      expect(circuitRegistry.get(circuitScope()).snapshot()).toMatchObject({
        state: 'closed',
        sampleCount: 0,
        failureCount: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares an open circuit across service instances without another request', async () => {
    vi.useFakeTimers({ now: 1_000 });
    const circuitRegistry = new ProviderCircuitRegistry({
      processSecret: new Uint8Array(32).fill(2),
    });
    streamPiModel.mockImplementation(() => chunks([new Error('status 503')]));

    try {
      const first = (
        await service(
          circuitOverrides(circuitRegistry, {
            maxRetries: 3,
          })
        )
      ).chat([{ role: 'user', content: 'trip the circuit' }]);
      const firstRejection = expect(first).rejects.toThrow();
      await vi.runAllTimersAsync();
      await firstRejection;
      expect(streamPiModel).toHaveBeenCalledTimes(4);

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
            reason: 'server_error',
            statusCode: 503,
          },
        },
      });
      await expect(second.next()).rejects.toMatchObject({
        code: 'PROVIDER_CIRCUIT_OPEN',
      });
      expect(streamPiModel).toHaveBeenCalledTimes(4);
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
        { modelFallback: true },
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

  it('emits probe close before yielding the first real Provider chunk', async () => {
    vi.useFakeTimers({ now: 1_000 });
    const circuitRegistry = new ProviderCircuitRegistry({
      processSecret: new Uint8Array(32).fill(5),
    });
    const handle = tripCircuit(circuitRegistry);
    await vi.advanceTimersByTimeAsync(2_000);
    streamPiModel.mockReturnValue(chunks([{ content: 'probe-content' }]));
    const stream = (
      await service(circuitOverrides(circuitRegistry, { maxRetries: 0 }))
    ).streamChat([{ role: 'user', content: 'probe' }], undefined, undefined, {
      providerRecovery: {
        mode: 'bounded_foreground',
        budgetMs: 600_000,
      },
    });

    try {
      await expect(stream.next()).resolves.toMatchObject({
        value: { providerCircuit: { phase: 'probe' } },
      });
      await expect(stream.next()).resolves.toMatchObject({
        value: { providerCircuit: { phase: 'closed' } },
      });
      await expect(stream.next()).resolves.toEqual({
        value: { content: 'probe-content' },
        done: false,
      });
      expect(handle.snapshot().state).toBe('closed');
    } finally {
      await stream.return(undefined);
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

  it('does not close a probe on a pre-output stream idle timeout', async () => {
    vi.useFakeTimers({ now: 1_000 });
    const circuitRegistry = new ProviderCircuitRegistry({
      processSecret: new Uint8Array(32).fill(9),
    });
    const handle = tripCircuit(circuitRegistry);
    await vi.advanceTimersByTimeAsync(2_000);
    observePiProviderResponses.mockImplementation(
      (
        _options: unknown,
        _model: unknown,
        onResponse: (response: { statusCode: number }) => void
      ) => onResponse({ statusCode: 200 })
    );
    const idleTimeout = Object.assign(new Error('Provider stream idle timeout'), {
      code: 'STREAM_IDLE_TIMEOUT',
      timeoutMs: 300_000,
    });
    streamPiModel.mockReturnValueOnce(chunks([idleTimeout]));
    const stream = (
      await service(circuitOverrides(circuitRegistry, { maxRetries: 0 }))
    ).streamChat([{ role: 'user', content: 'idle probe' }], undefined, undefined, {
      providerRecovery: {
        mode: 'bounded_foreground',
        budgetMs: 600_000,
      },
    });

    try {
      await expect(stream.next()).resolves.toMatchObject({
        value: { providerCircuit: { phase: 'probe' } },
      });
      await expect(stream.next()).rejects.toBe(idleTimeout);
      expect(handle.snapshot().state).toBe('half_open');
      expect(handle.check()).toMatchObject({ allowed: true, probe: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('records output-started attempts as success instead of circuit failures', async () => {
    const circuitRegistry = new ProviderCircuitRegistry({
      processSecret: new Uint8Array(32).fill(6),
    });
    streamPiModel.mockImplementation(() =>
      chunks([{ content: 'partial' }, new Error('status 503')])
    );

    for (let index = 0; index < 4; index++) {
      await expect(
        (
          await service(
            circuitOverrides(circuitRegistry, {
              maxRetries: 0,
            })
          )
        ).chat([{ role: 'user', content: `partial ${index}` }])
      ).rejects.toThrow('status 503');
    }

    expect(circuitRegistry.get(circuitScope()).snapshot()).toMatchObject({
      state: 'closed',
      sampleCount: 4,
      failureCount: 0,
    });
    expect(streamPiModel).toHaveBeenCalledTimes(4);
  });
});
