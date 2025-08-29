import type { ToolDefinition } from '../types.js';

/**
 * 时间戳工具
 */
const timestampTool: ToolDefinition = {
  name: 'timestamp',
  description: '获取当前时间戳或转换时间格式',
  version: '1.0.0',
  category: 'utility',
  tags: ['time', 'timestamp', 'date'],
  parameters: {
    operation: {
      type: 'string',
      description: '操作类型',
      enum: ['now', 'parse', 'format'],
      default: 'now',
    },
    input: {
      type: 'string',
      description: '输入时间（用于解析或格式化）',
    },
    format: {
      type: 'string',
      description: '输出格式',
      enum: ['timestamp', 'iso', 'local', 'utc'],
      default: 'timestamp',
    },
  },
  async execute(params) {
    const { operation, input, format } = params;

    try {
      let date: Date;

      switch (operation) {
        case 'now':
          date = new Date();
          break;
        case 'parse':
          if (!input) {
            return {
              success: false,
              error: '解析操作需要提供 input 参数',
            };
          }
          date = new Date(input);
          if (isNaN(date.getTime())) {
            return {
              success: false,
              error: '无法解析的时间格式',
            };
          }
          break;
        case 'format':
          if (!input) {
            return {
              success: false,
              error: '格式化操作需要提供 input 参数',
            };
          }
          date = new Date(input);
          if (isNaN(date.getTime())) {
            return {
              success: false,
              error: '无法解析的时间格式',
            };
          }
          break;
        default:
          return {
            success: false,
            error: `不支持的操作: ${operation}`,
          };
      }

      let result: any;

      switch (format) {
        case 'timestamp':
          result = date.getTime();
          break;
        case 'iso':
          result = date.toISOString();
          break;
        case 'local':
          result = date.toLocaleString();
          break;
        case 'utc':
          result = date.toUTCString();
          break;
        default:
          result = date.getTime();
      }

      return {
        success: true,
        data: {
          operation,
          format,
          result,
          timestamp: date.getTime(),
          iso: date.toISOString(),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `时间处理失败: ${(error as Error).message}`,
      };
    }
  },
};

/**
 * UUID 生成工具
 */
const uuidTool: ToolDefinition = {
  name: 'uuid',
  description: '生成 UUID',
  version: '1.0.0',
  category: 'utility',
  tags: ['uuid', 'id', 'generator'],
  parameters: {
    count: {
      type: 'number',
      description: '生成数量',
      default: 1,
    },
    version: {
      type: 'string',
      description: 'UUID 版本',
      enum: ['v4'],
      default: 'v4',
    },
  },
  async execute(params) {
    const { count, version } = params;

    if (count < 1 || count > 100) {
      return {
        success: false,
        error: '生成数量必须在 1-100 之间',
      };
    }

    try {
      const { randomUUID } = await import('crypto');
      const uuids: string[] = [];

      for (let i = 0; i < count; i++) {
        uuids.push(randomUUID());
      }

      return {
        success: true,
        data: {
          count,
          version,
          uuids: count === 1 ? uuids[0] : uuids,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `UUID 生成失败: ${(error as Error).message}`,
      };
    }
  },
};

/**
 * 随机数生成工具
 */
const randomTool: ToolDefinition = {
  name: 'random',
  description: '生成随机数或随机字符串',
  version: '1.0.0',
  category: 'utility',
  tags: ['random', 'number', 'string'],
  parameters: {
    type: {
      type: 'string',
      description: '随机类型',
      enum: ['number', 'string', 'boolean'],
      default: 'number',
    },
    min: {
      type: 'number',
      description: '最小值（数字类型）',
      default: 0,
    },
    max: {
      type: 'number',
      description: '最大值（数字类型）',
      default: 100,
    },
    length: {
      type: 'number',
      description: '字符串长度',
      default: 8,
    },
    charset: {
      type: 'string',
      description: '字符集',
      enum: ['alphanumeric', 'letters', 'numbers', 'symbols'],
      default: 'alphanumeric',
    },
    count: {
      type: 'number',
      description: '生成数量',
      default: 1,
    },
  },
  async execute(params) {
    const { type, min, max, length, charset, count } = params;

    if (count < 1 || count > 100) {
      return {
        success: false,
        error: '生成数量必须在 1-100 之间',
      };
    }

    try {
      const results: any[] = [];

      for (let i = 0; i < count; i++) {
        let result: any;

        switch (type) {
          case 'number':
            result = Math.floor(Math.random() * (max - min + 1)) + min;
            break;
          case 'string':
            result = generateRandomString(length, charset);
            break;
          case 'boolean':
            result = Math.random() < 0.5;
            break;
          default:
            return {
              success: false,
              error: `不支持的类型: ${type}`,
            };
        }

        results.push(result);
      }

      return {
        success: true,
        data: {
          type,
          count,
          results: count === 1 ? results[0] : results,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `随机生成失败: ${(error as Error).message}`,
      };
    }
  },
};

/**
 * Base64 编码/解码工具
 */
const base64Tool: ToolDefinition = {
  name: 'base64',
  description: 'Base64 编码和解码',
  version: '1.0.0',
  category: 'utility',
  tags: ['base64', 'encode', 'decode'],
  parameters: {
    operation: {
      type: 'string',
      description: '操作类型',
      enum: ['encode', 'decode'],
      required: true,
    },
    input: {
      type: 'string',
      description: '输入文本',
      required: true,
    },
  },
  required: ['operation', 'input'],
  async execute(params) {
    const { operation, input } = params;

    try {
      let result: string;

      switch (operation) {
        case 'encode':
          result = Buffer.from(input, 'utf8').toString('base64');
          break;
        case 'decode':
          result = Buffer.from(input, 'base64').toString('utf8');
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
          length: {
            input: input.length,
            output: result.length,
          },
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Base64 ${operation === 'encode' ? '编码' : '解码'}失败: ${(error as Error).message}`,
      };
    }
  },
};

/**
 * 生成随机字符串
 */
function generateRandomString(length: number, charset: string): string {
  const charsets = {
    alphanumeric: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    letters: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
    numbers: '0123456789',
    symbols: '!@#$%^&*()_+-=[]{}|;:,.<>?',
  };

  const chars = charsets[charset as keyof typeof charsets] || charsets.alphanumeric;
  let result = '';

  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return result;
}

/**
 * 导出所有实用工具
 */
export const utilityTools: ToolDefinition[] = [timestampTool, uuidTool, randomTool, base64Tool];
