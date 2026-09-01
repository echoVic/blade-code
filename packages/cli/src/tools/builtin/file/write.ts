import { promises as fs } from 'fs';
import { basename, dirname, extname } from 'path';
import {
  ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS,
  AcpRemoteFileBoundaryError,
} from '../../../acp/AcpFileRequestCoordinator.js';
import {
  AcpFileSystemCapabilityError,
  AcpFileSystemService,
} from '../../../acp/AcpFileSystemService.js';
import { type AcpRemotePath, AcpRemotePathError } from '../../../acp/AcpRemotePath.js';
import {
  getAcpFileSystemService,
  isAcpMode,
  isAcpRemoteFileSystem,
  isExplicitUnknownAcpSession,
} from '../../../acp/AcpServiceContext.js';
import {
  AcpRemoteMutationError,
  commitVerifiedRemoteTextMutation,
} from '../../../acp/RemoteTextMutation.js';
import { Default, Type } from '../../../schema/index.js';
import { getFileSystemService } from '../../../services/FileSystemService.js';
import { createTool } from '../../core/createTool.js';
import {
  createInvalidAcpRemotePathResult,
  createUnavailableAcpSessionFileSystemResult,
} from '../../execution/ToolExecutionResults.js';
import { getExecutionWorkspaceToolPolicy } from '../../execution/WorkspaceToolPolicy.js';
import type {
  ExecutionContext,
  NodeError,
  ToolResult,
  WriteMetadata,
} from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { ToolSchemas } from '../../validation/toolSchemas.js';
import { generateDiffSnippet } from './diffUtils.js';
import { FileAccessTracker } from './FileAccessTracker.js';
import { SnapshotManager, type SnapshotMetadata } from './SnapshotManager.js';

/**
 * WriteTool - File writer
 * Uses the TypeBox validation design
 */
