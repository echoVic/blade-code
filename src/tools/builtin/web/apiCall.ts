import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/zodSchemas.js';

/**
 * API response shape
 */
interface ApiResponse {
  status: number;
  status_text: string;
  headers: Record<string, string>;
  data: any;
  raw_body: string;
  url: string;
  response_time: number;
}

/**
 * ApiCallTool - API caller
 * Uses the newer Zod validation design
 */
export const apiCallTool = createTool({
  name: 'ApiCall',
  displayName: 'API Call',
  kind: ToolKind.Network,

  // Zod Schema 定义
  schema: z.object({
    url: z.string().url().describe('API endpoint URL'),
    method: z
      .enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
      .default('GET')
      .describe('HTTP method'),
    headers: z.record(z.string()).optional().describe('Custom headers (optional)'),
    query_params: z.record(z.string()).optional().describe('Query parameters (optional)'),
    body: z.any().optional().describe('Request body (optional; JSON object or string)'),
    auth: z
      .object({
        type: z.enum(['bearer', 'basic', 'api_key']).describe('Auth type'),
        token: z.string().optional().describe('Bearer token (for bearer auth)'),
        username: z.string().optional().describe('Username (for basic auth)'),
        password: z.string().optional().describe('Password (for basic auth)'),
        api_key: z.string().optional().describe('API key (for api_key auth)'),
        api_key_header: z
          .string()
          .default('X-API-Key')
          .describe('Header name for API key (optional)'),
      })
      .optional()
      .describe('Authentication info (optional)'),
    timeout: ToolSchemas.timeout(1000, 120000, 30000),
    parse_response: z.boolean().default(true).describe('Attempt to parse JSON response'),
  }),

  // 工具描述
  description: {
    short: 'Call RESTful APIs with multiple HTTP methods and auth options',
    long: `Full REST API calling support with Bearer, Basic, or API Key auth. Automatically parses JSON responses and supports query params and request bodies.`,
    usageNotes: [
      'url is required and must be valid',
      'method defaults to GET',
      'Auth types supported: bearer, basic, api_key',
      'query_params are appended to the URL automatically',
      'body accepts JSON objects or strings',
      'parse_response defaults to true to auto-parse JSON',
      'timeout defaults to 30s, max 2 minutes',
    ],
    examples: [
      {
        description: 'Simple GET request',
        params: {
          url: 'https://api.example.com/users',
        },
      },
      {
        description: 'POST request with auth',
        params: {
          url: 'https://api.example.com/data',
          method: 'POST',
          auth: {
            type: 'bearer',
            token: 'your_token_here',
          },
          body: { name: 'test', value: 123 },
        },
      },
      {
        description: 'Request with query params',
        params: {
          url: 'https://api.example.com/search',
          query_params: {
            q: 'query',
            limit: '10',
          },
        },
      },
      {
        description: 'API Key auth',
        params: {
          url: 'https://api.example.com/secure',
          auth: {
            type: 'api_key',
            api_key: 'your_api_key',
            api_key_header: 'X-API-Key',
          },
        },
      },
    ],
    important: [
      'API calls require user approval',
      'HTTP 4xx/5xx responses are treated as errors',
      'Auth data is handled securely',
      'Automatic JSON parsing supported',
    ],
  },

  // 执行函数
  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const {
      url,
      method = 'GET',
      headers = {},
      query_params,
      body,
      auth,
      timeout = 30000,
      parse_response = true,
    } = params;
    const { updateOutput } = context;
    const signal = context.signal ?? new AbortController().signal;

    try {
      // 构建最终URL
      const finalUrl = buildUrl(url, query_params);
      updateOutput?.(`Calling API: ${method} ${finalUrl}`);

      const startTime = Date.now();
      const response = await performApiCall({
        url: finalUrl,
        method,
        headers,
        body,
        auth,
        timeout,
        signal,
      });

      const responseTime = Date.now() - startTime;
      response.response_time = responseTime;

      // 解析响应数据
      if (parse_response && response.raw_body) {
        try {
          response.data = JSON.parse(response.raw_body);
        } catch {
          // 如果不是JSON，保持原始文本
          response.data = response.raw_body;
        }
      } else {
        response.data = response.raw_body;
      }

      const metadata = {
        url: finalUrl,
        method,
        status: response.status,
        response_time: responseTime,
        content_type: response.headers['content-type'] || 'unknown',
        content_length: response.raw_body.length,
        has_auth: !!auth,
      };

      // HTTP错误状态码处理
      if (response.status >= 400) {
        return {
          success: false,
          llmContent: `API call failed ${response.status}: ${response.status_text}`,
          displayContent: formatDisplayMessage(response, metadata, true),
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: `API调用失败 ${response.status}: ${response.status_text}`,
            details: {
              ...metadata,
              response_data: response.data,
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
          llmContent: 'API request aborted',
          displayContent: '⚠️ API请求被用户中止',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: '操作被中止',
          },
        };
      }

      return {
        success: false,
        llmContent: `API request failed: ${error.message}`,
        displayContent: `❌ API请求失败: ${error.message}`,
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
  tags: ['api', 'rest', 'http', 'request', 'web_service'],

  /**
   * 提取签名内容：返回 domain:hostname 格式
   * 例如：domain:api.example.com
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
   * 例如：domain:api.example.com
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
 * 构建 URL
 */
function buildUrl(baseUrl: string, queryParams?: Record<string, string>): string {
  if (!queryParams || Object.keys(queryParams).length === 0) {
    return baseUrl;
  }

  const url = new URL(baseUrl);
  Object.entries(queryParams).forEach(([key, value]) => {
    url.searchParams.append(key, value);
  });

  return url.toString();
}

/**
 * 执行 API 调用
 */
async function performApiCall(options: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: any;
  auth?: any;
  timeout: number;
  signal: AbortSignal;
}): Promise<ApiResponse> {
  const { url, method, headers, body, auth, timeout, signal } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  signal.addEventListener('abort', () => controller.abort());

  try {
    // 构建请求头
    const requestHeaders = {
      'User-Agent': 'Blade-AI/1.0',
      Accept: 'application/json, text/plain, */*',
      ...headers,
    };

    // 处理认证
    if (auth) {
      applyAuthentication(requestHeaders, auth);
    }

    // 构建请求选项
    const fetchOptions: RequestInit = {
      method,
      headers: requestHeaders,
      signal: controller.signal,
    };

    // 处理请求体
    if (body && method !== 'GET' && method !== 'HEAD') {
      if (typeof body === 'string') {
        fetchOptions.body = body;
        if (!requestHeaders['Content-Type' as keyof typeof requestHeaders]) {
          (requestHeaders as Record<string, string>)['Content-Type'] =
            'application/json';
        }
      } else {
        fetchOptions.body = JSON.stringify(body);
        (requestHeaders as Record<string, string>)['Content-Type'] = 'application/json';
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
      data: null, // 将在外部处理
      raw_body: responseBody,
      url: response.url,
      response_time: 0, // 将在外部设置
    };
  } catch (error: any) {
    clearTimeout(timeoutId);

    if (error.name === 'AbortError') {
      throw new Error('API请求被中止或超时');
    }

    throw new Error(`API请求失败: ${error.message}`);
  }
}

/**
 * 应用认证
 */
function applyAuthentication(headers: Record<string, string>, auth: any): void {
  switch (auth.type) {
    case 'bearer':
      if (auth.token) {
        headers['Authorization'] = `Bearer ${auth.token}`;
      }
      break;

    case 'basic':
      if (auth.username && auth.password) {
        const credentials = btoa(`${auth.username}:${auth.password}`);
        headers['Authorization'] = `Basic ${credentials}`;
      }
      break;

    case 'api_key':
      if (auth.api_key) {
        const headerName = auth.api_key_header || 'X-API-Key';
        headers[headerName] = auth.api_key;
      }
      break;
  }
}

/**
 * 格式化显示消息
 */
function formatDisplayMessage(
  response: ApiResponse,
  metadata: {
    url: string;
    method: string;
    status: number;
    response_time: number;
    content_type: string;
  },
  isError: boolean
): string {
  const { url, method, status, response_time, content_type } = metadata;

  let message = isError
    ? `❌ API调用失败: ${method} ${url}`
    : `✅ API调用成功: ${method} ${url}`;
  message += `\n状态码: ${status} ${response.status_text}`;
  message += `\n响应时间: ${response_time}ms`;
  message += `\n内容类型: ${content_type}`;

  // 显示响应数据预览
  if (response.data) {
    let preview: string;
    if (typeof response.data === 'object') {
      preview = JSON.stringify(response.data, null, 2);
      if (preview.length > 1000) {
        preview = preview.substring(0, 1000) + '\n... (响应数据已截断)';
      }
    } else {
      preview = String(response.data);
      if (preview.length > 500) {
        preview = preview.substring(0, 500) + '... (响应内容已截断)';
      }
    }
    message += `\n响应数据:\n${preview}`;
  }

  return message;
}
