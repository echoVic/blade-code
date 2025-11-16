/**
 * /init slash command implementation
 * 分析当前项目并生成 BLADE.md 配置文件
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { Agent } from '../agent/Agent.js';
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from './types.js';

const initCommand: SlashCommand = {
  name: 'init',
  description: '分析当前项目并生成 BLADE.md 配置文件',
  usage: '/init',
  async handler(
    args: string[],
    context: SlashCommandContext
  ): Promise<SlashCommandResult> {
    try {
      const { cwd, addAssistantMessage } = context;

      // 检查是否已存在 BLADE.md
      const blademdPath = path.join(cwd, 'BLADE.md');
      const exists = await fs
        .access(blademdPath)
        .then(() => true)
        .catch(() => false);

      if (exists) {
        addAssistantMessage('⚠️ BLADE.md 已存在。');
        addAssistantMessage('💡 正在分析现有文件并提供改进建议...');

        // 创建 Agent 并分析现有文件
        const agent = await Agent.create();
        const analysisPrompt = `Please analyze the existing BLADE.md file and suggest improvements.

**Step-by-step process:**

1. Read the current BLADE.md file at ${blademdPath}

2. Read package.json to check for:
   - New scripts or commands not documented
   - New dependencies that might need explanation
   - Changed project structure

3. Explore the codebase to identify:
   - Missing architectural information
   - Undocumented patterns or conventions
   - Important files or directories not mentioned

4. Provide feedback:
   - What's good about the current BLADE.md
   - What's missing or outdated
   - Suggested improvements (with specific examples)
   - If significant changes needed, provide an updated version

Focus on practical, actionable improvements that make the file more useful for future AI assistants.`;

        // 使用 chat 方法让 Agent 可以调用工具
        const result = await agent.chat(
          analysisPrompt,
          {
            messages: [],
            userId: 'cli-user',
            sessionId: context.sessionId || 'init-session',
            workspaceRoot: cwd,
          }
        );

        addAssistantMessage(result);

        return {
          success: true,
          message: '✅ 分析完成',
        };
      }

      // 创建空文件并显示进度
      await fs.writeFile(blademdPath, '', 'utf-8');
      addAssistantMessage('✅ 已创建空的 BLADE.md 文件');
      addAssistantMessage('🔍 正在分析项目结构...');

      // 创建 Agent 并生成内容
      const agent = await Agent.create();
      const analysisPrompt = `Please analyze this codebase and create a BLADE.md file.

**Step-by-step process:**

1. First, read package.json to understand:
   - Project name and type
   - Dependencies and frameworks
   - Available scripts (build, test, lint, etc.)

2. Explore the project structure:
   - Find the main entry point
   - Identify key directories (src, tests, config, etc.)
   - Look for common patterns (React components, API routes, etc.)

3. Analyze the architecture:
   - How is the code organized?
   - What are the main modules/components?
   - How do different parts interact?

4. Generate BLADE.md with:
   - Project overview (type, languages, frameworks)
   - Essential commands (from package.json scripts)
   - Architecture overview (structure, patterns, relationships)
   - Development guidelines (testing, building, deploying)

**Format requirements:**
- Start with: "# BLADE.md\\n\\n你是一个专门帮助 [项目类型] 开发者的助手。"
- Include actual working commands
- Focus on non-obvious insights
- Be concise but comprehensive

After analysis, write the complete BLADE.md content to ${blademdPath}.`;

      // 使用 chat 方法让 Agent 可以调用工具
      const generatedContent = await agent.chat(
        analysisPrompt,
        {
          messages: [],
          userId: 'cli-user',
          sessionId: context.sessionId || 'init-session',
          workspaceRoot: cwd,
        }
      );

      // 写入生成的内容
      await fs.writeFile(blademdPath, generatedContent, 'utf-8');
      addAssistantMessage('✅ 已生成 BLADE.md 文件');

      return {
        success: true,
        message: '✅ 初始化完成',
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
