/**
 * Task Tool - Subagent 调度工具
 *
 * 1. Markdown + YAML frontmatter 配置 subagent
 * 2. 模型决策 - 让模型自己决定用哪个 subagent_type
 * 3. subagent_type 参数必需 - 明确指定要使用的 subagent
 * 4. 工具隔离 - 每个 subagent 配置自己的工具白名单
 */

import { z } from 'zod';
import { SubagentExecutor } from '../../../agent/subagents/SubagentExecutor.js';
import { subagentRegistry } from '../../../agent/subagents/SubagentRegistry.js';
import type {
  SubagentContext,
  SubagentResult,
} from '../../../agent/subagents/types.js';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';

/**
 * 获取可用的 subagent 类型（用于 Zod 枚举）
 */
function getAvailableSubagentTypes(): [string, ...string[]] {
  const types = subagentRegistry.getAllNames();
  if (types.length === 0) {
    return ['Explore']; // 默认值，避免 Zod 空数组报错
  }
  return types as [string, ...string[]];
}

/**
 * TaskTool - Subagent 调度器
 *
 * 核心设计：
 * - subagent_type 参数（必需）- 明确指定使用哪个 subagent
 * - 模型从 subagent 描述中选择合适的类型
 * - 每个 subagent 有独立的系统提示和工具配置
 */
export const taskTool = createTool({
  name: 'Task',
  displayName: 'Subagent调度',
  kind: ToolKind.Execute,
  isReadOnly: true,

  // Zod Schema 定义
  schema: z.object({
    subagent_type: z
      .enum(getAvailableSubagentTypes())
      .describe('要使用的 subagent 类型（如 "Explore", "Plan"）'),
    description: z.string().min(3).max(100).describe('任务简短描述（3-5个词）'),
    prompt: z.string().min(10).describe('详细的任务指令'),
  }),

  // 工具描述
  description: {
    short:
      'Launch a specialized agent to handle complex, multi-step tasks autonomously',
    long: `
Launch a specialized agent to handle complex, multi-step tasks autonomously.

The Task tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

${subagentRegistry.getDescriptionsForPrompt()}

**How to use the Task tool:**
- Set subagent_type to ANY agent name from the list above (e.g., 'Explore', 'Plan', 'code-reviewer', etc.)
- Each agent has a specific purpose described in its description - choose the one that best matches the task
- The agent descriptions tell you when to use each agent (look for "Use this when...")

**When NOT to use the Task tool:**
- If you want to read a specific file path, use the Read or Glob tool instead of the Task tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use the Glob tool instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead of the Task tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above

**Usage notes:**
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses
- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
- Each agent invocation is stateless. You will not be able to send additional messages to the agent, nor will the agent be able to communicate with you outside of its final report. Therefore, your prompt should contain a highly detailed task description for the agent to perform autonomously and you should specify exactly what information the agent should return back to you in its final and only message to you.
- The agent's outputs should generally be trusted
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent
- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple Task tool use content blocks.
    `.trim(),
    usageNotes: [
      'subagent_type is required - choose from available agent types',
      'description should be 3-5 words (e.g., "Explore error handling")',
      'prompt should contain a highly detailed task description and specify exactly what information to return',
      'Launch multiple agents concurrently when possible for better performance',
    ],
    examples: [
      {
        description: 'Explore codebase for API endpoints',
        params: {
          subagent_type: 'Explore',
          description: 'Find API endpoints',
          prompt:
            'Search the codebase for all API endpoint definitions. Look for route handlers, REST endpoints, and GraphQL resolvers. Return a structured list with file paths, endpoint URLs, HTTP methods, and descriptions.',
        },
      },
      {
        description: 'Plan authentication feature',
        params: {
          subagent_type: 'Plan',
          description: 'Plan user auth',
          prompt:
            'Create a detailed implementation plan for adding user authentication to this project. Analyze the existing architecture, then provide step-by-step instructions including: 1) Database schema changes 2) API routes to create 3) Frontend components needed 4) Security considerations 5) Testing strategy. Be specific about file names and code locations.',
        },
      },
    ],
  },

  // 执行函数
  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const { subagent_type, description, prompt } = params;
    const { updateOutput } = context;

    try {
      // 1. 获取 subagent 配置
      const subagentConfig = subagentRegistry.getSubagent(subagent_type);
      if (!subagentConfig) {
        return {
          success: false,
          llmContent: `Unknown subagent type: ${subagent_type}`,
          displayContent: `❌ 未知的 subagent 类型: ${subagent_type}\n\n可用类型: ${subagentRegistry.getAllNames().join(', ')}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: `Unknown subagent type: ${subagent_type}`,
          },
        };
      }

      updateOutput?.(`🚀 启动 ${subagent_type} subagent: ${description}`);

      // 2. 创建执行器
      const executor = new SubagentExecutor(subagentConfig);

      // 3. 构建执行上下文
      const subagentContext: SubagentContext = {
        prompt,
        parentSessionId: context.sessionId,
      };

      updateOutput?.(`⚙️  执行任务中...`);

      // 4. 执行 subagent
      const startTime = Date.now();
      const result: SubagentResult = await executor.execute(subagentContext);
      const duration = Date.now() - startTime;

      // 5. 返回结果
      if (result.success) {
        const outputPreview =
          result.message.length > 1000
            ? result.message.slice(0, 1000) + '\n...(截断)'
            : result.message;

        return {
          success: true,
          llmContent: result.message,
          displayContent:
            `✅ Subagent 任务完成\n\n` +
            `类型: ${subagent_type}\n` +
            `任务: ${description}\n` +
            `耗时: ${duration}ms\n` +
            `工具调用: ${result.stats?.toolCalls || 0} 次\n` +
            `Token: ${result.stats?.tokens || 0}\n\n` +
            `结果:\n${outputPreview}`,
          metadata: {
            subagent_type,
            description,
            duration,
            stats: result.stats,
          },
        };
      } else {
        return {
          success: false,
          llmContent: `Subagent 执行失败: ${result.error}`,
          displayContent:
            `⚠️ Subagent 任务失败\n\n` +
            `类型: ${subagent_type}\n` +
            `任务: ${description}\n` +
            `耗时: ${duration}ms\n` +
            `错误: ${result.error}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: result.error || '未知错误',
          },
        };
      }
    } catch (error) {
      const err = error as Error;
      return {
        success: false,
        llmContent: `Subagent 执行异常: ${err.message}`,
        displayContent: `❌ Subagent 执行异常\n\n${err.message}\n\n${err.stack || ''}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: err.message,
          details: error,
        },
      };
    }
  },

  version: '4.0.0',
  category: 'Subagent',
  tags: ['task', 'subagent', 'delegation', 'explore', 'plan'],

  extractSignatureContent: (params) => `${params.subagent_type}:${params.description}`,
  abstractPermissionRule: () => '',
});
