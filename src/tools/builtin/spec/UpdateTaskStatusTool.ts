/**
 * UpdateTaskStatus Tool
 *
 * 更新任务状态
 */

import { z } from 'zod';
import { SpecManager } from '../../../spec/SpecManager.js';
import type { TaskStatus } from '../../../spec/types.js';
import { createTool } from '../../core/createTool.js';
import type { ToolResult } from '../../types/ToolTypes.js';
import { ToolErrorType, ToolKind } from '../../types/ToolTypes.js';

const STATUS_DISPLAY: Record<TaskStatus, string> = {
  pending: '⏳ 待处理',
  in_progress: '🔄 进行中',
  completed: '✅ 已完成',
  blocked: '🚫 已阻塞',
  skipped: '⏭️ 已跳过',
};

export const updateTaskStatusTool = createTool({
  name: 'UpdateTaskStatus',
  displayName: 'Update Task Status',
  kind: ToolKind.Write,

  schema: z.object({
    taskId: z.string().min(1).describe('The ID of the task to update'),
    status: z
      .enum(['pending', 'in_progress', 'completed', 'blocked', 'skipped'])
      .describe('The new status for the task'),
    notes: z
      .string()
      .optional()
      .describe('Optional notes about the status change (e.g., why blocked)'),
  }),

  description: {
    short: 'Update the status of a task in the current Spec',
    long: `Use this tool to update the status of tasks in the current Spec project.

## Task Statuses

- **pending**: Task not yet started (default)
- **in_progress**: Currently working on this task
- **completed**: Task finished successfully
- **blocked**: Cannot proceed due to external dependency or issue
- **skipped**: Intentionally skipped (e.g., no longer needed)

## Workflow

1. Before starting a task: Set status to "in_progress"
2. After completing: Set status to "completed"
3. If stuck: Set status to "blocked" with notes explaining why

## Example Usage

\`\`\`
UpdateTaskStatus({
  taskId: "abc12345",
  status: "completed",
  notes: "Implemented user model with all required fields"
})
\`\`\`

## Notes

- Use GetSpecContext to see all tasks and their current statuses
- Only one task should be "in_progress" at a time
- Completing a task may unblock dependent tasks
`,
  },

  async execute(params, context): Promise<ToolResult> {
    const { taskId, status, notes } = params;

    // Validate we're in Spec mode
    const specManager = SpecManager.getInstance();
    const currentSpec = specManager.getCurrentSpec();

    if (!currentSpec) {
      return {
        success: false,
        llmContent:
          'No active spec. Use EnterSpecMode to start a new spec project, ' +
          'or use the /spec command to load an existing one.',
        displayContent: '❌ No active spec',
        error: {
          type: ToolErrorType.VALIDATION_ERROR,
          message: 'No active spec project',
        },
      };
    }

    // Find the task first to get its title
    const task = currentSpec.tasks.find((t) => t.id === taskId);
    if (!task) {
      return {
        success: false,
        llmContent:
          `Task "${taskId}" not found.\n\n` +
          `Available tasks:\n${currentSpec.tasks.map((t) => `- ${t.id}: ${t.title}`).join('\n') || 'No tasks'}`,
        displayContent: `❌ Task not found: ${taskId}`,
        error: {
          type: ToolErrorType.VALIDATION_ERROR,
          message: 'Task not found',
        },
      };
    }

    // Update the status
    const result = await specManager.updateTaskStatus(taskId, status as TaskStatus);

    if (!result.success) {
      return {
        success: false,
        llmContent: `Failed to update task status: ${result.message}`,
        displayContent: `❌ Failed to update: ${result.message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: result.message,
        },
      };
    }

    const progress = specManager.getTaskProgress();
    const nextTask = specManager.getNextTask();

    let nextTaskInfo = '';
    if (status === 'completed' && nextTask) {
      nextTaskInfo = `\n\n🎯 Next task: "${nextTask.title}" (${nextTask.id})`;
    } else if (status === 'completed' && progress.completed === progress.total) {
      nextTaskInfo =
        '\n\n🎉 All tasks completed! Use /spec archive to archive this spec.';
    }

    return {
      success: true,
      llmContent:
        `✅ Updated task "${task.title}"\n\n` +
        `📋 Task ID: ${taskId}\n` +
        `📊 Status: ${STATUS_DISPLAY[status as TaskStatus]}\n` +
        (notes ? `📝 Notes: ${notes}\n` : '') +
        `\n📈 Progress: ${progress.completed}/${progress.total} tasks (${progress.percentage}%)` +
        nextTaskInfo,
      displayContent: `✅ ${task.title}: ${STATUS_DISPLAY[status as TaskStatus]}`,
      metadata: {
        taskId,
        title: task.title,
        status,
        notes,
        progress: {
          completed: progress.completed,
          total: progress.total,
          percentage: progress.percentage,
        },
      },
    };
  },
});
