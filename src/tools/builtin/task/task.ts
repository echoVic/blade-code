/**
 * Task Tool - Subagent 调度工具
 *
 * 设计哲学（参考 Claude Code 官方）：
 * 1. Markdown + YAML frontmatter 配置 subagent
 * 2. 模型决策 - 让模型自己决定用哪个 subagent
 * 3. 自动匹配 - 根据任务描述自动选择最合适的 subagent
 * 4. 工具隔离 - 每个 subagent 可限制工具访问
 */

import { z } from 'zod';
import type { Agent } from '../../../agent/Agent.js';
import type { ChatContext } from '../../../agent/types.js';
import { SubagentRegistry } from '../../../agents/registry.js';
import { SubagentExecutor } from '../../../agents/executor.js';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';

// Agent 工厂函数（支持传入自定义系统提示词和工具限制）
let agentFactory:
  | ((systemPrompt?: string, allowedTools?: string[]) => Promise<Agent>)
  | undefined;

/**
 * 设置 Agent 工厂函数
 * @param factory 工厂函数，接受可选的 systemPrompt 和 allowedTools 参数
 */
export function setTaskToolAgentFactory(
  factory: (systemPrompt?: string, allowedTools?: string[]) => Promise<Agent>
): void {
  agentFactory = factory;
}

/**
 * TaskTool - 简洁的子 Agent 任务调度
 *
 * 核心设计：
 * - 移除 subagent_type：让模型根据任务自己决定策略
 * - 移除固定的系统提示词：动态生成适应任务的提示
 * - 移除复杂的配置：只保留最基本的参数
 */
