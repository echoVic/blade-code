import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';

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
  provider: 'duckduckgo';
  total_results: number;
  fetched_at: string;
}

const SEARCH_ENDPOINT = 'https://duckduckgo.com/';
const SEARCH_TIMEOUT = 15000;
const MAX_RESULTS = 8;

export const webSearchTool = createTool({
  name: 'WebSearch',
  displayName: '网络搜索',
  kind: ToolKind.Network,

  schema: z.object({
    query: z
      .string()
      .min(2, '搜索关键词至少需要2个字符')
      .describe('搜索关键词'),
    allowed_domains: z
      .array(z.string().min(1))
      .optional()
      .describe('只返回这些域名下的结果(可选)'),
    blocked_domains: z
      .array(z.string().min(1))
      .optional()
      .describe('排除这些域名下的结果(可选)'),
  }),

  description: {
    short: '执行实时网络搜索，返回结构化的搜索结果列表',
    long: `使用 DuckDuckGo 即时搜索 API 获取最新网页信息。结果包含标题、简介、URL 以及来源域名，可选地根据域名白名单或黑名单过滤。`,
    usageNotes: [
      'Use this tool when需要最新信息或超出模型知识截止日期的数据',
      'Domain filtering is supported via allowed_domains 和 blocked_domains',
      'Web search is only available in the US地区 (使用 kl=us-en 区域参数)',
      'Searches are performed automatically within a single API call，返回结构化结果块',
      'Account for "Today\'s date" in <env> when组织查询关键字，例如请求 2025 年信息时确保查询包含 2025',
    ],
    examples: [
      {
        description: '搜索最新 TypeScript 版本',
        params: {
          query: 'latest TypeScript release',
        },
      },
      {
        description: '只查看官方博客上的模型更新',
        params: {
          query: 'Claude model roadmap',
          allowed_domains: ['anthropic.com'],
        },
      },
      {
        description: '排除维基百科结果',
        params: {
          query: 'Rust ownership guide',
          blocked_domains: ['wikipedia.org'],
        },
      },
    ],
    important: [
      '搜索结果来自公开网络，请自行验证权威性',
      'Blocked/allowed 列表使用域名匹配（支持子域）',
      '网络访问需要获得用户许可',
    ],
  },

  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const { query } = params;
    const allowedDomains = normalizeDomainList(params.allowed_domains);
    const blockedDomains = normalizeDomainList(params.blocked_domains);
    const { updateOutput } = context;
    const signal = context.signal ?? new AbortController().signal;

    updateOutput?.(`🔎 正在搜索: "${query}"`);

    try {
      const response = await fetchWithTimeout(
        buildSearchUrl(query),
        {
          headers: {
            Accept: 'application/json, text/plain;q=0.9',
            'User-Agent': 'Blade-AI-WebSearch/1.0',
          },
        },
        SEARCH_TIMEOUT,
        signal
      );

      if (!response.ok) {
        throw new Error(`搜索请求失败，状态码 ${response.status}`);
      }

      const rawText = await response.text();
      let payload: DuckDuckGoResponse;
      try {
        payload = JSON.parse(rawText) as DuckDuckGoResponse;
      } catch {
        throw new Error('无法解析搜索结果 JSON');
      }

      const combinedResults = transformDuckDuckGoResponse(payload);
      const filteredResults = applyDomainFilters(combinedResults, allowedDomains, blockedDomains);
      const limitedResults = filteredResults.slice(0, MAX_RESULTS);

      const resultPayload: WebSearchPayload = {
        query,
        results: limitedResults,
        provider: 'duckduckgo',
        total_results: filteredResults.length,
        fetched_at: new Date().toISOString(),
      };

      const metadata = {
        query,
        provider: 'duckduckgo',
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
          displayContent: `🔍 WebSearch("${query}") 未找到匹配结果`,
          metadata,
        };
      }

      return {
        success: true,
        llmContent: resultPayload,
        displayContent: formatDisplayResults(query, limitedResults, filteredResults.length),
        metadata,
      };
    } catch (error: any) {
      return {
        success: false,
        llmContent: `WebSearch 调用失败: ${error.message}`,
        displayContent: `❌ WebSearch 调用失败: ${error.message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: error.message,
          details: {
            query,
            allowedDomains,
            blockedDomains,
          },
        },
      };
    }
  },

  version: '1.0.0',
  category: '网络工具',
  tags: ['web', 'search', 'internet', 'news'],

  extractSignatureContent: (params) => `search:${sanitizeQuery(params.query)}`,

  abstractPermissionRule: () => 'search:*',
});

function buildSearchUrl(query: string): string {
  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('no_html', '1');
  url.searchParams.set('skip_disambig', '1');
  url.searchParams.set('t', 'blade-code');
  url.searchParams.set('kl', 'us-en');
  return url.toString();
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeout: number,
  externalSignal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const abortListener = () => controller.abort();
  externalSignal?.addEventListener('abort', abortListener);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new Error('搜索请求超时或被中止');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortListener);
  }
}

function transformDuckDuckGoResponse(data: DuckDuckGoResponse): WebSearchResult[] {
  const directResults = (data.Results ?? [])
    .map((entry) => mapDuckDuckGoResult(entry))
    .filter((entry): entry is WebSearchResult => entry !== null);

  const relatedResults = flattenTopics(data.RelatedTopics ?? []);

  return [...directResults, ...relatedResults];
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
    source: extractHostname(entry.FirstURL) ?? '',
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
        source: extractHostname(topic.FirstURL) ?? '',
      });
    }
  }

  return results;
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

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
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

    if (blockedDomains.length > 0 && blockedDomains.some((domain) => matchesDomain(hostname, domain))) {
      return false;
    }

    if (allowedDomains.length > 0 && !allowedDomains.some((domain) => matchesDomain(hostname, domain))) {
      return false;
    }

    return true;
  });
}

function formatDisplayResults(query: string, results: WebSearchResult[], total: number): string {
  const header = `🔎 WebSearch("${query}") - 返回 ${results.length}/${total} 条结果`;
  const lines = results.map(
    (result, index) =>
      `${index + 1}. ${result.title}\n   ${result.display_url}\n   ${result.snippet}`
  );
  return [header, ...lines].join('\n');
}

function sanitizeQuery(query: string): string {
  const trimmed = query.trim().toLowerCase();
  return trimmed.length > 80 ? trimmed.slice(0, 80) : trimmed;
}
