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

export interface RecordingProviderProxy {
  baseUrl: string;
  requestBodies: string[];
  requestPaths: string[];
  requestStartedAt: number[];
  requestFinishedAt: number[];
  heldRequestNumbers: number[];
  injectedRequestNumbers: number[];
  forwardedRequestNumbers: number[];
  requestLifecycle: RecordingProviderRequestLifecycle[];
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
    inject503Once?: { path: string; retryAfterMs?: number };
  } = {}
): Promise<RecordingProviderProxy> {
  const injection = options.inject503Once;
  if (
    injection !== undefined &&
    (!injection.path.startsWith('/') ||
      injection.path.includes('?') ||
      injection.path.includes('#') ||
      (injection.retryAfterMs !== undefined &&
        (!Number.isSafeInteger(injection.retryAfterMs) || injection.retryAfterMs < 0)))
  ) {
    throw new Error('Invalid one-shot Provider failure injection');
  }

  const requestBodies: string[] = [];
  const requestPaths: string[] = [];
  const requestStartedAt: number[] = [];
  const requestFinishedAt: number[] = [];
  const heldRequestNumbers: number[] = [];
  const injectedRequestNumbers: number[] = [];
  const forwardedRequestNumbers: number[] = [];
  const requestLifecycle: RecordingProviderRequestLifecycle[] = [];
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
          response.statusCode = 503;
          response.setHeader('content-type', 'application/json');
          if (injection.retryAfterMs !== undefined) {
            response.setHeader('retry-after-ms', String(injection.retryAfterMs));
          }
          response.end(
            JSON.stringify({
              error: { message: 'Qualification proxy injected Provider failure' },
            })
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
        recordLifecycle({ requestNumber, phase: 'upstream_started' });
        const upstreamResponse = await fetch(target, {
          method: request.method,
          headers,
          body: body.length > 0 ? body : undefined,
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
        const reader = upstreamResponse.body?.getReader();
        if (reader) {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
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
    forwardedRequestNumbers,
    requestLifecycle,
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
