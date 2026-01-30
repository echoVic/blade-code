/**
 * 搜索提供商定义
 *
 * 支持多个免费搜索 API，自动故障转移
 * 当前支持：Exa (MCP)、DuckDuckGo、SearXNG（多实例）
 */

import type { WebSearchResult } from './webSearch.js';

/**
 * 搜索提供商接口
 */
export interface SearchProvider {
  /** 提供商名称（用于日志显示） */
  name: string;
  /** API 端点 */
  endpoint: string;
  /** HTTP 方法（GET 或 POST） */
  method?: 'GET' | 'POST';
  /** 构建搜索 URL */
  buildUrl: (query: string) => string;
  /** 构建 POST 请求体（仅当 method 为 POST 时使用） */
  buildBody?: (query: string) => Record<string, unknown>;
  /** 解析响应数据 */
  parseResponse: (data: unknown) => WebSearchResult[];
  /** 获取请求头 */
  getHeaders: () => Record<string, string>;
  /** 可选的 SDK 搜索函数（优先使用，绕过 HTTP 请求） */
  searchFn?: (query: string) => Promise<WebSearchResult[]>;
}

// ============================================================================
// DuckDuckGo 提供商
// ============================================================================

interface DuckDuckGoResult {
  FirstURL?: string;
  Text?: string;
  Result?: string;
}

interface DuckDuckGoTopic extends DuckDuckGoResult {
  Topics?: DuckDuckGoTopic[];
}

