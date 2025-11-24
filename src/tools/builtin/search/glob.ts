import type { Entry } from 'fast-glob';
import fg from 'fast-glob';
import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { join, resolve } from 'path';
import { z } from 'zod';
import { FileFilter } from '../../../utils/filePatterns.js';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/zodSchemas.js';

/**
 * 创建标准的 AbortError
 */
function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
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
    const { updateOutput } = context;
    const signal = context.signal ?? new AbortController().signal;

    try {
      updateOutput?.(`开始在 ${path} 中搜索模式 "${pattern}"...`);

      // 验证搜索路径存在
      const searchPath = resolve(path);
      try {
        const stats = await stat(searchPath);
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

      // 创建文件过滤器（会读取并解析 .gitignore 一次）
      const fileFilter = await FileFilter.create({
        cwd: searchPath,
        useGitignore: true,
        useDefaults: true,
        gitignoreScanMode: 'recursive',
        customScanIgnore: [],
        cacheTTL: 30000,
      });

      // 执行 glob 搜索（复用 FileFilter 已解析的模式）
      const { matches, wasTruncated } = await performGlobSearch(
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

      const metadata: Record<string, any> = {
        search_path: searchPath,
        pattern,
        // 注意：total_matches 和 returned_matches 都是返回的条数（截断后）
        // 如果 truncated=true，实际总数未知，只知道"至少"这么多
        total_matches: matches.length, // 返回的匹配数（可能被截断）
        returned_matches: matches.length, // 实际返回的条数
        max_results,
        include_directories,
        case_sensitive,
        truncated: wasTruncated, // 是否因达到 max_results 而截断
      };

      const displayMessage = formatDisplayMessage(metadata);

      // 为 LLM 生成更友好的文本格式
      let llmFriendlyText: string;
      if (sortedMatches.length > 0) {
        const countPrefix = wasTruncated
          ? `Found at least ${sortedMatches.length} file(s) matching "${pattern}" (truncated)`
          : `Found ${sortedMatches.length} file(s) matching "${pattern}"`;

        llmFriendlyText =
          `${countPrefix}:\n\n` +
          sortedMatches.map((m) => `- ${m.relative_path}`).join('\n') +
          '\n\nUse the relative_path values above for Read/Edit operations.';
      } else {
        llmFriendlyText = `No files found matching "${pattern}"`;
      }

      return {
        success: true,
        llmContent: llmFriendlyText,
        displayContent: displayMessage,
        metadata: {
          ...metadata,
          matches: sortedMatches, // 保留原始数据在 metadata 中
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
): Promise<{ matches: FileMatch[]; wasTruncated: boolean }> {
  // 复用 FileFilter 已解析的 ignore 模式（避免重复读取 .gitignore）
  // negates 由 FileFilter 在二次过滤时使用
  const ignore = fileFilter.getIgnorePatterns();

  const matches: FileMatch[] = [];
  let wasTruncated = false;

  return await new Promise<{ matches: FileMatch[]; wasTruncated: boolean }>(
    (resolvePromise, rejectPromise) => {
      // 提前检查：如果 signal 已经 aborted，直接 reject
      if (options.signal.aborted) {
        rejectPromise(createAbortError('文件搜索被用户中止'));
        return;
      }

      const stream = fg.stream(pattern, {
        cwd: searchPath,
        dot: true,
        followSymbolicLinks: false,
        unique: true,
        caseSensitiveMatch: options.caseSensitive,
        objectMode: true,
        stats: true,
        onlyFiles: !options.includeDirectories,
        ignore,
      }) as unknown as Readable;

      let ended = false;
      let abortHandler: (() => void) | null = null; // 声明在前，定义在后

      // 移除 abort 监听器的辅助函数
      const removeAbortListener = () => {
        if (abortHandler) {
          if (options.signal.removeEventListener) {
            options.signal.removeEventListener('abort', abortHandler);
          } else if ('onabort' in options.signal) {
            (options.signal as unknown as { onabort: null }).onabort = null;
          }
          abortHandler = null; // 避免重复清理
        }
      };

      const abortAndClose = () => {
        if (!ended) {
          ended = true;
          wasTruncated = true; // 标记因达到 maxResults 而截断
          stream.destroy();
          removeAbortListener(); // 清理监听器
          resolvePromise({ matches, wasTruncated });
        }
      };

      const onData = (entry: Entry) => {
        // 检查用户中止 - 抛出错误而非返回部分结果
        if (options.signal.aborted) {
          if (!ended) {
            ended = true;
            stream.destroy(createAbortError('文件搜索被用户中止'));
          }
          return;
        }

        // 检查是否达到最大结果数 - 正常返回部分结果
        if (matches.length >= options.maxResults) {
          abortAndClose();
          return;
        }

        const rel = entry.path.replace(/\\/g, '/');
        const abs = join(searchPath, rel);

        // 二次过滤，支持 .gitignore 的 negation 语义（如 !src/important.js）
        // FileFilter 内部使用 collectIgnoreGlobs 返回的 negates
        if (fileFilter.shouldIgnore(rel)) return;

        const isDir = entry.stats ? (entry.stats as Stats).isDirectory() : false;
        if (isDir && fileFilter.shouldIgnoreDirectory(rel)) return;

        const size =
          entry.stats && (entry.stats as Stats).isFile()
            ? (entry.stats as Stats).size
            : undefined;
        const modified = entry.stats
          ? (entry.stats as Stats).mtime.toISOString()
          : undefined;

        matches.push({
          path: abs,
          relative_path: rel,
          is_directory: isDir,
          size,
          modified,
        });

        if (matches.length >= options.maxResults) {
          abortAndClose();
        }
      };

      stream.on('data', onData);

      // 处理中止信号 - 主动监听 abort 事件
      abortHandler = () => {
        if (!ended) {
          ended = true;
          removeAbortListener(); // 清理监听器（虽然 abort 只触发一次，但保持一致性）
          stream.destroy(createAbortError('文件搜索被用户中止'));
        }
      };

      // 兼容不同版本的 AbortSignal API
      if (options.signal.addEventListener) {
        options.signal.addEventListener('abort', abortHandler);
      } else if ('onabort' in options.signal) {
        (options.signal as unknown as { onabort: () => void }).onabort = abortHandler;
      }

      stream.once('error', (err) => {
        if (!ended) {
          ended = true;
          removeAbortListener();
          rejectPromise(err);
        }
      });

      stream.once('end', () => {
        if (!ended) {
          ended = true;
          removeAbortListener();
          resolvePromise({ matches, wasTruncated });
        }
      });
    }
  );
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

  let message: string;

  if (truncated) {
    // 截断时使用"至少 N 个"避免误导
    message = `✅ 在 ${search_path} 中找到至少 ${total_matches} 个匹配 "${pattern}" 的文件（已截断）`;
    message += `\n📋 显示前 ${returned_matches} 个结果`;
  } else {
    // 未截断时显示准确数量
    message = `✅ 在 ${search_path} 中找到 ${total_matches} 个匹配 "${pattern}" 的文件`;
  }

  return message;
}
