import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type {
  ExecutionContext,
  ToolResult,
  WebFetchMetadata,
} from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/zodSchemas.js';
import { isPlainObject } from 'lodash-es';

function getErrorName(error: unknown): string | undefined {
  if (!isPlainObject(error)) return undefined;
  const obj = error as Record<string, unknown>;
  return typeof obj.name === 'string' ? obj.name : undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (isPlainObject(error)) {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === 'string') return obj.message;
  }
  return String(error);
}

/**
 * Web response result shape
 */
interface WebResponse {
  status: number;
  status_text: string;
  headers?: Record<string, string>;
  body: string;
  url: string;
  redirected?: boolean;
  redirect_count?: number;
  redirect_chain?: string[];
  content_type?: string;
  response_time: number;
}

/**
 * WebFetchTool - Web content fetcher
 * Uses the newer Zod validation design
 */
export const webFetchTool = createTool({
  name: 'WebFetch',
  displayName: 'Web Fetch',
  kind: ToolKind.ReadOnly,
  isConcurrencySafe: true, // 纯读操作，无副作用

  // Zod Schema 定义
  schema: z.object({
    url: z.string().url().describe('URL to request'),
    method: z
      .enum(['GET', 'POST', 'PUT', 'DELETE', 'HEAD'])
      .default('GET')
      .describe('HTTP method'),
    extract_content: z
      .boolean()
      .default(false)
      .describe(
        'Use Jina Reader to extract clean content in Markdown format. Removes HTML clutter, scripts, and styling, returning only the main content.'
      ),
    jina_options: z
      .object({
        with_generated_alt: z
          .boolean()
          .default(false)
          .describe('Generate alt text for images'),
        with_links_summary: z
          .boolean()
          .default(false)
          .describe('Include summary of all links'),
        wait_for_selector: z
          .string()
          .optional()
          .describe('Wait for specific CSS selector to load'),
      })
      .optional()
      .describe(
        'Jina Reader advanced options (only used when extract_content is true)'
      ),
    headers: z.record(z.string()).optional().describe('Request headers (optional)'),
    body: z.string().optional().describe('Request body (optional)'),
    timeout: ToolSchemas.timeout(1000, 120000, 30000),
    follow_redirects: z.boolean().default(true).describe('Follow redirects'),
    max_redirects: z
      .number()
      .int()
      .min(0)
      .max(10)
      .default(5)
      .describe('Maximum redirect hops'),
    return_headers: z.boolean().default(false).describe('Return response headers'),
  }),

  // 工具描述（对齐 Claude Code 官方）
  description: {
    short: 'Fetches content from a specified URL and processes it using an AI model',
    long: `
- Fetches content from a specified URL and processes it using an AI model
- Takes a URL and a prompt as input
- Fetches the URL content, converts HTML to markdown
- Processes the content with the prompt using a small, fast model
- Returns the model's response about the content
- Use this tool when you need to retrieve and analyze web content

Usage notes:
  - IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions. All MCP-provided tools start with "mcp__".
  - The URL must be a fully-formed valid URL
  - HTTP URLs will be automatically upgraded to HTTPS
  - The prompt should describe what information you want to extract from the page
  - This tool is read-only and does not modify any files
  - Results may be summarized if the content is very large
  - Includes a self-cleaning 15-minute cache for faster responses when repeatedly accessing the same URL
  - When a URL redirects to a different host, the tool will inform you and provide the redirect URL in a special format. You should then make a new WebFetch request with the redirect URL to fetch the content.
`,
  },

  // 执行函数
  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const {
      url,
      method = 'GET',
      extract_content = false,
      jina_options,
      headers = {},
      body,
      timeout = 30000,
      follow_redirects = true,
      max_redirects = 5,
      return_headers = false,
    } = params;
    const { updateOutput } = context;
    const signal = context.signal ?? new AbortController().signal;

    try {
      // 如果启用内容提取，使用 Jina Reader
      if (extract_content) {
        try {
          const startTime = Date.now();
          const response = await fetchWithJinaReader({
            url,
            jinaOptions: jina_options,
            timeout,
            signal,
            updateOutput,
          });

          const responseTime = Date.now() - startTime;
          response.response_time = responseTime;

          // 如果不需要返回头部信息，删除它们
          if (!return_headers) {
            delete response.headers;
          }

          const metadata: WebFetchMetadata = {
            url,
            method: 'GET',
            status: response.status,
            response_time: responseTime,
            content_length: Buffer.byteLength(response.body || '', 'utf8'),
            redirected: response.redirected || false,
            redirect_count: response.redirect_count ?? 0,
            final_url: response.url,
            content_type: response.content_type,
            redirect_chain: response.redirect_chain,
          };

          const hostname = safeHostname(url);
          return {
            success: true,
            llmContent: response,
            metadata: {
              ...metadata,
              summary: `GET ${hostname} - ${response.status}`,
            },
          };
        } catch {
          // Jina Reader 失败，回退到直接获取
          updateOutput?.(`[WARN] Jina Reader 失败，使用标准方式获取`);
          // 继续执行下面的标准逻辑
        }
      }

      // 标准获取逻辑
      updateOutput?.(`发送 ${method} 请求到: ${url}`);

      const startTime = Date.now();
      const response = await performRequest({
        url,
        method,
        headers,
        body,
        timeout,
        follow_redirects,
        max_redirects,
        signal,
      });

      const responseTime = Date.now() - startTime;
      response.response_time = responseTime;

      // 如果不需要返回头部信息，删除它们
      if (!return_headers) {
        delete response.headers;
      }

      const metadata: WebFetchMetadata = {
        url,
        method,
        status: response.status,
        response_time: responseTime,
        content_length: Buffer.byteLength(response.body || '', 'utf8'),
        redirected: response.redirected || false,
        redirect_count: response.redirect_count ?? 0,
        final_url: response.url,
        content_type: response.content_type,
        redirect_chain: response.redirect_chain,
      };

      const hostname = safeHostname(url);

      // HTTP错误状态码处理
      if (response.status >= 400) {
        return {
          success: false,
          llmContent: `HTTP error ${response.status}: ${response.status_text}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: `HTTP error ${response.status}: ${response.status_text}`,
            details: {
              ...metadata,
              response_body: response.body,
            },
          },
          metadata: {
            ...metadata,
            summary: `请求失败: HTTP ${response.status} ${response.status_text}`,
          },
        };
      }

      return {
        success: true,
        llmContent: response,
        metadata: {
          ...metadata,
          summary: `${method} ${hostname} - ${response.status}`,
        },
      };
    } catch (error: unknown) {
      if (getErrorName(error) === 'AbortError') {
        return {
          success: false,
          llmContent: 'Request aborted',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: '操作被中止',
          },
          metadata: {
            summary: '请求失败: 操作被中止',
          },
        };
      }

      const message = getErrorMessage(error);
      return {
        success: false,
        llmContent: `Network request failed: ${message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message,
          details: error,
        },
        metadata: {
          summary: `请求失败: ${message}`,
        },
      };
    }
  },

  version: '2.0.0',
  category: '网络工具',
  tags: ['web', 'http', 'fetch', 'request', 'api'],

  /**
   * 提取签名内容：返回 domain:hostname 格式
   * 例如：domain:github.com
   */
  extractSignatureContent: (params) => {
    try {
      const urlObj = new URL(params.url);
      return `domain:${urlObj.hostname}`;
    } catch {
      return params.url;
    }
  },

  /**
   * 抽象权限规则：提取域名通配符
   * 例如：domain:github.com
   */
  abstractPermissionRule: (params) => {
    try {
      const urlObj = new URL(params.url);
      return `domain:${urlObj.hostname}`;
    } catch {
      return '*';
    }
  },
});

