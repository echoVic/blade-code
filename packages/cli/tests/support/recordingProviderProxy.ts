import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordingProviderProxy {
  baseUrl: string;
  requestBodies: string[];
  requestStartedAt: number[];
  requestFinishedAt: number[];
  heldRequestNumbers: number[];
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
  } = {}
): Promise<RecordingProviderProxy> {
  const requestBodies: string[] = [];
  const requestStartedAt: number[] = [];
  const requestFinishedAt: number[] = [];
  const heldRequestNumbers: number[] = [];
  let matchingRequestHeld = false;
  let releaseHeldRequest: (() => void) | undefined;
  let inFlight = 0;
  let maxInFlight = 0;
  const upstream = new URL(upstreamBaseUrl);
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      const bodyText = body.toString('utf8');
      requestBodies.push(bodyText);
      const requestNumber = requestBodies.length;
      requestStartedAt.push(Date.now());
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (
          (options.holdRequestNumber === requestNumber ||
            (!matchingRequestHeld &&
              options.holdBodyIncludes !== undefined &&
              bodyText.includes(options.holdBodyIncludes))) &&
          (options.holdMs ?? 0) > 0
        ) {
          matchingRequestHeld = true;
          heldRequestNumbers.push(requestNumber);
          await options.onHold?.(requestNumber);
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, options.holdMs);
            releaseHeldRequest = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          releaseHeldRequest = undefined;
        }

        const incoming = new URL(request.url ?? '/', 'http://blade-proxy.invalid');
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
        const upstreamResponse = await fetch(target, {
          method: request.method,
          headers,
          body: body.length > 0 ? body : undefined,
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
        response.end(Buffer.from(await upstreamResponse.arrayBuffer()));
      } finally {
        inFlight = Math.max(0, inFlight - 1);
        requestFinishedAt.push(Date.now());
      }
    })().catch((error: unknown) => {
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
    requestStartedAt,
    requestFinishedAt,
    heldRequestNumbers,
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
