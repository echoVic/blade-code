import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ToolResult } from '../../types/ToolTypes.js';
import { ToolErrorType, ToolKind } from '../../types/ToolTypes.js';

/**
 * SlashCommand tool
 * Execute a slash command within the main conversation
 */
export const slashCommandTool = createTool({
  name: 'SlashCommand',
  displayName: 'Slash Command',
  kind: ToolKind.Execute,

  schema: z.object({
    command: z
      .string()
      .describe(
        'The slash command to execute with its arguments, e.g., "/review-pr 123"'
      ),
  }),

  description: {
    short: 'Execute a slash command within the main conversation',
    long: `Execute a slash command within the main conversation

How slash commands work:
When you use this tool or when a user types a slash command, you will see <command-message>{name} is running...</command-message> followed by the expanded prompt. For example, if .claude/commands/foo.md contains "Print today's date", then /foo expands to that prompt in the next message.

Usage:
- \`command\` (required): The slash command to execute, including any arguments
- Example: \`command: "/review-pr 123"\`

IMPORTANT: Only use this tool for custom slash commands that appear in the Available Commands list below. Do NOT use for:
- Built-in CLI commands (like /help, /clear, etc.)
- Commands not shown in the list
- Commands you think might exist but aren't listed

Notes:
- When a user requests multiple slash commands, execute each one sequentially and check for <command-message>{name} is running...</command-message> to verify each has been processed
- Do not invoke a command that is already running. For example, if you see <command-message>foo is running...</command-message>, do NOT use this tool with "/foo" - process the expanded prompt in the following message
- Only custom slash commands with descriptions are listed in Available Commands. If a user's command is not listed, ask them to check the slash command file and consult the docs.
`,
  },

  async execute(params, _context): Promise<ToolResult> {
    const { command } = params;

    // TODO: Implement slash command handler in ExecutionContext when ready
    // For now, return a message indicating the system is not yet implemented

    return {
      success: false,
      llmContent: `Slash command system not yet implemented. The command "${command}" could not be executed.`,
      displayContent: 'Slash command system not available',
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: 'Slash command handler not configured',
      },
    };
  },
});
