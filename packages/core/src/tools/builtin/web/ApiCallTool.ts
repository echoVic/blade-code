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
 * API调用参数接口
 */
interface ApiCallParams {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  query_params?: Record<string, string>;
  body?: any;
  auth?: {
    type: 'bearer' | 'basic' | 'api_key';
    token?: string;
    username?: string;
    password?: string;
    api_key?: string;
    api_key_header?: string;
  };
  timeout?: number;
  parse_response?: boolean;
}

/**
 * API响应结果
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
 * ApiCall工具调用实现
 */
class ApiCallToolInvocation extends BaseToolInvocation<ApiCallParams> {
  constructor(params: ApiCallParams) {
    super('api_call', params);
  }

  getDescription(): string {
    const { url, method = 'GET' } = this.params;
    return `调用API: ${method} ${url}`;
  }

  getAffectedPaths(): string[] {
    return [];
  }

  async shouldConfirm(): Promise<ConfirmationDetails | null> {
    const { url, method = 'GET', body, auth } = this.params;

    const risks = ['将向外部API发送请求'];

    if (method !== 'GET') {
      risks.push(`使用 ${method} 方法可能修改远程数据`);
    }

    if (body) {
      risks.push('请求包含数据内容');
    }

    if (auth) {
      risks.push('请求包含认证信息');
    }

    return {
      type: 'network',
      title: '确认API调用',
      message: `将调用API: ${method} ${url}`,
      risks,
      affectedFiles: [],
    };
  }

  async execute(signal: AbortSignal, updateOutput?: (output: string) => void): Promise<ToolResult> {
    try {
      this.validateParams();
      this.checkAbortSignal(signal);

      const {
        url,
        method = 'GET',
        headers = {},
        query_params,
        body,
        auth,
        timeout = 30000,
        parse_response = true,
      } = this.params;

      // 构建最终URL
      const finalUrl = this.buildUrl(url, query_params);
      updateOutput?.(`调用API: ${method} ${finalUrl}`);

      const startTime = Date.now();
      const response = await this.performApiCall({
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

      const displayMessage = this.formatDisplayMessage(response, metadata);

      // HTTP错误状态码处理
      if (response.status >= 400) {
        return this.createErrorResult(`API调用失败 ${response.status}: ${response.status_text}`, {
          ...metadata,
          response_data: response.data,
        });
      }

      return this.createSuccessResult(response, displayMessage, metadata);
    } catch (error: any) {
      return this.createErrorResult(error);
    }
  }

  private buildUrl(baseUrl: string, queryParams?: Record<string, string>): string {
    if (!queryParams || Object.keys(queryParams).length === 0) {
      return baseUrl;
    }

    const url = new URL(baseUrl);
    Object.entries(queryParams).forEach(([key, value]) => {
      url.searchParams.append(key, value);
    });

    return url.toString();
  }

  private async performApiCall(options: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: any;
    auth?: ApiCallParams['auth'];
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
        this.applyAuthentication(requestHeaders, auth);
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
          if (!requestHeaders['Content-Type']) {
            requestHeaders['Content-Type'] = 'application/json';
          }
        } else {
          fetchOptions.body = JSON.stringify(body);
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

  private applyAuthentication(
    headers: Record<string, string>,
    auth: NonNullable<ApiCallParams['auth']>
  ): void {
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

  private formatDisplayMessage(response: ApiResponse, metadata: any): string {
    const { url, method, status, response_time, content_type } = metadata;

    let message = `API调用成功: ${method} ${url}`;
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
}

/**
 * API调用工具
 * 发送RESTful API请求，支持多种认证方式
 */
export class ApiCallTool extends DeclarativeTool<ApiCallParams> {
  constructor() {
    const schema: JSONSchema7 = {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          format: 'uri',
          description: 'API端点URL',
        },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
          default: 'GET',
          description: 'HTTP方法',
        },
        headers: {
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
          description: '自定义请求头（可选）',
        },
        query_params: {
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
          description: '查询参数（可选）',
        },
        body: {
          description: '请求体数据（可选，支持JSON对象或字符串）',
        },
        auth: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['bearer', 'basic', 'api_key'],
              description: '认证类型',
            },
            token: {
              type: 'string',
              description: 'Bearer token（用于bearer认证）',
            },
            username: {
              type: 'string',
              description: '用户名（用于basic认证）',
            },
            password: {
              type: 'string',
              description: '密码（用于basic认证）',
            },
            api_key: {
              type: 'string',
              description: 'API密钥（用于api_key认证）',
            },
            api_key_header: {
              type: 'string',
              default: 'X-API-Key',
              description: 'API密钥头部名称（可选）',
            },
          },
          required: ['type'],
          description: '认证信息（可选）',
        },
        timeout: {
          type: 'integer',
          minimum: 1000,
          maximum: 120000,
          default: 30000,
          description: '超时时间（毫秒，默认30秒）',
        },
        parse_response: {
          type: 'boolean',
          default: true,
          description: '是否尝试解析JSON响应',
        },
      },
      required: ['url'],
      additionalProperties: false,
    };

