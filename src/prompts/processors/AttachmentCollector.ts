/**
 * 附件收集器
 *
 * 负责从用户消息中提取 @ 提及，读取文件内容，并转换为附件对象
 */

import fg from 'fast-glob';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger, LogCategory } from '../../logging/Logger.js';
import { PathSecurity } from '../../utils/pathSecurity.js';
import { AtMentionParser } from './AtMentionParser.js';
import type { AtMention, Attachment, CollectorOptions, LineRange } from './types.js';

const logger = createLogger(LogCategory.PROMPTS);

/**
 * 附件收集器
 */
export class AttachmentCollector {
  private fileCache = new Map<string, { content: string; timestamp: number }>();
  private options: Required<CollectorOptions>;

  constructor(options: CollectorOptions) {
    this.options = {
      maxFileSize: 1024 * 1024, // 1MB
      maxLines: 2000,
      maxTokens: 32000,
      ...options,
    };

    logger.debug('AttachmentCollector initialized', {
      maxFileSize: this.options.maxFileSize,
      maxLines: this.options.maxLines,
    });
  }

  /**
   * 收集所有 @ 提及的附件
   *
   * @param message - 用户消息
   * @returns 附件数组
   *
   * @example
   * ```typescript
   * const attachments = await collector.collect('Read @src/agent.ts#L100-150');
   * // => [{ type: 'file', path: 'src/agent.ts', content: '...', metadata: {...} }]
   * ```
   */
  async collect(message: string): Promise<Attachment[]> {
    // 快速检查：是否包含 @
    if (!AtMentionParser.hasAtMentions(message)) {
      return [];
    }

    // 提取 @ 提及
    const mentions = AtMentionParser.extract(message);
    if (mentions.length === 0) {
      return [];
    }

    logger.debug(`Found ${mentions.length} @ mentions`);

    // 并行处理所有提及（参考 Claude Code 的 Promise.all）
    const jobs = mentions.map((m) => this.processOne(m));
    const results = await Promise.allSettled(jobs);

    // 转换为附件对象
    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        // 错误情况：返回错误附件
        const mention = mentions[index];
        const error =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);

        logger.warn(`Failed to process @${mention.path}:`, error);

