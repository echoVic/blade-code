/**
 * AddTask Tool
 *
 * 向当前 Spec 添加任务
 */

import { z } from 'zod';
import { SpecManager } from '../../../spec/SpecManager.js';
import type { TaskComplexity } from '../../../spec/types.js';
import { createTool } from '../../core/createTool.js';
import type { ToolResult } from '../../types/ToolTypes.js';
import { ToolErrorType, ToolKind } from '../../types/ToolTypes.js';

export const addTaskTool = createTool({
  name: 'AddTask',
  displayName: 'Add Task',
  kind: ToolKind.Write,

  schema: z.object({
    title: z.string().min(1).describe('Brief title of the task'),
    description: z
      .string()
      .min(1)
      .describe('Detailed description of what needs to be done'),
    complexity: z
      .enum(['low', 'medium', 'high'])
      .optional()
      .default('medium')
      .describe('Estimated complexity of the task'),
    affectedFiles: z
      .array(z.string())
      .optional()
      .default([])
      .describe('List of files that will be modified by this task'),
    dependencies: z
      .array(z.string())
      .optional()
      .default([])
      .describe('IDs of tasks that must be completed before this one'),
  }),

  description: {
    short: 'Add a task to the current Spec project',
    long: `Use this tool to add tasks to the current Spec-Driven Development project.

## Task Structure

Each task should be:
- **Atomic**: Completable in 1-2 tool calls
- **Clear**: Has a specific, measurable outcome
- **Dependent-aware**: Lists prerequisites

## Parameters

- **title**: Short description (e.g., "Create User model")
- **description**: Detailed requirements and acceptance criteria
- **complexity**: low (simple change), medium (moderate), high (complex)
- **affectedFiles**: Files that will be created or modified
- **dependencies**: Task IDs that must complete first

## Example Usage

\`\`\`
AddTask({
  title: "Create User model",
  description: "Create a User model with fields: id, email, passwordHash, createdAt",
  complexity: "low",
  affectedFiles: ["src/models/User.ts", "src/db/schema.ts"],
  dependencies: []
})
\`\`\`

## Notes

- You must be in Spec mode and in tasks or implementation phase
- Tasks are tracked in .meta.json, not tasks.md
- Use UpdateTaskStatus to mark tasks as completed
- Use GetSpecContext to see current tasks and progress
`,
  },

  async execute(params, context): Promise<ToolResult> {
    const { title, description, complexity, affectedFiles, dependencies } = params;

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

    // Add the task
    const result = await specManager.addTask(title, description, {
      complexity: complexity as TaskComplexity,
      affectedFiles,
      dependencies,
    });

    if (!result.success) {
      return {
        success: false,
        llmContent: `Failed to add task: ${result.message}`,
        displayContent: `❌ Failed to add task: ${result.message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: result.message,
        },
      };
    }

    const task = result.data?.task;
    const progress = specManager.getTaskProgress();

    return {
      success: true,
      llmContent:
        `✅ Task added: "${title}"\n\n` +
        `📋 Task ID: ${task?.id}\n` +
        `📊 Complexity: ${complexity}\n` +
        `📁 Affected files: ${affectedFiles?.length ? affectedFiles.join(', ') : 'None specified'}\n` +
        `🔗 Dependencies: ${dependencies?.length ? dependencies.join(', ') : 'None'}\n\n` +
        `📈 Progress: ${progress.completed}/${progress.total} tasks (${progress.percentage}%)\n\n` +
        '💡 Use AddTask to add more tasks, or use /spec apply to start implementation.',
      displayContent: `✅ Added task: ${title} (ID: ${task?.id})`,
      metadata: {
        taskId: task?.id,
        title,
        complexity,
        affectedFiles,
        dependencies,
        totalTasks: progress.total,
      },
    };
  },
});
