import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startRecordingProviderProxy } from '../../support/recordingProviderProxy.js';

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

describe('recording Provider proxy one-shot failure injection', () => {
  it('injects one fixed 503 before forwarding the next exact-path request', async () => {
    const { proxy, requestCount } = await createProxy({
      inject503Once: { path: '/v1/chat/completions', retryAfterMs: 25 },
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
      inject503Once: { path: '/v1/chat/completions' },
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

  it('forwards every request by default', async () => {
    const { proxy, requestCount } = await createProxy();

    await fetch(`${proxy.baseUrl}/chat/completions`);
    await fetch(`${proxy.baseUrl}/chat/completions`);

    expect(requestCount.value).toBe(2);
    expect(proxy.injectedRequestNumbers).toEqual([]);
    expect(proxy.forwardedRequestNumbers).toEqual([1, 2]);
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

  it('injects exactly once when matching requests arrive concurrently', async () => {
    const { proxy, requestCount } = await createProxy({
      inject503Once: { path: '/v1/chat/completions' },
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
  ])('fails closed for invalid injection options: %j', async (inject503Once) => {
    await expect(
      startRecordingProviderProxy('http://127.0.0.1:1/v1', { inject503Once })
    ).rejects.toThrow('Invalid one-shot Provider failure injection');
  });
});