interface DuckDuckGoResponse {
  Results?: DuckDuckGoResult[];
  RelatedTopics?: DuckDuckGoTopic[];
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTitleAndSnippet(rawText: string): { title: string; snippet: string } {
  const decoded = decodeHtmlEntities(rawText).trim();
  if (!decoded.includes(' - ')) {
    return { title: decoded, snippet: decoded };
  }

  const [maybeTitle, ...rest] = decoded.split(' - ');
  const title = maybeTitle.trim();
  const snippet = rest.join(' - ').trim() || decoded;
  return { title, snippet };
}

function formatDisplayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.hostname}${path}`;
  } catch {
    return url;
  }
}

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function mapDuckDuckGoResult(entry: DuckDuckGoResult): WebSearchResult | null {
  if (!entry.FirstURL || !entry.Text) {
    return null;
  }

  const { title, snippet } = extractTitleAndSnippet(entry.Text);

  return {
    title,
    snippet,
    url: entry.FirstURL,
    display_url: formatDisplayUrl(entry.FirstURL),
    source: extractHostname(entry.FirstURL),
  };
}

function flattenTopics(topics: DuckDuckGoTopic[]): WebSearchResult[] {
  const results: WebSearchResult[] = [];

  for (const topic of topics) {
    if (topic.Topics && topic.Topics.length > 0) {
      results.push(...flattenTopics(topic.Topics));
      continue;
    }

    if (topic.FirstURL && topic.Text) {
      const { title, snippet } = extractTitleAndSnippet(topic.Text);
      results.push({
        title,
        snippet,
        url: topic.FirstURL,
        display_url: formatDisplayUrl(topic.FirstURL),
        source: extractHostname(topic.FirstURL),
      });
    }
  }

  return results;
}

function transformDuckDuckGoResponse(data: unknown): WebSearchResult[] {
  const response = data as DuckDuckGoResponse;

  const directResults = (response.Results ?? [])
    .map((entry) => mapDuckDuckGoResult(entry))
    .filter((entry): entry is WebSearchResult => entry !== null);

  const relatedResults = flattenTopics(response.RelatedTopics ?? []);

  return [...directResults, ...relatedResults];
}

const duckDuckGoProvider: SearchProvider = {
  name: 'DuckDuckGo',
  endpoint: 'https://duckduckgo.com/',
  buildUrl: (query: string) => {
    const url = new URL('https://duckduckgo.com/');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('no_html', '1');
    url.searchParams.set('skip_disambig', '1');
    url.searchParams.set('t', 'blade-code');
    url.searchParams.set('kl', 'us-en');
    return url.toString();
  },
  parseResponse: transformDuckDuckGoResponse,
  getHeaders: () => ({
    Accept: 'application/json, text/plain;q=0.9',
    'User-Agent': 'Blade-AI-WebSearch/1.0',
  }),
};

// ============================================================================
// SearXNG 提供商
// ============================================================================

interface SearXNGResult {
  url?: string;
  title?: string;
  content?: string;
  engine?: string;
}

interface SearXNGResponse {
  results?: SearXNGResult[];
}

function transformSearXNGResponse(data: unknown): WebSearchResult[] {
  const response = data as SearXNGResponse;
  const results: WebSearchResult[] = [];

  for (const item of response.results ?? []) {
    if (!item.url || !item.title) {
      continue;
    }

    results.push({
      title: item.title,
      snippet: item.content || item.title,
      url: item.url,
      display_url: formatDisplayUrl(item.url),
      source: extractHostname(item.url),
    });
  }

  return results;
}

/**
 * SearXNG 公共实例列表
 * 这些实例都是开源社区维护的，可能会有变化
 * 参考：https://searx.space/
 */
const SEARXNG_INSTANCES = [
  'https://searx.be',
  'https://search.ononoki.org',
  'https://searx.tiekoetter.com',
  'https://searx.work',
];

function createSearXNGProvider(instanceUrl: string): SearchProvider {
  const hostname = (() => {
    try {
      return new URL(instanceUrl).hostname;
    } catch {
      return instanceUrl;
    }
  })();

  return {
    name: `SearXNG(${hostname})`,
    endpoint: instanceUrl,
    buildUrl: (query: string) => {
      const url = new URL(`${instanceUrl}/search`);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('categories', 'general');
      return url.toString();
    },
    parseResponse: transformSearXNGResponse,
    getHeaders: () => ({
      Accept: 'application/json',
      'User-Agent': 'Blade-AI-WebSearch/1.0',
    }),
  };
}

// ============================================================================
// Exa 提供商（使用公开 MCP 端点）
// ============================================================================

const EXA_MCP_CONFIG = {
  BASE_URL: 'https://mcp.exa.ai',
  ENDPOINT: '/mcp',
  DEFAULT_NUM_RESULTS: 10,
  TIMEOUT: 25000, // 25秒超时
} as const;

interface McpSearchRequest {
  jsonrpc: string;
  id: number;
  method: string;
  params: {
    name: string;
    arguments: {
      query: string;
      numResults?: number;
      type?: 'auto' | 'fast' | 'deep';
      contextMaxCharacters?: number;
    };
  };
}

interface McpSearchResponse {
  jsonrpc: string;
  result: {
    content: Array<{
      type: string;
      text: string;
    }>;
  };
}

/**
 * 解析 Exa MCP 响应为标准搜索结果
 */
function parseExaMcpResponse(text: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];

  // Exa MCP 返回的实际格式：
  // Title: xxx
  // Published Date: xxx (optional)
  // URL: xxx
  // Text: xxx
  //
  // Title: xxx
  // URL: xxx
  // Text: xxx

  const lines = text.split('\n');
  let currentResult: Partial<WebSearchResult> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('Title: ')) {
      // 保存上一个结果
      if (currentResult.title && currentResult.url) {
        results.push({
          title: currentResult.title,
          url: currentResult.url,
          snippet: currentResult.snippet || currentResult.title,
          display_url: formatDisplayUrl(currentResult.url),
          source: extractHostname(currentResult.url),
        });
      }

      // 开始新结果
      currentResult = {
        title: line.substring(7).trim(),
        snippet: '',
      };
    } else if (line.startsWith('URL: ')) {
      currentResult.url = line.substring(5).trim();
    } else if (line.startsWith('Text: ')) {
      // Text 后面的内容作为摘要（截取前300字符）
      const textContent = line.substring(6).trim();
      // 移除 HTML 标签和多余空白
      const cleanText = textContent
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      currentResult.snippet = cleanText.substring(0, 300);
    }
    // 跳过 Published Date 等其他字段
  }

  // 保存最后一个结果
  if (currentResult.title && currentResult.url) {
    results.push({
      title: currentResult.title,
      url: currentResult.url,
      snippet: currentResult.snippet || currentResult.title,
      display_url: formatDisplayUrl(currentResult.url),
      source: extractHostname(currentResult.url),
    });
  }

  return results;
}

/**
 * 创建 Exa MCP 提供商（无需 API key）
 */
function createExaProvider(): SearchProvider {
  return {
    name: 'Exa',
    endpoint: `${EXA_MCP_CONFIG.BASE_URL}${EXA_MCP_CONFIG.ENDPOINT}`,

    // 使用 MCP 搜索函数
    searchFn: async (query: string): Promise<WebSearchResult[]> => {
      const searchRequest: McpSearchRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'web_search_exa',
          arguments: {
            query,
            type: 'auto',
            numResults: EXA_MCP_CONFIG.DEFAULT_NUM_RESULTS,
            contextMaxCharacters: 10000,
          },
        },
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        EXA_MCP_CONFIG.TIMEOUT
      );

      try {
        const response = await fetch(
          `${EXA_MCP_CONFIG.BASE_URL}${EXA_MCP_CONFIG.ENDPOINT}`,
          {
            method: 'POST',
            headers: {
              accept: 'application/json, text/event-stream',
              'content-type': 'application/json',
            },
            body: JSON.stringify(searchRequest),
            signal: controller.signal,
          }
        );

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`MCP error (${response.status})`);
        }

        const responseText = await response.text();

        // 解析 SSE 响应
        const lines = responseText.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data: McpSearchResponse = JSON.parse(line.substring(6));
            if (
              data.result &&
              data.result.content &&
              data.result.content.length > 0
            ) {
              return parseExaMcpResponse(data.result.content[0].text);
            }
          }
        }

        throw new Error('No search results found');
      } catch (error) {
        clearTimeout(timeoutId);

        if ((error as Error).name === 'AbortError') {
          throw new Error('MCP request timed out');
        }

        throw error;
      }
    },

    // 兼容性字段
    buildUrl: () => `${EXA_MCP_CONFIG.BASE_URL}${EXA_MCP_CONFIG.ENDPOINT}`,
    parseResponse: () => [],
    getHeaders: () => ({}),
  };
}

// ============================================================================
// 提供商管理
// ============================================================================

/**
 * 获取所有可用的搜索提供商
 * 按优先级排序：Exa (MCP) -> DuckDuckGo -> SearXNG 实例轮询
 */
export function getAllProviders(): SearchProvider[] {
  const providers: SearchProvider[] = [];

  // 1. Exa（使用公开 MCP 端点，无需 API key）
  providers.push(createExaProvider());

  // 2. DuckDuckGo（免费，无需 API key）
  providers.push(duckDuckGoProvider);

  // 3. SearXNG 实例（免费，但不稳定）
  providers.push(...SEARXNG_INSTANCES.map(createSearXNGProvider));

  return providers;
}

/**
 * 获取提供商总数
 */
export function getProviderCount(): number {
  return 1 + 1 + SEARXNG_INSTANCES.length; // Exa + DuckDuckGo + SearXNG
}
