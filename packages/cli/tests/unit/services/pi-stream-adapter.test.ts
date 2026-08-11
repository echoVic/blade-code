import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  Models,
  Usage,
} from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import {
  ProviderStreamClosedError,
  resolveStreamStallWarningMs,
  streamPiModel,
  StreamIdleTimeoutError,
} from '../../../src/services/pi/streamAdapter.js';
import { isFallbackablePiError } from '../../../src/services/pi/requestOptions.js';

const model: Model<Api> = {
  id: 'test-model',
  name: 'Test Model',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: 'https://example.test/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
};
const context: Context = { messages: [] };
const usage: Usage = {
  input: 4,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 6,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};
const partial = { usage } as AssistantMessage;

function modelsFor(stream: AsyncIterable<AssistantMessageEvent>): Models {
  return {
    stream: vi.fn(() => stream),
  } as unknown as Models;
}

function streamFrom(
  events: () => AsyncGenerator<AssistantMessageEvent>
): AsyncIterable<AssistantMessageEvent> {
  return { [Symbol.asyncIterator]: events };
}

describe('pi stream adapter watchdog', () => {
  it('derives a bounded stall warning before the hard idle timeout', () => {
    expect(resolveStreamStallWarningMs(300_000)).toBe(30_000);
    expect(resolveStreamStallWarningMs(20_000)).toBe(10_000);
    expect(resolveStreamStallWarningMs(20_000, 4_000)).toBe(4_000);
    expect(resolveStreamStallWarningMs(20_000, 0)).toBeUndefined();
  });

  it('keeps idle timeouts fatal while allowing a clean pre-output EOF retry', () => {
    expect(isFallbackablePiError(new StreamIdleTimeoutError(20))).toBe(false);
    expect(isFallbackablePiError(new ProviderStreamClosedError())).toBe(true);
  });

  it('aborts a provider that emits no first event before the idle deadline', async () => {
    const returnStream = vi.fn(async () => ({
      done: true as const,
      value: undefined,
    }));
    const stream = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<AssistantMessageEvent>>(() => undefined),
        return: returnStream,
      }),
    };
    const controller = new AbortController();
    const iterator = streamPiModel(
      modelsFor(stream),
      model,
      context,
      {},
      {
        idleTimeoutMs: 20,
        signal: controller.signal,
        abort: (reason) => controller.abort(reason),
      }
    );

    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        providerStall: {
          phase: 'detected',
          stallCount: 1,
          durationMs: 10,
          warningAfterMs: 10,
          timeoutMs: 20,
          outputStarted: false,
        },
      },
      done: false,
    });
    await expect(iterator.next()).rejects.toBeInstanceOf(StreamIdleTimeoutError);
    expect(controller.signal.reason).toBeInstanceOf(StreamIdleTimeoutError);
    await vi.waitFor(() => expect(returnStream).toHaveBeenCalledOnce());
  });

  it('reports recovery on the same pending provider read', async () => {
    let resolveNext:
      | ((result: IteratorResult<AssistantMessageEvent>) => void)
      | undefined;
    const nextProviderEvent = vi.fn(
      () =>
        new Promise<IteratorResult<AssistantMessageEvent>>((resolve) => {
          resolveNext = resolve;
        })
    );
    const returnStream = vi.fn(async () => ({
      done: true as const,
      value: undefined,
    }));
    const stream = {
      [Symbol.asyncIterator]: () => ({
        next: nextProviderEvent,
        return: returnStream,
      }),
    };
    const iterator = streamPiModel(
      modelsFor(stream),
      model,
      context,
      {},
      {
        idleTimeoutMs: 100,
        stallWarningMs: 10,
      }
    );

    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        providerStall: {
          phase: 'detected',
          stallCount: 1,
          outputStarted: false,
        },
      },
    });
    expect(nextProviderEvent).toHaveBeenCalledOnce();

    const recovered = iterator.next();
    resolveNext?.({
      done: false,
      value: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'ok',
        partial,
      },
    });
    await expect(recovered).resolves.toMatchObject({
      value: {
        providerStall: {
          phase: 'recovered',
          stallCount: 1,
          outputStarted: false,
        },
      },
    });
    expect(nextProviderEvent).toHaveBeenCalledOnce();
    await expect(iterator.next()).resolves.toEqual({
      value: { content: 'ok' },
      done: false,
    });
    expect(nextProviderEvent).toHaveBeenCalledOnce();
    await iterator.return();
    expect(returnStream).toHaveBeenCalledOnce();
  });

  it('cancels the same pending read after a stall warning', async () => {
    const nextProviderEvent = vi.fn(
      () => new Promise<IteratorResult<AssistantMessageEvent>>(() => undefined)
    );
    const returnStream = vi.fn(async () => ({
      done: true as const,
      value: undefined,
    }));
    const stream = {
      [Symbol.asyncIterator]: () => ({
        next: nextProviderEvent,
        return: returnStream,
      }),
    };
    const controller = new AbortController();
    const iterator = streamPiModel(
      modelsFor(stream),
      model,
      context,
      {},
      {
        idleTimeoutMs: 100,
        stallWarningMs: 10,
        signal: controller.signal,
      }
    );

    await expect(iterator.next()).resolves.toMatchObject({
      value: { providerStall: { phase: 'detected' } },
    });
    const pending = iterator.next();
    controller.abort(new Error('cancelled by caller'));

    await expect(pending).rejects.toThrow('cancelled by caller');
    expect(nextProviderEvent).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(returnStream).toHaveBeenCalledOnce());
  });

  it('marks a recovered gap as mid-stream after visible output', async () => {
    const stream = streamFrom(async function* () {
      yield { type: 'text_delta', contentIndex: 0, delta: 'partial', partial };
      await new Promise((resolve) => setTimeout(resolve, 25));
      yield { type: 'done', reason: 'stop', message: partial };
    });
    const chunks = [];

    for await (const chunk of streamPiModel(
      modelsFor(stream),
      model,
      context,
      {},
      {
        idleTimeoutMs: 80,
        stallWarningMs: 10,
      }
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { content: 'partial' },
      {
        providerStall: {
          phase: 'detected',
          stallCount: 1,
          durationMs: 10,
          warningAfterMs: 10,
          timeoutMs: 80,
          outputStarted: true,
        },
      },
      {
        providerStall: {
          phase: 'recovered',
          stallCount: 1,
          durationMs: expect.any(Number),
          warningAfterMs: 10,
          timeoutMs: 80,
          outputStarted: true,
        },
      },
      {
        finishReason: 'stop',
        usage: {
          promptTokens: 4,
          completionTokens: 2,
          totalTokens: 6,
          costUsd: 0,
        },
      },
    ]);
    expect(chunks[2]?.providerStall?.durationMs).toBeGreaterThanOrEqual(10);
  });

  it('resets the idle deadline after every provider event', async () => {
    const stream = streamFrom(async function* () {
      yield { type: 'start', partial };
      await new Promise((resolve) => setTimeout(resolve, 15));
      yield { type: 'text_delta', contentIndex: 0, delta: 'ok', partial };
      await new Promise((resolve) => setTimeout(resolve, 15));
      yield { type: 'done', reason: 'stop', message: partial };
    });

    const chunks = [];
    for await (const chunk of streamPiModel(
      modelsFor(stream),
      model,
      context,
      {},
      {
        idleTimeoutMs: 25,
        stallWarningMs: 0,
      }
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { content: 'ok' },
      {
        finishReason: 'stop',
        usage: {
          promptTokens: 4,
          completionTokens: 2,
          totalTokens: 6,
          costUsd: 0,
        },
      },
    ]);
  });

  it('rejects a provider EOF that arrives without a terminal event', async () => {
    const stream = streamFrom(async function* () {
      yield { type: 'start', partial };
    });

    const iterator = streamPiModel(
      modelsFor(stream),
      model,
      context,
      {},
      {
        idleTimeoutMs: 50,
      }
    );
    await expect(iterator.next()).rejects.toBeInstanceOf(ProviderStreamClosedError);
  });

  it('propagates caller cancellation without waiting for the idle deadline', async () => {
    const stream = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<AssistantMessageEvent>>(() => undefined),
        return: async () => ({ done: true as const, value: undefined }),
      }),
    };
    const controller = new AbortController();
    const iterator = streamPiModel(
      modelsFor(stream),
      model,
      context,
      {},
      { idleTimeoutMs: 60_000, signal: controller.signal }
    );
    const pending = iterator.next();
    controller.abort(new DOMException('Stopped', 'AbortError'));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
