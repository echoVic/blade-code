import type {
  Api,
  AssistantMessageEvent,
  Context,
  Model,
  Models,
} from '@earendil-works/pi-ai';
import type { StreamChunk } from '../ChatServiceInterface.js';
import type { ProviderStallEvent } from './providerStall.js';
import { convertPiUsage } from './requestOptions.js';

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
export const DEFAULT_STREAM_STALL_WARNING_MS = 30_000;

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
  stallWarningMs?: number;
  signal?: AbortSignal;
  abort?: (reason: Error) => void;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Aborted', 'AbortError');
}

interface StreamWatchdogState {
  stallCount: number;
  outputStarted: boolean;
}

type PendingNextOutcome<T> =
  | { kind: 'next'; result: IteratorResult<T> }
  | { kind: 'timer' };

function resolveIdleTimeoutMs(options: StreamWatchdogOptions): number {
  return options.idleTimeoutMs && options.idleTimeoutMs > 0
    ? options.idleTimeoutMs
    : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

export function resolveStreamStallWarningMs(
  idleTimeoutMs: number,
  configuredWarningMs?: number
): number | undefined {
  if (configuredWarningMs === 0) return undefined;
  const requested =
    configuredWarningMs !== undefined && configuredWarningMs > 0
      ? configuredWarningMs
      : DEFAULT_STREAM_STALL_WARNING_MS;
  return Math.max(1, Math.min(requested, Math.floor(idleTimeoutMs / 2)));
}

function waitForPendingNext<T>(
  pendingNext: Promise<IteratorResult<T>>,
  delayMs: number,
  signal?: AbortSignal
): Promise<PendingNextOutcome<T>> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));

  return new Promise<PendingNextOutcome<T>>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (outcome: PendingNextOutcome<T>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };
    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onAbort = () => {
      if (signal) finishReject(abortReason(signal));
    };
    const timer = setTimeout(() => finish({ kind: 'timer' }), Math.max(0, delayMs));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    pendingNext.then((result) => finish({ kind: 'next', result }), finishReject);
  });
}

async function* nextWithIdleWatchdog<T>(
  iterator: AsyncIterator<T>,
  options: StreamWatchdogOptions,
  state: StreamWatchdogState
): AsyncGenerator<ProviderStallEvent, IteratorResult<T>, void> {
  const idleTimeoutMs = resolveIdleTimeoutMs(options);
  const stallWarningMs = resolveStreamStallWarningMs(
    idleTimeoutMs,
    options.stallWarningMs
  );
  if (options.signal?.aborted) {
    throw abortReason(options.signal);
  }

  const startedAt = Date.now();
  const pendingNext = Promise.resolve().then(() => iterator.next());
  let stall: ProviderStallEvent | undefined;

  for (;;) {
    const deadlineMs = stall ? idleTimeoutMs : (stallWarningMs ?? idleTimeoutMs);
    const outcome = await waitForPendingNext(
      pendingNext,
      deadlineMs - (Date.now() - startedAt),
      options.signal
    );
    if (outcome.kind === 'next') {
      if (stall) {
        yield {
          ...stall,
          phase: 'recovered',
          durationMs: Math.max(stall.durationMs, Date.now() - startedAt),
        };
      }
      return outcome.result;
    }

    if (!stall && stallWarningMs !== undefined) {
      state.stallCount++;
      stall = {
        phase: 'detected',
        stallCount: state.stallCount,
        durationMs: stallWarningMs,
        warningAfterMs: stallWarningMs,
        timeoutMs: idleTimeoutMs,
        outputStarted: state.outputStarted,
      };
      yield stall;
      continue;
    }

    const error = new StreamIdleTimeoutError(idleTimeoutMs);
    options.abort?.(error);
    throw error;
  }
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
  const watchdogState: StreamWatchdogState = {
    stallCount: 0,
    outputStarted: false,
  };

  try {
    while (true) {
      const pending = nextWithIdleWatchdog<AssistantMessageEvent>(
        iterator,
        watchdog,
        watchdogState
      );
      let next = await pending.next();
      while (!next.done) {
        yield { providerStall: next.value };
        next = await pending.next();
      }
      const result = next.value;
      if (result.done) {
        throw new ProviderStreamClosedError();
      }
      const event = result.value;
      switch (event.type) {
        case 'text_delta':
          watchdogState.outputStarted = true;
          yield { content: event.delta };
          break;
        case 'thinking_delta':
          watchdogState.outputStarted = true;
          yield { reasoningContent: event.delta };
          break;
        case 'toolcall_end':
          watchdogState.outputStarted = true;
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