/**
 * 执行请求
 */
async function performRequest(options: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeout: number;
  follow_redirects: boolean;
  max_redirects: number;
  signal?: AbortSignal;
}): Promise<WebResponse> {
  const {
    url,
    method,
    headers,
    body,
    timeout,
    follow_redirects,
    max_redirects,
    signal,
  } = options;

  const normalizedHeaders: Record<string, string> = {
    'User-Agent': 'Blade-AI/1.0',
    ...headers,
  };

  let currentUrl = url;
  let currentMethod = method;
  let currentBody = body;
  let redirects = 0;
  const redirectChain: string[] = [];

  while (true) {
    const requestHeaders = { ...normalizedHeaders };
    if (
      currentBody &&
      currentMethod !== 'GET' &&
      currentMethod !== 'HEAD' &&
      !hasHeader(requestHeaders, 'content-type')
    ) {
      requestHeaders['Content-Type'] = 'application/json';
    }

    const response = await fetchWithTimeout(
      currentUrl,
      {
        method: currentMethod,
        headers: requestHeaders,
        body:
          currentBody && currentMethod !== 'GET' && currentMethod !== 'HEAD'
            ? currentBody
            : undefined,
        redirect: 'manual',
      },
      timeout,
      signal
    );

    const location = response.headers.get('location');
    const isRedirectStatus = response.status >= 300 && response.status < 400;
    const shouldFollow =
      follow_redirects && isRedirectStatus && location && redirects < max_redirects;

    if (isRedirectStatus && follow_redirects && !location) {
      throw new Error(`收到状态码 ${response.status} 但响应缺少 Location 头`);
    }

    if (isRedirectStatus && follow_redirects && redirects >= max_redirects) {
      throw new Error(`超过最大重定向次数 (${max_redirects})`);
    }

    if (shouldFollow && location) {
      redirects++;
      const nextUrl = resolveRedirectUrl(location, currentUrl);
      redirectChain.push(`${response.status} -> ${nextUrl}`);

      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          currentMethod !== 'GET' &&
          currentMethod !== 'HEAD')
      ) {
        currentMethod = 'GET';
        currentBody = undefined;
      }

      currentUrl = nextUrl;
      continue;
    }

    const responseBody = await response.text();
    const responseHeaders = headersToObject(response.headers);

    return {
      status: response.status,
      status_text: response.statusText,
      headers: responseHeaders,
      body: responseBody,
      url: response.url || currentUrl,
      redirected: redirects > 0,
      redirect_count: redirects,
      redirect_chain: redirectChain,
      content_type: responseHeaders['content-type'],
      response_time: 0, // 将在外部设置
    };
  }
}

