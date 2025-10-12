import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type {
  ConfirmationDetails,
  ExecutionContext,
  ToolResult,
} from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/zodSchemas.js';

/**
 * Web响应结果
 */
interface WebResponse {
  status: number;
  status_text: string;
  headers?: Record<string, string>;
  body: string;
  url: string;
  redirected?: boolean;
  response_time: number;
}

/**
 * WebFetchTool - Web 内容获取工具
 * 使用新的 Zod 验证设计
 */
export const webFetchTool = createTool({
  name: 'WebFetch',
  displayName: '网页内容获取',
  kind: ToolKind.Network,

  // Zod Schema 定义
  schema: z.object({
    url: z.string().url().describe('要请求的URL地址'),
    method: z
      .enum(['GET', 'POST', 'PUT', 'DELETE', 'HEAD'])
      .default('GET')
      .describe('HTTP方法'),
    headers: z.record(z.string()).optional().describe('请求头(可选)'),
    body: z.string().optional().describe('请求体内容(可选)'),
    timeout: ToolSchemas.timeout(1000, 120000, 30000),
    follow_redirects: z.boolean().default(true).describe('是否跟随重定向'),
    max_redirects: z
      .number()
      .int()
      .min(0)
      .max(10)
      .default(5)
      .describe('最大重定向次数'),
    return_headers: z.boolean().default(false).describe('是否返回响应头信息'),
  }),

  // 工具描述
  description: {
    short: '发送HTTP请求获取网页或API内容，支持多种HTTP方法和自定义请求头',
    long: `提供灵活的 HTTP 请求功能。支持 GET、POST、PUT、DELETE、HEAD 等方法，可自定义请求头和请求体。支持重定向控制和超时配置。`,
    usageNotes: [
      'url 参数是必需的，必须是有效的 URL',
      'method 默认为 GET',
      '支持自定义请求头(headers)',
      '可配置请求体(body)，适用于 POST/PUT 请求',
      'timeout 默认 30 秒，最长 2 分钟',
      'follow_redirects 默认启用，最多 5 次重定向',
      'return_headers 可控制是否返回响应头',
    ],
    examples: [
      {
        description: '简单 GET 请求',
        params: {
          url: 'https://api.example.com/data',
        },
      },
      {
        description: 'POST 请求带 JSON 数据',
        params: {
          url: 'https://api.example.com/create',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: '{"name":"test"}',
        },
      },
      {
        description: '自定义请求头',
        params: {
          url: 'https://api.example.com/secure',
          headers: {
            Authorization: 'Bearer token123',
            Accept: 'application/json',
          },
        },
      },
      {
        description: '禁用重定向',
        params: {
          url: 'https://example.com',
          follow_redirects: false,
        },
      },
    ],
    important: [
      '外部网络请求需要用户确认',
      'HTTP 4xx/5xx 状态码会返回错误',
      '超时会中止请求',
      '支持 HTTPS',
    ],
  },

  // 需要用户确认(外部网络请求)
  requiresConfirmation: async (params): Promise<ConfirmationDetails | null> => {
    const { url, method = 'GET', body } = params;

    // 检查是否是外部网络请求
    if (!url.startsWith('http://localhost') && !url.startsWith('http://127.0.0.1')) {
      const risks = ['将向外部网站发送网络请求'];

      if (method !== 'GET') {
        risks.push(`使用 ${method} 方法可能修改远程数据`);
      }

      if (body) {
        risks.push('请求包含数据内容');
      }

      return {
        type: 'network',
        title: '确认网络请求',
        message: `将向 ${url} 发送 ${method} 请求`,
        risks,
      };
    }

    return null;
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
    const { signal, updateOutput } = context;

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
        content_length: response.body.length,
        redirected: response.redirected || false,
      };

      // HTTP错误状态码处理
      if (response.status >= 400) {
        return {
          success: false,
          llmContent: `HTTP错误 ${response.status}: ${response.status_text}`,
          displayContent: formatDisplayMessage(response, metadata, true),
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: `HTTP错误 ${response.status}: ${response.status_text}`,
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
          llmContent: '请求被中止',
          displayContent: '⚠️ 请求被用户中止',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: '操作被中止',
          },
        };
      }

      return {
        success: false,
        llmContent: `网络请求失败: ${error.message}`,
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
  signal: AbortSignal;
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

  // 使用fetch API(Node.js 18+内置支持)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  // 合并中止信号
  signal.addEventListener('abort', () => controller.abort());

  try {
    const requestHeaders = {
      'User-Agent': 'Blade-AI/1.0',
      ...headers,
    };

    const fetchOptions: RequestInit = {
      method,
      headers: requestHeaders,
      signal: controller.signal,
      redirect: follow_redirects ? 'follow' : 'manual',
    };

    if (body && method !== 'GET' && method !== 'HEAD') {
      fetchOptions.body = body;
      if (!requestHeaders['Content-Type']) {
        requestHeaders['Content-Type'] = 'application/json';
      }
    }

    const response = await fetch(url, fetchOptions);
    clearTimeout(timeoutId);

    const responseBody = await response.text();
    const responseHeaders: Record<string, string> = {};

    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    return {
      status: response.status,
      status_text: response.statusText,
      headers: responseHeaders,
      body: responseBody,
      url: response.url,
      redirected: response.redirected,
      response_time: 0, // 将在外部设置
    };
  } catch (error: any) {
    clearTimeout(timeoutId);

    if (error.name === 'AbortError') {
      throw new Error('请求被中止或超时');
    }

    throw new Error(`网络请求失败: ${error.message}`);
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
  },
  isError: boolean
): string {
  const { url, method, status, response_time, content_length } = metadata;

  let message = isError
    ? `❌ ${method} ${url} - ${status} ${response.status_text}`
    : `✅ ${method} ${url} - ${status} ${response.status_text}`;
  message += `\n响应时间: ${response_time}ms`;
  message += `\n内容长度: ${content_length} 字符`;

  if (response.redirected) {
    message += `\n最终URL: ${response.url}`;
  }

  // 显示部分响应内容
  if (response.body && response.body.length > 0) {
    const preview =
      response.body.length > 500
        ? response.body.substring(0, 500) + '...'
        : response.body;
    message += `\n响应内容:\n${preview}`;
  }

  return message;
}
