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