export const taskTool = createTool({
  name: 'Task',
  displayName: 'Agent任务调度',
  kind: ToolKind.Execute,
  isReadOnly: true,

  // Zod Schema 定义 - 极简设计 + 工具隔离
  schema: z.object({
    description: z.string().min(3).max(100).describe('任务简短描述（3-10个词）'),
    prompt: z.string().min(10).describe('详细的任务指令和期望输出'),
    model: z
      .enum(['haiku', 'sonnet', 'opus'])
      .optional()
      .describe('使用的模型（可选，默认 sonnet）'),
    tools: z
      .array(z.string())
      .optional()
      .describe(
        '允许使用的工具列表（可选，默认允许所有工具）。示例：["Read", "Grep", "Glob"] 只允许只读工具'
      ),
  }),

  // 工具描述 - 简洁清晰 + 自动委托提示
  description: {
    short: '启动独立的 AI 助手自主执行复杂的多步骤任务',
    long: `
启动独立的 AI 助手来处理复杂任务。助手会自动选择合适的工具和策略来完成任务。

**🔥 自动委托提示（Use PROACTIVELY）：**
当遇到以下场景时，**强烈建议**主动使用此工具：
- 需要**深入分析代码结构**或架构设计
- 需要**搜索大量文件**或执行复杂的代码搜索
- 需要**生成文档、报告或总结**
- 需要**多步骤推理**或执行复杂的工作流
- 任务可以**独立完成**，不需要与用户频繁交互

**适用场景：**
- 代码分析：分析项目依赖、检查代码质量、查找潜在问题
- 文件搜索：查找测试文件、配置文件、特定模式的代码
- 文档生成：生成 API 文档、README、技术报告
- 重构建议：分析代码并提供重构方案
- 问题诊断：调查 bug、分析日志、查找错误原因

**助手的能力：**
- 自动选择和使用工具（Read、Write、Grep、Glob、Bash、WebSearch 等）
- 自主决定执行策略和步骤
- 独立的执行上下文（不共享父 Agent 的对话历史）
- 可限制工具访问（通过 tools 参数提升安全性）

**⚠️ 重要：**
- 这不是 TODO 清单管理工具（使用 TodoWrite 管理任务清单）
- prompt 应该包含完整的上下文和详细的期望输出
- 助手会消耗独立的 API token
- 对于敏感操作，可通过 tools 参数限制工具使用（如只允许只读工具）
    `.trim(),
    usageNotes: [
      'description 应简短（3-10个词），如"分析项目依赖"',
      'prompt 应详细完整，包含任务目标、期望输出格式',
      '助手无法访问父 Agent 的对话历史，需在 prompt 中提供完整上下文',
      '助手会自动选择合适的工具，无需指定（除非使用 tools 参数限制）',
      'model 参数可选：haiku（快速）、sonnet（平衡）、opus（高质量）',
      'tools 参数可选：限制可用工具列表，提升安全性（如：["Read", "Grep", "Glob"]）',
    ],
    examples: [
      {
        description: '分析项目依赖（完全权限）',
        params: {
          description: '分析项目依赖',
          prompt:
            '分析项目中的所有依赖包（package.json），检查：1) 过时的包 2) 存在安全漏洞的包 3) 建议的更新方案。以 Markdown 表格格式输出。',
        },
      },
      {
        description: '查找测试文件（只读权限）',
        params: {
          description: '查找测试文件',
          prompt:
            '查找项目中所有的测试文件（.test.ts, .spec.ts），列出文件路径和每个测试文件的主要测试内容。',
          tools: ['Read', 'Grep', 'Glob'], // 只允许只读工具
        },
      },
      {
        description: '生成 API 文档（高质量模型）',
        params: {
          description: '生成 API 文档',
          prompt:
            '分析 src/api/ 目录下的所有 API 路由，生成完整的 API 文档，包括：路由、请求参数、响应格式、示例。',
          model: 'opus',
          tools: ['Read', 'Grep', 'Glob', 'Write'], // 允许读取和写入，但不允许执行命令
        },
      },
    ],
    important: [
      '⚠️ 这不是 TODO 清单工具！管理任务清单请使用 TodoWrite',
      '🔥 当需要深入分析、大量搜索、生成文档时，主动使用此工具（PROACTIVELY）',
      '助手会消耗独立的 API token',
      '助手无法访问父 Agent 的对话历史',
      'prompt 应该详细完整，包含所有必要的上下文',
      '🔒 对于敏感操作，使用 tools 参数限制工具访问（安全最佳实践）',
    ],
  },

  // 执行函数
  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const { description, prompt, model = 'sonnet', tools } = params;
    const { updateOutput } = context;
    const signal = context.signal ?? new AbortController().signal;

    try {
      // 检查是否配置了 agentFactory
      if (!agentFactory) {
        return {
          success: false,
          llmContent: '任务工具未初始化：缺少 Agent 工厂函数',
          displayContent:
            '❌ 任务工具未初始化\n\n请联系系统管理员配置 Agent 工厂函数',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: 'Agent factory not configured',
          },
        };
      }

      updateOutput?.(`🚀 启动子 Agent: ${description}`);

      // 动态生成系统提示词（根据任务内容和工具限制）
      const dynamicSystemPrompt = buildDynamicSystemPrompt(prompt, model, tools);

      // 创建子 Agent（传入动态系统提示词和工具限制）
      const subAgent = await agentFactory(dynamicSystemPrompt, tools);

      // 构建子 Agent 的上下文
      const subContext: ChatContext = {
        messages: [], // 子 Agent 从空消息列表开始
        userId: context.userId || 'subagent',
        sessionId: `subagent_${Date.now()}`,
        workspaceRoot: context.workspaceRoot || process.cwd(),
        signal,
        confirmationHandler: context.confirmationHandler,
      };

      updateOutput?.(`⚙️  执行任务中...`);

      // 执行子 Agent 循环
      const startTime = Date.now();
      const result = await subAgent.runAgenticLoop(prompt, subContext, {
        maxTurns: 20, // 限制最大回合数
        signal,
      });
      const duration = Date.now() - startTime;

      if (result.success) {
        // 任务成功完成
        const finalMessage = result.finalMessage ?? '';
        const outputPreview =
          typeof finalMessage === 'string'
            ? finalMessage.length > 1000
              ? finalMessage.slice(0, 1000) + '...(截断)'
              : finalMessage
            : JSON.stringify(finalMessage, null, 2);

        return {
          success: true,
          llmContent: result.finalMessage ?? outputPreview,
          displayContent:
            `✅ 子 Agent 任务完成\n\n` +
            `任务: ${description}\n` +
            `模型: ${model}\n` +
            `耗时: ${duration}ms\n` +
            `回合数: ${result.metadata?.toolCallsCount || 0}\n\n` +
            `结果:\n${outputPreview}`,
          metadata: {
            description,
            model,
            duration,
            turns: result.metadata?.toolCallsCount || 0,
          },
        };
      } else {
        // 任务失败
        const errorMessage = result.error?.message || '未知错误';

        return {
          success: false,
          llmContent: `任务执行失败: ${errorMessage}`,
          displayContent:
            `⚠️ 子 Agent 任务失败\n\n` +
            `任务: ${description}\n` +
            `耗时: ${duration}ms\n` +
            `错误: ${errorMessage}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: errorMessage,
            details: result.error,
          },
        };
      }
    } catch (error) {
      const err = error as Error;
      if (err.name === 'AbortError') {
        return {
          success: false,
          llmContent: '任务执行被中止',
          displayContent: '⚠️ 任务执行被用户中止',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: '操作被中止',
          },
        };
      }

      return {
        success: false,
        llmContent: `任务执行失败: ${err.message}`,
        displayContent: `❌ 任务执行失败\n\n${err.message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: err.message,
          details: error,
        },
      };
    }
  },

  version: '3.0.0',
  category: '任务工具',
  tags: ['task', 'agent', 'delegation', 'workflow'],

  extractSignatureContent: (params) => params.description,
  abstractPermissionRule: () => '',
});