        return {
          type: 'error' as const,
          path: mention.path,
          content: '',
          error,
        };
      }
    });
  }

  /**
   * 处理单个 @ 提及
   */
  private async processOne(mention: AtMention): Promise<Attachment> {
    // 安全验证
    const absolutePath = await PathSecurity.validatePath(
      mention.path,
      this.options.cwd
    );

    // 解析符号链接
    const realPath = await PathSecurity.resolveSymlink(absolutePath, this.options.cwd);

    const stats = await fs.stat(realPath);

    // 目录处理
    if (stats.isDirectory()) {
      logger.debug(`Processing directory: ${mention.path}`);
      return await this.readDirectory(realPath, mention.path);
    }

    // 文件处理
    logger.debug(`Processing file: ${mention.path}`, {
      lineRange: mention.lineRange,
    });
    return await this.readFile(realPath, mention.path, mention.lineRange);
  }

  /**
   * 读取文件内容
   */
  private async readFile(
    absolutePath: string,
    relativePath: string,
    lineRange?: LineRange
  ): Promise<Attachment> {
    // 检查缓存
    const cached = this.fileCache.get(absolutePath);
    if (cached && Date.now() - cached.timestamp < 60000) {
      logger.debug(`Cache hit: ${relativePath}`);
      return this.formatFileAttachment(relativePath, cached.content, lineRange);
    }

    // 检查文件大小
    const stats = await fs.stat(absolutePath);
    if (stats.size > this.options.maxFileSize) {
      throw new Error(
        `File too large: ${Math.round(stats.size / 1024 / 1024)}MB ` +
          `(max ${Math.round(this.options.maxFileSize / 1024 / 1024)}MB)`
      );
    }

    // 读取文件
    let content: string;
    try {
      content = await fs.readFile(absolutePath, 'utf-8');
    } catch (_error) {
      // 尝试以二进制方式读取（可能是非文本文件）
      throw new Error(
        `Cannot read file as text: ${relativePath}. It may be a binary file.`
      );
    }

    // 缓存结果
    this.fileCache.set(absolutePath, {
      content,
      timestamp: Date.now(),
    });

    return this.formatFileAttachment(relativePath, content, lineRange);
  }

  /**
   * 格式化文件附件
   */
  private formatFileAttachment(
    relativePath: string,
    content: string,
    lineRange?: LineRange
  ): Attachment {
    const lines = content.split('\n');
    let finalContent = content;
    let truncated = false;
    let actualLineRange = lineRange;

    // 行范围裁剪
    if (lineRange) {
      const start = Math.max(0, lineRange.start - 1); // 转为 0-based
      const end = lineRange.end ? lineRange.end : lineRange.start;

      // 验证行号范围
      if (start >= lines.length) {
        throw new Error(
          `Line range start (${lineRange.start}) exceeds file length (${lines.length} lines)`
        );
      }

      const endIndex = Math.min(end, lines.length);
      finalContent = lines.slice(start, endIndex).join('\n');

      // 添加行号信息
      const lineNumbers = Array.from(
        { length: endIndex - start },
        (_, i) => start + i + 1
      );
      const numberedLines = finalContent
        .split('\n')
        .map((line, i) => `${lineNumbers[i]}: ${line}`)
        .join('\n');

      finalContent = numberedLines;
      actualLineRange = { start: lineRange.start, end: endIndex };
    } else {
      // 行数限制
      if (lines.length > this.options.maxLines) {
        finalContent = lines.slice(0, this.options.maxLines).join('\n');
        finalContent += `\n\n[... truncated ${lines.length - this.options.maxLines} lines ...]`;
        truncated = true;
      }
    }

    return {
      type: 'file',
      path: relativePath,
      content: finalContent,
      metadata: {
        size: content.length,
        lines: lines.length,
        truncated,
        lineRange: actualLineRange,
      },
    };
  }

  /**
   * 读取目录内容
   */
  private async readDirectory(
    absolutePath: string,
    relativePath: string
  ): Promise<Attachment> {
    // 递归查找所有文件
    const files = (await fg('**/*', {
      cwd: absolutePath,
      dot: false,
      followSymbolicLinks: false,
      onlyFiles: true,
      unique: true,
      ignore: [
        'node_modules/**',
        '.git/**',
        'dist/**',
        'build/**',
        '.next/**',
        '.cache/**',
        'coverage/**',
      ],
    })) as string[];

    if (files.length === 0) {
      return {
        type: 'directory',
        path: relativePath,
        content: '(empty directory)',
      };
    }

    logger.debug(`Found ${files.length} files in directory: ${relativePath}`);

    // 限制文件数量
    const maxFiles = 50;
    const limitedFiles = files.slice(0, maxFiles);

    // 读取所有文件（并行）
    const fileContents = await Promise.allSettled(
      limitedFiles.map(async (file) => {
        const filePath = path.join(absolutePath, file);
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          // 限制每个文件的长度
          const truncated =
            content.length > 10000 ? content.slice(0, 10000) + '\n...' : content;
          return `--- ${file} ---\n${truncated}\n`;
        } catch (error) {
          return `--- ${file} ---\n[Error reading file: ${error instanceof Error ? error.message : 'unknown error'}]\n`;
        }
      })
    );

    // 合并所有文件内容
    const contentParts = fileContents.map((result) =>
      result.status === 'fulfilled' ? result.value : '[Error]'
    );

    const content = contentParts.join('\n');
    const suffix =
      files.length > maxFiles
        ? `\n\n[... ${files.length - maxFiles} more files omitted ...]`
        : '';

    return {
      type: 'directory',
      path: relativePath,
      content: content + suffix,
      metadata: {
        lines: files.length,
        truncated: files.length > maxFiles,
      },
    };
  }

  /**
   * 清理过期缓存
   */
  clearExpiredCache(): void {
    const now = Date.now();
    let cleared = 0;

    for (const [key, value] of this.fileCache.entries()) {
      if (now - value.timestamp > 60000) {
        this.fileCache.delete(key);
        cleared++;
      }
    }

    if (cleared > 0) {
      logger.debug(`Cleared ${cleared} expired cache entries`);
    }
  }

  /**
   * 清空所有缓存
   */
  clearCache(): void {
    this.fileCache.clear();
    logger.debug('Cleared all cache');
  }

  /**
   * 获取缓存统计
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.fileCache.size,
      keys: Array.from(this.fileCache.keys()),
    };
  }
}
