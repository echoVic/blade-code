import { execFile } from 'node:child_process';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamChunk } from '../../src/services/ChatServiceInterface.js';
import { PiAIChatService } from '../../src/services/PiAIChatService.js';
import { ProviderCircuitRegistry } from '../../src/services/pi/providerCircuitBreaker.js';

vi.unmock('node:child_process');

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

  it.each([
    { maxRetries: 0, partial: false },
    { maxRetries: 1, partial: false },
    { maxRetries: 1, partial: true },
  ])(
    'keeps Bun POST replay bounded (retries: $maxRetries, partial: $partial)',
    async ({ maxRetries, partial }) => {
      server?.removeAllListeners('request');
      server?.on('request', async (request, response) => {
        for await (const chunk of request) {
          void chunk;
        }
        requestCount++;
        if (requestCount === 2) {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.flushHeaders();
          if (partial) {
            response.write(
              `data: ${JSON.stringify({
                id: 'bounded-post',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'deepseek-v4-flash',
                choices: [
                  { index: 0, delta: { content: 'PARTIAL' }, finish_reason: null },
                ],
              })}\n\n`
            );
          }
          setTimeout(() => response.destroy(), 100);
          return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          `data: ${JSON.stringify({
            id: 'bounded-post',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'deepseek-v4-flash',
            choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\ndata: [DONE]\n\n`
        );
      });
      const modulePath = new URL(
        '../../src/services/PiAIChatService.ts',
        import.meta.url
      ).href;
      const source = `import { PiAIChatService } from ${JSON.stringify(modulePath)};
      const service = new PiAIChatService({provider:'deepseek',model:'deepseek-v4-flash',apiKey:'integration-test-key',baseUrl:${JSON.stringify(baseUrl)},maxRetries:${maxRetries},timeout:5000});
      await service.chat([{role:'user',content:'warmup'}]);
      const phases=[]; let failed=false; let content='';
      try { for await(const chunk of service.streamChat([{role:'user',content:'second'}])) { if(chunk.providerRetry) phases.push(chunk.providerRetry.phase); content+=chunk.content??''; } }
      catch { failed=true; }
      console.log(JSON.stringify({failed,phases,content}));`;
      const result = await promisify(execFile)('bun', ['-e', source], {
        timeout: 15_000,
      });
      expect(JSON.parse(result.stdout)).toEqual({
        failed: partial || maxRetries === 0,
        phases: partial
          ? []
          : maxRetries === 0
            ? ['exhausted']
            : ['scheduled', 'attempt', 'recovered'],
        content: partial ? 'PARTIAL' : maxRetries === 0 ? '' : 'OK',
      });
      expect(requestCount).toBe(partial || maxRetries === 0 ? 2 : 3);
    }
  );

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

  it('shares an explicit 429 cooldown before another real HTTP request', async () => {
    let now = 1_000;
    requestCount = 0;
    server?.removeAllListeners('request');
    server?.on('request', async (request, response) => {
      for await (const _chunk of request) {
        // Drain the request body.
      }
      requestCount++;
      if (requestCount === 1) {
        response.writeHead(429, {
          'content-type': 'application/json',
          'retry-after-ms': '2000',
        });
        response.end(
          JSON.stringify({
            error: {
              message: 'PRIVATE_RATE_LIMIT_BODY_MUST_NOT_SURFACE',
              type: 'rate_limit_error',
            },
          })
        );
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      response.end(
        `data: ${JSON.stringify({
          id: 'cooldown-probe',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'deepseek-v4-flash',
          choices: [
            { index: 0, delta: { content: 'RECOVERED' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        })}\n\ndata: [DONE]\n\n`
      );
    });
    const registry = new ProviderCircuitRegistry({
      processSecret: new Uint8Array(32).fill(9),
      now: () => now,
      wallNow: () => now,
    });
    const options = {
      provider: 'deepseek',
      apiKey: 'integration-test-key',
      baseUrl,
      model: 'deepseek-v4-flash',
      maxOutputTokens: 64,
      timeout: 5_000,
      maxRetries: 0,
      providerCircuitBreakerOpenMs: 1_000,
      providerCircuitRegistry: registry,
    } as const;

    await expect(
      new PiAIChatService(options).chat([{ role: 'user', content: 'first' }])
    ).rejects.toThrow();
    const second = new PiAIChatService(options).streamChat([
      { role: 'user', content: 'second' },
    ]);
    await expect(second.next()).resolves.toMatchObject({
      value: {
        providerCircuit: {
          phase: 'rejected',
          reason: 'rate_limit',
          statusCode: 429,
          retryAfterMs: 2_000,
        },
      },
    });
    await expect(second.next()).rejects.toMatchObject({
      code: 'PROVIDER_CIRCUIT_OPEN',
    });
    expect(requestCount).toBe(1);

    now += 2_000;
    const recovered: StreamChunk[] = [];
    for await (const chunk of new PiAIChatService(options).streamChat([
      { role: 'user', content: 'probe' },
    ])) {
      recovered.push(chunk);
    }
    expect(requestCount).toBe(2);
    expect(
      recovered.flatMap((chunk) =>
        chunk.providerCircuit ? [chunk.providerCircuit.phase] : []
      )
    ).toEqual(['probe', 'closed']);
    expect(recovered.filter((chunk) => chunk.content !== undefined)).toEqual([
      expect.objectContaining({ content: 'RECOVERED' }),
    ]);
    expect(JSON.stringify(recovered)).not.toContain(
      'PRIVATE_RATE_LIMIT_BODY_MUST_NOT_SURFACE'
    );
    expect(JSON.stringify(recovered)).not.toContain('integration-test-key');
  });
});
