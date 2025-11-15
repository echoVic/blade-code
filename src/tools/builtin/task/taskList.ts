/**
 * TaskList Tool - 列出 Subagent 任务
 */

import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolKind } from '../../types/index.js';
import { getTaskManager } from './task.js';

/**
 * TaskList 工具 - 列出任务
 */
export const taskListTool = createTool({
  name: 'TaskList',
  displayName: '列出任务',
  kind: ToolKind.Read,
  isReadOnly: true,

  schema: z.object({
    status: z
      .enum(['pending', 'running', 'completed', 'failed', 'cancelled'])
      .optional()
      .describe('按状态过滤'),
    agent_name: z.string().optional().describe('按 subagent 名称过滤'),
    limit: z.number().int().positive().default(10).describe('返回的最大任务数'),
  }),

  description: {
    short: '列出 subagent 任务',
    long: `
列出所有或特定条件的 subagent 任务。

**过滤选项：**
- status: 按状态过滤（pending, running, completed, failed, cancelled）
- agent_name: 按 subagent 类型过滤
- limit: 限制返回数量（默认 10）

**返回信息：**
- 任务 ID
- 状态
- Subagent 类型
- 创建时间
- 简要描述

**适用场景：**
- 查看所有运行中的任务
- 查看最近完成的任务
- 查看特定 subagent 的任务历史
    `.trim(),
    usageNotes: [
      '默认返回最近的 10 个任务',
      '使用 status 参数查看特定状态的任务',
      '使用 agent_name 参数查看特定 subagent 的任务',
    ],
    examples: [
      {
        description: '列出所有运行中的任务',
        params: {
          status: 'running',
        },
      },
      {
        description: '列出最近 5 个已完成的任务',
        params: {
          status: 'completed',
          limit: 5,
        },
      },
      {
        description: '列出 file-search 的任务',
        params: {
          agent_name: 'file-search',
        },
      },
    ],
  },

  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const { status, agent_name, limit = 10 } = params;

    try {
      const taskManager = getTaskManager();
      const tasks = taskManager.listTasks({
        status,
        agentName: agent_name,
        limit,
      });

      if (tasks.length === 0) {
        return {
          success: true,
          llmContent: { tasks: [], count: 0 },
          displayContent: '📋 没有找到任务',
        };
      }

      // 格式化输出
      let displayContent = `📋 找到 ${tasks.length} 个任务\n\n`;

      for (const task of tasks) {
        const statusEmoji = {
          pending: '⏳',
          running: '🔄',
          completed: '✅',
          failed: '❌',
          cancelled: '🚫',
        }[task.status];

        displayContent += `${statusEmoji} ${task.id.slice(0, 8)}... - ${task.agentName}\n`;
        displayContent += `   状态: ${task.status}\n`;
        displayContent += `   创建: ${new Date(task.createdAt).toLocaleString()}\n`;

        if (task.params.description) {
          displayContent += `   描述: ${task.params.description}\n`;
        }

        if (task.result) {
          displayContent += `   回合: ${task.result.turns}, 耗时: ${task.result.duration}ms\n`;
        }

        displayContent += '\n';
      }

      // 统计信息
      const stats = taskManager.getStats();
      displayContent += `\n统计: 总计 ${stats.total} 个任务, 运行中 ${stats.running} 个`;

      return {
        success: true,
        llmContent: {
          tasks: tasks.map((t) => ({
            task_id: t.id,
            status: t.status,
            agent_name: t.agentName,
            description: t.params.description,
            created_at: t.createdAt,
            completed_at: t.completedAt,
          })),
          count: tasks.length,
          stats,
        },
        displayContent,
        metadata: {
          count: tasks.length,
          stats,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        llmContent: `列出任务失败: ${error.message}`,
        displayContent: `❌ 列出任务失败\n\n${error.message}`,
        error: {
          type: 'execution_error',
          message: error.message,
        },
      };
    }
  },

  version: '1.0.0',
  category: '任务工具',
  tags: ['task', 'list', 'query'],

  extractSignatureContent: () => 'list_tasks',
  abstractPermissionRule: () => '',
});
