/**
 * proxyFetch 工具函数测试
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { proxyFetch } from '../../../src/utils/proxyFetch.js';

// 保存原始环境变量
const originalEnv = { ...process.env };

describe('proxyFetch', () => {
  beforeEach(() => {
    // 重置环境变量
    process.env.HTTP_PROXY = undefined;
    process.env.HTTPS_PROXY = undefined;
    process.env.http_proxy = undefined;
    process.env.https_proxy = undefined;
  });

  afterEach(() => {
    // 恢复原始环境变量
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe('基本功能', () => {
    it('应该能够发起 GET 请求', async () => {
      const response = await proxyFetch('https://httpbin.org/get');
      // proxyFetch 返回的是 undici 的 Response，它兼容标准 Response
      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);
    });

    it('应该能够发起 POST 请求', async () => {
      const response = await proxyFetch('https://httpbin.org/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: 'data' }),
      });
      expect(response.ok).toBe(true);
    });

    it('应该支持自定义 headers', async () => {
      const response = await proxyFetch('https://httpbin.org/headers', {
        headers: { 'X-Custom-Header': 'test-value' },
      });
      expect(response.ok).toBe(true);
    });
  });

  describe('超时处理', () => {
    it('应该在超时后抛出错误', async () => {
      await expect(
        proxyFetch('https://httpbin.org/delay/10', { timeout: 100 })
      ).rejects.toThrow('Request timeout after 100ms');
    });

    it('应该使用默认超时时间 (30s)', async () => {
      // 使用一个快速请求，确保不会超时
      const response = await proxyFetch('https://httpbin.org/delay/1');
      expect(response.ok).toBe(true);
    });
  });

  describe('AbortSignal', () => {
    it('应该支持外部 AbortSignal', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        proxyFetch('https://httpbin.org/get', { signal: controller.signal })
      ).rejects.toThrow('The operation was aborted.');
    });
  });

  describe('代理支持', () => {
    it('应该正确处理 HTTPS_PROXY 环境变量', async () => {
      process.env.HTTPS_PROXY = 'http://proxy.example.com:8080';

      // 这个测试只是验证代码不会因为无效代理 URL 而崩溃
      // 实际的代理连接需要在有代理服务器的环境中测试
      // 在没有实际代理的情况下，请求会失败，但不应该因为代理配置而崩溃
      await expect(
        proxyFetch('https://httpbin.org/get')
      ).rejects.toThrow();
    });

    it('应该正确处理 HTTP_PROXY 环境变量', async () => {
      process.env.HTTP_PROXY = 'http://proxy.example.com:8080';

      // 同样的，只是验证代码不会崩溃
      await expect(
        proxyFetch('https://httpbin.org/get')
      ).rejects.toThrow();
    });
  });

  describe('错误处理', () => {
    it('应该处理网络错误', async () => {
      await expect(
        proxyFetch('https://this-domain-does-not-exist-12345.com')
      ).rejects.toThrow();
    });

    it('应该处理无效的 URL', async () => {
      await expect(
        proxyFetch('not-a-valid-url')
      ).rejects.toThrow();
    });
  });

  describe('选项传递', () => {
    it('应该支持 fetch 标准选项', async () => {
      const response = await proxyFetch('https://httpbin.org/put', {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: 'test data',
      });
      expect(response.ok).toBe(true);
    });

    it('应该处理 JSON 响应', async () => {
      const response = await proxyFetch('https://httpbin.org/json');
      const data = await response.json();
      expect(data).toBeDefined();
      expect(typeof data).toBe('object');
    });

    it('应该处理文本响应', async () => {
      const response = await proxyFetch('https://httpbin.org/robots.txt');
      const text = await response.text();
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    });
  });
});
