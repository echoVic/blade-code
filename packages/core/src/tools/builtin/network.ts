import type { ToolDefinition } from '../types.js';

/**
 * HTTP 请求工具
 */
const httpRequestTool: ToolDefinition = {
  name: 'http_request',
  description: '发送 HTTP 请求',
  version: '1.0.0',
  category: 'network',
  tags: ['http', 'request', 'api'],
  parameters: {
    url: {
      type: 'string',
      description: '请求 URL',
      required: true,
    },
    method: {
      type: 'string',
      description: 'HTTP 方法',
      enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
      default: 'GET',
    },
    headers: {
      type: 'object',
      description: '请求头',
      default: {},
    },
    body: {
      type: 'string',
      description: '请求体（用于 POST、PUT 等）',
    },
    timeout: {
      type: 'number',
      description: '超时时间（毫秒）',
      default: 10000,
    },
    followRedirects: {
      type: 'boolean',
      description: '是否跟随重定向',
      default: true,
    },
  },
  required: ['url'],
  async execute(params) {
    const { url, method, headers, body, timeout, followRedirects } = params;

    try {
      // 动态导入 axios
      const axios = (await import('axios')).default;

      const config: any = {
        url,
        method: method.toLowerCase(),
        headers: {
          'User-Agent': 'Agent-CLI/1.0.0',
          ...headers,
        },
        timeout,
        validateStatus: () => true, // 接受所有状态码
        maxRedirects: followRedirects ? 5 : 0,
      };

      if (body && ['post', 'put', 'patch'].includes(method.toLowerCase())) {
        config.data = body;

        // 如果没有指定 Content-Type，尝试自动检测
        if (!headers['Content-Type'] && !headers['content-type']) {
          try {
            JSON.parse(body);
            config.headers['Content-Type'] = 'application/json';
          } catch {
            config.headers['Content-Type'] = 'text/plain';
          }
        }
      }

      const startTime = Date.now();
      const response = await axios(config);
      const duration = Date.now() - startTime;

      return {
        success: true,
        data: {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          data: response.data,
          duration,
          url: response.config.url,
          method: response.config.method?.toUpperCase(),
        },
        metadata: {
          requestConfig: {
            url,
            method,
            headers: config.headers,
            timeout,
          },
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: `HTTP 请求失败: ${error.message}`,
        metadata: {
          errorCode: error.code,
          requestConfig: {
            url,
            method,
            headers,
            timeout,
          },
        },
      };
    }
  },
};

/**
 * URL 解析工具
 */
const urlParseTool: ToolDefinition = {
  name: 'url_parse',
  description: '解析 URL 的各个组成部分',
  version: '1.0.0',
  category: 'network',
  tags: ['url', 'parse', 'analysis'],
  parameters: {
    url: {
      type: 'string',
      description: '要解析的 URL',
      required: true,
    },
  },
  required: ['url'],
  async execute(params) {
    const { url } = params;

    try {
      const urlObj = new URL(url);

      // 解析查询参数
      const queryParams: Record<string, string> = {};
      urlObj.searchParams.forEach((value, key) => {
        queryParams[key] = value;
      });

      return {
        success: true,
        data: {
          original: url,
          protocol: urlObj.protocol,
          host: urlObj.host,
          hostname: urlObj.hostname,
          port: urlObj.port || (urlObj.protocol === 'https:' ? '443' : '80'),
          pathname: urlObj.pathname,
          search: urlObj.search,
          hash: urlObj.hash,
          origin: urlObj.origin,
          queryParams,
          isSecure: urlObj.protocol === 'https:',
          isLocalhost: ['localhost', '127.0.0.1', '::1'].includes(urlObj.hostname),
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: `URL 解析失败: ${error.message}`,
      };
    }
  },
};

/**
 * URL 构建工具
 */
const urlBuildTool: ToolDefinition = {
  name: 'url_build',
  description: '构建 URL',
  version: '1.0.0',
  category: 'network',
  tags: ['url', 'build', 'construct'],
  parameters: {
    protocol: {
      type: 'string',
      description: '协议',
      enum: ['http', 'https'],
      default: 'https',
    },
    hostname: {
      type: 'string',
      description: '主机名',
      required: true,
    },
    port: {
      type: 'number',
      description: '端口号',
    },
    pathname: {
      type: 'string',
      description: '路径',
      default: '/',
    },
    queryParams: {
      type: 'object',
      description: '查询参数',
      default: {},
    },
    hash: {
      type: 'string',
      description: 'Hash 片段',
    },
  },
  required: ['hostname'],
  async execute(params) {
    const { protocol, hostname, port, pathname, queryParams, hash } = params;

    try {
      const url = new URL(`${protocol}://${hostname}`);

      if (port) {
        url.port = port.toString();
      }

      if (pathname) {
        url.pathname = pathname;
      }

      if (queryParams && typeof queryParams === 'object') {
        Object.entries(queryParams).forEach(([key, value]) => {
          url.searchParams.set(key, String(value));
        });
      }

      if (hash) {
        url.hash = hash.startsWith('#') ? hash : `#${hash}`;
      }

      return {
        success: true,
        data: {
          url: url.toString(),
          components: {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port,
            pathname: url.pathname,
            search: url.search,
            hash: url.hash,
            origin: url.origin,
          },
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: `URL 构建失败: ${error.message}`,
      };
    }
  },
};

/**
 * JSON 格式化工具
 */
const jsonFormatTool: ToolDefinition = {
  name: 'json_format',
  description: '格式化或压缩 JSON',
  version: '1.0.0',
  category: 'network',
  tags: ['json', 'format', 'parse'],
  parameters: {
    input: {
      type: 'string',
      description: 'JSON 字符串',
      required: true,
    },
    operation: {
      type: 'string',
      description: '操作类型',
      enum: ['format', 'minify', 'validate'],
      default: 'format',
    },
    indent: {
      type: 'number',
      description: '缩进空格数（格式化时）',
      default: 2,
    },
  },
  required: ['input'],
  async execute(params) {
    const { input, operation, indent } = params;

    try {
      const parsed = JSON.parse(input);

      let result: string;

      switch (operation) {
        case 'format':
          result = JSON.stringify(parsed, null, indent);
          break;
        case 'minify':
          result = JSON.stringify(parsed);
          break;
        case 'validate':
          result = '✓ 有效的 JSON';
          break;
        default:
          return {
            success: false,
            error: `不支持的操作: ${operation}`,
          };
      }

      return {
        success: true,
        data: {
          operation,
          input,
          result,
          valid: true,
          size: {
            input: input.length,
            output: result.length,
            reduction: operation === 'minify' ? input.length - result.length : 0,
          },
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: `JSON 处理失败: ${error.message}`,
        data: {
          valid: false,
          input,
        },
      };
    }
  },
};

/**
 * 导出所有网络工具
 */
export const networkTools: ToolDefinition[] = [
  httpRequestTool,
  urlParseTool,
  urlBuildTool,
  jsonFormatTool,
];
 