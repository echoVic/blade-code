import { promises as fs } from 'fs';
import { extname, join, relative, resolve } from 'path';
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
 * Find搜索参数接口
 */
interface FindParams {
  name?: string;
  path?: string;
  type?: 'file' | 'directory' | 'both';
  size_min?: number;
  size_max?: number;
  modified_after?: string;
  modified_before?: string;
  extension?: string;
  case_sensitive?: boolean;
  max_depth?: number;
  max_results?: number;
  exclude_patterns?: string[];
}

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
 * Find工具调用实现
 */
class FindToolInvocation extends BaseToolInvocation<FindParams> {
  constructor(params: FindParams) {
    super('find', params);
  }

  getDescription(): string {
    const { name, path, type } = this.params;
    const searchPath = path || '当前目录';
    const searchType =
      type === 'file' ? '文件' : type === 'directory' ? '目录' : '文件和目录';
    const namePattern = name ? ` 匹配"${name}"` : '';
    return `在 ${searchPath} 中查找${searchType}${namePattern}`;
  }

  getAffectedPaths(): string[] {
    return [this.params.path || process.cwd()];
  }

  async shouldConfirm(): Promise<ConfirmationDetails | null> {
    // 文件查找操作通常不需要确认
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
      } = this.params;

      updateOutput?.(`开始在 ${path} 中查找文件...`);

