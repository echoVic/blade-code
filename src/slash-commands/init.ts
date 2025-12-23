/**
 * /init slash command implementation
 * 分析当前项目并生成 BLADE.md 配置文件
 */

import { promises as fs } from 'fs';
import type { ChatCompletionMessageToolCall } from 'openai/resources/chat';
import * as path from 'path';
import { Agent } from '../agent/Agent.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import { getState } from '../store/vanilla.js';
import type { ToolResult } from '../tools/types/index.js';
import { formatToolCallSummary } from '../ui/utils/toolFormatters.js';
import {
  getUI,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from './types.js';

const logger = createLogger(LogCategory.AGENT);

const initCommand: SlashCommand = {
  name: 'init',
  description: '分析当前项目并生成 BLADE.md 配置文件',
  usage: '/init',
  async handler(
    _args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    try {
      const { cwd, signal } = context;
      const ui = getUI(context);

      // 工具消息（带换行）
      const sendToolMessage = (summary: string) => {
        ui.sendMessage(`${summary}`);
      };

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
        ui.sendMessage('⚠️ BLADE.md 已存在。');
        ui.sendMessage('💡 正在分析现有文件并提供改进建议...');

        // 创建 Agent 并分析现有文件
        const agent = await Agent.create();
        const analysisPrompt = `Please analyze the existing BLADE.md file and provide improvement suggestions.

**Important**:
- After each step, briefly describe what you found before proceeding
- DO NOT create new files or modify the existing BLADE.md
- Return only your analysis and suggestions as TEXT

**Context**: BLADE.md is given to AI coding agents. Length should match project complexity - simple projects ~20 lines, complex projects can be longer but every section must provide value.

**Step-by-step process:**

1. Read the current BLADE.md file at ${blademdPath} and summarize its current structure

2. Read package.json and note:
   - Any new scripts or commands not documented
   - New dependencies that might need explanation
   - Changes in project structure

3. Check for existing AI rule files and note any useful guidance:
   - .cursorrules or .cursor/rules/
   - .github/copilot-instructions.md

4. Explore the codebase (use Glob/Grep tools) to identify:
   - Missing architectural information
   - Undocumented patterns or conventions
   - Important files or directories not mentioned
   - Key modules, design patterns, state management, data flow

**Evaluate against these criteria**:
- Has essential commands (build, test, lint, especially single test execution)?
- Has architecture overview proportional to project complexity?
- Does it include project-specific knowledge that saves agent time?
- Does it avoid LOW-VALUE content (generic best practices, exhaustive file listings)?

5. Provide comprehensive feedback in Chinese:
   - 当前 BLADE.md 的优点
   - 缺失或过时的内容
   - 具体的改进建议（附带示例）
   - 如果需要重大修改，提供完整的改进版本内容

**Final output**: Return your analysis and suggestions as plain text. Do NOT use Write tool.`;

        // 使用 chat 方法让 Agent 可以调用工具
        logger.info(`[/init] Starting agent.chat, signal.aborted: ${signal?.aborted}`);
        const result = await agent.chat(
          analysisPrompt,
          {
            messages: [],
            userId: 'cli-user',
            sessionId: sessionId || 'init-session',
            workspaceRoot: cwd,
            signal,
          },
          {
            // 注意：abort 检查已在 Agent 内部统一处理
            onToolStart: (toolCall: ChatCompletionMessageToolCall) => {
              if (toolCall.type !== 'function') return;
              try {
                const params = JSON.parse(toolCall.function.arguments);
                const summary = formatToolCallSummary(toolCall.function.name, params);
                sendToolMessage(summary);
              } catch {
                // 静默处理解析错误
              }
            },
            onToolResult: async (
              toolCall: ChatCompletionMessageToolCall,
              result: ToolResult
            ) => {
              if (toolCall.type !== 'function') return;
              if (result?.metadata?.summary) {
                sendToolMessage(result.metadata.summary);
              }
            },
          }
        );
        logger.info(`[/init] agent.chat completed, signal.aborted: ${signal?.aborted}`);

        if (signal?.aborted) {
          logger.info('[/init] Returning cancelled after agent.chat');
          return { success: false, message: '操作已取消' };
        }

        ui.sendMessage(result);

        return {
          success: true,
          message: '✅ 分析完成',
        };
      }

      // 显示适当的提示消息
      if (isEmpty) {
        ui.sendMessage('⚠️ 检测到空的 BLADE.md 文件，将重新生成...');
      }
      ui.sendMessage('🔍 正在分析项目结构...');

      // 创建 Agent 并生成内容
      const agent = await Agent.create();
      const analysisPrompt = `Please analyze this codebase and generate BLADE.md content.

**Important**: After each step, briefly describe what you found before proceeding.

**Context**: This file will be given to AI coding agents. Length should match project complexity - every section must provide value that saves agent time.

**Step-by-step process:**

1. Read package.json and summarize:
   - Project name and type
   - Key dependencies and frameworks
   - Available scripts (build, test, lint, etc.)

2. Check for existing AI rule files and incorporate useful guidance:
   - .cursorrules or .cursor/rules/
   - .github/copilot-instructions.md
   - README.md (extract non-obvious insights only)

3. Explore the project structure and note:
   - Main entry point
   - Key directories (src, tests, config, etc.)
   - Common patterns (React components, API routes, etc.)

4. Analyze the architecture and identify:
   - How the code is organized
   - Main modules/components and their responsibilities
   - Key design patterns (state management, data flow, etc.)
   - How different parts interact

5. Generate the final BLADE.md content with:
   - Project overview (type, languages, frameworks)
   - Essential commands (from package.json scripts, especially single test execution)
   - Architecture overview (structure, patterns, relationships)
   - Non-obvious conventions and gotchas
   - Key file locations for common tasks

**What to AVOID** (low-value content):
- Generic best practices (error handling basics, security fundamentals)
- Exhaustive file/directory listings without context
- Information already obvious from README or file names

**Format requirements:**
- Start with: "# BLADE.md\\n\\nalways respond in Chinese"
- Include actual working commands
- Focus on non-obvious insights
- Be concise but comprehensive for complex projects

**Final output**: Return ONLY the complete BLADE.md content (markdown format), ready to be written to the file.`;

      // 使用 chat 方法让 Agent 可以调用工具
      logger.info(`[/init] Starting agent.chat for new BLADE.md, signal.aborted: ${signal?.aborted}`);
      const generatedContent = await agent.chat(
        analysisPrompt,
        {
          messages: [],
          userId: 'cli-user',
          sessionId: sessionId || 'init-session',
          workspaceRoot: cwd,
          signal,
        },
        {
          // 注意：abort 检查已在 Agent 内部统一处理
          onToolStart: (toolCall: ChatCompletionMessageToolCall) => {
            if (toolCall.type !== 'function') return;
            try {
              const params = JSON.parse(toolCall.function.arguments);
              const summary = formatToolCallSummary(toolCall.function.name, params);
              sendToolMessage(summary);
            } catch {
              // 静默处理解析错误
            }
          },
          onToolResult: async (
            toolCall: ChatCompletionMessageToolCall,
            result: ToolResult
          ) => {
            if (toolCall.type !== 'function') return;
            if (result?.metadata?.summary) {
              sendToolMessage(result.metadata.summary);
            }
          },
        }
      );
      logger.info(`[/init] agent.chat completed for new BLADE.md, signal.aborted: ${signal?.aborted}`);

      if (signal?.aborted) {
        logger.info('[/init] Returning cancelled after agent.chat (new BLADE.md)');
        return { success: false, message: '操作已取消' };
      }

      // 验证生成内容的有效性（至少应该有基本的标题和内容）
      if (!generatedContent || generatedContent.trim().length === 0) {
        throw new Error('Agent 未能生成有效的 BLADE.md 内容');
      }

      // 写入生成的内容
      ui.sendMessage('✨ 正在写入 BLADE.md...');
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
