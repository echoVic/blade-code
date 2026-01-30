/**
 * GetSpecContext Tool
 *
 * 获取当前 Spec 的完整上下文信息
 */

import { z } from 'zod';
import { SpecManager } from '../../../spec/SpecManager.js';
import { PHASE_DISPLAY_NAMES } from '../../../spec/types.js';
import { createTool } from '../../core/createTool.js';
import type { ToolResult } from '../../types/ToolTypes.js';
import { ToolErrorType, ToolKind } from '../../types/ToolTypes.js';

export const getSpecContextTool = createTool({
  name: 'GetSpecContext',
  displayName: 'Get Spec Context',
  kind: ToolKind.ReadOnly,

  schema: z.object({
    includeFiles: z
      .boolean()
      .optional()
      .default(true)
      .describe('Whether to include file contents in the context'),
    includeSteering: z
      .boolean()
      .optional()
      .default(true)
      .describe('Whether to include steering documents'),
  }),

  description: {
    short: 'Get the current Spec context including metadata, files, and steering docs',
    long: `Use this tool to retrieve the complete context of the current Spec project.

## What's Included

1. **Metadata**: Name, description, phase, timestamps, task progress
2. **Spec Files**: Contents of proposal, spec, requirements, design, tasks
3. **Steering Docs**: Project-wide governance documents (constitution, product, tech, structure)
4. **Task Status**: Current task, completion progress, blocked items

## When to Use

- At the start of a Spec mode session to understand current state
- Before transitioning to a new phase
- To review progress and remaining work
- To understand project governance (steering docs)

## Example Output

\`\`\`
📋 Spec: user-authentication
📝 Description: Implement OAuth2 user authentication
📊 Phase: design (2/4)
📈 Tasks: 3/8 completed (37%)

[File contents and steering docs follow...]
\`\`\`
`,
  },

  async execute(params, _context): Promise<ToolResult> {
    const { includeFiles, includeSteering } = params;

    const specManager = SpecManager.getInstance();
    const currentSpec = specManager.getCurrentSpec();

    if (!currentSpec) {
      return {
        success: false,
        llmContent: 'No active spec. Use EnterSpecMode or /spec load <name> first.',
        displayContent: '❌ No active spec',
        error: {
          type: ToolErrorType.VALIDATION_ERROR,
          message: 'No active spec project',
        },
      };
    }

    try {
      const fileManager = specManager.getFileManager();
      const parts: string[] = [];

      // Header
      parts.push(`# 📋 Spec: ${currentSpec.name}`);
      parts.push(`**Description**: ${currentSpec.description}`);
      parts.push(
        `**Phase**: ${PHASE_DISPLAY_NAMES[currentSpec.phase]} (${currentSpec.phase})`
      );
      parts.push(`**Created**: ${new Date(currentSpec.createdAt).toLocaleString()}`);
      parts.push(`**Updated**: ${new Date(currentSpec.updatedAt).toLocaleString()}`);

      // Task progress
      const progress = specManager.getTaskProgress();
      if (progress.total > 0) {
        parts.push(
          `**Tasks**: ${progress.completed}/${progress.total} completed (${progress.percentage}%)`
        );

        // Current task
        if (currentSpec.currentTaskId) {
          const currentTask = currentSpec.tasks.find(
            (t) => t.id === currentSpec.currentTaskId
          );
          if (currentTask) {
            parts.push(`**Current Task**: ${currentTask.title}`);
          }
        }

        // Blocked tasks
        const blockedTasks = currentSpec.tasks.filter((t) => t.status === 'blocked');
        if (blockedTasks.length > 0) {
          parts.push(`**⚠️ Blocked**: ${blockedTasks.map((t) => t.title).join(', ')}`);
        }
      }

      parts.push('');

      // Include steering documents
      if (includeSteering) {
        const steeringContext = await specManager.getSteeringContextString();
        if (steeringContext) {
          parts.push('---');
          parts.push('## 📖 Steering Documents');
          parts.push('');
          parts.push(steeringContext);
          parts.push('');
        }
      }

      // Include file contents
      if (includeFiles) {
        const fileTypes = [
          'proposal',
          'spec',
          'requirements',
          'design',
          'tasks',
        ] as const;

        for (const fileType of fileTypes) {
          const content = await fileManager.readSpecFile(currentSpec.name, fileType);
          if (content) {
            parts.push('---');
            parts.push(`## 📄 ${fileType}.md`);
            parts.push('');
            parts.push(content);
            parts.push('');
          }
        }
      }

      // Task list summary
      if (currentSpec.tasks.length > 0) {
        parts.push('---');
        parts.push('## 📝 Task List');
        parts.push('');
        for (const task of currentSpec.tasks) {
          const statusEmoji = {
            pending: '⏳',
            in_progress: '🔄',
            completed: '✅',
            blocked: '🚫',
            skipped: '⏭️',
          }[task.status];
          parts.push(
            `- ${statusEmoji} **${task.title}** (${task.complexity}) - ${task.status}`
          );
          if (task.description) {
            parts.push(`  ${task.description}`);
          }
        }
      }

      const fullContent = parts.join('\n');

      return {
        success: true,
        llmContent: fullContent,
        displayContent: `📋 Spec context: ${currentSpec.name} (${currentSpec.phase})`,
        metadata: {
          featureName: currentSpec.name,
          phase: currentSpec.phase,
          taskProgress: progress,
          filesIncluded: includeFiles,
          steeringIncluded: includeSteering,
        },
      };
    } catch (error) {
      return {
        success: false,
        llmContent: `Failed to get spec context: ${error instanceof Error ? error.message : 'Unknown error'}`,
        displayContent: '❌ Failed to get spec context',
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: error instanceof Error ? error.message : 'Read error',
        },
      };
    }
  },
});
