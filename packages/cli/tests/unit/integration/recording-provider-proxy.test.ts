import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  OpenAIResponseSummaryCollector,
  startRecordingProviderProxy,
} from '../../support/recordingProviderProxy.js';

vi.unmock('http');
vi.unmock('node:http');

let createServer: typeof import('node:http').createServer;

beforeAll(async () => {
  ({ createServer } = await vi.importActual<typeof import('node:http')>('node:http'));
});

interface TestServer {
  baseUrl: string;
  close(): Promise<void>;
}

async function startUpstream(requestCount: { value: number }): Promise<TestServer> {
  const server = createServer((_request, response) => {
    requestCount.value++;
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true }));
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
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function createProxy(
  options: Parameters<typeof startRecordingProviderProxy>[1] = {}
) {
  const requestCount = { value: 0 };
  const upstream = await startUpstream(requestCount);
  closers.push(upstream.close);
  const proxy = await startRecordingProviderProxy(upstream.baseUrl, options);
  closers.unshift(proxy.close);
  return { proxy, requestCount };
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 1_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for proxy test condition');
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('OpenAI response summary collection', () => {
  it('counts split UTF-8 SSE deltas without retaining their content', () => {
    const collector = new OpenAIResponseSummaryCollector(3);
    const frames = [
      {
        choices: [
          { delta: { reasoning_content: 'PRIVATE_REASONING' }, finish_reason: null },
        ],
      },
      {
        choices: [
          {
            delta: {
              content: '中文PRIVATE_TEXT',
              tool_calls: [
                {
                  index: 0,
                  function: { name: 'PRIVATE_TOOL', arguments: 'PRIVATE_ARGUMENTS' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ];
    const bytes = Buffer.from(
      frames.map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`).join('') +
        'data: [DONE]\r\n\r\n'
    );
    for (const byte of bytes) collector.append(Uint8Array.of(byte));
    const summary = collector.finish();
    expect(summary).toEqual({
      requestNumber: 3,
      contentChars: 14,
      reasoningChars: 17,
      toolCallDeltas: 1,
      finishReasons: ['tool_calls'],
      done: true,
      parseStatus: 'complete',
    });
    expect(JSON.stringify(summary)).not.toContain('PRIVATE_');
    expect(JSON.stringify(collector)).not.toContain('PRIVATE_');
  });

  it.each(['stop', 'length'] as const)(
    'distinguishes an empty %s response',
    (finishReason) => {
      const collector = new OpenAIResponseSummaryCollector(2);
      collector.append(
        Buffer.from(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`
        )
      );
      expect(collector.finish()).toMatchObject({
        contentChars: 0,
        finishReasons: [finishReason],
        done: true,
        parseStatus: 'complete',
      });
    }
  );

  it('does not call an unterminated stream complete', () => {
    const collector = new OpenAIResponseSummaryCollector(1);
    collector.append(Buffer.from('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
    expect(collector.finish()).toMatchObject({
      contentChars: 1,
      done: false,
      parseStatus: 'incomplete',
    });
  });

  it('drops unknown finish reasons and malformed data without leaking them', () => {
    const collector = new OpenAIResponseSummaryCollector(1);
    collector.append(
      Buffer.from(
        'data: PRIVATE_BAD_JSON\n\ndata: {"choices":[{"delta":{},"finish_reason":"PRIVATE_REASON"}]}\n\ndata: [DONE]\n\n'
      )
    );
    const summary = collector.finish();
    expect(summary).toMatchObject({
      finishReasons: ['unknown'],
      done: true,
      parseStatus: 'invalid',
    });
    expect(JSON.stringify(summary)).not.toContain('PRIVATE_');
  });

  it('bounds an oversized unterminated SSE event', () => {
    const collector = new OpenAIResponseSummaryCollector(1);
    collector.append(Buffer.from(`data: ${'PRIVATE_'.repeat(20_000)}`));
    expect(collector.finish().parseStatus).toBe('limit_exceeded');
    expect(JSON.stringify(collector)).not.toContain('PRIVATE_');
  });
});

describe('recording Provider proxy one-shot failure injection', () => {
  it('injects one fixed 503 before forwarding the next exact-path request', async () => {
    const { proxy, requestCount } = await createProxy({
      injectFailureOnce: { path: '/v1/chat/completions', retryAfterMs: 25 },
    });

    const first = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ secret: 'body-secret' }),
      headers: { authorization: 'Bearer authorization-secret' },
    });
    const second = await fetch(`${proxy.baseUrl}/chat/completions`, { method: 'POST' });

    expect(first.status).toBe(503);
    expect(first.headers.get('retry-after-ms')).toBe('25');
    expect(await first.json()).toEqual({
      error: { message: 'Qualification proxy injected Provider failure' },
    });
    expect(second.status).toBe(200);
    expect(requestCount.value).toBe(1);
    expect(proxy.requestPaths).toEqual([
      '/v1/chat/completions',
      '/v1/chat/completions',
    ]);
    expect(proxy.injectedRequestNumbers).toEqual([1]);
    expect(proxy.forwardedRequestNumbers).toEqual([2]);
    expect(proxy.requestStartedAt).toHaveLength(2);
    expect(proxy.requestFinishedAt).toHaveLength(2);
    expect(
      JSON.stringify({
        requestPaths: proxy.requestPaths,
        injectedRequestNumbers: proxy.injectedRequestNumbers,
        forwardedRequestNumbers: proxy.forwardedRequestNumbers,
      })
    ).not.toMatch(/authorization-secret|body-secret/i);
  });

  it('does not consume injection on another path and ignores query for matching', async () => {
    const { proxy, requestCount } = await createProxy({
      injectFailureOnce: { path: '/v1/chat/completions' },
    });

    expect((await fetch(`${proxy.baseUrl}/models?token=query-secret`)).status).toBe(
      200
    );
    expect(
      (await fetch(`${proxy.baseUrl}/chat/completions?token=query-secret`)).status
    ).toBe(503);

    expect(requestCount.value).toBe(1);
    expect(proxy.requestPaths).toEqual(['/v1/models', '/v1/chat/completions']);
    expect(proxy.forwardedRequestNumbers).toEqual([1]);
    expect(proxy.injectedRequestNumbers).toEqual([2]);
    expect(JSON.stringify(proxy.requestPaths)).not.toContain('query-secret');
  });

  it('supports a custom failure status and body', async () => {
    const { proxy } = await createProxy({
      injectFailureOnce: {
        path: '/v1/chat/completions',
        status: 413,
        body: { error: { code: 'context_length_exceeded' } },
      },
    });

    const response = await fetch(`${proxy.baseUrl}/chat/completions`);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: { code: 'context_length_exceeded' },
    });
  });

  it('forwards every request by default', async () => {
    const { proxy, requestCount } = await createProxy();

    await fetch(`${proxy.baseUrl}/chat/completions`);
    await fetch(`${proxy.baseUrl}/chat/completions`);

    expect(requestCount.value).toBe(2);
    expect(proxy.injectedRequestNumbers).toEqual([]);
    expect(proxy.forwardedRequestNumbers).toEqual([1, 2]);
  });

  it('requests JSON-only text on the first request without replacing responses', async () => {
    const receivedBodies: unknown[] = [];
    const upstreamServer = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.setHeader('content-type', 'text/event-stream');
        response.end('data: unchanged-upstream-response\n\n');
      })();
    });
    await new Promise<void>((resolve, reject) => {
      upstreamServer.once('error', reject);
      upstreamServer.listen(0, '127.0.0.1', resolve);
    });
    closers.push(async () => {
      upstreamServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        upstreamServer.close((error) => (error ? reject(error) : resolve()));
      });
    });
    const address = upstreamServer.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port');
    const proxy = await startRecordingProviderProxy(
      `http://127.0.0.1:${address.port}/v1`,
      { firstRequestJsonOnly: { prompt: 'Return the requested JSON object.' } }
    );
    closers.unshift(proxy.close);
    const request = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'Call Read.' }],
      tools: [{ type: 'function', function: { name: 'Read' } }],
      tool_choice: 'auto',
      stream: true,
    };
    for (let index = 0; index < 2; index++) {
      const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
        method: 'POST',
        body: JSON.stringify(request),
        headers: { 'content-type': 'application/json' },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('data: unchanged-upstream-response\n\n');
    }
    expect(receivedBodies).toEqual([
      {
        model: request.model,
        messages: [{ role: 'user', content: 'Return the requested JSON object.' }],
        stream: true,
        response_format: { type: 'json_object' },
      },
      request,
    ]);
    expect(proxy.requestBodies.map((body) => JSON.parse(body))).toEqual([
      request,
      request,
    ]);
    expect(proxy.jsonOnlyRequestNumbers).toEqual([1]);
    expect(proxy.injectedRequestNumbers).toEqual([]);
    expect(proxy.forwardedRequestNumbers).toEqual([1, 2]);
  });

  it.each([false, true])(
    'sets one upstream stop sequence without replacing responses (prompt: %s)',
    async (replacePrompt) => {
      const receivedBodies: unknown[] = [];
      const upstreamServer = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          response.setHeader('content-type', 'text/event-stream');
          response.end('data: unchanged-stop-sequence-response\n\n');
        })();
      });
      await new Promise<void>((resolve, reject) => {
        upstreamServer.once('error', reject);
        upstreamServer.listen(0, '127.0.0.1', resolve);
      });
      closers.push(async () => {
        upstreamServer.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          upstreamServer.close((error) => (error ? reject(error) : resolve()));
        });
      });
      const address = upstreamServer.address();
      if (!address || typeof address === 'string') throw new Error('Missing test port');
      const proxy = await startRecordingProviderProxy(
        `http://127.0.0.1:${address.port}/v1`,
        {
          stopSequenceOnce: {
            requestNumber: 2,
            stop: 'HELLO',
            ...(replacePrompt ? { prompt: 'Reply exactly HELLO' } : {}),
          },
        }
      );
      closers.unshift(proxy.close);
      const request = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'Call Bash.' }],
        max_tokens: 4096,
        stream: true,
      };
      for (let index = 0; index < 3; index++) {
        const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
          method: 'POST',
          body: JSON.stringify(request),
          headers: { 'content-type': 'application/json' },
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(
          'data: unchanged-stop-sequence-response\n\n'
        );
      }
      expect(receivedBodies).toEqual([
        request,
        {
          ...request,
          stop: ['HELLO'],
          ...(replacePrompt
            ? { messages: [{ role: 'user', content: 'Reply exactly HELLO' }] }
            : {}),
        },
        request,
      ]);
      expect(proxy.requestBodies.map((body) => JSON.parse(body))).toEqual([
        request,
        request,
        request,
      ]);
      expect(proxy.injectedRequestNumbers).toEqual([]);
      expect(proxy.forwardedRequestNumbers).toEqual([1, 2, 3]);
      expect(proxy.stopSequenceRequestNumbers).toEqual([2]);
      expect(proxy.jsonOnlyRequestNumbers).toEqual([]);
    }
  );

  it.each([
    { requestNumber: 0, stop: 'STOP' },
    { requestNumber: 1.5, stop: 'STOP' },
    { requestNumber: 2, stop: '' },
  ])('rejects invalid stop sequence options: %j', async (stopSequenceOnce) => {
    await expect(
      startRecordingProviderProxy('http://127.0.0.1:1/v1', { stopSequenceOnce }).then(
        (proxy) => {
          closers.unshift(proxy.close);
          return proxy;
        }
      )
    ).rejects.toThrow('Invalid one-shot Provider stop sequence');
  });

  it('records a bounded structural lifecycle for a held upstream request', async () => {
    const secret = 'proxy-lifecycle-secret';
    const { proxy } = await createProxy({
      holdRequestNumber: 1,
      holdMs: 5_000,
    });
    const responsePromise = fetch(`${proxy.baseUrl}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ prompt: secret }),
      headers: { authorization: `Bearer ${secret}` },
    });

    await waitForCondition(() => proxy.heldRequestNumbers.includes(1));
    expect(proxy.requestLifecycle.map((entry) => entry.phase)).toEqual([
      'body_read',
      'hold_entered',
    ]);

    proxy.releaseHeld();
    expect((await responsePromise).status).toBe(200);

    expect(proxy.requestLifecycle).toEqual([
      { requestNumber: 1, phase: 'body_read' },
      { requestNumber: 1, phase: 'hold_entered' },
      { requestNumber: 1, phase: 'release_observed' },
      { requestNumber: 1, phase: 'upstream_started' },
      { requestNumber: 1, phase: 'headers_received', statusClass: 2 },
      { requestNumber: 1, phase: 'body_completed' },
      { requestNumber: 1, phase: 'downstream_ended' },
    ]);
    expect(JSON.stringify(proxy.requestLifecycle)).not.toContain(secret);
  });

  it('forwards streaming response chunks before the upstream response ends', async () => {
    const releaseTail = deferred<void>();
    const upstreamStarted = { value: false };
    const upstreamServer = createServer((_request, response) => {
      upstreamStarted.value = true;
      response.statusCode = 200;
      response.setHeader('content-type', 'text/event-stream');
      response.flushHeaders();
      response.write('data: first\n\n');
      void releaseTail.promise.then(() => response.end('data: second\n\n'));
    });
    await new Promise<void>((resolve, reject) => {
      upstreamServer.once('error', reject);
      upstreamServer.listen(0, '127.0.0.1', () => {
        upstreamServer.off('error', reject);
        resolve();
      });
    });
    closers.push(async () => {
      releaseTail.resolve();
      upstreamServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        upstreamServer.close((error) => (error ? reject(error) : resolve()));
      });
    });
    const address = upstreamServer.address() as AddressInfo;
    const proxy = await startRecordingProviderProxy(
      `http://127.0.0.1:${address.port}/v1`
    );
    closers.unshift(proxy.close);
    let responseResolved = false;
    const responsePromise = fetch(`${proxy.baseUrl}/chat/completions`, {
      method: 'POST',
    }).then((response) => {
      responseResolved = true;
      return response;
    });

    await waitForCondition(() => upstreamStarted.value);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(responseResolved).toBe(true);

    const response = await responsePromise;
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Streaming proxy response body is unavailable');
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('data: first\n\n');
    expect(proxy.requestLifecycle.at(-1)?.phase).toBe('headers_received');

    releaseTail.resolve();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe('data: second\n\n');
    await reader.read();
    expect(proxy.requestLifecycle.at(-1)?.phase).toBe('downstream_ended');
  });

  it('records response summaries while forwarding the original stream incrementally', async () => {
    const releaseTail = deferred<void>();
    const firstFrame =
      'data: {"choices":[{"delta":{"content":"PRIVATE_TEXT"},"finish_reason":null}]}\n\n';
    const lastFrames =
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const upstreamServer = createServer((_request, response) => {
      response.setHeader('content-type', 'text/event-stream');
      response.write(firstFrame);
      void releaseTail.promise.then(() => response.end(lastFrames));
    });
    await new Promise<void>((resolve, reject) => {
      upstreamServer.once('error', reject);
      upstreamServer.listen(0, '127.0.0.1', resolve);
    });
    closers.push(async () => {
      releaseTail.resolve();
      upstreamServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        upstreamServer.close((error) => (error ? reject(error) : resolve()));
      });
    });
    const address = upstreamServer.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port');
    const proxy = await startRecordingProviderProxy(
      `http://127.0.0.1:${address.port}/v1`
    );
    closers.unshift(proxy.close);
    try {
      const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
        method: 'POST',
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Missing response body');
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe(firstFrame);
      expect(proxy.responseSummaries).toEqual([]);
      releaseTail.resolve();
      let received = firstFrame;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += new TextDecoder().decode(chunk.value);
      }
      expect(received).toBe(firstFrame + lastFrames);
      expect(proxy.responseSummaries).toEqual([
        {
          requestNumber: 1,
          contentChars: 12,
          reasoningChars: 0,
          toolCallDeltas: 0,
          finishReasons: ['stop'],
          done: true,
          parseStatus: 'complete',
        },
      ]);
      expect(JSON.stringify(proxy.responseSummaries)).not.toContain('PRIVATE_');
    } finally {
      releaseTail.resolve();
    }
  });

  it('injects exactly once when matching requests arrive concurrently', async () => {
    const { proxy, requestCount } = await createProxy({
      injectFailureOnce: { path: '/v1/chat/completions' },
    });

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => fetch(`${proxy.baseUrl}/chat/completions`))
    );

    expect(responses.filter((response) => response.status === 503)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(7);
    expect(requestCount.value).toBe(7);
    expect(proxy.injectedRequestNumbers).toHaveLength(1);
    expect(proxy.forwardedRequestNumbers).toHaveLength(7);
    expect(proxy.requestStartedAt).toHaveLength(8);
    expect(proxy.requestFinishedAt).toHaveLength(8);
  });

  it.each([
    { path: 'v1/chat/completions' },
    { path: '/v1/chat/completions?unsafe=true' },
    { path: '/v1/chat/completions', retryAfterMs: -1 },
    { path: '/v1/chat/completions', retryAfterMs: Number.NaN },
    { path: '/v1/chat/completions', retryAfterMs: 1.5 },
    { path: '/v1/chat/completions', status: 399 },
    { path: '/v1/chat/completions', status: 600 },
    { path: '/v1/chat/completions', status: 503.5 },
  ])('fails closed for invalid injection options: %j', async (injectFailureOnce) => {
    await expect(
      startRecordingProviderProxy('http://127.0.0.1:1/v1', { injectFailureOnce })
    ).rejects.toThrow('Invalid one-shot Provider failure injection');
  });
});
