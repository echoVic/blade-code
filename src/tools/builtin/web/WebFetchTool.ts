import { DeclarativeTool } from '../../base/DeclarativeTool.js';
import { BaseToolInvocation } from '../../base/ToolInvocation.js';
import type {
  ConfirmationDetails,
  JSONSchema7,
  ToolInvocation,
  ToolResult,
} from '../../types/index.js';
import { ToolKind } from '../../types/index.js';

/**
 * Web请求参数接口
 */
interface WebFetchParams {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
  follow_redirects?: boolean;
  max_redirects?: number;
  return_headers?: boolean;
}

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
 * WebFetch工具调用实现
 */
class WebFetchToolInvocation extends BaseToolInvocation<WebFetchParams> {
  constructor(params: WebFetchParams) {
    super('web_fetch', params);
  }

  getDescription(): string {
    const { url, method = 'GET' } = this.params;
    return `${method} 请求: ${url}`;
  }

  getAffectedPaths(): string[] {
    return [];
  }

  async shouldConfirm(): Promise<ConfirmationDetails | null> {
    const { url, method = 'GET', body } = this.params;

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
        affectedFiles: [],
      };
    }

    return null;
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    try {
      this.validateParams();
      this.checkAbortSignal(signal);

      const {
        url,
        method = 'GET',
        headers = {},
        body,
        timeout = 30000,
        follow_redirects = true,
        max_redirects = 5,
        return_headers = false,
      } = this.params;

      updateOutput?.(`发送 ${method} 请求到: ${url}`);

      const startTime = Date.now();
      const response = await this.performRequest({
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

      const displayMessage = this.formatDisplayMessage(response, metadata);

      // HTTP错误状态码处理
      if (response.status >= 400) {
        return this.createErrorResult(
          `HTTP错误 ${response.status}: ${response.status_text}`,
          {
            ...metadata,
            response_body: response.body,
          }
        );
      }

      return this.createSuccessResult(response, displayMessage, metadata);
    } catch (error: any) {
      return this.createErrorResult(error);
    }
  }

  private async performRequest(options: {
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

    // 使用fetch API（Node.js 18+内置支持）
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

  private formatDisplayMessage(response: WebResponse, metadata: any): string {
    const { url, method, status, response_time, content_length } = metadata;

    let message = `${method} ${url} - ${status} ${response.status_text}`;
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
}

/**
 * Web内容获取工具
 * 发送HTTP请求获取网页内容
 */
export class WebFetchTool extends DeclarativeTool<WebFetchParams> {
  constructor() {
    const schema: JSONSchema7 = {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          format: 'uri',
          description: '要请求的URL地址',
        },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD'],
          default: 'GET',
          description: 'HTTP方法',
        },
        headers: {
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
          description: '请求头（可选）',
        },
        body: {
          type: 'string',
          description: '请求体内容（可选）',
        },
        timeout: {
          type: 'integer',
          minimum: 1000,
          maximum: 120000,
          default: 30000,
          description: '超时时间（毫秒，默认30秒）',
        },
        follow_redirects: {
          type: 'boolean',
          default: true,
          description: '是否跟随重定向',
        },
        max_redirects: {
          type: 'integer',
          minimum: 0,
          maximum: 10,
          default: 5,
          description: '最大重定向次数',
        },
        return_headers: {
          type: 'boolean',
          default: false,
          description: '是否返回响应头信息',
        },
      },
      required: ['url'],
      additionalProperties: false,
    };

    super(
      'web_fetch',
      '网页内容获取',
      '发送HTTP请求获取网页或API内容，支持多种HTTP方法和自定义请求头',
      ToolKind.Network,
      schema,
      true, // 网络请求需要确认
      '1.0.0',
      '网络工具',
      ['web', 'http', 'fetch', 'request', 'api']
    );
  }

  build(params: WebFetchParams): ToolInvocation<WebFetchParams> {
    // 验证参数
    const url = this.validateString(params.url, 'url', {
      required: true,
      minLength: 1,
    });

    // 简单的URL格式验证
    try {
      new URL(url);
    } catch {
      this.createValidationError('url', 'URL格式无效', url);
    }

    const method = params.method || 'GET';
    if (!['GET', 'POST', 'PUT', 'DELETE', 'HEAD'].includes(method)) {
      this.createValidationError('method', 'HTTP方法无效', method);
    }

    let headers: Record<string, string> | undefined;
    if (params.headers !== undefined) {
      if (typeof params.headers !== 'object' || params.headers === null) {
        this.createValidationError('headers', '请求头必须是对象类型', params.headers);
      }

      headers = {};
      for (const [key, value] of Object.entries(params.headers)) {
        headers[key] = this.validateString(value, `headers.${key}`, { required: true });
      }
    }

    let body: string | undefined;
    if (params.body !== undefined) {
      body = this.validateString(params.body, 'body', { required: false });
    }

    let timeout: number | undefined;
    if (params.timeout !== undefined) {
      timeout = this.validateNumber(params.timeout, 'timeout', {
        min: 1000,
        max: 120000,
        integer: true,
      });
    }

    const followRedirects = this.validateBoolean(
      params.follow_redirects ?? true,
      'follow_redirects'
    );

    let maxRedirects: number | undefined;
    if (params.max_redirects !== undefined) {
      maxRedirects = this.validateNumber(params.max_redirects, 'max_redirects', {
        min: 0,
        max: 10,
        integer: true,
      });
    }

    const returnHeaders = this.validateBoolean(
      params.return_headers ?? false,
      'return_headers'
    );

    const validatedParams: WebFetchParams = {
      url,
      method: method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD',
      ...(headers !== undefined && { headers }),
      ...(body !== undefined && { body }),
      ...(timeout !== undefined && { timeout }),
      follow_redirects: followRedirects,
      ...(maxRedirects !== undefined && { max_redirects: maxRedirects }),
      return_headers: returnHeaders,
    };

    return new WebFetchToolInvocation(validatedParams);
  }
}
