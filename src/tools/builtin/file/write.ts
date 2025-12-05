import { promises as fs } from 'fs';
import { dirname, extname } from 'path';
import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/zodSchemas.js';
import { generateDiffSnippet } from './diffUtils.js';
import { FileAccessTracker } from './FileAccessTracker.js';
import { SnapshotManager } from './SnapshotManager.js';

/**
 * WriteTool - File writer
 * Uses the newer Zod validation design
 */
export const writeTool = createTool({
  name: 'Write',
  displayName: 'File Write',
  kind: ToolKind.Write,
  strict: true, // 启用 OpenAI Structured Outputs
  isConcurrencySafe: false, // 文件写入不支持并发

  // Zod Schema 定义
  schema: z.object({
    file_path: ToolSchemas.filePath({
      description: 'Absolute file path to write',
    }),
    content: z.string().describe('Content to write'),
    encoding: ToolSchemas.encoding(),
    create_directories: z
      .boolean()
      .default(true)
      .describe('Automatically create missing parent directories'),
  }),

  // 工具描述（对齐 Claude Code 官方）
  description: {
    short: 'Writes a file to the local filesystem',
    long: `Writes a file to the local filesystem.`,
    usageNotes: [
      'This tool will overwrite the existing file if there is one at the provided path.',
      "If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.",
      'ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.',
      'NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.',
      'Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.',
    ],
  },

  // 执行函数
  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const { file_path, content, encoding, create_directories } = params;
    const { updateOutput, sessionId, messageId } = context;
    const signal = context.signal ?? new AbortController().signal;

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
      let oldContent: string | null = null;
      try {
        await fs.access(file_path);
        fileExists = true;
        // 如果文件存在且是文本文件，读取旧内容用于生成 diff
        if (encoding === 'utf8') {
          try {
            oldContent = await fs.readFile(file_path, 'utf8');
          } catch (error) {
            console.warn('[WriteTool] 读取旧文件内容失败:', error);
          }
        }
      } catch {
        // 文件不存在
      }

      // Read-Before-Write 验证（对齐 Claude Code 官方：强制模式）
      if (fileExists && sessionId) {
        const tracker = FileAccessTracker.getInstance();

        // 检查文件是否已读取（强制失败）
        if (!tracker.hasFileBeenRead(file_path, sessionId)) {
          return {
            success: false,
            llmContent: `If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.`,
            displayContent: `❌ 写入失败：必须先使用 Read 工具读取文件\n\n文件 ${file_path} 已存在，请先用 Read 工具查看其内容。`,
            error: {
              type: ToolErrorType.VALIDATION_ERROR,
              message: 'File not read before write',
            },
          };
        }

        // 🔴 检查文件是否被外部程序修改（对齐 gemini-cli：强制失败）
        const externalModCheck = await tracker.checkExternalModification(file_path);
        if (externalModCheck.isExternal) {
          return {
            success: false,
            llmContent: `The file has been modified by an external program since you last read it. You must use the Read tool again to see the current content before writing.\n\nDetails: ${externalModCheck.message}`,
            displayContent: `❌ 写入失败：文件已被外部程序修改\n\n${externalModCheck.message}\n\n💡 请重新使用 Read 工具读取最新内容后再写入`,
            error: {
              type: ToolErrorType.VALIDATION_ERROR,
              message: 'File modified externally',
              details: { externalModification: externalModCheck.message },
            },
          };
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

      // 🔴 更新文件访问记录（记录写入操作）
      if (sessionId) {
        const tracker = FileAccessTracker.getInstance();
        await tracker.recordFileEdit(file_path, sessionId, 'write');
      }

      signal.throwIfAborted();

      // 验证写入是否成功
      const stats = await fs.stat(file_path);

      // 计算写入的行数（仅对文本文件）
      const lineCount = encoding === 'utf8' ? content.split('\n').length : 0;
      const fileName = file_path.split('/').pop() || file_path;

      // 生成 diff（如果是覆盖现有文本文件）
      let diffSnippet: string | null = null;
      if (oldContent && encoding === 'utf8' && oldContent !== content) {
        // 文件大小限制：超过 1MB 跳过 diff 生成（避免性能问题）
        const MAX_DIFF_SIZE = 1024 * 1024; // 1MB
        if (oldContent.length < MAX_DIFF_SIZE && content.length < MAX_DIFF_SIZE) {
          diffSnippet = generateDiffSnippet(oldContent, content, 4);
        }
      }

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
        has_diff: !!diffSnippet, // 是否生成了 diff
        summary:
          encoding === 'utf8'
            ? `写入 ${lineCount} 行到 ${fileName}`
            : `写入 ${formatFileSize(stats.size)} 到 ${fileName}`,
      };

      const displayMessage = formatDisplayMessage(
        file_path,
        metadata,
        content,
        diffSnippet
      );

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
          llmContent: 'File write aborted',
          displayContent: '⚠️ 文件写入被用户中止',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: '操作被中止',
          },
        };
      }

      return {
        success: false,
        llmContent: `File write failed: ${error.message}`,
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
  content?: string,
  diffSnippet?: string | null
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

  // 优先显示 diff（如果有）
  if (diffSnippet) {
    message += diffSnippet;
  }

  // 添加内容预览（仅对文本文件且没有 diff 时才显示完整预览）
  if (content && metadata.encoding === 'utf8' && !diffSnippet) {
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
