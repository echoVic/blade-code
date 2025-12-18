/**
 * /init slash command implementation
 * 分析当前项目并生成 BLADE.md 配置文件
 */

import { promises as fs } from 'fs';
import type { ChatCompletionMessageToolCall } from 'openai/resources/chat';
import * as path from 'path';
import { Agent } from '../agent/Agent.js';
import { getState, sessionActions } from '../store/vanilla.js';
import type { ToolResult } from '../tools/types/index.js';
import { formatToolCallSummary } from '../ui/utils/toolFormatters.js';
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types.js';

const initCommand: SlashCommand = {
  name: 'init',
  description: '分析当前项目并生成 BLADE.md 配置文件',
  usage: '/init',
  async handler(
    _args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    try {
      const { cwd } = context;
      const addMessage = sessionActions().addAssistantMessage;
      const addToolMessage = sessionActions().addToolMessage;

      // 从 store 获取 sessionId
      const sessionId = getState().session.sessionId;

      // 检查是否已存在有效的 BLADE.md（非空文件）
      const blademdPath = path.join(cwd, 'BLADE.md');
      let exists = false;
      let isEmpty = false;

      try {
        const stat = await fs.stat(blademdPath);
        exists = stat.isFile();

        if (exists) {
          const content = await fs.readFile(blademdPath, 'utf-8');
          // 只有完全空白的文件才视为无效，任何有内容的文件都应保留并分析
          isEmpty = content.trim().length === 0;
        }
      } catch {
        // 文件不存在
        exists = false;
      }

      if (exists && !isEmpty) {
        addMessage('⚠️ BLADE.md 已存在。');
        addMessage('💡 正在分析现有文件并提供改进建议...');

        // 创建 Agent 并分析现有文件
        const agent = await Agent.create();
        const analysisPrompt = `Please analyze the existing BLADE.md file and provide improvement suggestions.

**Important**:
- After each step, briefly describe what you found before proceeding
- DO NOT create new files or modify the existing BLADE.md
- Return only your analysis and suggestions as TEXT

**Step-by-step process:**

1. Read the current BLADE.md file at ${blademdPath} and summarize its current structure

2. Read package.json and note:
   - Any new scripts or commands not documented
   - New dependencies that might need explanation
   - Changes in project structure

3. Explore the codebase (use Glob/Grep instead of find/grep commands) to identify:
   - Missing architectural information
   - Undocumented patterns or conventions
   - Important files or directories not mentioned

4. Provide comprehensive feedback in Chinese:
   - 当前 BLADE.md 的优点
   - 缺失或过时的内容
   - 具体的改进建议（附带示例）
   - 如果需要重大修改，提供完整的改进版本内容

**Final output**: Return your analysis and suggestions as plain text. Do NOT use Write tool.`;

        // 使用 chat 方法让 Agent 可以调用工具
        const result = await agent.chat(
          analysisPrompt,
          {
            messages: [],
            userId: 'cli-user',
            sessionId: sessionId || 'init-session',
            workspaceRoot: cwd,
          },
          {
            onToolStart: (toolCall: ChatCompletionMessageToolCall) => {
              if (toolCall.type !== 'function') return;
              try {
                const params = JSON.parse(toolCall.function.arguments);
                const summary = formatToolCallSummary(toolCall.function.name, params);
                addToolMessage(summary, {
                  toolName: toolCall.function.name,
                  phase: 'start',
                  summary,
                  params,
                });
              } catch {
                // 静默处理解析错误
              }
            },
            onToolResult: async (toolCall: ChatCompletionMessageToolCall, result: ToolResult) => {
              if (toolCall.type !== 'function') return;
              if (result?.metadata?.summary) {
                addToolMessage(result.metadata.summary, {
                  toolName: toolCall.function.name,
                  phase: 'complete',
                  summary: result.metadata.summary,
                });
              }
            },
          }
        );

        addMessage(result);

        return {
          success: true,
          message: '✅ 分析完成',
        };
      }

      // 显示适当的提示消息
      if (isEmpty) {
        addMessage('⚠️ 检测到空的 BLADE.md 文件，将重新生成...');
      }
      addMessage('🔍 正在分析项目结构...');

      // 创建 Agent 并生成内容
      const agent = await Agent.create();
      const analysisPrompt = `Please analyze this codebase and generate BLADE.md content.

**Important**: After each step, briefly describe what you found before proceeding.

**Step-by-step process:**

1. Read package.json and summarize:
   - Project name and type
   - Key dependencies and frameworks
   - Available scripts (build, test, lint, etc.)

2. Explore the project structure and note:
   - Main entry point
   - Key directories (src, tests, config, etc.)
   - Common patterns (React components, API routes, etc.)

3. Analyze the architecture and identify:
   - How the code is organized
   - Main modules/components
   - How different parts interact

4. Generate the final BLADE.md content with:
   - Project overview (type, languages, frameworks)
   - Essential commands (from package.json scripts)
   - Architecture overview (structure, patterns, relationships)
   - Development guidelines (testing, building, deploying)

**Format requirements:**
- Start with: "# BLADE.md\\n\\nalways respond in Chinese\\n\\n你是一个专门帮助 [项目类型] 开发者的助手。"
- Include actual working commands
- Focus on non-obvious insights
- Be concise but comprehensive

**Final output**: Return ONLY the complete BLADE.md content (markdown format), ready to be written to the file.`;

      // 使用 chat 方法让 Agent 可以调用工具
      const generatedContent = await agent.chat(
        analysisPrompt,
        {
          messages: [],
          userId: 'cli-user',
          sessionId: sessionId || 'init-session',
          workspaceRoot: cwd,
        },
        {
          onToolStart: (toolCall: ChatCompletionMessageToolCall) => {
            if (toolCall.type !== 'function') return;
            try {
              const params = JSON.parse(toolCall.function.arguments);
              const summary = formatToolCallSummary(toolCall.function.name, params);
              addToolMessage(summary, {
                toolName: toolCall.function.name,
                phase: 'start',
                summary,
                params,
              });
            } catch {
              // 静默处理解析错误
            }
          },
          onToolResult: async (toolCall: ChatCompletionMessageToolCall, result: ToolResult) => {
            if (toolCall.type !== 'function') return;
            if (result?.metadata?.summary) {
              addToolMessage(result.metadata.summary, {
                toolName: toolCall.function.name,
                phase: 'complete',
                summary: result.metadata.summary,
              });
            }
          },
        }
      );

      // 验证生成内容的有效性（至少应该有基本的标题和内容）
      if (!generatedContent || generatedContent.trim().length === 0) {
        throw new Error('Agent 未能生成有效的 BLADE.md 内容');
      }

      // 写入生成的内容
      addMessage('✨ 正在写入 BLADE.md...');
      await fs.writeFile(blademdPath, generatedContent, 'utf-8');

      return {
        success: true,
        message: '✅ 已成功生成 BLADE.md 文件',
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      return {
        success: false,
        error: `初始化失败: ${errorMessage}`,
      };
    }
  },
};

export default initCommand;
