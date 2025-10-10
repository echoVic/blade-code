import { promises as fs } from 'fs';
import { extname, join, relative, resolve } from 'path';
import { z } from 'zod';
import { getExcludePatterns } from '../../../utils/file-patterns.js';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/zod-schemas.js';

/**
 * Find搜索参数 Schema
 */
const FindParamsSchema = z.object({
  name: z.string().min(1).optional().describe('文件/目录名称模式（支持*和?通配符）'),
  path: z.string().optional().describe('搜索路径（可选，默认当前工作目录）'),
  type: z
    .enum(['file', 'directory', 'both'])
    .default('both')
    .describe('搜索类型：file文件、directory目录或both两者'),
  size_min: ToolSchemas.nonNegativeInt().optional().describe('最小文件大小（字节）'),
  size_max: ToolSchemas.nonNegativeInt().optional().describe('最大文件大小（字节）'),
  modified_after: z.string().optional().describe('修改时间晚于指定时间（ISO格式）'),
  modified_before: z.string().optional().describe('修改时间早于指定时间（ISO格式）'),
  extension: z.string().optional().describe('文件扩展名过滤（如 ".js" 或 "js"）'),
  case_sensitive: z.boolean().default(false).describe('名称匹配是否区分大小写'),
  max_depth: z.number().int().min(0).max(20).default(10).describe('最大搜索深度'),
  max_results: ToolSchemas.positiveInt()
    .max(1000)
    .default(100)
    .describe('最大返回结果数'),
  exclude_patterns: z
    .array(z.string())
    .default([])
    .describe('排除模式列表（支持通配符）'),
});

type FindParams = z.infer<typeof FindParamsSchema>;

/**
 * 文件查找结果
 */
interface FindMatch {
  path: string;
  relative_path: string;
  name: string;
  is_directory: boolean;
  size?: number;
  modified: string;
  extension?: string;
  depth: number;
}

/**
 * 创建glob正则表达式
 */
function createGlobRegex(pattern: string, caseSensitive: boolean): RegExp {
  // 将glob模式转换为正则表达式
  let regexPattern = pattern
    .replace(/\./g, '\\.') // 转义点号
    .replace(/\*/g, '.*') // * 匹配任意字符
    .replace(/\?/g, '.'); // ? 匹配单个字符

  // 完全匹配
  regexPattern = `^${regexPattern}$`;

  const flags = caseSensitive ? '' : 'i';
  return new RegExp(regexPattern, flags);
}

/**
 * 检查是否应该排除
 */
function shouldExclude(
  relativePath: string,
  name: string,
  excludePatterns: string[]
): boolean {
  for (const pattern of excludePatterns) {
    const regex = createGlobRegex(pattern, false);
    if (regex.test(relativePath) || regex.test(name)) {
      return true;
    }
  }
  return false;
}

/**
 * 检查是否匹配搜索条件
 */
function matchesCriteria(
  name: string,
  isDirectory: boolean,
  stats: any,
  fileExtension: string | undefined,
  options: {
    name?: string;
    type: 'file' | 'directory' | 'both';
    size_min?: number;
    size_max?: number;
    modified_after?: Date;
    modified_before?: Date;
    extension?: string;
    case_sensitive: boolean;
  }
): boolean {
  // 类型过滤
  if (options.type === 'file' && isDirectory) return false;
  if (options.type === 'directory' && !isDirectory) return false;

  // 名称匹配
  if (options.name) {
    const nameRegex = createGlobRegex(options.name, options.case_sensitive);
    if (!nameRegex.test(name)) return false;
  }

  // 扩展名匹配
  if (options.extension && !isDirectory) {
    const targetExt = options.extension.startsWith('.')
      ? options.extension
      : `.${options.extension}`;
    if (fileExtension !== targetExt) return false;
  }

  // 文件大小过滤（仅对文件有效）
  if (!isDirectory) {
    if (options.size_min !== undefined && stats.size < options.size_min) return false;
    if (options.size_max !== undefined && stats.size > options.size_max) return false;
  }

  // 修改时间过滤
  const fileModified = stats.mtime;
  if (options.modified_after && fileModified < options.modified_after) return false;
  if (options.modified_before && fileModified > options.modified_before) return false;

  return true;
}

