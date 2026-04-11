import { promises as fs } from 'fs';
import { basename, dirname, extname } from 'path';
import { z } from 'zod';
import { isAcpMode } from '../../../acp/AcpServiceContext.js';
import { getFileSystemService } from '../../../services/FileSystemService.js';
import { createTool } from '../../core/createTool.js';
import type {
  ExecutionContext,
  NodeError,
  ToolResult,
  WriteMetadata,
} from '../../types/index.js';
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

      // 获取文件系统服务（ACP 或本地）
      const fsService = getFileSystemService();
      const useAcp = isAcpMode();

      // 检查并创建目录（统一使用 FileSystemService）
      if (create_directories) {
        const dir = dirname(file_path);
        try {
          await fsService.mkdir(dir, { recursive: true, mode: 0o755 });
        } catch (error) {
          const nodeError = error as NodeError;
          if (nodeError.code !== 'EEXIST') {
            throw error;
          }
        }
      }

      if (typeof signal.throwIfAborted === 'function') {
        signal.throwIfAborted();
      }

      // 检查文件是否存在（统一使用 FileSystemService）
      let fileExists = false;
      let oldContent: string | null = null;
      try {
        fileExists = await fsService.exists(file_path);
        // 如果文件存在且是文本文件，读取旧内容用于生成 diff
        if (fileExists && encoding === 'utf8') {
          try {
            oldContent = await fsService.readTextFile(file_path);
          } catch (error) {
            console.warn('[WriteTool] 读取旧文件内容失败:', error);
          }
        }
      } catch {
        // 检查失败，假设文件不存在
      }

      // Read-Before-Write 验证（对齐 Claude Code 官方：强制模式）
      if (fileExists && sessionId) {
        const tracker = FileAccessTracker.getInstance();

        // 检查文件是否已读取（强制失败）
        if (!tracker.hasFileBeenRead(file_path, sessionId)) {
          return {
            success: false,
            llmContent: `If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.`,
            error: {
              type: ToolErrorType.VALIDATION_ERROR,
              message: 'File not read before write',
            },
            metadata: {
              requiresRead: true,
            },
          };
        }

        // 检查文件是否被外部程序修改（强制失败）
        const externalModCheck = await tracker.checkExternalModification(file_path);
        if (externalModCheck.isExternal) {
          return {
            success: false,
            llmContent: `The file has been modified by an external program since you last read it. You must use the Read tool again to see the current content before writing.\n\nDetails: ${externalModCheck.message}`,
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

      if (typeof signal.throwIfAborted === 'function') {
        signal.throwIfAborted();
      }

      // 根据编码写入文件
      if (encoding === 'utf8') {
        // 文本文件：使用 FileSystemService 写入
        if (useAcp) {
          updateOutput?.('通过 IDE 写入文件...');
        }
        await fsService.writeTextFile(file_path, content);
      } else {
        // 二进制文件写入
        // [WARN] ACP 模式下不支持二进制写入，必须明确失败
        // 否则会写到本地磁盘而非远端，造成数据丢失/错位
        if (useAcp) {
          return {
            success: false,
            llmContent: `Binary file writes are not supported in ACP mode. The IDE only supports text file operations. Please use encoding='utf8' for text files, or ask the user to write the file manually.`,
            error: {
              type: ToolErrorType.VALIDATION_ERROR,
              message: 'Binary writes not supported in ACP mode',
            },
          };
        }

        // 本地模式：正常写入二进制
        let writeBuffer: Buffer;

        if (encoding === 'base64') {
          writeBuffer = Buffer.from(content, 'base64');
        } else if (encoding === 'binary') {
          writeBuffer = Buffer.from(content, 'binary');
        } else {
          writeBuffer = Buffer.from(content, 'utf8');
        }

        await fs.writeFile(file_path, writeBuffer);
      }

      // 更新文件访问记录（记录写入操作）
      if (sessionId) {
        const tracker = FileAccessTracker.getInstance();
        await tracker.recordFileEdit(file_path, sessionId, 'write');
      }

      if (typeof signal.throwIfAborted === 'function') {
        signal.throwIfAborted();
      }

      // 验证写入是否成功（统一使用 FileSystemService）
      const stats = await fsService.stat(file_path);

      // 计算写入的行数（仅对文本文件）
      const lineCount = encoding === 'utf8' ? content.split('\n').length : 0;
      const fileName = basename(file_path);

      // 生成 diff（如果是覆盖现有文本文件）
      let diffSnippet: string | null = null;
      if (oldContent && encoding === 'utf8' && oldContent !== content) {
        // 文件大小限制：超过 1MB 跳过 diff 生成（避免性能问题）
        const MAX_DIFF_SIZE = 1024 * 1024; // 1MB
        if (oldContent.length < MAX_DIFF_SIZE && content.length < MAX_DIFF_SIZE) {
          diffSnippet = generateDiffSnippet(oldContent, content, 4);
        }
      }

      const metadata: WriteMetadata = {
        file_path,
        content_size: content.length,
        file_size: stats?.size,
        encoding,
        created_directories: create_directories,
        snapshot_created: snapshotCreated, // 是否创建了快照
        session_id: sessionId,
        message_id: messageId,
        last_modified:
          stats?.mtime instanceof Date ? stats.mtime.toISOString() : undefined,
        has_diff: !!diffSnippet, // 是否生成了 diff
        summary:
          encoding === 'utf8'
            ? `写入 ${lineCount} 行到 ${fileName}`
            : `写入 ${stats?.size ? formatFileSize(stats.size) : 'unknown'} 到 ${fileName}`,
        // ACP diff 支持：完整内容用于 IDE 显示差异
        kind: 'edit',
        oldContent: oldContent || '', // 新文件为空字符串
        newContent: encoding === 'utf8' ? content : undefined, // 仅文本文件
      };

      return {
        success: true,
        llmContent: {
          file_path,
          size: stats?.size,
          modified:
            stats?.mtime instanceof Date ? stats.mtime.toISOString() : undefined,
        },
        metadata,
      };
    } catch (error) {
      const nodeError = error as NodeError;
      if (nodeError.name === 'AbortError') {
        return {
          success: false,
          llmContent: 'File write aborted',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: '操作被中止',
          },
        };
      }

      return {
        success: false,
        llmContent: `File write failed: ${nodeError.message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: nodeError.message,
          details: nodeError,
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
