import { isAbsolute } from 'path';
import { z } from 'zod';

/**
 * 常用的 Zod Schema 工具库
 */
export const ToolSchemas = {
  /**
   * 文件路径 Schema (必须是绝对路径)
   */
  filePath: (options?: { description?: string }) =>
    z
      .string()
      .min(1, '文件路径不能为空')
      .refine((path) => isAbsolute(path), {
        message: '必须是绝对路径',
      })
      .describe(options?.description || '文件绝对路径'),

  /**
   * 文件编码 Schema
   */
  encoding: () =>
    z.enum(['utf8', 'base64', 'binary']).default('utf8').describe('文件编码方式'),

  /**
   * 超时时间 Schema
   */
  timeout: (min = 1000, max = 300000, defaultValue = 30000) =>
    z
      .number()
      .int('必须是整数')
      .min(min, `不能小于 ${min}ms`)
      .max(max, `不能大于 ${max}ms`)
      .default(defaultValue)
      .describe(`超时时间（毫秒，默认 ${defaultValue}ms）`),

  /**
   * 正则表达式模式 Schema
   */
  pattern: (options?: { description?: string }) =>
    z
      .string()
      .min(1, '模式不能为空')
      .describe(options?.description || '正则表达式或 glob 模式'),

  /**
   * Glob 模式 Schema
   */
  glob: (options?: { description?: string }) =>
    z
      .string()
      .min(1, 'Glob 模式不能为空')
      .describe(options?.description || 'Glob 文件匹配模式（如 "*.js", "**/*.ts"）'),

  /**
   * 行号 Schema
   */
  lineNumber: (options?: { min?: number; description?: string }) =>
    z
      .number()
      .int('行号必须是整数')
      .min(options?.min ?? 0, `行号不能小于 ${options?.min ?? 0}`)
      .describe(options?.description || '行号'),

  /**
   * 行数限制 Schema
   */
  lineLimit: (options?: { min?: number; max?: number; description?: string }) =>
    z
      .number()
      .int('行数必须是整数')
      .min(options?.min ?? 1, `行数不能少于 ${options?.min ?? 1}`)
      .max(options?.max ?? 10000, `行数不能超过 ${options?.max ?? 10000}`)
      .describe(options?.description || '读取的行数限制'),

  /**
   * 工作目录 Schema
   */
  workingDirectory: () =>
    z
      .string()
      .min(1, '工作目录不能为空')
      .refine((path) => isAbsolute(path), {
        message: '必须是绝对路径',
      })
      .describe('工作目录绝对路径'),

  /**
   * 环境变量 Schema
   */
  environment: () =>
    z.record(z.string(), z.string()).describe('环境变量键值对').optional(),

  /**
   * 输出模式 Schema
   */
  outputMode: <T extends string>(modes: readonly T[], defaultMode?: T) => {
    const schema = z.enum(modes as [T, ...T[]]);
    return defaultMode ? schema.default(defaultMode) : schema;
  },

  /**
   * 布尔标志 Schema
   */
  flag: (options?: { defaultValue?: boolean; description?: string }) =>
    z
      .boolean()
      .default(options?.defaultValue ?? false)
      .describe(options?.description || '布尔标志'),

  /**
   * URL Schema
   */
  url: (options?: { description?: string }) =>
    z
      .string()
      .url('必须是有效的 URL')
      .describe(options?.description || 'URL 地址'),

  /**
   * 端口号 Schema
   */
  port: () =>
    z
      .number()
      .int('端口号必须是整数')
      .min(1, '端口号不能小于 1')
      .max(65535, '端口号不能大于 65535')
      .describe('端口号'),

  /**
   * 命令字符串 Schema
   */
  command: (options?: { description?: string }) =>
    z
      .string()
      .min(1, '命令不能为空')
      .describe(options?.description || '要执行的命令'),

  /**
   * 会话 ID Schema
   */
  sessionId: () =>
    z
      .string()
      .min(1, '会话 ID 不能为空')
      .uuid('必须是有效的 UUID')
      .optional()
      .describe('会话标识符（UUID）'),

  /**
   * 非负整数 Schema
   */
  nonNegativeInt: (options?: { description?: string }) =>
    z
      .number()
      .int('必须是整数')
      .min(0, '不能为负数')
      .describe(options?.description || '非负整数'),

  /**
   * 正整数 Schema
   */
  positiveInt: (options?: { description?: string }) =>
    z
      .number()
      .int('必须是整数')
      .min(1, '必须大于 0')
      .describe(options?.description || '正整数'),
};
