import type {
  Api,
  AssistantMessageEvent,
  Context,
  Model,
  Models,
} from '@earendil-works/pi-ai';
import type { StreamChunk } from '../ChatServiceInterface.js';
import { convertPiUsage } from './requestOptions.js';

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

export class StreamIdleTimeoutError extends Error {
  readonly code = 'STREAM_IDLE_TIMEOUT';

  constructor(readonly timeoutMs: number) {
    super(`Provider stream idle timeout after ${timeoutMs}ms without an event`);
    this.name = 'StreamIdleTimeoutError';
  }
}

export class ProviderStreamClosedError extends Error {
  readonly code = 'PROVIDER_STREAM_CLOSED';

  constructor() {
    super('Provider stream closed before completion');
    this.name = 'ProviderStreamClosedError';
  }
}

export interface StreamWatchdogOptions {
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  abort?: (reason: Error) => void;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Aborted', 'AbortError');
}

function nextWithIdleTimeout<T>(
  iterator: AsyncIterator<T>,
  options: StreamWatchdogOptions
): Promise<IteratorResult<T>> {
  const idleTimeoutMs =
    options.idleTimeoutMs && options.idleTimeoutMs > 0
      ? options.idleTimeoutMs
      : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  if (options.signal?.aborted) {
    return Promise.reject(abortReason(options.signal));
  }

  return new Promise<IteratorResult<T>>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const finishResolve = (value: IteratorResult<T>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      if (!options.signal) return;
      finishReject(abortReason(options.signal));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      const error = new StreamIdleTimeoutError(idleTimeoutMs);
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      options.abort?.(error);
      reject(error);
    }, idleTimeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    void Promise.resolve()
      .then(() => iterator.next())
      .then(finishResolve, (error: unknown) =>
        finishReject(error instanceof Error ? error : new Error(String(error)))
      );
  });
}

export async function* streamPiModel(
  models: Models,
  model: Model<Api>,
  context: Context,
  options: Record<string, unknown>,
  watchdog: StreamWatchdogOptions = {}
): AsyncGenerator<StreamChunk, void, unknown> {
  const stream = models.stream(model, context, options as never);
  const iterator = stream[Symbol.asyncIterator]();
  let toolCallIndex = 0;
  let completed = false;

  try {
    while (true) {
      const next = await nextWithIdleTimeout<AssistantMessageEvent>(iterator, watchdog);
      if (next.done) {
        throw new ProviderStreamClosedError();
      }
      const event = next.value;
      switch (event.type) {
        case 'text_delta':
          yield { content: event.delta };
          break;
        case 'thinking_delta':
          yield { reasoningContent: event.delta };
          break;
        case 'toolcall_end':
          yield {
            toolCalls: [
              {
                index: toolCallIndex++,
                id: event.toolCall.id,
                type: 'function',
                function: {
                  name: event.toolCall.name,
                  arguments: JSON.stringify(event.toolCall.arguments),
                },
              },
            ],
          };
          break;
        case 'done':
          completed = true;
          yield {
            finishReason: event.reason,
            usage: convertPiUsage(event.message.usage),
          };
          return;
        case 'error':
          throw new Error(
            event.error.errorMessage ??
              `Request ${event.reason === 'aborted' ? 'aborted' : 'failed'}`
          );
      }
    }
  } finally {
    if (!completed) {
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    }
  }
}
