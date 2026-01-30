/**
 * ValidateSpec Tool
 *
 * 验证当前 Spec 的完整性和一致性
 */

import { z } from 'zod';
import { SpecManager } from '../../../spec/SpecManager.js';
import { PHASE_DISPLAY_NAMES } from '../../../spec/types.js';
import { createTool } from '../../core/createTool.js';
import type { ToolResult } from '../../types/ToolTypes.js';
import { ToolErrorType, ToolKind } from '../../types/ToolTypes.js';

export const validateSpecTool = createTool({
  name: 'ValidateSpec',
  displayName: 'Validate Spec',
  kind: ToolKind.ReadOnly,

  schema: z.object({}),

  description: {
    short: 'Validate the completeness and consistency of the current Spec',
    long: `Use this tool to check if the current Spec project is complete and ready for the next phase.

## What's Validated

1. **File Completeness**: Which spec files exist and have content
2. **Phase Appropriateness**: Whether current phase matches file state
3. **Task Status**: Progress on defined tasks
4. **Consistency**: Cross-references between files

## Validation Levels

- **Error**: Critical issues that must be fixed
- **Warning**: Recommended improvements
- **Info**: Informational notes

## When to Use

- Before transitioning to a new phase
- To review what's missing
- Before marking spec as done
- To get improvement suggestions
`,
  },

  async execute(_params, _context): Promise<ToolResult> {
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
      const validation = await specManager.validateCurrentSpec();
      const parts: string[] = [];

      // Header
      parts.push(`# 🔍 Spec Validation: ${currentSpec.name}`);
      parts.push('');
      parts.push(`**Phase**: ${PHASE_DISPLAY_NAMES[validation.phase]}`);
      parts.push(`**Status**: ${validation.valid ? '✅ Valid' : '⚠️ Has Issues'}`);
      parts.push('');

      // File completeness
      parts.push('## 📄 File Completeness');
      parts.push('');
      const fileStatus = [
        ['proposal.md', validation.completeness.proposal],
        ['spec.md', validation.completeness.spec],
        ['requirements.md', validation.completeness.requirements],
        ['design.md', validation.completeness.design],
        ['tasks.md', validation.completeness.tasks],
      ];

      for (const [file, exists] of fileStatus) {
        parts.push(`- ${exists ? '✅' : '❌'} ${file}`);
      }
      parts.push('');

      // Issues
      if (validation.issues.length > 0) {
        parts.push('## ⚠️ Issues');
        parts.push('');
        for (const issue of validation.issues) {
          const icon = {
            error: '🔴',
            warning: '🟡',
            info: '🔵',
          }[issue.severity];
          parts.push(`- ${icon} **${issue.file}**: ${issue.message}`);
        }
        parts.push('');
      }

      // Suggestions
      if (validation.suggestions.length > 0) {
        parts.push('## 💡 Suggestions');
        parts.push('');
        for (const suggestion of validation.suggestions) {
          parts.push(`- ${suggestion}`);
        }
        parts.push('');
      }

      // Task progress
      const progress = specManager.getTaskProgress();
      if (progress.total > 0) {
        parts.push('## 📊 Task Progress');
        parts.push('');
        parts.push(`- Total: ${progress.total}`);
        parts.push(`- Completed: ${progress.completed}`);
        parts.push(`- Remaining: ${progress.total - progress.completed}`);
        parts.push(`- Progress: ${progress.percentage}%`);
        parts.push('');

        // Progress bar
        const filled = Math.round(progress.percentage / 5);
        const empty = 20 - filled;
        parts.push(`[${'█'.repeat(filled)}${'░'.repeat(empty)}]`);
      }

      // Next steps
      parts.push('');
      parts.push('## 🚀 Next Steps');
      parts.push('');
      if (!validation.valid) {
        parts.push('1. Address the issues listed above');
        parts.push('2. Re-run ValidateSpec to verify fixes');
      } else {
        const nextPhases = specManager.getAllowedTransitions();
        if (nextPhases.length > 0) {
          parts.push(
            `1. Ready to transition to: ${nextPhases.map((p) => PHASE_DISPLAY_NAMES[p]).join(', ')}`
          );
          parts.push('2. Use TransitionSpecPhase to proceed');
        } else {
          parts.push('1. All phases complete!');
          parts.push('2. Use ExitSpecMode to finish and archive');
        }
      }

      const fullContent = parts.join('\n');

      return {
        success: true,
        llmContent: fullContent,
        displayContent: validation.valid
          ? `✅ Spec valid: ${currentSpec.name}`
          : `⚠️ Spec has ${validation.issues.length} issue(s)`,
        metadata: {
          valid: validation.valid,
          phase: validation.phase,
          completeness: validation.completeness,
          issueCount: validation.issues.length,
          taskProgress: progress,
        },
      };
    } catch (error) {
      return {
        success: false,
        llmContent: `Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        displayContent: '❌ Validation failed',
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: error instanceof Error ? error.message : 'Validation error',
        },
      };
    }
  },
});
