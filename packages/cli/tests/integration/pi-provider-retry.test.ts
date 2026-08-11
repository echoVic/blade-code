import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamChunk } from '../../src/services/ChatServiceInterface.js';
import { PiAIChatService } from '../../src/services/PiAIChatService.js';

describe('pi provider retry integration', () => {
  let server: Server | undefined;
  let createHttpServer: typeof import('node:http').createServer;
  let baseUrl: string;
  let requestCount: number;

  beforeAll(async () => {
    const http = await vi.importActual<typeof import('node:http')>('node:http');
    createHttpServer = http.createServer;
  });

  beforeEach(async () => {
    requestCount = 0;
    server = createHttpServer((_request, response) => {
      requestCount++;
      if (requestCount === 1) {
        response.writeHead(503, {
          'content-type': 'application/json',
          'retry-after-ms': '25',
        });
        response.end(
          JSON.stringify({
            error: {
              message: 'PRIVATE_PROVIDER_BODY_MUST_NOT_SURFACE',
              type: 'server_error',
            },
          })
        );
        return;
      }

      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.write(
        `data: ${JSON.stringify({
          id: 'retry-recovered',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'deepseek-v4-flash',
          choices: [
            {
              index: 0,
              delta: { content: 'RECOVERED_ONCE' },
              finish_reason: null,
            },
          ],
        })}\n\n`
      );
      response.write(
        `data: ${JSON.stringify({
          id: 'retry-recovered',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'deepseek-v4-flash',
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 4,
            completion_tokens: 2,
            total_tokens: 6,
          },
        })}\n\n`
      );
      response.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(0, '127.0.0.1', () => {
        server?.off('error', reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
  });

  afterEach(async () => {
    const activeServer = server;
    if (!activeServer) return;
    activeServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      activeServer.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('honors Retry-After and recovers before surfacing model output', async () => {
    const service = new PiAIChatService({
      provider: 'deepseek',
      apiKey: 'integration-test-key',
      baseUrl,
      model: 'deepseek-v4-flash',
      maxOutputTokens: 64,
      timeout: 5_000,
      maxRetries: 2,
    });
    const chunks: StreamChunk[] = [];

    for await (const chunk of service.streamChat([
      { role: 'user', content: 'hello' },
    ])) {
      chunks.push(chunk);
    }

    expect(requestCount).toBe(2);
    expect(
      chunks.flatMap((chunk) =>
        chunk.providerRetry ? [chunk.providerRetry.phase] : []
      )
    ).toEqual(['scheduled', 'attempt', 'recovered']);
    expect(chunks[0]).toMatchObject({
      providerRetry: {
        phase: 'scheduled',
        attempt: 1,
        maxRetries: 2,
        reason: 'server_error',
        statusCode: 503,
        delayMs: 25,
      },
    });
    expect(chunks.filter((chunk) => chunk.content)).toEqual([
      { content: 'RECOVERED_ONCE' },
    ]);
    expect(JSON.stringify(chunks)).not.toContain(
      'PRIVATE_PROVIDER_BODY_MUST_NOT_SURFACE'
    );
    expect(JSON.stringify(chunks)).not.toContain('integration-test-key');
  });
});
