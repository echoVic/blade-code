import { promises as fs } from 'node:fs';
import { z } from 'zod';
import type { ExecutionContext } from '../../../tools/types/ExecutionTypes.js';
import type { ToolResult } from '../../../tools/types/ToolTypes.js';
import { ToolErrorType, ToolKind } from '../../../tools/types/ToolTypes.js';
import { createTool } from '../../core/createTool.js';
import { SnapshotManager } from './SnapshotManager.js';

/**
 * UndoEdit 工具参数 Schema
 */
const undoEditParamsSchema = z.object({
  file_path: z.string().describe('要回滚的文件绝对路径'),
  message_id: z
    .string()
    .optional()
    .describe('要回滚到的消息 ID（可选，如果未提供则列出历史版本）'),
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
      llmContent: '错误：缺少 sessionId，无法执行回滚操作',
      displayContent: '❌ 错误：缺少会话 ID',
      error: {
        type: ToolErrorType.VALIDATION_ERROR,
        message: '缺少 sessionId',
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
          llmContent: `文件 ${file_path} 没有可用的历史版本`,
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
        llmContent: `错误：文件不存在: ${file_path}`,
        displayContent: `❌ 错误：文件不存在\n📂 路径: ${file_path}`,
        error: {
          type: ToolErrorType.VALIDATION_ERROR,
          message: `文件不存在: ${file_path}`,
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
        llmContent: `错误：未找到消息 ID 为 "${message_id}" 的快照`,
        displayContent: `❌ 错误：未找到快照\n📂 文件: ${file_path}\n🔍 消息 ID: ${message_id}`,
        error: {
          type: ToolErrorType.VALIDATION_ERROR,
          message: `未找到消息 ID 为 "${message_id}" 的快照`,
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
      llmContent: `回滚失败: ${error.message}`,
      displayContent: `❌ 回滚失败\n📂 文件: ${file_path}\n⚠️ 错误: ${error.message}`,
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: error.message,
      },
    };
  }
}

/**
 * UndoEdit 工具
 */
export const undoEditTool = createTool({
  name: 'UndoEdit',
  displayName: '文件回滚',
  kind: ToolKind.Edit,
  strict: true,
  isConcurrencySafe: false, // 文件操作不支持并发
  schema: undoEditParamsSchema,
  description: {
    short: '回滚文件到历史版本',
    long: `将文件恢复到之前的编辑版本。支持两种模式：
1. 列出历史版本：不提供 message_id，列出所有可用的历史版本
2. 回滚到指定版本：提供 message_id，恢复文件到该版本的状态`,
    usageNotes: [
      '需要提供文件的绝对路径',
      '如果不提供 message_id，将列出该文件的所有历史版本',
      '提供 message_id 将恢复文件到该消息对应的版本',
      '回滚操作会覆盖当前文件内容，请谨慎使用',
      '历史版本存储在 ~/.blade/file-history/{sessionId}/ 目录',
      '每个文件默认保留最近 10 个快照',
    ],
    examples: [
      {
        description: '列出文件的所有历史版本',
        params: {
          file_path: '/path/to/file.ts',
        },
      },
      {
        description: '回滚文件到特定消息的版本',
        params: {
          file_path: '/path/to/file.ts',
          message_id: 'msg_abc123',
        },
      },
    ],
    important: [
      '回滚操作不可逆，会覆盖当前文件内容',
      '建议先列出历史版本，确认 message_id 后再执行回滚',
      '只能回滚当前会话中编辑过的文件',
    ],
  },
  execute: executeUndoEdit,
  version: '1.0.0',
  category: 'file',
  tags: ['file', 'undo', 'rollback', 'history'],
});