/**
 * 递归遍历目录
 */
async function walkDirectory(
  currentPath: string,
  basePath: string,
  depth: number,
  matches: FindMatch[],
  options: {
    name?: string;
    type: 'file' | 'directory' | 'both';
    size_min?: number;
    size_max?: number;
    modified_after?: Date;
    modified_before?: Date;
    extension?: string;
    case_sensitive: boolean;
    max_depth: number;
    max_results: number;
    exclude_patterns: string[];
    signal?: AbortSignal;
  }
): Promise<void> {
  if (matches.length >= options.max_results || depth > options.max_depth) {
    return;
  }

  options.signal?.throwIfAborted();

  try {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      if (matches.length >= options.max_results) {
        break;
      }

      options.signal?.throwIfAborted();

      const fullPath = join(currentPath, entry.name);
      const relativePath = relative(basePath, fullPath);

      // 检查排除模式
      if (shouldExclude(relativePath, entry.name, options.exclude_patterns)) {
        continue;
      }

      // 获取文件/目录信息
      let stats;
      try {
        stats = await fs.stat(fullPath);
      } catch {
        continue; // 跳过无法访问的文件
      }

      const isDirectory = entry.isDirectory();
      const fileExtension = isDirectory ? undefined : extname(entry.name);

      // 检查是否匹配搜索条件
      if (matchesCriteria(entry.name, isDirectory, stats, fileExtension, options)) {
        matches.push({
          path: fullPath,
          relative_path: relativePath,
          name: entry.name,
          is_directory: isDirectory,
          size: isDirectory ? undefined : stats.size,
          modified: stats.mtime.toISOString(),
          extension: fileExtension,
          depth,
        });
      }

      // 递归搜索子目录
      if (isDirectory && depth < options.max_depth) {
        await walkDirectory(fullPath, basePath, depth + 1, matches, options);
      }
    }
  } catch (error: any) {
    // 忽略无权限访问的目录
    if (error.code !== 'EACCES' && error.code !== 'EPERM') {
      throw error;
    }
  }
}

/**
 * 排序匹配结果
 */
function sortMatches(matches: FindMatch[]): FindMatch[] {
  return matches.sort((a, b) => {
    // 首先按深度排序（浅层优先）
    if (a.depth !== b.depth) {
      return a.depth - b.depth;
    }

    // 然后按类型排序：目录在前，文件在后
    if (a.is_directory !== b.is_directory) {
      return a.is_directory ? -1 : 1;
    }

    // 然后按修改时间排序（最新的在前）
    const aTime = new Date(a.modified).getTime();
    const bTime = new Date(b.modified).getTime();
    if (aTime !== bTime) {
      return bTime - aTime;
    }

    // 最后按名称排序
    return a.name.localeCompare(b.name);
  });
}

/**
 * Find高级文件查找工具
 * 提供基于多种条件的文件和目录查找功能
 */
