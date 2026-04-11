import { type Dispatcher, ProxyAgent, fetch as undiciFetch } from 'undici';
import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type {
  ExecutionContext,
  ToolResult,
  WebSearchMetadata,
} from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { getSearchCache } from './SearchCache.js';
import {
  getAllProviders,
  getProviderCount,
  type SearchProvider,
} from './searchProviders.js';

// ============================================================================
// 类型定义
// ============================================================================

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  display_url: string;
  source: string;
}

interface WebSearchPayload {
  query: string;
  results: WebSearchResult[];
  provider: string;
  total_results: number;
  fetched_at: string;
}

// ============================================================================
// 配置常量
// ============================================================================

const SEARCH_TIMEOUT = 15000; // 15 秒
const MAX_RESULTS = 8;

/** 重试配置 */
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelay: 1000, // 1s -> 2s -> 4s
  maxDelay: 8000,
};

// ============================================================================
// 代理支持
// ============================================================================

/**
 * 获取代理 Agent（如果配置了代理环境变量）
 */
function getProxyAgent(): ProxyAgent | undefined {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy;

  if (proxyUrl) {
    try {
      return new ProxyAgent(proxyUrl);
    } catch (_error) {
      // 代理配置无效，忽略
      console.warn(`Invalid proxy URL: ${proxyUrl}`);
    }
  }
  return undefined;
}

// ============================================================================
// 网络请求函数
// ============================================================================

/**
 * 带超时的 fetch 请求
 */
async function fetchWithTimeout(
  url: string,
  options: { headers: Record<string, string>; method?: string; body?: string },
  timeout: number,
  externalSignal?: AbortSignal,
  dispatcher?: Dispatcher
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const abortListener = () => controller.abort();
  externalSignal?.addEventListener('abort', abortListener);

  try {
    const response = await undiciFetch(url, {
      ...options,
      signal: controller.signal,
      dispatcher,
    });
    return response as unknown as Response;
  } catch (error) {
    const err = error as Error;
    if (err.name === 'AbortError') {
      throw new Error('搜索请求超时或被中止');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortListener);
  }
}

/**
 * 带重试的 fetch 请求（指数退避）
 */
