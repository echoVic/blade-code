import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
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
  kind: ToolKind.ReadOnly,
  isConcurrencySafe: false, // 模式切换，改变状态

  schema: z.object({
    plan: z.string().describe('The complete implementation plan in markdown format'),
  }),

  // 工具描述
  description: {
    short:
      'Use this tool when you are in plan mode and have finished creating your plan and are ready for user approval',
    long: `Use this tool when you are in plan mode and have finished creating your implementation plan and are ready for user approval.

## PREREQUISITES (MUST be satisfied before calling)

1. [OK] You have created a complete implementation plan
2. [OK] You have OUTPUT TEXT to explain your plan to the user (not just tool calls)
3. [OK] The plan includes: summary, implementation steps, affected files, testing method

**DO NOT call this tool if**:
- [FAIL] You only called tools (Glob/Grep/Read) without outputting any text summary
- [FAIL] You haven't created a complete plan
- [FAIL] The plan is empty or incomplete

## How This Tool Works
- Pass your complete implementation plan as the 'plan' parameter
- The plan should be in markdown format with clear sections
- This tool will present your plan to the user for review and approval
- The user will see your plan and can approve or reject it

## When to Use This Tool
IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.

## Handling Ambiguity in Plans
Before using this tool, ensure your plan is clear and unambiguous. If there are multiple valid approaches or unclear requirements:
1. Use the AskUserQuestion tool to clarify with the user
2. Ask about specific implementation choices (e.g., architectural patterns, which library to use)
3. Clarify any assumptions that could affect the implementation
4. Edit your plan file to incorporate user feedback
5. Only proceed with ExitPlanMode after resolving ambiguities and updating the plan file

## Examples

1. Initial task: "Search for and understand the implementation of vim mode in the codebase" - Do not use the exit plan mode tool because you are not planning the implementation steps of a task.
2. Initial task: "Help me implement yank mode for vim" - Use the exit plan mode tool after you have finished planning the implementation steps of the task.
3. Initial task: "Add a new feature to handle user authentication" - If unsure about auth method (OAuth, JWT, etc.), use AskUserQuestion first, then use exit plan mode tool after clarifying the approach.
`,
  },

  async execute(params, context): Promise<ToolResult> {
    // 使用参数中的 plan 内容
    const planContent = params.plan || '';

    // 可选：将 plan 保存到文件以便后续查看
    if (planContent && context.sessionId) {
      try {
        const planDir = path.join(homedir(), '.blade', 'plans');
        await fs.mkdir(planDir, { recursive: true, mode: 0o755 });
        const planPath = path.join(planDir, `plan_${context.sessionId}.md`);
        await fs.writeFile(planPath, planContent, 'utf-8');
      } catch (error) {
        // 保存失败不影响功能，只是记录日志
        console.warn('Failed to save plan file:', error);
      }
    }

    // 触发 UI 确认流程
    if (context.confirmationHandler) {
      try {
        const response = await context.confirmationHandler.requestConfirmation({
          type: 'exitPlanMode',
          message: '助手已完成方案规划，请审核后选择执行方式。',
          details: '批准后将退出规划模式，开始实施。',
          planContent: planContent || undefined,
        });

        if (response.approved) {
          return {
            success: true,
            llmContent:
              '[OK] Plan approved by user. Plan mode exited; you can proceed to code changes.',
            metadata: {
              approved: true,
              shouldExitLoop: true,
              targetMode: response.targetMode, // 目标权限模式 PermissionMode.DEFAULT/AUTO_EDIT
              planContent: planContent, // 传递 plan 内容给 Agent
              summary: '方案已批准，退出 Plan 模式',
            },
          };
        } else {
          // 拒绝方案后退出循环，返回到用户输入界面
          return {
            success: true, // 拒绝不是错误，是正常的用户交互
            llmContent:
              '[WARN] Plan rejected by user. Awaiting user feedback.\n\n' +
              (response.feedback || 'No specific feedback provided.') +
              '\n\nThe agent has stopped and control is returned to the user. ' +
              'The user can now provide additional information or clarification.',
            metadata: {
              approved: false,
              shouldExitLoop: true,
              feedback: response.feedback,
              awaitingUserInput: true,
              summary: '方案被拒绝，等待用户反馈',
            },
          };
        }
      } catch (error) {
        return {
          success: false,
          llmContent: `Confirmation flow error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: 'Confirmation flow error',
          },
          metadata: { summary: '确认流程出错' },
        };
      }
    }

    // 降级：如果没有确认处理器，直接返回成功
    return {
      success: true,
      llmContent:
        '[OK] Plan mode exit requested. No interactive confirmation available.\n' +
        'Proceeding with implementation.',
      metadata: { approved: null, summary: '退出 Plan 模式（非交互）' },
    };
  },
});
