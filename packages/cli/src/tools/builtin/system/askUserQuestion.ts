import { Type } from '../../../schema/index.js';
import { createTool } from '../../core/createTool.js';
import type { ToolResult } from '../../types/ToolTypes.js';
import { ToolErrorType, ToolKind } from '../../types/ToolTypes.js';

/**
 * Option schema - 选项定义
 */
const optionSchema = Type.Object({
  label: Type.String({
    description:
      'The display text for this option that the user will see and select. Should be concise (1-5 words).',
  }),
  description: Type.String({
    description: 'Explanation of what this option means or what will happen if chosen.',
  }),
});

/**
 * Question schema - 问题定义
 */
const questionSchema = Type.Object({
  question: Type.String({
    description:
      'The complete, clear question to ask the user. End it with a question mark.',
  }),
  header: Type.String({
    maxLength: 12,
    description: 'Very short label displayed as a chip/tag (max 12 chars).',
  }),
  multiSelect: Type.Boolean({
    description:
      'Allow multiple answers when true. Use only when choices are not mutually exclusive.',
  }),
  options: Type.Array(optionSchema, {
    minItems: 2,
    maxItems: 4,
    description: 'The available choices for this question (2-4 options).',
  }),
});

/**
 * AskUserQuestion tool schema
 */
const askUserQuestionSchema = Type.Object({
  questions: Type.Array(questionSchema, {
    minItems: 1,
    maxItems: 4,
    description: 'Questions to ask the user (1-4 questions)',
  }),
});

/**
 * AskUserQuestion tool
 * 允许 Claude 在执行过程中向用户提问
 */
export const askUserQuestionTool = createTool({
  name: 'AskUserQuestion',
  displayName: 'Ask User Question',
  kind: ToolKind.ReadOnly,
  isConcurrencySafe: false, // 阻塞用户输入

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
        const response = await context.confirmationHandler.requestConfirmation(
          {
            type: 'askUserQuestion',
            kind: ToolKind.ReadOnly, // 显式标记为只读，避免在 Plan 模式下被拒绝
            message: 'Please answer the following questions:',
            questions: params.questions,
          },
          context.signal
        );

        // 检查是否被拒绝（用户取消或 ACP 权限拒绝）
        if (!response.approved) {
          return {
            success: true,
            llmContent: 'User cancelled the question prompt without providing answers.',
            metadata: { cancelled: true, summary: '用户取消了问题' },
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
            metadata: { answers: response.answers, summary: '用户已回答问题' },
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
          metadata: {
            acpMode: true,
            noAnswersCollected: true,
            summary: 'ACP 模式：无法收集答案',
          },
        };
      } catch (error) {
        return {
          success: false,
          llmContent: `Failed to ask user questions: ${error instanceof Error ? error.message : 'Unknown error'}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: 'Failed to display questions',
          },
          metadata: { summary: '问题显示失败' },
        };
      }
    }

    // 降级：如果没有确认处理器，返回错误
    return {
      success: false,
      llmContent:
        'No confirmation handler available. Cannot ask user questions in non-interactive mode.',
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: 'No confirmation handler available',
      },
      metadata: { summary: '非交互模式，无法提问' },
    };
  },
});
