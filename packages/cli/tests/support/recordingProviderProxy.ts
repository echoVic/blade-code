import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordingProviderProxy {
  baseUrl: string;
  requestBodies: string[];
  close(): Promise<void>;
}

export async function startRecordingProviderProxy(
  upstreamBaseUrl: string
): Promise<RecordingProviderProxy> {
  const requestBodies: string[] = [];
  const upstream = new URL(upstreamBaseUrl);
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      requestBodies.push(body.toString('utf8'));

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
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