/**
 * 安全地提取 hostname
 */
function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
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
  } catch (error: unknown) {
    if (getErrorName(error) === 'AbortError') {
      if (error instanceof Error) {
        error.message = '请求被中止或超时';
        throw error;
      }
      const wrapped = new Error('请求被中止或超时');
      wrapped.name = 'AbortError';
      throw wrapped;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortListener);
  }
}

function resolveRedirectUrl(location: string, baseUrl: string): string {
  try {
    return new URL(location, baseUrl).toString();
  } catch {
    return location;
  }
}

function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lowered = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lowered);
}

// ============================================================================
// Jina Reader Integration
// ============================================================================

/**
 * Jina Reader 响应格式
 */
interface JinaReaderResponse {
  title: string;
  sourceUrl: string;
  content: string;
}

/**
 * 使用 Jina Reader 提取网页内容
 */
async function fetchWithJinaReader(options: {
  url: string;
  jinaOptions?: {
    with_generated_alt?: boolean;
    with_links_summary?: boolean;
    wait_for_selector?: string;
  };
  timeout: number;
  signal?: AbortSignal;
  updateOutput?: (msg: string) => void;
}): Promise<WebResponse> {
  const { url, jinaOptions, timeout, signal, updateOutput } = options;

  // 构建 Jina Reader URL
  const jinaUrl = `https://r.jina.ai/${encodeURIComponent(url)}`;

  updateOutput?.(`使用 Jina Reader 提取内容: ${url}`);

  // 构建请求头
  const headers: Record<string, string> = {
    'User-Agent': 'Blade-AI/1.0',
    Accept: 'text/markdown',
  };

  if (jinaOptions?.with_generated_alt) {
    headers['X-With-Generated-Alt'] = 'true';
  }
  if (jinaOptions?.with_links_summary) {
    headers['X-With-Links-Summary'] = 'true';
  }
  if (jinaOptions?.wait_for_selector) {
    headers['X-Wait-For-Selector'] = jinaOptions.wait_for_selector;
  }

  try {
    const response = await fetchWithTimeout(
      jinaUrl,
      {
        method: 'GET',
        headers,
      },
      timeout,
      signal
    );

    if (!response.ok) {
      throw new Error(`Jina Reader error: ${response.status} ${response.statusText}`);
    }

    const markdownContent = await response.text();

    // 解析 Jina Reader 响应
    const parsed = parseJinaResponse(markdownContent);

    updateOutput?.(`[OK] Jina Reader 成功提取内容 (${parsed.content.length} 字符)`);

    // 返回标准 WebResponse 格式
    return {
      status: response.status,
      status_text: response.statusText,
      headers: headersToObject(response.headers),
      body: formatJinaContent(parsed),
      url: parsed.sourceUrl || url,
      redirected: false,
      redirect_count: 0,
      content_type: 'text/markdown',
      response_time: 0, // 将在外部设置
    };
  } catch (error) {
    updateOutput?.(`[WARN] Jina Reader 失败，回退到直接获取`);
    throw error; // 让外层处理回退
  }
}

/**
 * 解析 Jina Reader 响应
 */
function parseJinaResponse(text: string): JinaReaderResponse {
  const lines = text.split('\n');
  let title = '';
  let sourceUrl = '';
  let contentStartIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('Title: ')) {
      title = line.substring(7).trim();
    } else if (line.startsWith('URL Source: ')) {
      sourceUrl = line.substring(12).trim();
    } else if (line.startsWith('Markdown Content:')) {
      contentStartIndex = i + 1;
      break;
    }
  }

  const content = lines.slice(contentStartIndex).join('\n').trim();

  return {
    title: title || 'Untitled',
    sourceUrl: sourceUrl || '',
    content: content || text, // 回退到全文
  };
}

/**
 * 格式化 Jina 提取的内容
 */
function formatJinaContent(parsed: JinaReaderResponse): string {
  let formatted = '';

  if (parsed.title) {
    formatted += `# ${parsed.title}\n\n`;
  }

  if (parsed.sourceUrl) {
    formatted += `**Source**: ${parsed.sourceUrl}\n\n`;
  }

  formatted += '---\n\n';
  formatted += parsed.content;

  return formatted;
}
