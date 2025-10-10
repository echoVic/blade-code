import { promises as fs } from 'fs';
import { extname } from 'path';
import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/zod-schemas.js';

/**
 * ReadTool - 文件读取工具
 * 使用新的 Zod 验证设计
 */
export const readTool = createTool({
  name: 'read',
  displayName: '文件读取',
  kind: ToolKind.Read,

  // Zod Schema 定义
  schema: z.object({
    file_path: ToolSchemas.filePath({
      description: '要读取的文件路径（必须是绝对路径）',
    }),
    offset: ToolSchemas.lineNumber({
      description: '开始读取的行号（从0开始，仅对文本文件有效）',
    }).optional(),
    limit: ToolSchemas.lineLimit({
      description: '读取的行数（仅对文本文件有效）',
    }).optional(),
    encoding: ToolSchemas.encoding(),
  }),

  // 工具描述
  description: {
    short: '读取本地文件系统中的文件，支持文本、图片、PDF等多种格式',
    long: `支持多种文件格式和编码方式，可以按行切片读取文本文件。二进制文件会自动使用 base64 编码。`,
    usageNotes: [
      'file_path 参数必须是绝对路径，不能是相对路径',
      '默认读取整个文件内容，最多 2000 行',
      '可通过 offset 和 limit 参数控制读取的行范围（仅文本文件）',
      '文本文件会显示行号（格式：行号→内容）',
      '二进制文件（如图片、PDF等）自动使用 base64 编码',
      '支持的文本格式：.txt, .md, .js, .ts, .tsx, .json, .xml, .html, .css, .yml, .py, .rb, .php, .java, .cpp, .c, .h, .rs, .go, .sh, .sql 等',
      '读取前会检查文件是否存在，不存在会返回错误',
    ],
    examples: [
      {
        description: '读取整个文件',
        params: { file_path: '/path/to/file.txt' },
      },
      {
        description: '读取文件的前 100 行',
        params: { file_path: '/path/to/file.txt', limit: 100 },
      },
      {
        description: '从第 50 行开始读取 100 行',
        params: { file_path: '/path/to/file.txt', offset: 50, limit: 100 },
      },
      {
        description: '使用 base64 编码读取二进制文件',
        params: { file_path: '/path/to/image.png', encoding: 'base64' },
      },
    ],
    important: [
      '读取超大文件时建议使用 offset 和 limit 参数限制读取范围',
      '每行内容超过 2000 字符会被截断',
      '二进制文件会自动检测并切换到 base64 编码',
    ],
  },

  // 不需要用户确认
  requiresConfirmation: false,

  // 执行函数
  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const { file_path, offset, limit, encoding = 'utf8' } = params;
    const { signal, updateOutput } = context;

    try {
      updateOutput?.('开始读取文件...');

      // 检查文件是否存在
      try {
        await fs.access(file_path);
      } catch (_error) {
        return {
          success: false,
          llmContent: `文件不存在: ${file_path}`,
          displayContent: `❌ 文件不存在: ${file_path}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: `文件不存在: ${file_path}`,
          },
        };
      }

      // 检查中止信号
      signal.throwIfAborted();

      // 获取文件统计信息
      const stats = await fs.stat(file_path);

      if (stats.isDirectory()) {
        return {
          success: false,
          llmContent: `无法读取目录: ${file_path}`,
          displayContent: `❌ 无法读取目录: ${file_path}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: `目标是目录而非文件`,
          },
        };
      }

      // 获取文件扩展名
      const ext = extname(file_path).toLowerCase();
      const isTextFile = checkIsTextFile(ext);
      const isBinaryFile = checkIsBinaryFile(ext);

      let content: string;
      const metadata: Record<string, any> = {
        file_path,
        file_size: stats.size,
        file_type: ext,
        last_modified: stats.mtime.toISOString(),
        encoding: encoding,
      };

      // 处理二进制文件
      if (isBinaryFile && encoding === 'utf8') {
        updateOutput?.('检测到二进制文件，使用 base64 编码...');
        content = await fs.readFile(file_path, 'base64');
        metadata.encoding = 'base64';
        metadata.is_binary = true;
      } else {
        // 读取文件内容
        const buffer = await fs.readFile(file_path);

        if (encoding === 'base64') {
          content = buffer.toString('base64');
        } else if (encoding === 'binary') {
          content = buffer.toString('binary');
        } else {
          content = buffer.toString('utf8');
        }
      }

      signal.throwIfAborted();

      // 处理行级切片（仅文本文件）
      if (
        (offset !== undefined || limit !== undefined) &&
        encoding === 'utf8' &&
        isTextFile
      ) {
        const lines = content.split('\n');
        const startLine = offset || 0;
        const endLine = limit !== undefined ? startLine + limit : lines.length;

        const selectedLines = lines.slice(startLine, endLine);
        content = selectedLines
          .map((line, index) => {
            const lineNumber = startLine + index + 1;
            // 截断过长的行
            const truncatedLine =
              line.length > 2000 ? `${line.substring(0, 2000)}...` : line;
            return `${lineNumber.toString().padStart(6)}→${truncatedLine}`;
          })
          .join('\n');

        metadata.lines_read = selectedLines.length;
        metadata.total_lines = lines.length;
        metadata.start_line = startLine + 1;
        metadata.end_line = Math.min(endLine, lines.length);
      }

      const displayMessage = formatDisplayMessage(file_path, metadata);

      return {
        success: true,
        llmContent: content,
        displayContent: displayMessage,
        metadata,
      };
    } catch (error: any) {
      if (error.name === 'AbortError') {
        return {
          success: false,
          llmContent: '文件读取被中止',
          displayContent: '⚠️ 文件读取被用户中止',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: '操作被中止',
          },
        };
      }

      return {
        success: false,
        llmContent: `读取文件失败: ${error.message}`,
        displayContent: `❌ 读取文件失败: ${error.message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: error.message,
          details: error,
        },
      };
    }
  },

  version: '2.0.0',
  category: '文件操作',
  tags: ['file', 'io', 'read'],
});

/**
 * 检查是否是文本文件
 */
function checkIsTextFile(ext: string): boolean {
  const textExtensions = [
    '.txt',
    '.md',
    '.js',
    '.ts',
    '.jsx',
    '.tsx',
    '.json',
    '.xml',
    '.html',
    '.htm',
    '.css',
    '.scss',
    '.sass',
    '.less',
    '.yml',
    '.yaml',
    '.toml',
    '.ini',
    '.cfg',
    '.py',
    '.rb',
    '.php',
    '.java',
    '.cpp',
    '.c',
    '.h',
    '.hpp',
    '.rs',
    '.go',
    '.sh',
    '.bash',
    '.zsh',
    '.fish',
    '.ps1',
    '.bat',
    '.cmd',
    '.sql',
    '.graphql',
    '.vue',
    '.svelte',
    '.astro',
    '.dockerfile',
    '.gitignore',
    '.env',
  ];
  return textExtensions.includes(ext) || ext === '';
}

/**
 * 检查是否是二进制文件
 */
function checkIsBinaryFile(ext: string): boolean {
  const binaryExtensions = [
    '.jpg',
    '.jpeg',
    '.png',
    '.gif',
    '.bmp',
    '.svg',
    '.ico',
    '.webp',
    '.mp3',
    '.wav',
    '.mp4',
    '.avi',
    '.mov',
    '.wmv',
    '.flv',
    '.webm',
    '.pdf',
    '.doc',
    '.docx',
    '.xls',
    '.xlsx',
    '.ppt',
    '.pptx',
    '.zip',
    '.tar',
    '.gz',
    '.rar',
    '.7z',
    '.exe',
    '.dll',
    '.so',
    '.ttf',
    '.otf',
    '.woff',
    '.woff2',
    '.eot',
  ];
  return binaryExtensions.includes(ext);
}

/**
 * 格式化显示消息
 */
function formatDisplayMessage(filePath: string, metadata: Record<string, any>): string {
  let message = `✅ 成功读取文件: ${filePath}`;

  if (metadata.file_size !== undefined) {
    message += ` (${formatFileSize(metadata.file_size)})`;
  }

  if (metadata.lines_read !== undefined) {
    message += `\n📄 读取了 ${metadata.lines_read} 行 (第${metadata.start_line}-${metadata.end_line}行，共${metadata.total_lines}行)`;
  }

  if (metadata.is_binary) {
    message += '\n🔐 文件以 base64 编码显示';
  }

  return message;
}

/**
 * 格式化文件大小
 */
function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)}${units[unitIndex]}`;
}