/**
 * 动态生成系统提示词
 *
 * 根据任务内容自动生成适应性的系统提示词，而不是使用固定模板
 */
function buildDynamicSystemPrompt(
  taskPrompt: string,
  model: string,
  allowedTools?: string[]
): string {
  // 基础提示词
  let basePrompt = `你是一个专业的 AI 助手，负责自主完成以下任务：

${taskPrompt}

## 执行指南

`;

  // 工具限制说明
  if (allowedTools && allowedTools.length > 0) {
    basePrompt += `⚠️ **工具访问限制**：出于安全考虑，你只能使用以下工具：${allowedTools.join(', ')}

`;
  } else {
    basePrompt += `你可以使用所有可用的工具来完成任务。`;
  }

  basePrompt += `根据任务需求自主决定：
- 使用哪些工具
- 执行的步骤和顺序
- 输出的格式和结构

## 可用工具

`;

  // 根据工具限制列出可用工具
  const allTools = {
    Read: '读取文件内容',
    Write: '创建或覆盖文件',
    Edit: '编辑文件（字符串替换）',
    Grep: '搜索文件内容（支持正则）',
    Glob: '查找文件（支持通配符）',
    Bash: '执行 Shell 命令',
    WebSearch: '网络搜索',
    WebFetch: '获取网页内容',
  };

  if (allowedTools && allowedTools.length > 0) {
    // 只列出允许的工具
    for (const tool of allowedTools) {
      if (allTools[tool as keyof typeof allTools]) {
        basePrompt += `- **${tool}**: ${allTools[tool as keyof typeof allTools]}\n`;
      }
    }
  } else {
    // 列出所有工具
    for (const [tool, desc] of Object.entries(allTools)) {
      basePrompt += `- **${tool}**: ${desc}\n`;
    }
  }

  basePrompt += `
## 执行原则

1. **系统性思考**: 分析任务，制定计划，逐步执行
2. **高效工具使用**: 优先使用专门工具，避免重复操作
3. **完整输出**: 确保返回的结果完整、清晰、有用
4. **错误处理**: 遇到错误时尝试替代方案
`;

  if (allowedTools && allowedTools.length > 0) {
    basePrompt += `5. **严格遵守工具限制**: 不要尝试使用未授权的工具\n`;
  }

  basePrompt += `
当任务完成时，直接返回最终结果。`;

  // 根据模型添加特定提示（可选）
  if (model === 'haiku') {
    return basePrompt + '\n\n**注意**: 优先考虑速度和效率，快速完成任务。';
  } else if (model === 'opus') {
    return (
      basePrompt + '\n\n**注意**: 追求高质量输出，深入分析，提供详细的结果和建议。'
    );
  }

  return basePrompt;
}