export const writeTool = createTool({
  name: 'Write',
  displayName: 'File Write',
  kind: ToolKind.Write,
  strict: true, // 启用 OpenAI Structured Outputs
  isConcurrencySafe: false, // 文件写入不支持并发
  parallelism: 'shared', // 不同路径并行；同路径由 FileLockManager 串行
  affectedPaths: (params) => [params.file_path],

  schema: Type.Object({
    file_path: ToolSchemas.filePath({
      description: 'Absolute file path to write',
    }),
    content: Type.String({ description: 'Content to write' }),
    encoding: ToolSchemas.encoding(),
    create_directories: Default(
      Type.Boolean({
        description: 'Automatically create missing parent directories',
      }),
      true
    ),
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
    const trustedWorkspaceKind = getExecutionWorkspaceToolPolicy(context)?.kind;
    if (
      isExplicitUnknownAcpSession(
        sessionId,
        context.workspaceKind,
        trustedWorkspaceKind
      )
    ) {
      return createUnavailableAcpSessionFileSystemResult({
        filePath: file_path,
        mutation: true,
      });
    }

    try {
      // 获取文件系统服务（ACP 或本地）
      const useAcp =
        trustedWorkspaceKind === 'acp-remote' ||
        (trustedWorkspaceKind !== 'local' && isAcpMode(sessionId));
      const remoteFileSystem =
        trustedWorkspaceKind === 'acp-remote' ||
        (trustedWorkspaceKind !== 'local' && isAcpRemoteFileSystem(sessionId));
      const fsService = useAcp
        ? getAcpFileSystemService(sessionId)
        : getFileSystemService();

      if (remoteFileSystem) {
        if (!(fsService instanceof AcpFileSystemService)) {
          return {
            success: false,
            llmContent: 'File write failed: internal ACP remote filesystem mismatch',
            error: {
              type: ToolErrorType.EXECUTION_ERROR,
              message: 'ACP remote filesystem mismatch',
            },
            metadata: {
              file_path,
              sideEffectsUncertain: false,
            },
          };
        }
        return executeRemoteWrite(
          fsService,
          {
            file_path,
            content,
            encoding,
          },
          signal,
          updateOutput
        );
      }

      updateOutput?.('开始写入文件...');

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
        const externalModCheck = await tracker.checkExternalModification(
          file_path,
          sessionId
        );
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

      let snapshotCreated = false;
      let snapshotManager: SnapshotManager | undefined;
      let snapshotMetadata: SnapshotMetadata | undefined;

      if (typeof signal.throwIfAborted === 'function') {
        signal.throwIfAborted();
      }

      if (!useAcp && sessionId && messageId) {
        try {
          snapshotManager = new SnapshotManager({
            sessionId,
            workspaceRoot: context.workspaceRoot,
          });
          await snapshotManager.initialize();
          snapshotMetadata = await snapshotManager.createSnapshot(file_path, messageId);
        } catch (error) {
          console.warn('[WriteTool] 创建快照失败:', error);
          snapshotManager = undefined;
          snapshotMetadata = undefined;
        }
      }

      try {
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
      } catch (error) {
        if (snapshotManager && snapshotMetadata) {
          await snapshotManager
            .discardSnapshot(file_path, snapshotMetadata)
            .catch((cleanupError) =>
              console.warn('[WriteTool] 丢弃未完成快照失败:', cleanupError)
            );
        }
        throw error;
      }

      if (snapshotManager && snapshotMetadata) {
        try {
          await snapshotManager.recordPostEditState(file_path, snapshotMetadata);
          snapshotCreated = true;
        } catch (error) {
          console.warn('[WriteTool] 完成快照失败:', error);
          await snapshotManager
            .discardSnapshot(file_path, snapshotMetadata)
            .catch((cleanupError) =>
              console.warn('[WriteTool] 丢弃未完成快照失败:', cleanupError)
            );
        }
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
        llmContent: oldContent
          ? `Wrote ${file_path} (${content.length} chars, updated existing file)`
          : `Created ${file_path} (${content.length} chars, new file)`,
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

async function executeRemoteWrite(
  fsService: AcpFileSystemService,
  params: {
    file_path: string;
    content: string;
    encoding: 'utf8' | 'base64' | 'binary';
  },
  signal: AbortSignal,
  updateOutput?: (content: string) => void
): Promise<ToolResult> {
  const { file_path, content, encoding } = params;
  const deadlineAt = Date.now() + ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS;
  const stableMetadata = {
    file_path,
    sideEffectsUncertain: false,
  } satisfies Pick<WriteMetadata, 'file_path' | 'sideEffectsUncertain'>;
  let remotePath: AcpRemotePath;
  try {
    remotePath = fsService.parsePath(file_path);
  } catch (error) {
    if (error instanceof AcpRemotePathError) {
      return createInvalidAcpRemotePathResult({
        filePath: file_path,
        mutation: true,
      });
    }
    throw error;
  }

  updateOutput?.('开始写入文件...');

  if (encoding !== 'utf8') {
    return {
      success: false,
      llmContent:
        "ACP remote Write only supports UTF-8 text writes. Use encoding='utf8'.",
      error: {
        type: ToolErrorType.VALIDATION_ERROR,
        message: 'ACP remote Write only supports UTF-8 text writes',
      },
      metadata: stableMetadata,
    };
  }

  try {
    fsService.assertTextMutationCapabilities();
  } catch (error) {
    if (error instanceof AcpFileSystemCapabilityError) {
      return {
        success: false,
        llmContent: `ACP remote Write requires ${error.operation} capability.`,
        error: {
          type: ToolErrorType.VALIDATION_ERROR,
          message: `ACP remote filesystem does not support ${error.operation}`,
        },
        metadata: stableMetadata,
      };
    }
    throw error;
  }

  signal.throwIfAborted?.();
  const requiresReadBoundary = (error: unknown): boolean =>
    error instanceof AcpRemoteFileBoundaryError &&
    Boolean(
      (error as AcpRemoteFileBoundaryError & { requiresRead?: boolean }).requiresRead
    );
  const getOldContent = (
    prior: Awaited<ReturnType<AcpFileSystemService['readTextFileIfExists']>> | undefined
  ): string => (prior?.exists ? prior.content : '');
  let lease: ReturnType<AcpFileSystemService['tryAcquireMutationLeaseForParsedPaths']>;
  let previous:
    | Awaited<ReturnType<AcpFileSystemService['readTextFileIfExistsForParsedPath']>>
    | undefined;
  try {
    lease = fsService.tryAcquireMutationLeaseForParsedPaths([remotePath]);
  } catch (error) {
    if (requiresReadBoundary(error)) {
      return {
        success: false,
        llmContent:
          'Remote file state is uncertain for this path. Use Read on the same file to refresh remote state before retrying Write.',
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: 'Remote file state requires a fresh Read before mutation',
        },
        metadata: {
          file_path,
          write_acknowledged: false,
          write_verified: false,
          sideEffectsUncertain: true,
          requiresRead: true,
        },
      };
    }
    if (error instanceof AcpRemoteFileBoundaryError && error.reason === 'busy') {
      return {
        success: false,
        llmContent:
          'Remote file is busy with another in-flight mutation. Wait for it to settle before retrying Write.',
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: 'Remote file is busy',
        },
        metadata: stableMetadata,
      };
    }
    throw error;
  }
  try {
    previous = await fsService.readTextFileIfExistsForParsedPath(remotePath, {
      signal,
      deadlineAt,
      purpose: 'preflight',
      lease,
    });
    if (previous.exists) {
      const accessStatus = fsService.checkRemoteAccessForParsedPath(
        remotePath,
        previous.content
      );
      if (accessStatus === 'missing') {
        return {
          success: false,
          llmContent:
            "If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.",
          error: {
            type: ToolErrorType.VALIDATION_ERROR,
            message: 'File not read before write',
          },
          metadata: {
            file_path,
            requiresRead: true,
            sideEffectsUncertain: false,
          },
        };
      }

      if (accessStatus === 'modified') {
        return {
          success: false,
          llmContent:
            'The file has been modified externally since the last successful Read. Use Read again before writing.',
          error: {
            type: ToolErrorType.VALIDATION_ERROR,
            message: 'File modified externally',
          },
          metadata: {
            file_path,
            sideEffectsUncertain: false,
          },
        };
      }
    }

    updateOutput?.('通过 IDE 写入文件...');
    const receipt = await commitVerifiedRemoteTextMutation({
      service: fsService,
      lease,
      filePath: remotePath,
      previous,
      intendedContent: content,
      operation: 'write',
      signal,
      deadlineAt,
    });
    if (receipt.writeVerified) {
      lease.commitVerified();
    }
    const metadata: WriteMetadata = {
      file_path,
      content_size: content.length,
      file_size: Buffer.byteLength(content, 'utf8'),
      encoding,
      summary: previous.exists
        ? `写入 ${basename(file_path)} 并完成远端回读校验`
        : `创建 ${basename(file_path)} 并完成远端回读校验`,
      kind: 'edit',
      oldContent: previous.exists ? previous.content : '',
      newContent: content,
      snapshot_created: false,
      write_acknowledged: receipt.writeAcknowledged,
      write_verified: receipt.writeVerified,
      sideEffectsUncertain: receipt.sideEffectsUncertain,
      requiresRead: receipt.requiresRead || undefined,
    };

    return {
      success: true,
      llmContent: previous.exists
        ? `Wrote ${file_path} (${content.length} chars, updated existing file)`
        : `Created ${file_path} (${content.length} chars, new file)`,
      metadata,
    };
  } catch (error) {
    if (error instanceof AcpRemoteMutationError && error.requiresRead) {
      return {
        success: false,
        llmContent:
          'Remote file state is uncertain for this path. Use Read on the same file to refresh remote state before retrying Write.',
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: 'Remote file state requires a fresh Read before mutation',
        },
        metadata: {
          file_path,
          file_size: Buffer.byteLength(content, 'utf8'),
          encoding,
          kind: 'edit',
          oldContent: getOldContent(previous),
          newContent: content,
          snapshot_created: false,
          write_acknowledged: error.writeAcknowledged,
          write_verified: error.writeVerified,
          sideEffectsUncertain: error.sideEffectsUncertain,
          requiresRead: true,
        },
      };
    }
    if (error instanceof AcpRemoteMutationError) {
      return {
        success: false,
        llmContent: `File write failed: ${error.message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: error.message,
        },
        metadata: {
          file_path,
          file_size: Buffer.byteLength(content, 'utf8'),
          encoding,
          kind: 'edit',
          oldContent: getOldContent(previous),
          newContent: content,
          snapshot_created: false,
          write_acknowledged: error.writeAcknowledged,
          write_verified: error.writeVerified,
          sideEffectsUncertain: error.sideEffectsUncertain,
          requiresRead: error.requiresRead || undefined,
        },
      };
    }
    if (requiresReadBoundary(error)) {
      return {
        success: false,
        llmContent:
          'Remote file state is uncertain for this path. Use Read on the same file to refresh remote state before retrying Write.',
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: 'Remote file state requires a fresh Read before mutation',
        },
        metadata: {
          file_path,
          write_acknowledged: false,
          write_verified: false,
          sideEffectsUncertain: true,
          requiresRead: true,
        },
      };
    }
    if (previous === undefined) {
      return {
        success: false,
        llmContent: 'File write failed: Unable to read remote file before write',
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: 'Unable to read remote file before write',
        },
        metadata: stableMetadata,
      };
    }
    throw error;
  } finally {
    lease.release();
  }
}
