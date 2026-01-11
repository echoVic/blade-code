import type { Entry } from 'fast-glob';
import fg from 'fast-glob';
import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { join, resolve } from 'path';
import { z } from 'zod';

import { FileFilter } from '../../../utils/filePatterns.js';
import { createTool } from '../../core/createTool.js';
import type {
  ExecutionContext,
  GlobMetadata,
  NodeError,
  ToolResult,
} from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/zodSchemas.js';

/**
 * Create a standard AbortError
 */
function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

/**
 * File match result
 */
interface FileMatch {
  path: string;
  relative_path: string;
  is_directory: boolean;
  size?: number;
  modified?: string;
}

/**
 * GlobTool - File pattern matcher
 * Uses the newer Zod validation design
 */
export const globTool = createTool({
  name: 'Glob',
  displayName: 'File Pattern Match',
  kind: ToolKind.ReadOnly,

  // Zod Schema 定义
  schema: z.object({
    pattern: ToolSchemas.glob({
      description: 'Glob pattern string (supports *, ?, ** wildcards)',
    }),
    path: z.string().optional().describe('Search path (optional, defaults to cwd)'),
    max_results: ToolSchemas.positiveInt({
      description: 'Maximum number of results',
    })
      .max(1000, 'At most 1000 results can be returned')
      .default(100),
    include_directories: z
      .boolean()
      .default(false)
      .describe('Include directories in results'),
    case_sensitive: z.boolean().default(false).describe('Case sensitive matching'),
  }),

  // 工具描述（对齐 Claude Code 官方）
  description: {
    short: 'Fast file pattern matching tool that works with any codebase size',
    long: `Fast file pattern matching tool that works with any codebase size. Supports glob patterns like "**/*.js" or "src/**/*.ts". Returns matching file paths sorted by modification time.`,
    usageNotes: [
      'Use this tool when you need to find files by name patterns',
      'When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead',
      'You can call multiple tools in a single response. It is always better to speculatively perform multiple searches in parallel if they are potentially useful.',
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
      updateOutput?.(`Searching in ${path} for pattern "${pattern}"...`);

      // 验证搜索路径存在
      const searchPath = resolve(path);
      try {
        const stats = await stat(searchPath);
        if (!stats.isDirectory()) {
          return {
            success: false,
            llmContent: `Search path must be a directory: ${searchPath}`,
            displayContent: `❌ 搜索路径必须是目录: ${searchPath}`,
            error: {
              type: ToolErrorType.VALIDATION_ERROR,
              message: '搜索路径必须是目录',
            },
          };
        }
      } catch (error) {
        const nodeError = error as NodeError;
        if (nodeError.code === 'ENOENT') {
          return {
            success: false,
            llmContent: `Search path does not exist: ${searchPath}`,
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

      const metadata: GlobMetadata = {
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
    } catch (error) {
      const err = error as Error;
      if (err.name === 'AbortError') {
        return {
          success: false,
          llmContent: 'File search aborted',
          displayContent: '⚠️ 文件搜索被用户中止',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: '操作被中止',
          },
        };
      }

      return {
        success: false,
        llmContent: `Search failed: ${err.message}`,
        displayContent: `❌ 搜索失败: ${err.message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: err.message,
          details: err,
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
function formatDisplayMessage(metadata: GlobMetadata): string {
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
