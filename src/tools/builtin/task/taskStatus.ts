/**
 * TaskStatus Tool - 查询 Subagent 任务状态
 */

import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { getTaskManager } from './task.js';

/**
 * TaskStatus 工具 - 查询任务状态
 */
export const taskStatusTool = createTool({
  name: 'TaskStatus',
  displayName: '查询任务状态',
  kind: ToolKind.Read,
  isReadOnly: true,

  schema: z.object({
    task_id: z.string().describe('任务 ID'),
  }),

  description: {
    short: '查询 subagent 任务的执行状态和结果',
    long: `
查询后台或已完成的 subagent 任务的状态。

**返回信息：**
- 任务状态（pending, running, completed, failed, cancelled）
- 执行进度（已完成的回合数）
- 执行结果（如果已完成）
- Token 使用情况
- 错误信息（如果失败）

**适用场景：**
- 查看后台任务的进度
- 获取已完成任务的结果
- 检查任务是否失败
    `.trim(),
    usageNotes: [
      '使用 Task 工具返回的 task_id 查询状态',
      '后台任务需要定期查询以获取最新状态',
      '已完成的任务会返回完整的执行结果',
    ],
    examples: [
      {
        description: '查询任务状态',
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

      // 格式化状态
      const statusEmoji = {
        pending: '⏳',
        running: '🔄',
        completed: '✅',
        failed: '❌',
        cancelled: '🚫',
      }[task.status];

      const statusText = {
        pending: '等待中',
        running: '运行中',
        completed: '已完成',
        failed: '失败',
        cancelled: '已取消',
      }[task.status];

      let displayContent = `${statusEmoji} 任务状态: ${statusText}\n\n`;
      displayContent += `任务 ID: ${task_id}\n`;
      displayContent += `Subagent: ${task.agentName}\n`;
      displayContent += `创建时间: ${new Date(task.createdAt).toLocaleString()}\n`;

      if (task.startedAt) {
        displayContent += `开始时间: ${new Date(task.startedAt).toLocaleString()}\n`;
      }

      if (task.completedAt) {
        displayContent += `完成时间: ${new Date(task.completedAt).toLocaleString()}\n`;
        const duration = task.completedAt - task.createdAt;
        displayContent += `总耗时: ${duration}ms\n`;
      }

      // 如果有结果
      if (task.result) {
        displayContent += `\n回合数: ${task.result.turns}\n`;
        displayContent += `执行时长: ${task.result.duration}ms\n`;

        if (task.result.tokenUsage) {
          displayContent += `Token 使用: ${task.result.tokenUsage.total}\n`;
        }

        displayContent += `终止原因: ${task.result.terminateReason}\n`;

        if (task.result.output) {
          displayContent += `\n结果:\n`;
          const outputText =
            typeof task.result.output === 'string'
              ? task.result.output
              : JSON.stringify(task.result.output, null, 2);

          displayContent +=
            outputText.length > 500
              ? outputText.slice(0, 500) + '...(截断)'
              : outputText;
        }
      }

      // 如果有错误
      if (task.error) {
        displayContent += `\n错误: ${task.error}\n`;
      }

      return {
        success: true,
        llmContent: {
          task_id,
          status: task.status,
          agent_name: task.agentName,
          result: task.result,
          error: task.error,
          created_at: task.createdAt,
          started_at: task.startedAt,
          completed_at: task.completedAt,
        },
        displayContent,
        metadata: {
          task_id,
          status: task.status,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        llmContent: `查询任务状态失败: ${error.message}`,
        displayContent: `❌ 查询失败\n\n${error.message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: error.message,
        },
      };
    }
  },

  version: '1.0.0',
  category: '任务工具',
  tags: ['task', 'status', 'query'],

  extractSignatureContent: (params) => params.task_id,
  abstractPermissionRule: () => '',
});
