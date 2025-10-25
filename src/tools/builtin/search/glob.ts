import { promises as fs } from 'fs';
import { join, relative, resolve } from 'path';
import { z } from 'zod';
import { FileFilter } from '../../../utils/filePatterns.js';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/zodSchemas.js';

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
 * GlobTool - 文件模式匹配工具
 * 使用新的 Zod 验证设计
 */
export const globTool = createTool({
  name: 'Glob',
  displayName: '文件模式匹配',
  kind: ToolKind.Search,

  // Zod Schema 定义
  schema: z.object({
    pattern: ToolSchemas.glob({
      description: 'Glob 模式字符串（支持 *, ?, ** 通配符）',
    }),
    path: z.string().optional().describe('搜索路径（可选，默认当前工作目录）'),
    max_results: ToolSchemas.positiveInt({
      description: '最大返回结果数',
    })
      .max(1000, '最多返回 1000 个结果')
      .default(100),
    include_directories: z.boolean().default(false).describe('是否在结果中包含目录'),
    case_sensitive: z.boolean().default(false).describe('是否区分大小写'),
  }),

  // 工具描述
  description: {
    short: '使用 glob 模式搜索文件和目录，支持通配符匹配',
    long: `提供快速的文件模式匹配功能，支持标准 glob 通配符。自动排除 .git、node_modules 等常见目录。`,
    usageNotes: [
      '支持通配符：* 匹配任意字符（不含/），** 匹配任意字符（含/），? 匹配单个字符',
      'pattern 示例：*.js, **/*.ts, src/**/*.tsx',
      '默认搜索当前工作目录，可通过 path 参数指定搜索路径',
      '自动排除 .git, node_modules, dist, build 等目录',
      '结果按修改时间排序（最新的在前）',
      'max_results 默认 100，最多 1000',
      '默认不包含目录，只返回文件',
    ],
    examples: [
      {
        description: '搜索所有 JavaScript 文件',
        params: { pattern: '*.js' },
      },
      {
        description: '搜索所有 TypeScript 文件（递归）',
        params: { pattern: '**/*.ts' },
      },
      {
        description: '在特定目录中搜索',
        params: {
          pattern: '*.json',
          path: '/path/to/search',
        },
      },
      {
        description: '搜索并包含目录',
        params: {
          pattern: 'src/**',
          include_directories: true,
        },
      },
    ],
    important: [
      'Glob 匹配区分大小写（除非设置 case_sensitive: false）',
      '** 通配符可以匹配多级目录',
      '搜索大型目录树时建议设置 max_results 限制',
      '自动遵循 .gitignore 规则',
    ],
  },

  // 执行函数
  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const {
      pattern,
      path = process.cwd(),
      max_results,
      include_directories,
      case_sensitive,
    } = params;
    const { signal, updateOutput } = context;

    try {
      updateOutput?.(`开始在 ${path} 中搜索模式 "${pattern}"...`);

      // 验证搜索路径存在
      const searchPath = resolve(path);
      try {
        const stats = await fs.stat(searchPath);
        if (!stats.isDirectory()) {
          return {
            success: false,
            llmContent: `搜索路径必须是目录: ${searchPath}`,
            displayContent: `❌ 搜索路径必须是目录: ${searchPath}`,
            error: {
              type: ToolErrorType.VALIDATION_ERROR,
              message: '搜索路径必须是目录',
            },
          };
        }
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          return {
            success: false,
            llmContent: `搜索路径不存在: ${searchPath}`,
            displayContent: `❌ 搜索路径不存在: ${searchPath}`,
            error: {
              type: ToolErrorType.EXECUTION_ERROR,
              message: '搜索路径不存在',
            },
          };
        }
        throw error;
      }

      signal.throwIfAborted();

      // 创建文件过滤器
      const fileFilter = new FileFilter({
        cwd: searchPath,
        useGitignore: true,
        useDefaults: true,
      });

      // 执行 glob 搜索
      const matches = await performGlobSearch(
        searchPath,
        pattern,
        {
          maxResults: max_results,
          includeDirectories: include_directories,
          caseSensitive: case_sensitive,
          signal,
        },
        fileFilter
      );

      const sortedMatches = sortMatches(matches);
      const limitedMatches = sortedMatches.slice(0, max_results);

      const metadata: Record<string, any> = {
        search_path: searchPath,
        pattern,
        total_matches: matches.length,
        returned_matches: limitedMatches.length,
        max_results,
        include_directories,
        case_sensitive,
        truncated: matches.length > max_results,
      };

      const displayMessage = formatDisplayMessage(metadata);

      // 为 LLM 生成更友好的文本格式
      const llmFriendlyText =
        limitedMatches.length > 0
          ? `Found ${limitedMatches.length} file(s) matching "${pattern}":\n\n` +
            limitedMatches.map((m) => `- ${m.relative_path}`).join('\n') +
            '\n\nUse the relative_path values above for Read/Edit operations.'
          : `No files found matching "${pattern}"`;

      return {
        success: true,
        llmContent: llmFriendlyText,
        displayContent: displayMessage,
        metadata: {
          ...metadata,
          matches: limitedMatches, // 保留原始数据在 metadata 中
        },
      };
    } catch (error: any) {
      if (error.name === 'AbortError') {
        return {
          success: false,
          llmContent: '文件搜索被中止',
          displayContent: '⚠️ 文件搜索被用户中止',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: '操作被中止',
          },
        };
      }

      return {
        success: false,
        llmContent: `搜索失败: ${error.message}`,
        displayContent: `❌ 搜索失败: ${error.message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: error.message,
          details: error,
        },
      };
    }
  },

  version: '2.0.0',
  category: '搜索工具',
  tags: ['file', 'search', 'glob', 'pattern', 'wildcard'],

  /**
   * 提取签名内容：返回 glob 模式
   */
  extractSignatureContent: (params) => params.pattern,

  /**
   * 抽象权限规则：返回通配符模式
   */
  abstractPermissionRule: () => '*',
});

/**
 * 执行 glob 搜索
 */
async function performGlobSearch(
  searchPath: string,
  pattern: string,
  options: {
    maxResults: number;
    includeDirectories: boolean;
    caseSensitive: boolean;
    signal: AbortSignal;
  },
  fileFilter: FileFilter
): Promise<FileMatch[]> {
  const matches: FileMatch[] = [];
  const globRegex = createGlobRegex(pattern, options.caseSensitive);

  await walkDirectory(searchPath, searchPath, globRegex, matches, options, fileFilter);

  return matches;
}

/**
 * 递归遍历目录
 */
async function walkDirectory(
  currentPath: string,
  basePath: string,
  globRegex: RegExp,
  matches: FileMatch[],
  options: {
    maxResults: number;
    includeDirectories: boolean;
    caseSensitive: boolean;
    signal: AbortSignal;
  },
  fileFilter: FileFilter
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

      if (entry.isDirectory() && fileFilter.shouldIgnoreDirectory(entry.name)) {
        continue;
      }

      if (entry.isFile() && fileFilter.shouldIgnore(relativePath)) {
        continue;
      }

      // 检查是否匹配模式
      const isMatch = globRegex.test(relativePath) || globRegex.test(entry.name);

      if (entry.isDirectory()) {
        // 如果包含目录且匹配，添加到结果
        if (options.includeDirectories && isMatch) {
          matches.push({
            path: fullPath,
            relative_path: relativePath,
            is_directory: true,
          });
        }

        // 递归搜索子目录
        await walkDirectory(
          fullPath,
          basePath,
          globRegex,
          matches,
          options,
          fileFilter
        );
      } else if (entry.isFile() && isMatch) {
        // 获取文件信息
        try {
          const stats = await fs.stat(fullPath);
          matches.push({
            path: fullPath,
            relative_path: relativePath,
            is_directory: false,
            size: stats.size,
            modified: stats.mtime.toISOString(),
          });
        } catch {
          // 如果无法获取文件信息，仍添加基本信息
          matches.push({
            path: fullPath,
            relative_path: relativePath,
            is_directory: false,
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

/**
 * 将 glob 模式转换为正则表达式
 */
function createGlobRegex(pattern: string, caseSensitive: boolean): RegExp {
  // 将 glob 模式转换为正则表达式
  let regexPattern = pattern
    .replace(/\./g, '\\.') // 转义点号
    .replace(/\*\*/g, '___DOUBLESTAR___') // 临时替换 **
    .replace(/\*/g, '[^/]*') // * 匹配除/外的任意字符
    .replace(/\?/g, '[^/]') // ? 匹配除/外的单个字符
    .replace(/___DOUBLESTAR___/g, '.*'); // ** 匹配任意字符包括/

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

/**
 * 排序匹配结果
 */
function sortMatches(matches: FileMatch[]): FileMatch[] {
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

/**
 * 格式化显示消息
 */
function formatDisplayMessage(metadata: Record<string, any>): string {
  const { search_path, pattern, total_matches, returned_matches, truncated } = metadata;

  let message = `✅ 在 ${search_path} 中找到 ${total_matches} 个匹配 "${pattern}" 的文件`;

  if (truncated) {
    message += `\n📋 显示前 ${returned_matches} 个结果`;
  }

  return message;
}