async function fetchWithRetry(
  url: string,
  options: { headers: Record<string, string>; method?: string; body?: string },
  timeout: number,
  signal?: AbortSignal,
  dispatcher?: Dispatcher,
  updateOutput?: (msg: string) => void
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < RETRY_CONFIG.maxRetries; attempt++) {
    try {
      return await fetchWithTimeout(url, options, timeout, signal, dispatcher);
    } catch (error) {
      lastError = error as Error;

      // 如果是用户中止，立即抛出
      if (signal?.aborted) {
        throw error;
      }

      // 如果还有重试机会
      if (attempt < RETRY_CONFIG.maxRetries - 1) {
        const delay = Math.min(
          RETRY_CONFIG.baseDelay * Math.pow(2, attempt),
          RETRY_CONFIG.maxDelay
        );
        updateOutput?.(
          `请求失败，${delay / 1000}s 后重试 (${attempt + 1}/${RETRY_CONFIG.maxRetries})...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

// ============================================================================
// 多提供商故障转移
// ============================================================================

/**
 * 使用单个提供商搜索
 */
async function searchWithProvider(
  provider: SearchProvider,
  query: string,
  timeout: number,
  signal?: AbortSignal,
  dispatcher?: Dispatcher,
  updateOutput?: (msg: string) => void
): Promise<{ results: WebSearchResult[]; providerName: string }> {
  // 检查缓存
  const cache = getSearchCache();
  const cachedResults = cache.get(provider.name, query);

  if (cachedResults) {
    updateOutput?.(`使用缓存结果 (${provider.name})`);
    return {
      results: cachedResults,
      providerName: `${provider.name} (cached)`,
    };
  }

  // 如果提供商有 SDK 搜索函数，优先使用
  if (provider.searchFn) {
    try {
      updateOutput?.(`搜索中 (${provider.name})...`);
      const results = await provider.searchFn(query);

      // 写入缓存
      cache.set(provider.name, query, results);

      return { results, providerName: provider.name };
    } catch (error) {
      const err = error as Error;
      throw new Error(`SDK search failed: ${err.message}`);
    }
  }

  // 否则使用 HTTP 请求（兼容旧提供商）
  updateOutput?.(`搜索中 (${provider.name})...`);

  const url = provider.buildUrl(query);
  const method = provider.method || 'GET';
  const headers = provider.getHeaders();

  // 构建请求选项
  const options: { headers: Record<string, string>; method?: string; body?: string } = {
    headers,
    method,
  };

  // 如果是 POST 请求，添加请求体
  if (method === 'POST' && provider.buildBody) {
    options.body = JSON.stringify(provider.buildBody(query));
  }

  const response = await fetchWithRetry(
    url,
    options,
    timeout,
    signal,
    dispatcher,
    updateOutput
  );

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const rawText = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error('Failed to parse search result JSON');
  }

  const results = provider.parseResponse(data);

  // 写入缓存
  cache.set(provider.name, query, results);

  return { results, providerName: provider.name };
}

/**
 * 多提供商故障转移搜索
 */
async function searchWithFallback(
  query: string,
  timeout: number,
  signal?: AbortSignal,
  updateOutput?: (msg: string) => void
): Promise<{ results: WebSearchResult[]; providerName: string }> {
  const providers = getAllProviders();
  const dispatcher = getProxyAgent();
  const errors: string[] = [];

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];

    // 如果用户中止，立即退出
    if (signal?.aborted) {
      throw new Error('搜索被用户中止');
    }

    try {
      updateOutput?.(`使用 ${provider.name} 搜索...`);
      return await searchWithProvider(
        provider,
        query,
        timeout,
        signal,
        dispatcher,
        updateOutput
      );
    } catch (error) {
      const err = error as Error;
      const errorMsg = `${provider.name}: ${err.message}`;
      errors.push(errorMsg);
      updateOutput?.(`[WARN] ${errorMsg}`);

      // 如果是最后一个提供商，抛出错误
      if (i === providers.length - 1) {
        throw new Error(`所有搜索提供商都失败了:\n${errors.join('\n')}`);
      }

      // 继续尝试下一个提供商
    }
  }

  // 不应该到达这里
  throw new Error('No search providers available');
}

// ============================================================================
// 域名过滤
// ============================================================================

function extractHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function flattenDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

function normalizeDomainList(domains?: string[]): string[] {
  if (!domains || domains.length === 0) {
    return [];
  }
  return domains.map(flattenDomain).filter(Boolean);
}

function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function applyDomainFilters(
  results: WebSearchResult[],
  allowedDomains: string[],
  blockedDomains: string[]
): WebSearchResult[] {
  return results.filter((result) => {
    const hostname = extractHostname(result.url);
    if (!hostname) {
      return false;
    }

    if (
      blockedDomains.length > 0 &&
      blockedDomains.some((domain) => matchesDomain(hostname, domain))
    ) {
      return false;
    }

    if (
      allowedDomains.length > 0 &&
      !allowedDomains.some((domain) => matchesDomain(hostname, domain))
    ) {
      return false;
    }

    return true;
  });
}

// ============================================================================
// 格式化
// ============================================================================

function sanitizeQuery(query: string): string {
  const trimmed = query.trim().toLowerCase();
  return trimmed.length > 80 ? trimmed.slice(0, 80) : trimmed;
}

// ============================================================================
// 工具定义
// ============================================================================

export const webSearchTool = createTool({
  name: 'WebSearch',
  displayName: 'Web Search',
  kind: ToolKind.ReadOnly,
  isConcurrencySafe: true, // 纯读操作，无副作用

  schema: z.object({
    query: z
      .string()
      .min(2, 'Search query must be at least 2 characters')
      .describe('Search query'),
    allowed_domains: z
      .array(z.string().min(1))
      .optional()
      .describe('Return results only from these domains (optional)'),
    blocked_domains: z
      .array(z.string().min(1))
      .optional()
      .describe('Exclude results from these domains (optional)'),
  }),

  description: {
    short: 'Search the web and use the results to inform responses',
    long: `
- Search the web and use the results to inform responses
- Provides up-to-date information for current events and recent data
- Returns search result information formatted as search result blocks, including links as markdown hyperlinks
- Use this tool for accessing information beyond the model's knowledge cutoff
- Searches are performed automatically within a single API call
- **Automatic failover**: Uses multiple search providers (DuckDuckGo, SearXNG) with automatic fallback
- **Retry mechanism**: Automatically retries failed requests with exponential backoff
- **Proxy support**: Respects HTTPS_PROXY/HTTP_PROXY environment variables

CRITICAL REQUIREMENT - You MUST follow this:
  - After answering the user's question, you MUST include a "Sources:" section at the end of your response
  - In the Sources section, list all relevant URLs from the search results as markdown hyperlinks: [Title](URL)
  - This is MANDATORY - never skip including sources in your response
  - Example format:

    [Your answer here]

    Sources:
    - [Source Title 1](https://example.com/1)
    - [Source Title 2](https://example.com/2)

Usage notes:
  - Domain filtering is supported to include or block specific websites

IMPORTANT - Use the correct year in search queries:
  - You MUST use the current year when searching for recent information, documentation, or current events.
  - Example: If the user asks for "latest React docs", search for "React documentation 2025", NOT "React documentation 2024"
`,
  },

  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const { query } = params;
    const allowedDomains = normalizeDomainList(params.allowed_domains);
    const blockedDomains = normalizeDomainList(params.blocked_domains);
    const { updateOutput } = context;
    const signal = context.signal ?? new AbortController().signal;

    updateOutput?.(
      `Searching: "${query}" (${getProviderCount()} providers available)`
    );

    try {
      // 使用多提供商故障转移搜索
      const { results: rawResults, providerName } = await searchWithFallback(
        query,
        SEARCH_TIMEOUT,
        signal,
        updateOutput
      );

      // 应用域名过滤
      const filteredResults = applyDomainFilters(
        rawResults,
        allowedDomains,
        blockedDomains
      );
      const limitedResults = filteredResults.slice(0, MAX_RESULTS);

      const resultPayload: WebSearchPayload = {
        query,
        results: limitedResults,
        provider: providerName,
        total_results: filteredResults.length,
        fetched_at: new Date().toISOString(),
      };

      const metadata: WebSearchMetadata = {
        query,
        provider: providerName,
        fetched_at: resultPayload.fetched_at,
        total_results: filteredResults.length,
        returned_results: limitedResults.length,
        allowed_domains: allowedDomains,
        blocked_domains: blockedDomains,
      };

      if (limitedResults.length === 0) {
        return {
          success: true,
          llmContent: resultPayload,
          metadata: {
            ...metadata,
            summary: `搜索 "${query}" 找到 0 条结果`,
          },
        };
      }

      return {
        success: true,
        llmContent: resultPayload,
        metadata: {
          ...metadata,
          summary: `搜索 "${query}" 找到 ${limitedResults.length} 条结果`,
        },
      };
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        llmContent: `WebSearch call failed: ${err.message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: err.message,
          details: {
            query,
            allowedDomains,
            blockedDomains,
          },
        },
        metadata: {
          summary: `搜索失败: ${err.message}`,
        },
      };
    }
  },

  version: '2.0.0',
  category: '网络工具',
  tags: ['web', 'search', 'internet', 'news'],

  extractSignatureContent: (params) => `search:${sanitizeQuery(params.query)}`,

  abstractPermissionRule: () => 'search:*',
});