export const findTool = createTool({
  name: 'find',
  displayName: '高级文件查找',
  kind: ToolKind.Search,
  schema: FindParamsSchema,

  description: {
    short: '基于多种条件（名称、类型、大小、修改时间等）查找文件和目录',
    usageNotes: [
      'path 默认为当前工作目录',
      'name 支持通配符：* 匹配任意字符，? 匹配单个字符',
      'type 可选值：file（仅文件）、directory（仅目录）、both（两者）',
      'size_min 和 size_max 单位为字节，仅对文件有效',
      'modified_after 和 modified_before 使用 ISO 格式时间字符串',
      'extension 可以带点号（.js）或不带（js）',
      'exclude_patterns 支持通配符模式，自动排除常见目录（node_modules, .git等）',
      'max_depth 限制搜索深度，默认10层',
      'max_results 限制返回结果数，默认100个',
    ],
    important: [
      '大型目录树搜索可能耗时较长',
      '无权限访问的目录会被自动跳过',
      '结果按深度、类型、修改时间、名称排序',
    ],
    examples: [
      {
        description: '查找所有TypeScript文件',
        params: {
          name: '*.ts',
          type: 'file',
        },
      },
      {
        description: '查找最近修改的大文件',
        params: {
          type: 'file',
          size_min: 1048576, // 1MB
          max_results: 20,
        },
      },
      {
        description: '查找特定目录下的配置文件',
        params: {
          path: '/path/to/project',
          name: '*.json',
          max_depth: 3,
        },
      },
    ],
  },

  version: '1.0.0',
  category: '搜索工具',
  tags: ['file', 'search', 'find', 'filter', 'locate'],

  async execute(params: FindParams, context: ExecutionContext): Promise<ToolResult> {
    const {
      name,
      path = process.cwd(),
      type = 'both',
      size_min,
      size_max,
      modified_after,
      modified_before,
      extension,
      case_sensitive = false,
      max_depth = 10,
      max_results = 100,
      exclude_patterns = [],
    } = params;
    const { signal, updateOutput } = context;

    updateOutput?.(`开始在 ${path} 中查找文件...`);

    // 验证搜索路径存在
    const searchPath = resolve(path);
    try {
      const stats = await fs.stat(searchPath);
      if (!stats.isDirectory()) {
        throw new Error(`搜索路径必须是目录: ${searchPath}`);
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new Error(`搜索路径不存在: ${searchPath}`);
      }
      throw error;
    }

    if (signal?.aborted) {
      throw new Error('操作已取消');
    }

    // 解析时间过滤器
    const modifiedAfter = modified_after ? new Date(modified_after) : undefined;
    const modifiedBefore = modified_before ? new Date(modified_before) : undefined;

    // 执行查找
    const matches: FindMatch[] = [];
    const finalExcludePatterns = getExcludePatterns(exclude_patterns);

    await walkDirectory(searchPath, searchPath, 0, matches, {
      name,
      type,
      size_min,
      size_max,
      modified_after: modifiedAfter,
      modified_before: modifiedBefore,
      extension,
      case_sensitive,
      max_depth,
      max_results,
      exclude_patterns: finalExcludePatterns,
      signal,
    });

    const sortedMatches = sortMatches(matches);
    const limitedMatches = sortedMatches.slice(0, max_results);
    const truncated = matches.length > max_results;

    const metadata = {
      search_path: searchPath,
      search_criteria: {
        name,
        type,
        size_min,
        size_max,
        modified_after,
        modified_before,
        extension,
        case_sensitive,
        max_depth,
        exclude_patterns: finalExcludePatterns,
      },
      total_matches: matches.length,
      returned_matches: limitedMatches.length,
      max_results,
      truncated,
    };

    const displayMessage = formatDisplayMessage(searchPath, metadata);

    return {
      success: true,
      llmContent: limitedMatches,
      displayContent: displayMessage,
      metadata,
    };
  },
});

/**
 * 格式化显示消息
 */
function formatDisplayMessage(
  searchPath: string,
  metadata: Record<string, unknown>
): string {
  const {
    total_matches,
    returned_matches,
    truncated,
    search_criteria,
  } = metadata as {
    total_matches: number;
    returned_matches: number;
    truncated: boolean;
    search_criteria: {
      name?: string;
      type: string;
      extension?: string;
    };
  };

  let message = `在 ${searchPath} 中找到 ${total_matches} 个匹配项`;

  if (truncated) {
    message += `\n显示前 ${returned_matches} 个结果`;
  }

  // 显示搜索条件摘要
  const criteria = [];
  if (search_criteria.name) criteria.push(`名称: ${search_criteria.name}`);
  if (search_criteria.type !== 'both') criteria.push(`类型: ${search_criteria.type}`);
  if (search_criteria.extension) criteria.push(`扩展名: ${search_criteria.extension}`);

  if (criteria.length > 0) {
    message += `\n搜索条件: ${criteria.join(', ')}`;
  }

  return message;
}
