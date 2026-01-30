import { z } from 'zod';
import { CustomCommandRegistry } from '../../../slash-commands/custom/index.js';
import { createTool } from '../../core/createTool.js';
import type { ToolResult } from '../../types/ToolTypes.js';
import { ToolErrorType, ToolKind } from '../../types/ToolTypes.js';

/**
 * 字符预算（默认 15,000 字符）
 * 可通过环境变量 SLASH_COMMAND_TOOL_CHAR_BUDGET 配置
 */
const CHAR_BUDGET = Number.parseInt(
  process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET || '15000',
  10
);

/**
 * 生成可用命令列表描述
 */
function generateAvailableCommandsDescription(): string {
  const registry = CustomCommandRegistry.getInstance();

  if (!registry.isInitialized()) {
    return '\n(Custom commands not yet initialized)';
  }

  const { text, totalCount } = registry.generateCommandListDescription(CHAR_BUDGET);

  if (totalCount === 0) {
    return '\n(No custom commands available)';
  }

  return `\n\n<available_commands>\n${text}\n</available_commands>`;
}

/**
 * SlashCommand tool
 * Execute a custom slash command within the main conversation
 *
 * 自定义命令是用户在 .blade/commands/ 或 .claude/commands/ 目录下
 * 创建的 Markdown 文件。执行命令时：
 * - 解析参数插值 ($ARGUMENTS, $1, $2, ...)
 * - 执行 Bash 嵌入 (!`command`)
 * - 替换文件引用 (@path/to/file)
 * - 返回处理后的内容给 LLM
 */
export const slashCommandTool = createTool({
  name: 'SlashCommand',
  displayName: 'Slash Command',
  kind: ToolKind.Execute,

  schema: z.object({
    command: z
      .string()
      .describe(
        'The command name without the leading slash, e.g., "review-pr" or "commit"'
      ),
    arguments: z
      .string()
      .optional()
      .describe('Arguments to pass to the command, e.g., "123" or "fix bug"'),
  }),

  description: {
    short: 'Execute a custom slash command within the main conversation',
    long: `Execute a custom slash command within the main conversation

How slash commands work:
When you use this tool, the command's content (from .blade/commands/ or .claude/commands/) will be processed and returned. The content may include:
- Argument interpolation ($ARGUMENTS, $1, $2, ...)
- Bash command output (!${'`'}git status${'`'})
- File contents (@src/file.ts)

Usage:
- \`command\` (required): The command name without the leading slash
- \`arguments\` (optional): Arguments to pass to the command
- Example: \`command: "review-pr", arguments: "123"\`

IMPORTANT: Only use this tool for custom slash commands that appear in the Available Commands list below. Do NOT use for:
- Built-in CLI commands (like /help, /clear, /compact, etc.)
- Commands not shown in the list
- Commands you think might exist but aren't listed

Notes:
- When a user requests multiple slash commands, execute each one sequentially
- Only custom slash commands with descriptions are listed in Available Commands
- Commands with \`disable-model-invocation: true\` cannot be invoked by this tool
- If a command is not listed, ask the user to check the slash command file
${generateAvailableCommandsDescription()}`,
  },

  async execute(params, _context): Promise<ToolResult> {
    const { command, arguments: args } = params;

    // 获取 CustomCommandRegistry
    const registry = CustomCommandRegistry.getInstance();

    // 检查是否已初始化
    if (!registry.isInitialized()) {
      return {
        success: false,
        llmContent: `Custom command system not initialized. Please wait for the application to fully initialize.`,
        displayContent: '❌ Custom command system not initialized',
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: 'CustomCommandRegistry not initialized',
        },
      };
    }

    // 查找命令
    const cmd = registry.getCommand(command);
    if (!cmd) {
      const available = registry
        .getModelInvocableCommands()
        .map((c) => `/${c.name}`)
        .join(', ');
      return {
        success: false,
        llmContent: `Command "/${command}" not found. Available commands: ${available || 'none'}`,
        displayContent: `❌ Command "/${command}" not found`,
        error: {
          type: ToolErrorType.VALIDATION_ERROR,
          message: `Command "/${command}" is not registered`,
        },
      };
    }

    // 检查是否禁止 AI 调用
    if (cmd.config.disableModelInvocation) {
      return {
        success: false,
        llmContent: `Command "/${command}" has disabled model invocation. This command can only be executed by the user directly.`,
        displayContent: `❌ Command "/${command}" disabled for AI`,
        error: {
          type: ToolErrorType.PERMISSION_DENIED,
          message: `Command "/${command}" has disable-model-invocation: true`,
        },
      };
    }

    // 检查是否有 description（SlashCommand 工具要求）
    if (!cmd.config.description) {
      return {
        success: false,
        llmContent: `Command "/${command}" does not have a description and cannot be invoked by AI. Add a description in the command's frontmatter to enable AI invocation.`,
        displayContent: `❌ Command "/${command}" has no description`,
        error: {
          type: ToolErrorType.VALIDATION_ERROR,
          message: `Command "/${command}" missing description for AI invocation`,
        },
      };
    }

    // 解析参数
    const parsedArgs = args ? args.split(/\s+/).filter(Boolean) : [];

    // 执行命令（参数插值、Bash 嵌入、文件引用）
    try {
      const processedContent = await registry.executeCommand(command, {
        args: parsedArgs,
        workspaceRoot: process.cwd(),
      });

      if (!processedContent) {
        return {
          success: false,
          llmContent: `Failed to execute command "/${command}"`,
          displayContent: `❌ Failed to execute "/${command}"`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: `Command execution returned null`,
          },
        };
      }

      // 构建完整的命令指令
      const commandInstructions = buildCommandInstructions(
        cmd.name,
        processedContent,
        cmd.config
      );

      // 返回双消息
      return {
        success: true,
        // llmContent: 完整的命令指令（发送给 LLM）
        llmContent: commandInstructions,
        // displayContent: 可见的加载提示
        displayContent: `<command-message>/${command} is running...</command-message>`,
        metadata: {
          commandName: command,
          // allowed-tools: 限制命令执行期间可用的工具
          allowedTools: cmd.config.allowedTools,
          // model: 指定执行模型
          model: cmd.config.model,
          // 命令来源
          source: cmd.source,
          namespace: cmd.namespace,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        llmContent: `Error executing command "/${command}": ${errorMessage}`,
        displayContent: `❌ Error executing "/${command}"`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: errorMessage,
        },
      };
    }
  },
});

/**
 * 构建完整的命令指令
 */
function buildCommandInstructions(
  name: string,
  content: string,
  config: { allowedTools?: string[]; model?: string }
): string {
  let instructions = `# Custom Command: /${name}

The user has invoked the custom command "/${name}". Follow the instructions below to complete the task.

`;

  // 添加工具限制说明
  if (config.allowedTools && config.allowedTools.length > 0) {
    instructions += `**Allowed Tools:** ${config.allowedTools.join(', ')}
(You should only use these tools for this command)

`;
  }

  // 添加模型说明
  if (config.model) {
    instructions += `**Preferred Model:** ${config.model}

`;
  }

  instructions += `---

${content}

---

Remember: Follow the above instructions carefully to complete the user's request.`;

  return instructions;
}
