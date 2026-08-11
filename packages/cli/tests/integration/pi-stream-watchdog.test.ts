import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PiAIChatService } from '../../src/services/PiAIChatService.js';

type StreamMode = 'silent' | 'partial' | 'delayed';

describe('pi provider stream watchdog integration', () => {
  let createHttpServer: typeof import('node:http').createServer;
  let server: Server | undefined;
  let baseUrl: string;
  let mode: StreamMode;
  let requestCount: number;

  beforeAll(async () => {
    const http = await vi.importActual<typeof import('node:http')>('node:http');
    createHttpServer = http.createServer;
  });

  beforeEach(async () => {
    mode = 'silent';
    requestCount = 0;
    const activeServer = createHttpServer((_request, response) => {
      requestCount += 1;
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.flushHeaders();
      if (mode === 'partial' || mode === 'delayed') {
        const writeResponse = () => {
          if (response.destroyed) return;
          response.write(
            'data: ' +
              JSON.stringify({
                id: `watchdog-${requestCount}`,
                object: 'chat.completion.chunk',
                created: 1,
                model: 'deepseek-v4-flash',
                choices: [
                  {
                    index: 0,
                    delta: { content: 'partial' },
                    finish_reason: null,
                  },
                ],
              }) +
              '\n\n'
          );
          if (mode === 'delayed') {
            response.write(
              'data: ' +
                JSON.stringify({
                  id: `watchdog-${requestCount}`,
                  object: 'chat.completion.chunk',
                  created: 1,
                  model: 'deepseek-v4-flash',
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                  usage: {
                    prompt_tokens: 4,
                    completion_tokens: 1,
                    total_tokens: 5,
                  },
                }) +
                '\n\n'
            );
            response.end('data: [DONE]\n\n');
          }
        };
        if (mode === 'delayed') {
          setTimeout(writeResponse, 150);
          return;
        }
        writeResponse();
      }
    });
    server = activeServer;
    await new Promise<void>((resolve, reject) => {
      activeServer.once('error', reject);
      activeServer.listen(0, '127.0.0.1', () => {
        activeServer.off('error', reject);
        resolve();
      });
    });
    const address = activeServer.address() as AddressInfo;
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

  it('fails a silent stream without starting an overlapping provider request', async () => {
    const service = createService({ maxRetries: 2 });

    await expect(service.chat([{ role: 'user', content: 'hello' }])).rejects.toThrow(
      'stream idle timeout'
    );
    expect(requestCount).toBe(1);
  });

  it('does not replay a stream after partial model output', async () => {
    mode = 'partial';
    const service = createService({ maxRetries: 2 });
    const stream = service.streamChat([{ role: 'user', content: 'hello' }]);

    await expect(stream.next()).resolves.toMatchObject({
      value: { content: 'partial' },
      done: false,
    });
    await expect(stream.next()).resolves.toMatchObject({
      value: {
        providerStall: {
          phase: 'detected',
          outputStarted: true,
          warningAfterMs: 125,
          timeoutMs: 250,
        },
      },
      done: false,
    });
    await expect(stream.next()).rejects.toThrow('stream idle timeout');
    expect(requestCount).toBe(1);
  });

  it('surfaces a delayed stream and recovers without a second request', async () => {
    mode = 'delayed';
    const service = createService({ maxRetries: 2 });
    const chunks = [];

    for await (const chunk of service.streamChat([
      { role: 'user', content: 'hello' },
    ])) {
      chunks.push(chunk);
    }

    expect(requestCount).toBe(1);
    expect(
      chunks.flatMap((chunk) =>
        chunk.providerStall ? [chunk.providerStall.phase] : []
      )
    ).toEqual(['detected', 'recovered']);
    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerStall: expect.objectContaining({
            phase: 'detected',
            outputStarted: false,
          }),
        }),
        { content: 'partial' },
      ])
    );
  });

  function createService(overrides: { maxRetries: number }): PiAIChatService {
    return new PiAIChatService({
      provider: 'deepseek',
      apiKey: 'integration-test-key',
      baseUrl,
      model: 'deepseek-v4-flash',
      maxOutputTokens: 64,
      timeout: 5_000,
      streamIdleTimeout: 250,
      maxRetries: overrides.maxRetries,
    });
  }
});
