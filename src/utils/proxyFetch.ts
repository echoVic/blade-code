/**
 * 统一的代理 Fetch 工具
 *
 * 支持 https_proxy/http_proxy 环境变量，让 Blade 在以下场景正常工作：
 * - 企业/公司网络（需要代理才能访问外部服务）
 * - 网络受限地区（改善连接质量）
 * - 调试/抓包（Charles/Fiddler/mitmproxy）
 *
 * 使用 undici 的 ProxyAgent 实现，与 WebSearch 工具保持一致。
 */

import { type Dispatcher, ProxyAgent, fetch as undiciFetch } from 'undici';

function getProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy
  );
}

function getProxyAgent(): ProxyAgent | undefined {
  const proxyUrl = getProxyUrl();

  if (proxyUrl) {
    try {
      return new ProxyAgent(proxyUrl);
    } catch (_error) {
      console.warn(`[proxyFetch] Invalid proxy URL: ${proxyUrl}`);
    }
  }
  return undefined;
}

/**
 * ProxyFetch 选项
 */
export interface ProxyFetchOptions extends RequestInit {
  /** 超时时间（毫秒），默认 30000 */
  timeout?: number;
}

/**
 * 支持代理的 fetch 函数
 *
 * 自动检测并使用 https_proxy/http_proxy 环境变量配置的代理。
 * 如果没有配置代理，则直接使用原生 fetch。
 *
 * @example
 * ```ts
 * import { proxyFetch } from '../utils/proxyFetch.js';
 *
 * // 基本用法（自动使用代理）
 * const response = await proxyFetch('https://api.example.com/data');
 *
 * // 带选项
 * const response = await proxyFetch('https://api.example.com/data', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ key: 'value' }),
 *   timeout: 10000, // 10 秒超时
 * });
 * ```
 */
export async function proxyFetch(
  url: string | URL,
  options: ProxyFetchOptions = {}
): Promise<Response> {
  const { timeout = 30000, signal: externalSignal, ...fetchOptions } = options;

  // 如果外部信号已取消，立即抛出 AbortError（与原生 fetch 行为一致）
  if (externalSignal?.aborted) {
    const error = new DOMException('The operation was aborted.', 'AbortError');
    throw error;
  }

  // 获取代理 agent
  const dispatcher = getProxyAgent();

  // 创建超时控制器
  const controller = new AbortController();
  let isTimeout = false;
  const timer = setTimeout(() => {
    isTimeout = true;
    controller.abort();
  }, timeout);

  // 监听外部信号
  const abortListener = () => controller.abort();
  externalSignal?.addEventListener('abort', abortListener);

  try {
    // 构建 undici 请求选项
    const undiciFetchOptions: Parameters<typeof undiciFetch>[1] = {
      method: fetchOptions.method,
      headers: fetchOptions.headers as Record<string, string> | undefined,
      body: fetchOptions.body as string | Buffer | undefined,
      signal: controller.signal,
      dispatcher: dispatcher as Dispatcher | undefined,
    };

    const response = await undiciFetch(url.toString(), undiciFetchOptions);

    // undici 的 Response 类型与标准 Response 兼容
    return response as unknown as Response;
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      // 区分超时 vs 用户取消
      if (isTimeout) {
        // 超时：抛出带有明确信息的 Error（不是 AbortError）
        throw new Error(`Request timeout after ${timeout}ms`);
      }
      // 用户取消：保持 AbortError，让调用方可以识别
      throw error;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortListener);
  }
}
