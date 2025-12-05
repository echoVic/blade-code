import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ToolResult } from '../../types/ToolTypes.js';
import { ToolErrorType, ToolKind } from '../../types/ToolTypes.js';

/**
 * Skill tool
 * Execute a skill within the main conversation
 */
export const skillTool = createTool({
  name: 'Skill',
  displayName: 'Skill',
  kind: ToolKind.Execute,

  schema: z.object({
    skill: z
      .string()
      .describe('The skill name (no arguments). E.g., "pdf" or "xlsx"'),
  }),

  description: {
    short: 'Execute a skill within the main conversation',
    long: `Execute a skill within the main conversation

<skills_instructions>
When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.

How to use skills:
- Invoke skills using this tool with the skill name only (no arguments)
- When you invoke a skill, you will see <command-message>The "{name}" skill is loading</command-message>
- The skill's prompt will expand and provide detailed instructions on how to complete the task
- Examples:
  - \`skill: "pdf"\` - invoke the pdf skill
  - \`skill: "xlsx"\` - invoke the xlsx skill
  - \`skill: "ms-office-suite:pdf"\` - invoke using fully qualified name

Important:
- Only use skills listed in <available_skills> below
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)
</skills_instructions>

<available_skills>

</available_skills>
`,
  },

  async execute(params, _context): Promise<ToolResult> {
    const { skill } = params;

    // TODO: Implement skill handler in ExecutionContext when skill system is ready
    // For now, return a message indicating the skill system is not yet implemented

    return {
      success: false,
      llmContent: `Skill system not yet implemented. The skill "${skill}" could not be executed.`,
      displayContent: 'Skill system not available',
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: 'Skill handler not configured',
      },
    };
  },
});
