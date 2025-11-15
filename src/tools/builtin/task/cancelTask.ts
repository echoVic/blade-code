/**
 * CancelTask Tool - 取消 Subagent 任务
 */

import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { getTaskManager } from './task.js';

/**
 * CancelTask 工具 - 取消任务
 */
export const cancelTaskTool = createTool({
  name: 'CancelTask',
  displayName: '取消任务',
  kind: ToolKind.Execute,
  isReadOnly: false,

  schema: z.object({
    task_id: z.string().describe('要取消的任务 ID'),
  }),

  description: {
    short: '取消正在运行或等待中的 subagent 任务',
    long: `
取消一个 subagent 任务的执行。

**可取消的任务：**
- pending: 等待中的任务
- running: 正在运行的任务

**不可取消的任务：**
- completed: 已完成的任务
- failed: 已失败的任务
- cancelled: 已取消的任务

**注意：**
- 取消操作是异步的，任务可能不会立即停止
- 已经执行的操作无法回滚
- 取消后任务状态会变为 cancelled
    `.trim(),
    usageNotes: [
      '只能取消 pending 或 running 状态的任务',
      '取消操作不会回滚已执行的操作',
      '使用 TaskStatus 确认任务已取消',
    ],
    examples: [
      {
        description: '取消任务',
        params: {
          task_id: 'abc123',
        },
      },
    ],
  },

  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const { task_id } = params;

    try {
      const taskManager = getTaskManager();
      const task = taskManager.getTask(task_id);

      if (!task) {
        return {
          success: false,
          llmContent: `未找到任务 ${task_id}`,
          displayContent: `❌ 未找到任务 ${task_id}`,
          error: {
            type: ToolErrorType.VALIDATION_ERROR,
            message: `Task not found: ${task_id}`,
          },
        };
      }

      // 检查任务状态
      if (task.status !== 'pending' && task.status !== 'running') {
        return {
          success: false,
          llmContent: `任务 ${task_id} 无法取消，当前状态: ${task.status}`,
          displayContent: `⚠️ 无法取消任务\n\n任务状态: ${task.status}\n只能取消 pending 或 running 状态的任务`,
          error: {
            type: ToolErrorType.VALIDATION_ERROR,
            message: `Cannot cancel task in ${task.status} state`,
          },
        };
      }

      // 取消任务
      const cancelled = taskManager.cancelTask(task_id);

      if (cancelled) {
        return {
          success: true,
          llmContent: {
            task_id,
            status: 'cancelled',
            message: '任务已取消',
          },
          displayContent:
            `✅ 任务已取消\n\n` +
            `任务 ID: ${task_id}\n` +
            `Subagent: ${task.agentName}\n` +
            `描述: ${task.params.description || '无'}`,
          metadata: {
            task_id,
            previous_status: task.status,
          },
        };
      } else {
        return {
          success: false,
          llmContent: `取消任务 ${task_id} 失败`,
          displayContent: `❌ 取消任务失败\n\n任务 ID: ${task_id}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: 'Failed to cancel task',
          },
        };
      }
    } catch (error: any) {
      return {
        success: false,
        llmContent: `取消任务失败: ${error.message}`,
        displayContent: `❌ 取消任务失败\n\n${error.message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: error.message,
        },
      };
    }
  },

  version: '1.0.0',
  category: '任务工具',
  tags: ['task', 'cancel', 'control'],

  extractSignatureContent: (params) => params.task_id,
  abstractPermissionRule: () => '',
});
