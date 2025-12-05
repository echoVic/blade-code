import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/zodSchemas.js';

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

  // Zod Schema 定义
  schema: z.object({
    url: z.string().url().describe('URL to request'),
    method: z
      .enum(['GET', 'POST', 'PUT', 'DELETE', 'HEAD'])
      .default('GET')
      .describe('HTTP method'),
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

      const metadata = {
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

      // HTTP错误状态码处理
      if (response.status >= 400) {
        return {
          success: false,
          llmContent: `HTTP error ${response.status}: ${response.status_text}`,
          displayContent: formatDisplayMessage(response, metadata, true),
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: `HTTP error ${response.status}: ${response.status_text}`,
            details: {
              ...metadata,
              response_body: response.body,
            },
          },
          metadata,
        };
      }

      return {
        success: true,
        llmContent: response,
        displayContent: formatDisplayMessage(response, metadata, false),
        metadata,
      };
    } catch (error: any) {
      if (error.name === 'AbortError') {
        return {
          success: false,
          llmContent: 'Request aborted',
          displayContent: '⚠️ 请求被用户中止',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: '操作被中止',
          },
        };
      }

      return {
        success: false,
        llmContent: `Network request failed: ${error.message}`,
        displayContent: `❌ 网络请求失败: ${error.message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: error.message,
          details: error,
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
      redirectChain.push(`${response.status} → ${nextUrl}`);

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
 * 格式化显示消息
 */
function formatDisplayMessage(
  response: WebResponse,
  metadata: {
    url: string;
    method: string;
    status: number;
    response_time: number;
    content_length: number;
    final_url?: string;
    redirect_count?: number;
    content_type?: string;
  },
  isError: boolean
): string {
  const { url, method, status, response_time, content_length } = metadata;

  let message = isError
    ? `❌ ${method} ${url} - ${status} ${response.status_text}`
    : `✅ ${method} ${url} - ${status} ${response.status_text}`;
  message += `\n响应时间: ${response_time}ms`;
  message += `\n内容长度: ${content_length} 字节`;

  if (metadata.content_type) {
    message += `\nContent-Type: ${metadata.content_type}`;
  }

  if (response.redirected && metadata.final_url && metadata.final_url !== url) {
    message += `\n最终URL: ${metadata.final_url}`;
    if (metadata.redirect_count) {
      message += `\n重定向次数: ${metadata.redirect_count}`;
    }
  }

  const preview = buildBodyPreview(response.body, response.content_type);
  if (preview) {
    message += `\n响应内容:\n${preview}`;
  }

  return message;
}

function buildBodyPreview(body: string, contentType?: string): string {
  if (!body) {
    return '(空响应)';
  }

  if (shouldTreatAsBinary(contentType, body)) {
    return '[binary content omitted]';
  }

  const trimmed = body.trim();
  if (!trimmed) {
    return '(仅包含空白字符)';
  }

  return trimmed.length > 800 ? `${trimmed.slice(0, 800)}...` : trimmed;
}

function shouldTreatAsBinary(contentType?: string, body?: string): boolean {
  if (contentType) {
    const lowered = contentType.toLowerCase();
    const binaryMimePrefixes = [
      'image/',
      'audio/',
      'video/',
      'application/pdf',
      'application/zip',
      'application/octet-stream',
    ];
    if (binaryMimePrefixes.some((prefix) => lowered.startsWith(prefix))) {
      return true;
    }
  }

  if (!body) {
    return false;
  }

  let nonPrintable = 0;
  const sampleLength = Math.min(body.length, 200);
  for (let i = 0; i < sampleLength; i++) {
    const code = body.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) {
      continue;
    }
    if (code < 32 || code > 126) {
      nonPrintable++;
    }
  }

  return nonPrintable / (sampleLength || 1) > 0.3;
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
      error.message = '请求被中止或超时';
      throw error;
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
