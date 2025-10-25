import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ToolResult } from '../../types/ToolTypes.js';
import { ToolErrorType, ToolKind } from '../../types/ToolTypes.js';

/**
 * ExitPlanMode 工具
 * 在 Plan 模式下呈现完整方案并请求用户确认
 */
export const exitPlanModeTool = createTool({
  name: 'ExitPlanMode',
  displayName: 'Exit Plan Mode',
  kind: ToolKind.Think, // 自动推断为只读

  schema: z.object({
    plan: z.string().min(50).describe('完整的实现方案（Markdown 格式，至少50字符）'),
  }),

  description: {
    short: '呈现完整实现方案并请求用户确认退出 Plan 模式',
    long: `在 Plan 模式下完成方案制定后调用此工具。

IMPORTANT: 仅在任务需要编写代码时使用此工具。
- 如果是调研任务（搜索、理解代码库），不要调用此工具，直接回答即可
- 如果是实现任务（添加功能、修复 Bug），必须调用此工具提交方案`,
    usageNotes: [
      '✅ 实现任务示例：「帮我实现 vim 的 yank 模式」→ 调用此工具',
      '❌ 调研任务示例：「搜索并理解 vim 模式的实现」→ 不要调用此工具',
      '方案必须使用 Markdown 格式',
      '必须包含完整的实现步骤',
      '调用后会暂停，等待用户确认',
      '用户批准后退出 Plan 模式，拒绝后保持 Plan 模式',
    ],
    important: [
      '⚠️ 仅在需要写代码的任务中使用',
      '⚠️ 调研任务直接回答，不要调用此工具',
      '⚠️ 方案必须详细且可执行',
      '⚠️ 包含所有文件修改和创建',
      '⚠️ 说明潜在风险和测试策略',
    ],
  },

  async execute(params, context): Promise<ToolResult> {
    const { plan } = params;

    // 调试日志：追踪 ExitPlanModeTool 接收到的 confirmationHandler
    console.log('[ExitPlanModeTool] Execute with context:', {
      hasHandler: !!context.confirmationHandler,
      hasMethod: !!context.confirmationHandler?.requestConfirmation,
      methodType: typeof context.confirmationHandler?.requestConfirmation,
      contextKeys: Object.keys(context),
    });

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
            llmContent: '✅ 用户已批准方案。Plan 模式已退出，现在可以执行代码修改。',
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
              '❌ 用户拒绝了方案。请根据用户反馈修改方案。\n\n' +
              '提示：\n' +
              '- 询问用户具体需要改进的部分\n' +
              '- 使用 Read/Grep 等工具继续调研\n' +
              '- 完善方案后再次调用 ExitPlanMode',
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
          llmContent: `确认流程出错: ${error instanceof Error ? error.message : '未知错误'}`,
          displayContent: '❌ 确认失败',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: '确认流程出错',
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