    super(
      'api_call',
      'API调用',
      '调用RESTful API，支持多种HTTP方法和认证方式',
      ToolKind.Network,
      schema,
      true, // API调用需要确认
      '1.0.0',
      '网络工具',
      ['api', 'rest', 'http', 'request', 'web_service']
    );
  }

  build(params: ApiCallParams): ToolInvocation<ApiCallParams> {
    // 验证参数
    const url = this.validateString(params.url, 'url', {
      required: true,
      minLength: 1,
    });

    // URL格式验证
    try {
      new URL(url);
    } catch {
      this.createValidationError('url', 'URL格式无效', url);
    }

    const method = params.method || 'GET';
    if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
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

    let queryParams: Record<string, string> | undefined;
    if (params.query_params !== undefined) {
      if (typeof params.query_params !== 'object' || params.query_params === null) {
        this.createValidationError('query_params', '查询参数必须是对象类型', params.query_params);
      }

      queryParams = {};
      for (const [key, value] of Object.entries(params.query_params)) {
        queryParams[key] = this.validateString(value, `query_params.${key}`, { required: true });
      }
    }

    // 验证认证信息
    let auth: ApiCallParams['auth'];
    if (params.auth !== undefined) {
      if (typeof params.auth !== 'object' || params.auth === null) {
        this.createValidationError('auth', '认证信息必须是对象类型', params.auth);
      }

      const authType = params.auth.type;
      if (!['bearer', 'basic', 'api_key'].includes(authType)) {
        this.createValidationError('auth.type', '认证类型无效', authType);
      }

      auth = { type: authType } as ApiCallParams['auth'];

      switch (authType) {
        case 'bearer':
          if (params.auth.token) {
            auth!.token = this.validateString(params.auth.token, 'auth.token', { required: true });
          }
          break;
        case 'basic':
          if (params.auth.username) {
            auth!.username = this.validateString(params.auth.username, 'auth.username', {
              required: true,
            });
          }
          if (params.auth.password) {
            auth!.password = this.validateString(params.auth.password, 'auth.password', {
              required: true,
            });
          }
          break;
        case 'api_key':
          if (params.auth.api_key) {
            auth!.api_key = this.validateString(params.auth.api_key, 'auth.api_key', {
              required: true,
            });
          }
          if (params.auth.api_key_header) {
            auth!.api_key_header = this.validateString(
              params.auth.api_key_header,
              'auth.api_key_header',
              { required: true }
            );
          }
          break;
      }
    }

    let timeout: number | undefined;
    if (params.timeout !== undefined) {
      timeout = this.validateNumber(params.timeout, 'timeout', {
        min: 1000,
        max: 120000,
        integer: true,
      });
    }

    const parseResponse = this.validateBoolean(params.parse_response ?? true, 'parse_response');

    const validatedParams: ApiCallParams = {
      url,
      method: method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
      ...(headers !== undefined && { headers }),
      ...(queryParams !== undefined && { query_params: queryParams }),
      ...(params.body !== undefined && { body: params.body }),
      ...(auth !== undefined && { auth }),
      ...(timeout !== undefined && { timeout }),
      parse_response: parseResponse,
    };

    return new ApiCallToolInvocation(validatedParams);
  }
}
