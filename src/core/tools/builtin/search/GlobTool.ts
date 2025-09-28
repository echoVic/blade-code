import { promises as fs } from 'fs';
import { resolve, join, relative } from 'path';
import { DeclarativeTool } from '../../base/DeclarativeTool.js';
import { BaseToolInvocation } from '../../base/ToolInvocation.js';
import type { 
  ToolInvocation, 
  ToolResult, 
  JSONSchema7,
  ConfirmationDetails 
} from '../../types/index.js';
import { ToolKind } from '../../types/index.js';

/**
 * Glob搜索参数接口
 */
interface GlobParams {
  pattern: string;
  path?: string;
  max_results?: number;
  include_directories?: boolean;
  case_sensitive?: boolean;
}

/**
 * 文件匹配结果
 */
interface FileMatch {
  path: string;
  relative_path: string;
  is_directory: boolean;
  size?: number;
  modified?: string;
}

/**
 * Glob工具调用实现
 */
class GlobToolInvocation extends BaseToolInvocation<GlobParams> {
  constructor(params: GlobParams) {
    super('glob', params);
  }

  getDescription(): string {
    const { pattern, path } = this.params;
    const searchPath = path || '当前目录';
    return `在 ${searchPath} 中搜索匹配 "${pattern}" 的文件`;
  }

  getAffectedPaths(): string[] {
    return [this.params.path || process.cwd()];
  }

  async shouldConfirm(): Promise<ConfirmationDetails | null> {
    // 文件搜索操作通常不需要确认
    return null;
  }

  async execute(signal: AbortSignal, updateOutput?: (output: string) => void): Promise<ToolResult> {
    try {
      this.validateParams();
      this.checkAbortSignal(signal);

      const { 
        pattern, 
        path = process.cwd(),
        max_results = 100,
        include_directories = false,
        case_sensitive = false
      } = this.params;

      updateOutput?.(`开始在 ${path} 中搜索模式 "${pattern}"...`);
      
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

      // 执行glob搜索
      const matches = await this.performGlobSearch(
        searchPath, 
        pattern, 
        { 
          maxResults: max_results,
          includeDirectories: include_directories,
          caseSensitive: case_sensitive,
          signal
        }
      );

      const sortedMatches = this.sortMatches(matches);
      const limitedMatches = sortedMatches.slice(0, max_results);

      const metadata: Record<string, any> = {
        search_path: searchPath,
        pattern,
        total_matches: matches.length,
        returned_matches: limitedMatches.length,
        max_results,
        include_directories,
        case_sensitive,
        truncated: matches.length > max_results
      };

      const displayMessage = this.formatDisplayMessage(metadata);
      
      return this.createSuccessResult(
        limitedMatches,
        displayMessage,
        metadata
      );

    } catch (error: any) {
      return this.createErrorResult(error);
    }
  }

  private async performGlobSearch(
    searchPath: string,
    pattern: string,
    options: {
      maxResults: number;
      includeDirectories: boolean;
      caseSensitive: boolean;
      signal: AbortSignal;
    }
  ): Promise<FileMatch[]> {
    const matches: FileMatch[] = [];
    const globRegex = this.createGlobRegex(pattern, options.caseSensitive);
    
    await this.walkDirectory(
      searchPath,
      searchPath,
      globRegex,
      matches,
      options
    );

    return matches;
  }

  private async walkDirectory(
    currentPath: string,
    basePath: string,
    globRegex: RegExp,
    matches: FileMatch[],
    options: {
      maxResults: number;
      includeDirectories: boolean;
      caseSensitive: boolean;
      signal: AbortSignal;
    }
  ): Promise<void> {
    if (matches.length >= options.maxResults) {
      return;
    }

    options.signal.throwIfAborted();

    try {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });
      
