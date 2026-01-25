/**
 * TransitionSpecPhase Tool
 *
 * 转换 Spec 工作流阶段
 */

import { z } from 'zod';
import { SpecManager } from '../../../spec/SpecManager.js';
import {
  PHASE_DISPLAY_NAMES,
  PHASE_TRANSITIONS,
  type SpecPhase,
} from '../../../spec/types.js';
import { createTool } from '../../core/createTool.js';
import type { ToolResult } from '../../types/ToolTypes.js';
import { ToolErrorType, ToolKind } from '../../types/ToolTypes.js';

/**
 * 获取阶段指令
 */
function getPhaseInstructions(phase: SpecPhase): string {
  switch (phase) {
    case 'requirements':
      return `## Requirements Phase Instructions

1. Use UpdateSpec to write requirements.md
2. Use EARS format:
   - Ubiquitous: "The system shall [action]"
   - Event-driven: "When [trigger], the system shall [action]"
   - Unwanted: "If [condition], then the system shall [action]"
   - State-driven: "While [state], the system shall [action]"
3. Include both functional and non-functional requirements
4. When complete, transition to "design" or "tasks"`;

    case 'design':
      return `## Design Phase Instructions

1. Use UpdateSpec to write design.md
2. Include:
   - Architecture overview (Mermaid diagrams)
   - Component interactions
   - API contracts
   - Data models
   - Error handling strategy
3. When complete, transition to "tasks"`;

    case 'tasks':
      return `## Tasks Phase Instructions

1. Use UpdateSpec to write tasks.md
2. Break down into atomic tasks:
   - Each task completable in 1-2 tool calls
   - Include dependencies between tasks
   - Estimate complexity (low/medium/high)
   - List affected files
3. When complete, transition to "implementation"`;

    case 'implementation':
      return `## Implementation Phase Instructions

1. Get next task using GetSpecContext
2. Implement the task using regular tools (Edit, Write, Bash)
3. Update task status when complete
4. Repeat until all tasks done
5. Call ExitSpecMode or transition to "done" when finished`;

    case 'done':
      return `## Spec Complete! 🎉

The spec has been marked as complete. Next steps:
1. The spec will be archived to .blade/archive/
2. Any spec deltas will be merged to .blade/specs/
3. You can start a new spec or exit Spec mode`;

    default:
      return '';
  }
}

export const transitionSpecPhaseTool = createTool({
  name: 'TransitionSpecPhase',
  displayName: 'Transition Spec Phase',
  kind: ToolKind.Write,

  schema: z.object({
    targetPhase: z
      .enum(['requirements', 'design', 'tasks', 'implementation', 'done'])
      .describe('The phase to transition to'),
  }),

  description: {
    short: 'Transition the current Spec to a new workflow phase',
    long: `Use this tool to move the Spec project to the next phase in the workflow.

## Workflow Phases

1. **init** → **requirements**: After creating proposal, define requirements
2. **requirements** → **design** or **tasks**: After requirements, create design or jump to tasks
3. **design** → **tasks**: After design, break down into tasks
4. **tasks** → **implementation**: After task breakdown, start implementation
5. **implementation** → **done**: After completing all tasks, finish

## Allowed Transitions

- init → requirements
- requirements → design, tasks
- design → tasks
- tasks → implementation
- implementation → done, tasks (can go back to add more tasks)

## Prerequisites

Before transitioning, ensure:
- Current phase's primary document is complete
- For implementation → done: All tasks should be completed

## Example

\`\`\`
TransitionSpecPhase({ targetPhase: "design" })
\`\`\`
`,
  },

  async execute(params, context): Promise<ToolResult> {
    const { targetPhase } = params;

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

    // Check if transition is allowed
    const allowedTransitions = PHASE_TRANSITIONS[currentSpec.phase];
    if (!allowedTransitions.includes(targetPhase as SpecPhase)) {
      return {
        success: false,
        llmContent:
          `Cannot transition from "${currentSpec.phase}" to "${targetPhase}".\n\n` +
          `Allowed transitions from ${currentSpec.phase}: ${allowedTransitions.join(', ') || 'none'}`,
        displayContent: '❌ Invalid phase transition',
        error: {
          type: ToolErrorType.VALIDATION_ERROR,
          message: `Invalid transition: ${currentSpec.phase} → ${targetPhase}`,
        },
      };
    }

    // Validate prerequisites for certain transitions
    // 从 tasks 阶段转换到 implementation 时，必须至少添加一个任务
    if (currentSpec.phase === 'tasks' && targetPhase === 'implementation') {
      const progress = specManager.getTaskProgress();
      if (progress.total === 0) {
        return {
          success: false,
          llmContent:
            '❌ Cannot transition to implementation: No tasks defined!\n\n' +
            'You MUST use the **AddTask** tool to add tasks before starting implementation.\n\n' +
            'Example:\n' +
            '```\n' +
            'AddTask({\n' +
            '  title: "Create User model",\n' +
            '  description: "Create User entity with required fields",\n' +
            '  complexity: "low",\n' +
            '  affectedFiles: ["src/models/User.ts"]\n' +
            '})\n' +
            '```\n\n' +
            'After adding tasks, try transitioning again.',
          displayContent: '❌ No tasks defined - 我需要先添加任务',
          error: {
            type: ToolErrorType.VALIDATION_ERROR,
            message: 'No tasks defined. Use AddTask tool to add tasks first.',
          },
        };
      }
    }

    if (targetPhase === 'done') {
      const progress = specManager.getTaskProgress();
      if (progress.total > 0 && progress.completed < progress.total) {
        // Request confirmation for incomplete tasks
        if (context.confirmationHandler) {
          const response = await context.confirmationHandler.requestConfirmation({
            title: 'Incomplete Tasks',
            message:
              `⚠️ ${progress.total - progress.completed} tasks are not completed.\n\n` +
              'Are you sure you want to mark this spec as done?',
            details: `Completed: ${progress.completed}/${progress.total}`,
          });

          if (!response.approved) {
            return {
              success: false,
              llmContent: 'User cancelled transition to done phase.',
              displayContent: '⚠️ Transition cancelled',
              error: {
                type: ToolErrorType.VALIDATION_ERROR,
                message: 'User cancelled',
              },
            };
          }
        }
      }
    }

    try {
      const result = await specManager.transitionPhase(targetPhase as SpecPhase);

      if (!result.success) {
        return {
          success: false,
          llmContent: result.message,
          displayContent: `❌ ${result.message}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: result.error || 'Transition failed',
          },
        };
      }

      const fromDisplay = PHASE_DISPLAY_NAMES[currentSpec.phase];
      const toDisplay = PHASE_DISPLAY_NAMES[targetPhase as SpecPhase];

      return {
        success: true,
        llmContent:
          `✅ Transitioned from "${fromDisplay}" to "${toDisplay}"\n\n` +
          getPhaseInstructions(targetPhase as SpecPhase),
        displayContent: `✅ Phase: ${fromDisplay} → ${toDisplay}`,
        metadata: {
          fromPhase: currentSpec.phase,
          toPhase: targetPhase,
          featureName: currentSpec.name,
        },
      };
    } catch (error) {
      return {
        success: false,
        llmContent: `Transition failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        displayContent: '❌ Transition failed',
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: error instanceof Error ? error.message : 'Transition error',
        },
      };
    }
  },
});
