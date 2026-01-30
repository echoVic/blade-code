import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ToolResult } from '../../types/ToolTypes.js';
import { ToolErrorType, ToolKind } from '../../types/ToolTypes.js';

/**
 * Option schema - 选项定义
 */
const optionSchema = z.object({
  label: z
    .string()
    .describe(
      'The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.'
    ),
  description: z
    .string()
    .describe(
      'Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.'
    ),
});

/**
 * Question schema - 问题定义
 */
const questionSchema = z.object({
  question: z
    .string()
    .describe(
      'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"'
    ),
  header: z
    .string()
    .max(12)
    .describe(
      'Very short label displayed as a chip/tag (max 12 chars). Examples: "Auth method", "Library", "Approach".'
    ),
  multiSelect: z
    .boolean()
    .describe(
      'Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.'
    ),
  options: z
    .array(optionSchema)
    .min(2)
    .max(4)
    .describe(
      'The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no "Other" option, that will be provided automatically.'
    ),
});

/**
 * AskUserQuestion tool schema
 */
const askUserQuestionSchema = z.object({
  questions: z
    .array(questionSchema)
    .min(1)
    .max(4)
    .describe('Questions to ask the user (1-4 questions)'),
});

/**
 * AskUserQuestion tool
 * 允许 Claude 在执行过程中向用户提问
 */
export const askUserQuestionTool = createTool({
  name: 'AskUserQuestion',
  displayName: 'Ask User Question',
  kind: ToolKind.ReadOnly,

  schema: askUserQuestionSchema,

  description: {
    short: 'Ask user questions to gather preferences or clarify requirements',
    long: `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label`,
  },

  async execute(params, context): Promise<ToolResult> {
    // 触发 UI 确认流程
    if (context.confirmationHandler) {
      try {
        const response = await context.confirmationHandler.requestConfirmation({
          type: 'askUserQuestion',
          kind: ToolKind.ReadOnly, // 显式标记为只读，避免在 Plan 模式下被拒绝
          message: 'Please answer the following questions:',
          questions: params.questions,
        });

        // 检查是否被拒绝（用户取消或 ACP 权限拒绝）
        if (!response.approved) {
          return {
            success: true,
            llmContent: 'User cancelled the question prompt without providing answers.',
            displayContent: '❌ 用户取消了问题',
            metadata: { cancelled: true },
          };
        }

        // 检查是否有答案（本地 TUI 模式）
        if (response.answers && Object.keys(response.answers).length > 0) {
          // 格式化答案返回给 LLM
          const formattedAnswers = Object.entries(response.answers)
            .map(([header, answer]) => {
              const answerStr = Array.isArray(answer) ? answer.join(', ') : answer;
              return `${header}: ${answerStr}`;
            })
            .join('\n');

          return {
            success: true,
            llmContent: `User answers:\n${formattedAnswers}`,
            displayContent: '✅ 用户已回答问题',
            metadata: { answers: response.answers },
          };
        }

        // ACP 兼容模式：approved 但没有 answers
        // 这意味着在 ACP/IDE 会话中用户允许了操作，但 ACP 不支持收集答案
        // 返回友好提示，让 LLM 知道需要用其他方式获取信息
        return {
          success: true,
          llmContent:
            'The question was approved but no answers were collected. ' +
            'This typically happens in IDE/ACP sessions where structured question UI is not available. ' +
            'Please ask the user directly in your response or make reasonable assumptions based on context.',
          displayContent: '⚠️ ACP 模式：无法收集答案',
          metadata: { acpMode: true, noAnswersCollected: true },
        };
      } catch (error) {
        return {
          success: false,
          llmContent: `Failed to ask user questions: ${error instanceof Error ? error.message : 'Unknown error'}`,
          displayContent: '❌ 问题显示失败',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: 'Failed to display questions',
          },
        };
      }
    }

    // 降级：如果没有确认处理器，返回错误
    return {
      success: false,
      llmContent:
        'No confirmation handler available. Cannot ask user questions in non-interactive mode.',
      displayContent: '❌ 非交互模式，无法提问',
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: 'No confirmation handler available',
      },
    };
  },
});
