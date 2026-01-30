/**
 * ExitSpecMode Tool
 *
 * 退出 Spec 模式，可选归档变更
 */

import { z } from 'zod';
import { SpecManager } from '../../../spec/SpecManager.js';
import { PHASE_DISPLAY_NAMES } from '../../../spec/types.js';
import { createTool } from '../../core/createTool.js';
import type { ToolResult } from '../../types/ToolTypes.js';
import { ToolErrorType, ToolKind } from '../../types/ToolTypes.js';

export const exitSpecModeTool = createTool({
  name: 'ExitSpecMode',
  displayName: 'Exit Spec Mode',
  kind: ToolKind.ReadOnly,

  schema: z.object({
    archive: z
      .boolean()
      .optional()
      .default(false)
      .describe('If true, archive the spec (mark as done and move to archive)'),
    summary: z
      .string()
      .optional()
      .describe('Optional summary of what was accomplished'),
  }),

  description: {
    short: 'Exit Spec mode and optionally archive the completed spec',
    long: `Use this tool to exit Spec-Driven Development mode.

## Options

- **archive: false** (default): Exit spec mode but keep the spec in .blade/changes/ for later
- **archive: true**: Mark spec as done and move to .blade/archive/

## When to Use

1. **Completed Implementation**: Set archive: true when all tasks are done
2. **Pausing Work**: Set archive: false to continue later
3. **Switching Context**: Exit to work on something else

## What Happens

### Without Archive
- Spec remains in .blade/changes/<feature>/
- Can resume later with /spec load <feature>
- Progress is preserved

### With Archive
- Spec moves to .blade/archive/<feature>/
- Any spec deltas merge to .blade/specs/
- Marked as complete in history

## Example

\`\`\`
// Just exit, keep spec for later
ExitSpecMode({})

// Complete and archive
ExitSpecMode({ archive: true, summary: "Implemented OAuth2 authentication" })
\`\`\`
`,
  },

  async execute(params, context): Promise<ToolResult> {
    const { archive, summary } = params;

    const specManager = SpecManager.getInstance();
    const currentSpec = specManager.getCurrentSpec();

    if (!currentSpec) {
      return {
        success: false,
        llmContent: 'No active spec to exit from.',
        displayContent: '❌ No active spec',
        error: {
          type: ToolErrorType.VALIDATION_ERROR,
          message: 'No active spec project',
        },
      };
    }

    try {
      const featureName = currentSpec.name;
      const currentPhase = currentSpec.phase;
      const progress = specManager.getTaskProgress();

      // Request confirmation for archive
      if (archive && context.confirmationHandler) {
        const incompleteWarning =
          progress.total > 0 && progress.completed < progress.total
            ? `\n\n⚠️ Warning: ${progress.total - progress.completed} tasks are not completed.`
            : '';

        const response = await context.confirmationHandler.requestConfirmation({
          title: 'Archive Spec',
          message:
            `Archive spec "${featureName}"?\n\n` +
            `Phase: ${PHASE_DISPLAY_NAMES[currentPhase]}\n` +
            `Tasks: ${progress.completed}/${progress.total} completed` +
            incompleteWarning,
          details: 'This will move the spec to archive and merge any spec deltas.',
        });

        if (!response.approved) {
          return {
            success: true,
            llmContent: 'Archive cancelled. Still in Spec mode.',
            displayContent: '⚠️ Archive cancelled',
            metadata: {
              archived: false,
              stillActive: true,
            },
          };
        }
      }

      // Perform archive if requested
      if (archive) {
        const result = await specManager.archiveCurrentSpec();
        if (!result.success) {
          return {
            success: false,
            llmContent: `Failed to archive: ${result.message}`,
            displayContent: '❌ Archive failed',
            error: {
              type: ToolErrorType.EXECUTION_ERROR,
              message: result.error || 'Archive failed',
            },
          };
        }

        return {
          success: true,
          llmContent:
            `✅ Spec "${featureName}" archived successfully!\n\n` +
            `📊 Final Status:\n` +
            `- Phase: ${PHASE_DISPLAY_NAMES[currentPhase]}\n` +
            `- Tasks: ${progress.completed}/${progress.total} completed\n` +
            (summary ? `- Summary: ${summary}\n` : '') +
            `\n📁 Location: .blade/archive/${featureName}/\n\n` +
            'Exited Spec mode. You can start a new spec or continue with regular work.',
          displayContent: `✅ Archived: ${featureName}`,
          metadata: {
            archived: true,
            featureName,
            phase: currentPhase,
            taskProgress: progress,
            summary,
            shouldExitSpecMode: true,
          },
        };
      }

      // Just exit without archiving
      specManager.exitSpecMode();

      return {
        success: true,
        llmContent:
          `✅ Exited Spec mode for "${featureName}"\n\n` +
          `📊 Current Status:\n` +
          `- Phase: ${PHASE_DISPLAY_NAMES[currentPhase]}\n` +
          `- Tasks: ${progress.completed}/${progress.total} completed\n\n` +
          `📁 Spec preserved at: .blade/changes/${featureName}/\n` +
          `💡 Resume later with: /spec load ${featureName}\n\n` +
          'You can now work on other tasks or start a new spec.',
        displayContent: `✅ Exited: ${featureName} (preserved)`,
        metadata: {
          archived: false,
          featureName,
          phase: currentPhase,
          taskProgress: progress,
          shouldExitSpecMode: true,
        },
      };
    } catch (error) {
      return {
        success: false,
        llmContent: `Exit failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        displayContent: '❌ Exit failed',
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: error instanceof Error ? error.message : 'Exit error',
        },
      };
    }
  },
});
