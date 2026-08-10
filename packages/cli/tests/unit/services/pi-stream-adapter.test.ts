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

    await expect(iterator.next()).rejects.toBeInstanceOf(StreamIdleTimeoutError);
    expect(controller.signal.reason).toBeInstanceOf(StreamIdleTimeoutError);
    await vi.waitFor(() => expect(returnStream).toHaveBeenCalledOnce());
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