      for (const entry of entries) {
        if (matches.length >= options.maxResults) {
          break;
        }

        options.signal.throwIfAborted();

        const fullPath = join(currentPath, entry.name);
        const relativePath = relative(basePath, fullPath);
        
        // 检查是否匹配模式
        const isMatch = globRegex.test(relativePath) || globRegex.test(entry.name);
        
        if (entry.isDirectory()) {
          // 如果包含目录且匹配，添加到结果
          if (options.includeDirectories && isMatch) {
            matches.push({
              path: fullPath,
              relative_path: relativePath,
              is_directory: true
            });
          }
          
          // 递归搜索子目录
          await this.walkDirectory(fullPath, basePath, globRegex, matches, options);
        } else if (entry.isFile() && isMatch) {
          // 获取文件信息
          try {
            const stats = await fs.stat(fullPath);
            matches.push({
              path: fullPath,
              relative_path: relativePath,
              is_directory: false,
              size: stats.size,
              modified: stats.mtime.toISOString()
            });
          } catch {
            // 如果无法获取文件信息，仍添加基本信息
            matches.push({
              path: fullPath,
              relative_path: relativePath,
              is_directory: false
            });
          }
        }
      }
    } catch (error: any) {
      // 忽略无权限访问的目录
      if (error.code !== 'EACCES' && error.code !== 'EPERM') {
        throw error;
      }
    }
  }

  private createGlobRegex(pattern: string, caseSensitive: boolean): RegExp {
    // 将glob模式转换为正则表达式
    let regexPattern = pattern
      .replace(/\./g, '\\.')  // 转义点号
      .replace(/\*/g, '[^/]*') // * 匹配除/外的任意字符
      .replace(/\?/g, '[^/]')  // ? 匹配除/外的单个字符
      .replace(/\*\*/g, '.*'); // ** 匹配任意字符包括/

    // 如果模式不以/开头或结尾，允许部分匹配
    if (!pattern.startsWith('/')) {
      regexPattern = '(^|/)' + regexPattern;
    }
    if (!pattern.endsWith('/') && !pattern.includes('.')) {
      regexPattern = regexPattern + '($|/|\\.)';
    }

    const flags = caseSensitive ? '' : 'i';
    return new RegExp(regexPattern, flags);
  }

  private sortMatches(matches: FileMatch[]): FileMatch[] {
    return matches.sort((a, b) => {
      // 首先按类型排序：文件在前，目录在后
      if (a.is_directory !== b.is_directory) {
        return a.is_directory ? 1 : -1;
      }
      
      // 然后按修改时间排序（最新的在前）
      if (a.modified && b.modified) {
        return new Date(b.modified).getTime() - new Date(a.modified).getTime();
      }
      
      // 最后按路径名排序
      return a.relative_path.localeCompare(b.relative_path);
    });
  }

  private formatDisplayMessage(metadata: Record<string, any>): string {
    const { 
      search_path,
      pattern,
      total_matches, 
      returned_matches,
      truncated 
    } = metadata;

    let message = `在 ${search_path} 中找到 ${total_matches} 个匹配 "${pattern}" 的文件`;
    
    if (truncated) {
      message += `\n显示前 ${returned_matches} 个结果`;
    }
    
    return message;
  }
}

/**
 * Glob文件匹配工具
 * 支持文件模式匹配搜索
 */
export class GlobTool extends DeclarativeTool<GlobParams> {
  constructor() {
    const schema: JSONSchema7 = {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob模式字符串（支持*、?、**通配符）'
        },
        path: {
          type: 'string',
          description: '搜索路径（可选，默认当前工作目录）'
        },
        max_results: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          default: 100,
          description: '最大返回结果数'
        },
        include_directories: {
          type: 'boolean',
          default: false,
          description: '是否包含目录'
        },
        case_sensitive: {
          type: 'boolean',
          default: false,
          description: '是否区分大小写'
        }
      },
      required: ['pattern'],
      additionalProperties: false
    };

    super(
      'glob',
      '文件模式匹配',
      '使用glob模式搜索文件和目录，支持通配符匹配',
      ToolKind.Search,
      schema,
      false, // 搜索操作不需要确认
      '1.0.0',
      '搜索工具',
      ['file', 'search', 'glob', 'pattern', 'wildcard']
    );
  }

  build(params: GlobParams): ToolInvocation<GlobParams> {
    // 验证参数
    const pattern = this.validateString(params.pattern, 'pattern', { 
      required: true,
      minLength: 1
    });

    let path: string | undefined;
    if (params.path !== undefined) {
      path = this.validateString(params.path, 'path', { 
        required: false,
        minLength: 1
      });
    }

    let maxResults: number | undefined;
    if (params.max_results !== undefined) {
      maxResults = this.validateNumber(params.max_results, 'max_results', { 
        min: 1,
        max: 1000,
        integer: true
      });
    }

    const includeDirectories = this.validateBoolean(
      params.include_directories ?? false, 
      'include_directories'
    );

    const caseSensitive = this.validateBoolean(
      params.case_sensitive ?? false, 
      'case_sensitive'
    );

    const validatedParams: GlobParams = {
      pattern,
      ...(path !== undefined && { path }),
      ...(maxResults !== undefined && { max_results: maxResults }),
      include_directories: includeDirectories,
      case_sensitive: caseSensitive
    };

    return new GlobToolInvocation(validatedParams);
  }
}