/**
 * 搜索提供商定义
 *
 * 支持多个免费搜索 API，自动故障转移
 * 当前支持：DuckDuckGo、SearXNG（多实例）
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
  /** 构建搜索 URL */
  buildUrl: (query: string) => string;
  /** 解析响应数据 */
  parseResponse: (data: unknown) => WebSearchResult[];
  /** 获取请求头 */
  getHeaders: () => Record<string, string>;
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

/**
 * DuckDuckGo 搜索提供商（默认）
 */
export const duckDuckGoProvider: SearchProvider = {
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

/**
 * 创建 SearXNG 提供商
 */
export function createSearXNGProvider(instanceUrl: string): SearchProvider {
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
// 提供商管理
// ============================================================================

/**
 * 获取所有可用的搜索提供商
 * 按优先级排序：DuckDuckGo -> SearXNG 实例轮询
 */
export function getAllProviders(): SearchProvider[] {
  return [duckDuckGoProvider, ...SEARXNG_INSTANCES.map(createSearXNGProvider)];
}

/**
 * 获取提供商总数
 */
export function getProviderCount(): number {
  return 1 + SEARXNG_INSTANCES.length;
}
