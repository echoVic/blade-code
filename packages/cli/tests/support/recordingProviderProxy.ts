import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordingProviderRequestLifecycle {
  requestNumber: number;
  phase:
    | 'body_read'
    | 'hold_entered'
    | 'release_observed'
    | 'upstream_started'
    | 'headers_received'
    | 'body_completed'
    | 'downstream_ended'
    | 'failed';
  statusClass?: number;
  errorName?: string;
  errorCode?: string;
}

export interface RecordingProviderResponseSummary {
  requestNumber: number;
  contentChars: number;
  reasoningChars: number;
  toolCallDeltas: number;
  finishReasons: string[];
  done: boolean;
  parseStatus: 'complete' | 'incomplete' | 'invalid' | 'limit_exceeded' | 'unsupported';
}

export class OpenAIResponseSummaryCollector {
  #decoder = new TextDecoder('utf-8', { fatal: true });
  #pending = '';
  #contentChars = 0;
  #reasoningChars = 0;
  #toolCallDeltas = 0;
  #finishReasons = new Set<string>();
  #done = false;
  #invalid = false;
  #limitExceeded = false;
  #sawChoices = false;

  constructor(private readonly requestNumber: number) {}

  append(chunk: Uint8Array): void {
    if (this.#limitExceeded) return;
    try {
      for (let offset = 0; offset < chunk.length; offset += 16_384) {
        this.#pending += this.#decoder.decode(chunk.subarray(offset, offset + 16_384), {
          stream: true,
        });
        let boundary = /\r?\n\r?\n/.exec(this.#pending);
        while (boundary) {
          const frame = this.#pending.slice(0, boundary.index);
          this.#pending = this.#pending.slice(boundary.index + boundary[0].length);
          if (Buffer.byteLength(frame) > 65_536) {
            this.#limitExceeded = true;
            this.#pending = '';
            return;
          }
          this.#observeFrame(frame);
          boundary = /\r?\n\r?\n/.exec(this.#pending);
        }
        if (Buffer.byteLength(this.#pending) > 65_536) {
          this.#limitExceeded = true;
          this.#pending = '';
          return;
        }
      }
    } catch {
      this.#invalid = true;
      this.#pending = '';
    }
  }

  #observeFrame(frame: string): void {
    const lines = frame.split(/\r?\n/).filter((line) => line.startsWith('data:'));
    if (lines.length === 0) return;
    const data = lines.map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    if (this.#done) {
      this.#invalid = true;
      return;
    }
    if (data === '[DONE]') {
      this.#done = true;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      this.#invalid = true;
      return;
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('choices' in parsed) ||
      !Array.isArray(parsed.choices)
    )
      return;
    this.#sawChoices = true;
    for (const choice of parsed.choices) {
      if (!choice || typeof choice !== 'object') {
        this.#invalid = true;
        continue;
      }
      const delta: unknown = 'delta' in choice ? choice.delta : undefined;
      if (delta && typeof delta === 'object') {
        if ('content' in delta && typeof delta.content === 'string') {
          this.#contentChars += delta.content.length;
        }
        if (
          'reasoning_content' in delta &&
          typeof delta.reasoning_content === 'string'
        ) {
          this.#reasoningChars += delta.reasoning_content.length;
        }
        if ('tool_calls' in delta && Array.isArray(delta.tool_calls)) {
          this.#toolCallDeltas += delta.tool_calls.length;
        }
      }
      const reason: unknown =
        'finish_reason' in choice ? choice.finish_reason : undefined;
      if (reason !== undefined && reason !== null) {
        if (
          typeof reason === 'string' &&
          ['stop', 'length', 'tool_calls', 'function_call', 'content_filter'].includes(
            reason
          )
        ) {
          this.#finishReasons.add(reason);
        } else {
          this.#finishReasons.add('unknown');
          this.#invalid = true;
        }
      }
    }
  }

  finish(): RecordingProviderResponseSummary {
    try {
      this.#pending += this.#decoder.decode();
    } catch {
      this.#invalid = true;
    }
    const incomplete =
      this.#pending.trim().length > 0 || !this.#done || this.#finishReasons.size === 0;
    this.#pending = '';
    return {
      requestNumber: this.requestNumber,
      contentChars: this.#contentChars,
      reasoningChars: this.#reasoningChars,
      toolCallDeltas: this.#toolCallDeltas,
      finishReasons: [...this.#finishReasons],
      done: this.#done,
      parseStatus: this.#limitExceeded
        ? 'limit_exceeded'
        : this.#invalid
          ? 'invalid'
          : !this.#sawChoices
            ? 'unsupported'
            : incomplete
              ? 'incomplete'
              : 'complete',
    };
  }
}

export interface RecordingProviderProxy {
  baseUrl: string;
  requestBodies: string[];
  requestPaths: string[];
  requestStartedAt: number[];
  requestFinishedAt: number[];
  heldRequestNumbers: number[];
  injectedRequestNumbers: number[];
  jsonOnlyRequestNumbers: number[];
  stopSequenceRequestNumbers: number[];
  forwardedRequestNumbers: number[];
  requestLifecycle: RecordingProviderRequestLifecycle[];
  responseSummaries: RecordingProviderResponseSummary[];
  maxInFlight: number;
  releaseHeld(): void;
  close(): Promise<void>;
}

export async function startRecordingProviderProxy(
  upstreamBaseUrl: string,
  options: {
    holdRequestNumber?: number;
    holdBodyIncludes?: string;
    holdMs?: number;
    onHold?: (requestNumber: number) => void | Promise<void>;
    injectFailureOnce?: {
      path: string;
      status?: number;
      retryAfterMs?: number;
      body?: unknown;
    };
    firstRequestJsonOnly?: { prompt: string };
    stopSequenceOnce?: { requestNumber: number; stop: string; prompt?: string };
  } = {}
): Promise<RecordingProviderProxy> {
  const injection = options.injectFailureOnce;
  if (
    injection !== undefined &&
    (!injection.path.startsWith('/') ||
      injection.path.includes('?') ||
      injection.path.includes('#') ||
      (injection.status !== undefined &&
        (!Number.isSafeInteger(injection.status) ||
          injection.status < 400 ||
          injection.status > 599)) ||
      (injection.retryAfterMs !== undefined &&
        (!Number.isSafeInteger(injection.retryAfterMs) || injection.retryAfterMs < 0)))
  ) {
    throw new Error('Invalid one-shot Provider failure injection');
  }

  const stopSequence = options.stopSequenceOnce;
  if (
    stopSequence !== undefined &&
    (!Number.isSafeInteger(stopSequence.requestNumber) ||
      stopSequence.requestNumber < 1 ||
      stopSequence.stop.length === 0)
  ) {
    throw new Error('Invalid one-shot Provider stop sequence');
  }

  const requestBodies: string[] = [];
  const requestPaths: string[] = [];
  const requestStartedAt: number[] = [];
  const requestFinishedAt: number[] = [];
  const heldRequestNumbers: number[] = [];
  const injectedRequestNumbers: number[] = [];
  const jsonOnlyRequestNumbers: number[] = [];
  const stopSequenceRequestNumbers: number[] = [];
  const forwardedRequestNumbers: number[] = [];
  const requestLifecycle: RecordingProviderRequestLifecycle[] = [];
  const responseSummaries: RecordingProviderResponseSummary[] = [];
  let matchingRequestHeld = false;
  let injectionConsumed = false;
  let requestCount = 0;
  let releaseHeldRequest: (() => void) | undefined;
  let inFlight = 0;
  let maxInFlight = 0;
  const recordLifecycle = (entry: RecordingProviderRequestLifecycle): void => {
    if (requestLifecycle.length < 128) requestLifecycle.push(entry);
  };
  const upstream = new URL(upstreamBaseUrl);
  const server = createServer((request, response) => {
    const incoming = new URL(request.url ?? '/', 'http://blade-proxy.invalid');
    const requestNumber = ++requestCount;
    const injectFailure =
      !injectionConsumed &&
      injection !== undefined &&
      incoming.pathname === injection.path;
    if (injectFailure) {
      injectionConsumed = true;
      injectedRequestNumbers.push(requestNumber);
    } else {
      forwardedRequestNumbers.push(requestNumber);
    }
    requestPaths.push(incoming.pathname);
    requestStartedAt.push(Date.now());
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);

    void (async () => {
      let summary: OpenAIResponseSummaryCollector | undefined;
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks);
        const bodyText = body.toString('utf8');
        requestBodies[requestNumber - 1] = bodyText;
        recordLifecycle({ requestNumber, phase: 'body_read' });

        if (injectFailure) {
          response.statusCode = injection.status ?? 503;
          response.setHeader('content-type', 'application/json');
          if (injection.retryAfterMs !== undefined) {
            response.setHeader('retry-after-ms', String(injection.retryAfterMs));
          }
          response.end(
            JSON.stringify(
              injection.body ?? {
                error: { message: 'Qualification proxy injected Provider failure' },
              }
            )
          );
          recordLifecycle({ requestNumber, phase: 'downstream_ended' });
          return;
        }

        if (
          (options.holdRequestNumber === requestNumber ||
            (!matchingRequestHeld &&
              options.holdBodyIncludes !== undefined &&
              bodyText.includes(options.holdBodyIncludes))) &&
          (options.holdMs ?? 0) > 0
        ) {
          matchingRequestHeld = true;
          let releaseHold!: () => void;
          const hold = new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, options.holdMs);
            releaseHold = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          releaseHeldRequest = releaseHold;
          heldRequestNumbers.push(requestNumber);
          recordLifecycle({ requestNumber, phase: 'hold_entered' });
          await options.onHold?.(requestNumber);
          await hold;
          releaseHeldRequest = undefined;
          recordLifecycle({ requestNumber, phase: 'release_observed' });
        }

        const target = new URL(upstream);
        const incomingPath =
          target.pathname.endsWith('/v1') && incoming.pathname.startsWith('/v1/')
            ? incoming.pathname.slice(3)
            : incoming.pathname;
        target.pathname = `${target.pathname.replace(/\/+$/, '')}/${incomingPath.replace(
          /^\/+/,
          ''
        )}`;
        target.search = incoming.search;

        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (
            value === undefined ||
            ['host', 'connection', 'content-length'].includes(name.toLowerCase())
          ) {
            continue;
          }
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        let upstreamBody = body;
        if (requestNumber === 1 && options.firstRequestJsonOnly) {
          const parsed: unknown = JSON.parse(bodyText);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Tool-choice qualification requires a JSON request object');
          }
          upstreamBody = Buffer.from(
            JSON.stringify({
              ...Object.fromEntries(
                Object.entries(parsed).filter(
                  ([key]) => key !== 'tools' && key !== 'tool_choice'
                )
              ),
              messages: [
                { role: 'user', content: options.firstRequestJsonOnly.prompt },
              ],
              response_format: { type: 'json_object' },
            })
          );
          jsonOnlyRequestNumbers.push(requestNumber);
        }
        if (stopSequence?.requestNumber === requestNumber) {
          const parsed: unknown = JSON.parse(upstreamBody.toString('utf8'));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(
              'Stop-sequence qualification requires a JSON request object'
            );
          }
          upstreamBody = Buffer.from(
            JSON.stringify({
              ...Object.fromEntries(
                Object.entries(parsed).filter(
                  ([key]) =>
                    !stopSequence.prompt || (key !== 'tools' && key !== 'tool_choice')
                )
              ),
              ...(stopSequence.prompt
                ? { messages: [{ role: 'user', content: stopSequence.prompt }] }
                : {}),
              stop: [stopSequence.stop],
            })
          );
          stopSequenceRequestNumbers.push(requestNumber);
        }
        recordLifecycle({ requestNumber, phase: 'upstream_started' });
        const upstreamResponse = await fetch(target, {
          method: request.method,
          headers,
          body: upstreamBody.length > 0 ? upstreamBody : undefined,
        });
        recordLifecycle({
          requestNumber,
          phase: 'headers_received',
          statusClass: Math.floor(upstreamResponse.status / 100),
        });
        response.statusCode = upstreamResponse.status;
        upstreamResponse.headers.forEach((value, name) => {
          if (
            ![
              'connection',
              'content-encoding',
              'content-length',
              'keep-alive',
              'transfer-encoding',
            ].includes(name.toLowerCase())
          ) {
            response.setHeader(name, value);
          }
        });
        if (
          upstreamResponse.headers.get('content-type')?.includes('text/event-stream')
        ) {
          summary = new OpenAIResponseSummaryCollector(requestNumber);
        }
        const reader = upstreamResponse.body?.getReader();
        if (reader) {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            summary?.append(chunk.value);
            if (!response.write(Buffer.from(chunk.value))) {
              await new Promise<void>((resolve, reject) => {
                const cleanup = () => {
                  response.off('drain', onDrain);
                  response.off('error', onError);
                };
                const onDrain = () => {
                  cleanup();
                  resolve();
                };
                const onError = (error: Error) => {
                  cleanup();
                  reject(error);
                };
                response.once('drain', onDrain);
                response.once('error', onError);
              });
            }
          }
        }
        recordLifecycle({ requestNumber, phase: 'body_completed' });
        response.end();
        recordLifecycle({ requestNumber, phase: 'downstream_ended' });
      } finally {
        if (summary && responseSummaries.length < 128)
          responseSummaries.push(summary.finish());
        inFlight = Math.max(0, inFlight - 1);
        requestFinishedAt.push(Date.now());
      }
    })().catch((error: unknown) => {
      const errorRecord =
        error && typeof error === 'object'
          ? (error as { name?: unknown; code?: unknown })
          : undefined;
      recordLifecycle({
        requestNumber,
        phase: 'failed',
        ...(typeof errorRecord?.name === 'string'
          ? { errorName: errorRecord.name.slice(0, 64) }
          : {}),
        ...(typeof errorRecord?.code === 'string'
          ? { errorCode: errorRecord.code.slice(0, 64) }
          : {}),
      });
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      response.statusCode = 502;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          error: { message: 'Qualification proxy forwarding failed' },
        })
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requestBodies,
    requestPaths,
    requestStartedAt,
    requestFinishedAt,
    heldRequestNumbers,
    injectedRequestNumbers,
    jsonOnlyRequestNumbers,
    stopSequenceRequestNumbers,
    forwardedRequestNumbers,
    requestLifecycle,
    responseSummaries,
    get maxInFlight() {
      return maxInFlight;
    },
    releaseHeld: () => {
      releaseHeldRequest?.();
    },
    close: async () => {
      releaseHeldRequest?.();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
