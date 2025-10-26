import { promises as fs } from 'fs';
import { dirname, extname } from 'path';
import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/zodSchemas.js';
import { FileAccessTracker } from './FileAccessTracker.js';
import { SnapshotManager } from './SnapshotManager.js';

/**
 * WriteTool - 文件写入工具
 * 使用新的 Zod 验证设计
 */
export const writeTool = createTool({
  name: 'Write',
  displayName: '文件写入',
  kind: ToolKind.Edit,
  strict: true, // 启用 OpenAI Structured Outputs
  isConcurrencySafe: false, // 文件写入不支持并发

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
  }),

  // 工具描述
  description: {
    short: '将内容写入到本地文件系统，支持自动创建目录和快照功能',
    long: `提供安全的文件写入功能，可以创建新文件或覆盖现有文件。支持多种编码格式和自动目录创建。覆盖文件前会自动创建快照。`,
    usageNotes: [
      'file_path 必须是绝对路径',
      '默认会自动创建不存在的父目录',
      '如果文件已存在，会完全覆盖原文件内容',
      '覆盖前自动创建快照（存储在 ~/.blade/file-history/{sessionId}/）',
      '快照可用于回滚操作',
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
        description: '覆盖现有文件（自动创建快照）',
        params: {
          file_path: '/path/to/existing-file.txt',
          content: 'New content',
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
      '如果文件已存在，Write 工具会完全覆盖原文件',
      '覆盖前会自动创建快照，可通过快照恢复',
      '修改现有文件应该优先使用 Edit 工具而非 Write',
      'Write 工具在覆盖文件前需要用户确认',
    ],
  },

  // 执行函数
  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const { file_path, content, encoding, create_directories } = params;
    const { signal, updateOutput, sessionId, messageId } = context;

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

      // 检查文件是否存在（用于后续验证和快照）
      let fileExists = false;
      try {
        await fs.access(file_path);
        fileExists = true;
      } catch {
        // 文件不存在
      }

      // Read-Before-Write 验证（如果文件已存在且有 sessionId）
      // 始终使用宽松模式（仅警告）
      if (fileExists && sessionId) {
        const tracker = FileAccessTracker.getInstance();

        // 检查文件是否已读取
        if (!tracker.hasFileBeenRead(file_path, sessionId)) {
          console.warn(
            `[WriteTool] 警告：覆盖文件 ${file_path}，但未通过 Read 工具读取`
          );
        }

        // 检查文件是否在读取后被修改
        const modificationCheck = await tracker.checkFileModification(file_path);
        if (modificationCheck.modified) {
          console.warn(`[WriteTool] 警告：${modificationCheck.message}`);
        }
      }

      // 创建快照（如果文件存在且有 sessionId 和 messageId）
      let snapshotCreated = false;
      if (fileExists && sessionId && messageId) {
        try {
          const snapshotManager = new SnapshotManager({ sessionId });
          await snapshotManager.initialize();
          await snapshotManager.createSnapshot(file_path, messageId);
          snapshotCreated = true;
        } catch (error) {
          console.warn('[WriteTool] 创建快照失败:', error);
          // 快照失败不中断写入操作
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
        snapshot_created: snapshotCreated, // 是否创建了快照
        session_id: sessionId,
        message_id: messageId,
        last_modified: stats.mtime.toISOString(),
      };

      const displayMessage = formatDisplayMessage(file_path, metadata, content);

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

  /**
   * 提取签名内容：返回文件路径
   */
  extractSignatureContent: (params) => params.file_path,

  /**
   * 抽象权限规则：返回扩展名通配符格式
   */
  abstractPermissionRule: (params) => {
    const ext = extname(params.file_path);
    return ext ? `**/*${ext}` : '**/*';
  },
});

/**
 * 格式化显示消息
 */
function formatDisplayMessage(
  filePath: string,
  metadata: Record<string, any>,
  content?: string
): string {
  let message = `✅ 成功写入文件: ${filePath}`;

  if (metadata.file_size !== undefined) {
    message += ` (${formatFileSize(metadata.file_size)})`;
  }

  if (metadata.snapshot_created) {
    message += `\n📸 已创建快照 (可回滚)`;
  }

  if (metadata.encoding !== 'utf8') {
    message += `\n🔐 使用编码: ${metadata.encoding}`;
  }

  // 添加内容预览（仅对文本文件）
  if (content && metadata.encoding === 'utf8') {
    const preview = generateContentPreview(filePath, content);
    if (preview) {
      message += '\n\n' + preview;
    }
  }

  return message;
}

/**
 * 生成文件内容预览（Markdown 代码块格式）
 */
function generateContentPreview(filePath: string, content: string): string | null {
  // 获取文件扩展名，用于语法高亮
  const ext = extname(filePath).toLowerCase();
  const languageMap: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.js': 'javascript',
    '.jsx': 'jsx',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.c': 'c',
    '.cpp': 'cpp',
    '.h': 'c',
    '.hpp': 'cpp',
    '.cs': 'csharp',
    '.rb': 'ruby',
    '.php': 'php',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.scala': 'scala',
    '.sh': 'bash',
    '.bash': 'bash',
    '.zsh': 'zsh',
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.toml': 'toml',
    '.xml': 'xml',
    '.html': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.sass': 'sass',
    '.less': 'less',
    '.md': 'markdown',
    '.sql': 'sql',
    '.graphql': 'graphql',
    '.proto': 'protobuf',
  };

  const language = languageMap[ext] || '';

  // 限制预览长度（最多 100 行或 5000 字符）
  const MAX_LINES = 100;
  const MAX_CHARS = 5000;

  let previewContent = content;
  let truncated = false;

  // 按行数截断
  const lines = content.split('\n');
  if (lines.length > MAX_LINES) {
    previewContent = lines.slice(0, MAX_LINES).join('\n');
    truncated = true;
  }

  // 按字符数截断
  if (previewContent.length > MAX_CHARS) {
    previewContent = previewContent.substring(0, MAX_CHARS);
    truncated = true;
  }

  // 生成 Markdown 代码块
  let preview = '📄 文件内容:\n\n';
  preview += '```' + language + '\n';
  preview += previewContent;
  if (!previewContent.endsWith('\n')) {
    preview += '\n';
  }
  preview += '```';

  if (truncated) {
    preview += `\n\n⚠️ 内容已截断（完整文件共 ${lines.length} 行，${content.length} 字符）`;
  }

  return preview;
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
