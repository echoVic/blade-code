import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionMode } from '../../../src/config/types.js';
import { HookManager } from '../../../src/hooks/HookManager.js';
import {
  type HookConfig,
  type HookMatcher,
  HookType,
} from '../../../src/hooks/types/HookTypes.js';

const execContext = {
  projectDir: '/tmp/proj',
  sessionId: 'test-session',
  permissionMode: PermissionMode.DEFAULT,
};

// mock fetch
const originalFetch = globalThis.fetch;

function makeResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status: init.status ?? 200,
    headers: init.headers,
  });
}

function registerHttpHook(
  hm: HookManager,
  url: string,
  opts?: Partial<{ timeout: number; retries: number; allowedHosts: string[] }>
) {
  hm.loadConfig({
    enabled: true,
    httpPolicy: opts?.allowedHosts ? { allowedHosts: opts.allowedHosts } : undefined,
  });
  const cfg = hm.getConfig() as HookConfig;
  (cfg.PreToolUse as HookMatcher[]) = [
    {
      name: 'test-http',
      matcher: { tools: 'Edit' },
      hooks: [
        {
          type: HookType.Http,
          url,
          timeout: opts?.timeout,
          retries: opts?.retries,
        },
      ],
    },
  ];
}

describe('HTTP Hook', () => {
  let hm: HookManager;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    hm = HookManager.getInstance();
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    hm.loadConfig({ enabled: false });
    vi.restoreAllMocks();
  });

  describe('正常响应', () => {
    it('handler 返回 decision.behavior=block → deny', async () => {
      fetchMock.mockResolvedValueOnce(
        makeResponse({
          decision: { behavior: 'block' },
          systemMessage: 'blocked by webhook',
        })
      );
      registerHttpHook(hm, 'https://api.example.com/hook');

      const result = await hm.executePreToolHooks(
        'Edit',
        'id-1',
        { file_path: '/x.ts' },
        execContext
      );

      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('blocked by webhook');
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.example.com/hook');
      expect(init.method).toBe('POST');
      expect(init.redirect).toBe('manual');
    });

    it('响应空 JSON → allow (pass-through)', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse({}));
      registerHttpHook(hm, 'https://api.example.com/hook');

      const result = await hm.executePreToolHooks(
        'Edit',
        'id-2',
        { file_path: '/x.ts' },
        execContext
      );
      expect(result.decision).toBe('allow');
    });

    it('POST body 是 HookInput 的 JSON', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse({}));
      registerHttpHook(hm, 'https://api.example.com/hook');

      await hm.executePreToolHooks(
        'Edit',
        'id-3',
        { file_path: '/abc.ts' },
        execContext
      );

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.tool_name).toBe('Edit');
      expect(body.tool_input).toEqual({ file_path: '/abc.ts' });
    });
  });

  describe('安全拦截', () => {
    it('http:// 默认被拒 → deny (阻塞错误)', async () => {
      registerHttpHook(hm, 'http://api.example.com/hook');

      const result = await hm.executePreToolHooks(
        'Edit',
        'id-http',
        { file_path: '/x.ts' },
        execContext
      );

      // failureBehavior=ignore 的默认下, blocking=true 会映射为 deny
      expect(result.decision).toBe('deny');
      expect(result.reason).toMatch(/HTTP \(non-TLS\) blocked/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('loopback 默认被拒', async () => {
      registerHttpHook(hm, 'https://127.0.0.1/hook');

      const result = await hm.executePreToolHooks(
        'Edit',
        'id-lb',
        { file_path: '/x.ts' },
        execContext
      );
      expect(result.decision).toBe('deny');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('allowedHosts 命中 loopback 时放行', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse({}));
      registerHttpHook(hm, 'http://127.0.0.1:8080/hook', {
        allowedHosts: ['127.0.0.1'],
      });

      const result = await hm.executePreToolHooks(
        'Edit',
        'id-allow',
        { file_path: '/x.ts' },
        execContext
      );
      expect(result.decision).toBe('allow');
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  describe('重试', () => {
    it('5xx 会重试;成功后返回结果', async () => {
      fetchMock
        .mockResolvedValueOnce(makeResponse('server down', { status: 503 }))
        .mockResolvedValueOnce(makeResponse({}));
      registerHttpHook(hm, 'https://api.example.com/hook', { retries: 1 });

      const result = await hm.executePreToolHooks(
        'Edit',
        'id-retry',
        { file_path: '/x.ts' },
        execContext
      );
      expect(result.decision).toBe('allow');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('4xx 不重试', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse('bad request', { status: 400 }));
      registerHttpHook(hm, 'https://api.example.com/hook', { retries: 3 });

      const result = await hm.executePreToolHooks(
        'Edit',
        'id-4xx',
        { file_path: '/x.ts' },
        execContext
      );
      // 非阻塞错误 → failureBehavior=ignore → allow
      expect(result.decision).toBe('allow');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('重定向被视作配置错误', async () => {
      fetchMock.mockResolvedValueOnce(
        makeResponse('', { status: 302, headers: { Location: 'https://evil.com' } })
      );
      registerHttpHook(hm, 'https://api.example.com/hook');

      const result = await hm.executePreToolHooks(
        'Edit',
        'id-redir',
        { file_path: '/x.ts' },
        execContext
      );
      expect(result.decision).toBe('allow'); // ignore
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('超时', () => {
    it('fetch AbortError 视作超时', async () => {
      fetchMock.mockImplementationOnce(() => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      });
      registerHttpHook(hm, 'https://api.example.com/hook', { timeout: 0.05 });

      const result = await hm.executePreToolHooks(
        'Edit',
        'id-timeout',
        { file_path: '/x.ts' },
        execContext
      );
      // timeoutBehavior=ignore → allow
      expect(result.decision).toBe('allow');
    });
  });
});
