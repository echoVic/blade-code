import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ToolResult } from '../../types/ToolTypes.js';
import { ToolErrorType, ToolKind } from '../../types/ToolTypes.js';

/**
 * ExitPlanMode tool
 * Presents the full plan in Plan mode and requests user approval
 */
export const exitPlanModeTool = createTool({
  name: 'ExitPlanMode',
  displayName: 'Exit Plan Mode',
  kind: ToolKind.Think, // 自动推断为只读

  schema: z.object({
    plan: z.string().min(50).describe('Complete implementation plan (Markdown, at least 50 chars)'),
  }),

  description: {
    short: 'Present the full implementation plan and request approval to exit Plan mode',
    long: `Call this tool after drafting the implementation plan in Plan mode.

IMPORTANT: Use only when the task requires writing code.
- For research tasks (searching, understanding codebase), do not call this tool; just answer directly.
- For implementation tasks (new features, bug fixes), you must call this tool to submit the plan.`,
    usageNotes: [
      '✅ Implementation task: “implement vim yank mode” → call this tool',
      '❌ Research task: “investigate how vim modes are implemented” → do NOT call this tool',
      'Plan must be in Markdown format',
      'Plan must include complete implementation steps',
      'Execution pauses awaiting user confirmation after calling',
      'Approved → exit Plan mode; rejected → stay in Plan mode',
    ],
    important: [
      '⚠️ Use only for coding tasks',
      '⚠️ Do not use for pure research tasks',
      '⚠️ Plan must be detailed and executable',
      '⚠️ Include all file modifications/creations',
      '⚠️ Note potential risks and testing strategy',
    ],
  },

  async execute(params, context): Promise<ToolResult> {
    const { plan } = params;

    // 触发 UI 确认流程
    if (context.confirmationHandler) {
      try {
        const response = await context.confirmationHandler.requestConfirmation({
          type: 'exitPlanMode',
          message: '请审查以下实现方案',
          details: plan,
        });

        if (response.approved) {
          return {
            success: true,
            llmContent:
              '✅ Plan approved by user. Plan mode exited; you can proceed to code changes.',
            displayContent: '✅ 方案已批准，退出 Plan 模式',
            metadata: {
              approved: true,
              planLength: plan.length,
              shouldExitLoop: true, // 🆕 标记应该退出循环
              targetMode: response.targetMode, // 🆕 目标权限模式（default/auto_edit）
            },
          };
        } else {
          return {
            success: false,
            llmContent:
              '❌ Plan rejected by user. Please revise based on their feedback.\n\n' +
              'Tips:\n' +
              '- Ask which parts need improvement\n' +
              '- Use Read/Grep tools for further investigation\n' +
              '- Refine the plan and call ExitPlanMode again',
            displayContent: '❌ 方案被拒绝，保持 Plan 模式',
            error: {
              type: ToolErrorType.VALIDATION_ERROR,
              message: '用户拒绝了方案',
              code: 'PLAN_REJECTED',
            },
            metadata: {
              approved: false,
              planLength: plan.length,
              shouldExitLoop: true, // 🆕 拒绝方案也应该退出循环，避免无限重试
            },
          };
        }
      } catch (error) {
        return {
          success: false,
          llmContent: `Confirmation flow error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          displayContent: '❌ 确认失败',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
          message: 'Confirmation flow error',
          },
        };
      }
    }

    // 降级：如果没有确认处理器，直接返回方案
    return {
      success: true,
      llmContent: plan,
      displayContent: '方案已呈现（无交互式确认）',
      metadata: { approved: null, planLength: plan.length },
    };
  },
});