      // 验证搜索路径存在
      const searchPath = resolve(path);
      try {
        const stats = await fs.stat(searchPath);
        if (!stats.isDirectory()) {
          return this.createErrorResult(`搜索路径必须是目录: ${searchPath}`);
        }
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          return this.createErrorResult(`搜索路径不存在: ${searchPath}`);
        }
        throw error;
      }

      this.checkAbortSignal(signal);

      // 解析时间过滤器
      const modifiedAfter = modified_after ? new Date(modified_after) : undefined;
      const modifiedBefore = modified_before ? new Date(modified_before) : undefined;

      // 执行查找
      const matches = await this.performFind(searchPath, {
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
        exclude_patterns,
        signal,
      });

      const sortedMatches = this.sortMatches(matches);
      const limitedMatches = sortedMatches.slice(0, max_results);

      const metadata: Record<string, any> = {
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
          exclude_patterns,
        },
        total_matches: matches.length,
        returned_matches: limitedMatches.length,
        max_results,
        truncated: matches.length > max_results,
      };

      const displayMessage = this.formatDisplayMessage(metadata);

      return this.createSuccessResult(limitedMatches, displayMessage, metadata);
    } catch (error: any) {
      return this.createErrorResult(error);
    }
  }

  private async performFind(
    searchPath: string,
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
      signal: AbortSignal;
    }
  ): Promise<FindMatch[]> {
    const matches: FindMatch[] = [];

    await this.walkDirectory(searchPath, searchPath, 0, matches, options);

    return matches;
  }

  private async walkDirectory(
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
      signal: AbortSignal;
    }
  ): Promise<void> {
    if (matches.length >= options.max_results || depth > options.max_depth) {
      return;
    }

    options.signal.throwIfAborted();

    try {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        if (matches.length >= options.max_results) {
          break;
        }

        options.signal.throwIfAborted();

        const fullPath = join(currentPath, entry.name);
        const relativePath = relative(basePath, fullPath);

        // 检查排除模式
        if (this.shouldExclude(relativePath, entry.name, options.exclude_patterns)) {
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
        if (
          this.matchesCriteria(
            entry.name,
            fullPath,
            relativePath,
            isDirectory,
            stats,
            fileExtension,
            depth,
            options
          )
        ) {
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
          await this.walkDirectory(fullPath, basePath, depth + 1, matches, options);
        }
      }
    } catch (error: any) {
      // 忽略无权限访问的目录
      if (error.code !== 'EACCES' && error.code !== 'EPERM') {
        throw error;
      }
    }
  }

  private shouldExclude(
    relativePath: string,
    name: string,
    excludePatterns: string[]
  ): boolean {
    for (const pattern of excludePatterns) {
      const regex = this.createGlobRegex(pattern, false);
      if (regex.test(relativePath) || regex.test(name)) {
        return true;
      }
    }
    return false;
  }

  private matchesCriteria(
    name: string,
    fullPath: string,
    relativePath: string,
    isDirectory: boolean,
    stats: any,
    fileExtension: string | undefined,
    depth: number,
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
      signal: AbortSignal;
    }
  ): boolean {
    // 类型过滤
    if (options.type === 'file' && isDirectory) return false;
    if (options.type === 'directory' && !isDirectory) return false;

    // 名称匹配
    if (options.name) {
      const nameRegex = this.createGlobRegex(options.name, options.case_sensitive);
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

  private createGlobRegex(pattern: string, caseSensitive: boolean): RegExp {
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

  private sortMatches(matches: FindMatch[]): FindMatch[] {
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

  private formatDisplayMessage(metadata: Record<string, any>): string {
    const { search_path, search_criteria, total_matches, returned_matches, truncated } =
      metadata;

    let message = `在 ${search_path} 中找到 ${total_matches} 个匹配项`;

    if (truncated) {
      message += `\n显示前 ${returned_matches} 个结果`;
    }

    // 显示搜索条件摘要
    const criteria = [];
    if (search_criteria.name) criteria.push(`名称: ${search_criteria.name}`);
    if (search_criteria.type !== 'both') criteria.push(`类型: ${search_criteria.type}`);
    if (search_criteria.extension)
      criteria.push(`扩展名: ${search_criteria.extension}`);

    if (criteria.length > 0) {
      message += `\n搜索条件: ${criteria.join(', ')}`;
    }

    return message;
  }
}

/**
 * Find高级文件查找工具
 * 提供基于多种条件的文件和目录查找功能
 */
export class FindTool extends DeclarativeTool<FindParams> {
  constructor() {
    const schema: JSONSchema7 = {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '文件/目录名称模式（支持*和?通配符）',
        },
        path: {
          type: 'string',
          description: '搜索路径（可选，默认当前工作目录）',
        },
        type: {
          type: 'string',
          enum: ['file', 'directory', 'both'],
          default: 'both',
          description: '搜索类型：文件、目录或两者',
        },
        size_min: {
          type: 'integer',
          minimum: 0,
          description: '最小文件大小（字节）',
        },
        size_max: {
          type: 'integer',
          minimum: 0,
          description: '最大文件大小（字节）',
        },
        modified_after: {
          type: 'string',
          description: '修改时间晚于指定时间（ISO格式）',
        },
        modified_before: {
          type: 'string',
          description: '修改时间早于指定时间（ISO格式）',
        },
        extension: {
          type: 'string',
          description: '文件扩展名过滤（如 ".js" 或 "js"）',
        },
        case_sensitive: {
          type: 'boolean',
          default: false,
          description: '名称匹配是否区分大小写',
        },
        max_depth: {
          type: 'integer',
          minimum: 0,
          maximum: 20,
          default: 10,
          description: '最大搜索深度',
        },
        max_results: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          default: 100,
          description: '最大返回结果数',
        },
        exclude_patterns: {
          type: 'array',
          items: {
            type: 'string',
          },
          default: [],
          description: '排除模式列表（支持通配符）',
        },
      },
      additionalProperties: false,
    };

    super(
      'find',
      '高级文件查找',
      '基于多种条件（名称、类型、大小、修改时间等）查找文件和目录',
      ToolKind.Search,
      schema,
      false, // 查找操作不需要确认
      '1.0.0',
      '搜索工具',
      ['file', 'search', 'find', 'filter', 'locate']
    );
  }

  build(params: FindParams): ToolInvocation<FindParams> {
    // 验证参数
    let name: string | undefined;
    if (params.name !== undefined) {
      name = this.validateString(params.name, 'name', {
        required: false,
        minLength: 1,
      });
    }

    let path: string | undefined;
    if (params.path !== undefined) {
      path = this.validateString(params.path, 'path', {
        required: false,
        minLength: 1,
      });
    }

    const type = params.type || 'both';
    if (!['file', 'directory', 'both'].includes(type)) {
      this.createValidationError(
        'type',
        '类型必须是 file、directory 或 both 之一',
        type
      );
    }

    let sizeMin: number | undefined;
    if (params.size_min !== undefined) {
      sizeMin = this.validateNumber(params.size_min, 'size_min', {
        min: 0,
        integer: true,
      });
    }

    let sizeMax: number | undefined;
    if (params.size_max !== undefined) {
      sizeMax = this.validateNumber(params.size_max, 'size_max', {
        min: 0,
        integer: true,
      });
    }

    // 验证时间字符串
    let modifiedAfter: string | undefined;
    if (params.modified_after !== undefined) {
      modifiedAfter = this.validateString(params.modified_after, 'modified_after');
      try {
        new Date(modifiedAfter);
      } catch {
        this.createValidationError(
          'modified_after',
          '时间格式无效，请使用ISO格式',
          modifiedAfter
        );
      }
    }

    let modifiedBefore: string | undefined;
    if (params.modified_before !== undefined) {
      modifiedBefore = this.validateString(params.modified_before, 'modified_before');
      try {
        new Date(modifiedBefore);
      } catch {
        this.createValidationError(
          'modified_before',
          '时间格式无效，请使用ISO格式',
          modifiedBefore
        );
      }
    }

    let extension: string | undefined;
    if (params.extension !== undefined) {
      extension = this.validateString(params.extension, 'extension', {
        required: false,
        minLength: 1,
      });
    }

    const caseSensitive = this.validateBoolean(
      params.case_sensitive ?? false,
      'case_sensitive'
    );

    let maxDepth: number = 10;
    if (params.max_depth !== undefined) {
      maxDepth = this.validateNumber(params.max_depth, 'max_depth', {
        min: 0,
        max: 20,
        integer: true,
      });
    }

    let maxResults: number = 100;
    if (params.max_results !== undefined) {
      maxResults = this.validateNumber(params.max_results, 'max_results', {
        min: 1,
        max: 1000,
        integer: true,
      });
    }

    const excludePatterns = this.validateArray(
      params.exclude_patterns || [],
      'exclude_patterns',
      {
        itemValidator: (item: any, index: number) => {
          return this.validateString(item, `exclude_patterns[${index}]`, {
            required: true,
            minLength: 1,
          });
        },
      }
    );

    const validatedParams: FindParams = {
      ...(name !== undefined && { name }),
      ...(path !== undefined && { path }),
      type: type as 'file' | 'directory' | 'both',
      ...(sizeMin !== undefined && { size_min: sizeMin }),
      ...(sizeMax !== undefined && { size_max: sizeMax }),
      ...(modifiedAfter !== undefined && { modified_after: modifiedAfter }),
      ...(modifiedBefore !== undefined && { modified_before: modifiedBefore }),
      ...(extension !== undefined && { extension }),
      case_sensitive: caseSensitive,
      max_depth: maxDepth,
      max_results: maxResults,
      exclude_patterns: excludePatterns,
    };

    return new FindToolInvocation(validatedParams);
  }
}
