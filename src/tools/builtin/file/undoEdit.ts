import { promises as fs } from 'node:fs';
import { z } from 'zod';
import type { ExecutionContext } from '../../../tools/types/ExecutionTypes.js';
import type { ToolResult } from '../../../tools/types/ToolTypes.js';
import { ToolErrorType, ToolKind } from '../../../tools/types/ToolTypes.js';
import { createTool } from '../../core/createTool.js';
import { SnapshotManager } from './SnapshotManager.js';

/**
 * UndoEdit tool params schema
*/
const undoEditParamsSchema = z.object({
  file_path: z.string().describe('Absolute path of the file to roll back'),
  message_id: z
    .string()
    .optional()
    .describe('Message ID to restore to (optional; list snapshots if omitted)'),
});

type UndoEditParams = z.infer<typeof undoEditParamsSchema>;

/**
 * 执行文件回滚
 */
async function executeUndoEdit(
  params: UndoEditParams,
  context: ExecutionContext
): Promise<ToolResult> {
  const { file_path, message_id } = params;
  const sessionId = context.sessionId;

  if (!sessionId) {
    return {
      success: false,
      llmContent: 'Error: Missing sessionId; cannot perform rollback',
      displayContent: '❌ 错误：缺少会话 ID',
      error: {
        type: ToolErrorType.VALIDATION_ERROR,
        message: 'Missing sessionId',
      },
    };
  }

  // 创建 SnapshotManager 实例
  const snapshotManager = new SnapshotManager({ sessionId });

  try {
    // 如果未提供 message_id，列出所有历史版本
    if (!message_id) {
      const snapshots = await snapshotManager.listSnapshots(file_path);

      if (snapshots.length === 0) {
        return {
          success: true,
          llmContent: `File ${file_path} has no available snapshots`,
          displayContent: `📂 文件: ${file_path}\n❌ 没有可用的历史版本`,
        };
      }

      // 按时间倒序排列（最新的在前）
      const sortedSnapshots = snapshots.sort(
        (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
      );

      // 格式化历史版本列表
      let displayMessage = `📂 文件: ${file_path}\n`;
      displayMessage += `📜 可用的历史版本（共 ${sortedSnapshots.length} 个）:\n\n`;

      for (let i = 0; i < sortedSnapshots.length; i++) {
        const snapshot = sortedSnapshots[i];
        const timeStr = snapshot.timestamp.toLocaleString('zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });

        displayMessage += `${i + 1}. [${snapshot.messageId}]\n`;
        displayMessage += `   📅 时间: ${timeStr}\n`;
        displayMessage += `   📄 快照: ${snapshot.backupFileName}\n`;
        if (i < sortedSnapshots.length - 1) {
          displayMessage += '\n';
        }
      }

      displayMessage += '\n💡 提示: 使用 UndoEdit 并指定 message_id 来恢复特定版本';

      return {
        success: true,
        llmContent: {
          file_path,
          snapshot_count: sortedSnapshots.length,
          snapshots: sortedSnapshots.map((s) => ({
            message_id: s.messageId,
            timestamp: s.timestamp.toISOString(),
            backup_file_name: s.backupFileName,
          })),
        },
        displayContent: displayMessage,
      };
    }

    // 执行回滚操作
    // 首先检查文件是否存在
    try {
      await fs.access(file_path);
    } catch {
      return {
        success: false,
        llmContent: `Error: File not found: ${file_path}`,
        displayContent: `❌ 错误：文件不存在\n📂 路径: ${file_path}`,
        error: {
          type: ToolErrorType.VALIDATION_ERROR,
          message: `File not found: ${file_path}`,
        },
      };
    }

    // 检查快照是否存在
    const snapshots = await snapshotManager.listSnapshots(file_path);
    const targetSnapshot = snapshots
      .slice()
      .reverse()
      .find((s) => s.messageId === message_id);

    if (!targetSnapshot) {
      return {
        success: false,
        llmContent: `Error: No snapshot found for message ID "${message_id}"`,
        displayContent: `❌ 错误：未找到快照\n📂 文件: ${file_path}\n🔍 消息 ID: ${message_id}`,
        error: {
          type: ToolErrorType.VALIDATION_ERROR,
          message: `No snapshot found for message ID "${message_id}"`,
        },
      };
    }

    // 执行恢复
    await snapshotManager.restoreSnapshot(file_path, message_id);

    const timeStr = targetSnapshot.timestamp.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const displayMessage =
      `✅ 成功回滚文件到历史版本\n` +
      `📂 文件: ${file_path}\n` +
      `🔄 消息 ID: ${message_id}\n` +
      `📅 快照时间: ${timeStr}\n` +
      `💡 提示: 文件已恢复到此版本的状态`;

    return {
      success: true,
      llmContent: {
        file_path,
        message_id,
        snapshot_time: targetSnapshot.timestamp.toISOString(),
        backup_file_name: targetSnapshot.backupFileName,
      },
      displayContent: displayMessage,
    };
  } catch (error: any) {
    return {
      success: false,
      llmContent: `Rollback failed: ${error.message}`,
      displayContent: `❌ 回滚失败\n📂 文件: ${file_path}\n⚠️ 错误: ${error.message}`,
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: error.message,
      },
    };
  }
}

/**
 * UndoEdit tool
*/
export const undoEditTool = createTool({
  name: 'UndoEdit',
  displayName: 'File Rollback',
  kind: ToolKind.Edit,
  strict: true,
  isConcurrencySafe: false, // 文件操作不支持并发
  schema: undoEditParamsSchema,
  description: {
    short: 'Restore a file to a previous snapshot',
    long: `Revert a file to an earlier edited version. Two modes:
1. List snapshots: omit message_id to list available versions
2. Restore snapshot: provide message_id to restore that version`,
    usageNotes: [
      'Requires an absolute file path',
      'Omitting message_id lists all snapshots for the file',
      'Providing message_id restores that snapshot',
      'Rollback overwrites current file content—use carefully',
      'Snapshots stored in ~/.blade/file-history/{sessionId}/',
      'Each file keeps the latest 10 snapshots by default',
    ],
    examples: [
      {
        description: 'List all snapshots for a file',
        params: {
          file_path: '/path/to/file.ts',
        },
      },
      {
        description: 'Restore file to a specific message snapshot',
        params: {
          file_path: '/path/to/file.ts',
          message_id: 'msg_abc123',
        },
      },
    ],
    important: [
      'Rollback is irreversible and overwrites the current file',
      'List snapshots first to confirm message_id before restoring',
      'Only files edited in the current session can be restored',
    ],
  },
  execute: executeUndoEdit,
  version: '1.0.0',
  category: 'file',
  tags: ['file', 'undo', 'rollback', 'history'],
});
