import { promises as fs } from 'fs';
import { dirname } from 'path';
import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/zodSchemas.js';

/**
 * WriteTool - 文件写入工具
 * 使用新的 Zod 验证设计
 */
export const writeTool = createTool({
  name: 'Write',
  displayName: '文件写入',
  kind: ToolKind.Edit,

  // Zod Schema 定义
  schema: z.object({
    file_path: ToolSchemas.filePath({
      description: '要写入的文件路径（必须是绝对路径）',
    }),
    content: z.string().describe('要写入的文件内容'),
    encoding: ToolSchemas.encoding(),
    create_directories: z
      .boolean()
      .default(true)
      .describe('是否自动创建不存在的父目录'),
    backup: z
      .boolean()
      .default(false)
      .describe('是否在覆盖文件前创建备份（备份文件名：原文件名.backup.时间戳）'),
  }),

  // 工具描述
  description: {
    short: '将内容写入到本地文件系统，支持自动创建目录和备份功能',
    long: `提供安全的文件写入功能，可以创建新文件或覆盖现有文件。支持多种编码格式和自动目录创建。`,
    usageNotes: [
      'file_path 必须是绝对路径',
      '默认会自动创建不存在的父目录',
      '如果文件已存在，会完全覆盖原文件内容',
      '可以通过 backup 参数在覆盖前创建备份',
      '备份文件格式：原文件名.backup.{时间戳}',
      '支持 utf8、base64、binary 三种编码',
      'NEVER 用于修改现有文件，应该优先使用 Edit 工具',
      'ALWAYS 用于创建全新文件',
    ],
    examples: [
      {
        description: '创建新的文本文件',
        params: {
          file_path: '/path/to/new-file.txt',
          content: 'Hello, World!',
        },
      },
      {
        description: '覆盖文件并创建备份',
        params: {
          file_path: '/path/to/existing-file.txt',
          content: 'New content',
          backup: true,
        },
      },
      {
        description: '写入 base64 编码的二进制文件',
        params: {
          file_path: '/path/to/image.png',
          content: 'iVBORw0KGgoAAAANSUhEUgA...',
          encoding: 'base64',
        },
      },
    ],
    important: [
      '如果文件已存在，Write 工具会完全覆盖原文件（无法撤销）',
      '修改现有文件应该优先使用 Edit 工具而非 Write',
      'Write 工具在覆盖文件前需要用户确认',
      '启用 backup 参数可以在覆盖前创建备份',
    ],
  },

  // 执行函数
  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const { file_path, content, encoding, create_directories, backup } = params;
    const { signal, updateOutput } = context;

    try {
      updateOutput?.('开始写入文件...');

      // 检查并创建目录
      if (create_directories) {
        const dir = dirname(file_path);
        try {
          await fs.mkdir(dir, { recursive: true });
        } catch (error: any) {
          if (error.code !== 'EEXIST') {
            throw error;
          }
        }
      }

      signal.throwIfAborted();

      // 创建备份（如果文件存在且启用备份）
      let backupPath: string | undefined;
      if (backup) {
        try {
          await fs.access(file_path);
          backupPath = `${file_path}.backup.${Date.now()}`;
          await fs.copyFile(file_path, backupPath);
          updateOutput?.(`已创建备份: ${backupPath}`);
        } catch {
          // 文件不存在，无需备份
        }
      }

      signal.throwIfAborted();

      // 根据编码写入文件
      let writeBuffer: Buffer;

      if (encoding === 'base64') {
        writeBuffer = Buffer.from(content, 'base64');
      } else if (encoding === 'binary') {
        writeBuffer = Buffer.from(content, 'binary');
      } else {
        writeBuffer = Buffer.from(content, 'utf8');
      }

      await fs.writeFile(file_path, writeBuffer);

      signal.throwIfAborted();

      // 验证写入是否成功
      const stats = await fs.stat(file_path);

      const metadata: Record<string, any> = {
        file_path,
        content_size: content.length,
        file_size: stats.size,
        encoding,
        created_directories: create_directories,
        backup_created: backup && backupPath !== undefined,
        backup_path: backupPath,
        last_modified: stats.mtime.toISOString(),
      };

      const displayMessage = formatDisplayMessage(file_path, metadata);

      return {
        success: true,
        llmContent: {
          file_path,
          size: stats.size,
          modified: stats.mtime.toISOString(),
        },
        displayContent: displayMessage,
        metadata,
      };
    } catch (error: any) {
      if (error.name === 'AbortError') {
        return {
          success: false,
          llmContent: '文件写入被中止',
          displayContent: '⚠️ 文件写入被用户中止',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: '操作被中止',
          },
        };
      }

      return {
        success: false,
        llmContent: `写入文件失败: ${error.message}`,
        displayContent: `❌ 写入文件失败: ${error.message}`,
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
  tags: ['file', 'io', 'write', 'create'],
});

/**
 * 格式化显示消息
 */
function formatDisplayMessage(filePath: string, metadata: Record<string, any>): string {
  let message = `✅ 成功写入文件: ${filePath}`;

  if (metadata.file_size !== undefined) {
    message += ` (${formatFileSize(metadata.file_size)})`;
  }

  if (metadata.backup_created) {
    message += `\n💾 已创建备份: ${metadata.backup_path}`;
  }

  if (metadata.encoding !== 'utf8') {
    message += `\n🔐 使用编码: ${metadata.encoding}`;
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
