import type { Api, Model } from '@earendil-works/pi-ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChatConfig,
  StreamChunk,
} from '../../../src/services/ChatServiceInterface.js';
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

describe('PiAIChatService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createPiRuntime.mockReturnValue({ models: {}, model: piModelFixture });
    observePiProviderResponses.mockReset();
    streamPiModel.mockReset();
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
  ] satisfies Array<
    [string, StreamChunk]
  >)('does not replay after a %s chunk crosses the boundary', async (_name, boundaryChunk) => {
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
  });

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
});
