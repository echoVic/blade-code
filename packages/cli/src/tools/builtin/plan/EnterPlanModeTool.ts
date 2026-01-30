import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ToolResult } from '../../types/ToolTypes.js';
import { ToolErrorType, ToolKind } from '../../types/ToolTypes.js';

/**
 * EnterPlanMode tool
 * Requests user permission to enter Plan mode for complex tasks
 */
export const enterPlanModeTool = createTool({
  name: 'EnterPlanMode',
  displayName: 'Enter Plan Mode',
  kind: ToolKind.ReadOnly,

  schema: z.object({}),

  // 工具描述
  description: {
    short:
      'Use this tool to enter plan mode for complex tasks requiring careful planning',
    long: `Use this tool when you encounter a complex task that requires careful planning and exploration before implementation. This tool transitions you into plan mode where you can thoroughly explore the codebase and design an implementation approach.

## When to Use This Tool

Use EnterPlanMode when ANY of these conditions apply:

1. **Multiple Valid Approaches**: The task can be solved in several different ways, each with trade-offs
   - Example: "Add caching to the API" - could use Redis, in-memory, file-based, etc.
   - Example: "Improve performance" - many optimization strategies possible

2. **Significant Architectural Decisions**: The task requires choosing between architectural patterns
   - Example: "Add real-time updates" - WebSockets vs SSE vs polling
   - Example: "Implement state management" - Redux vs Context vs custom solution

3. **Large-Scale Changes**: The task touches many files or systems
   - Example: "Refactor the authentication system"
   - Example: "Migrate from REST to GraphQL"

4. **Unclear Requirements**: You need to explore before understanding the full scope
   - Example: "Make the app faster" - need to profile and identify bottlenecks
   - Example: "Fix the bug in checkout" - need to investigate root cause

5. **User Input Needed**: You'll need to ask clarifying questions before starting
   - If you would use AskUserQuestion to clarify the approach, consider EnterPlanMode instead
   - Plan mode lets you explore first, then present options with context

## When NOT to Use This Tool

Do NOT use EnterPlanMode for:
- Simple, straightforward tasks with obvious implementation
- Small bug fixes where the solution is clear
- Adding a single function or small feature
- Tasks you're already confident how to implement
- Research-only tasks (use the Task tool with explore agent instead)

## What Happens in Plan Mode

In plan mode, you'll:
1. Thoroughly explore the codebase using Glob, Grep, and Read tools
2. Understand existing patterns and architecture
3. Design an implementation approach
4. Present your plan to the user for approval
5. Use AskUserQuestion if you need to clarify approaches
6. Exit plan mode with ExitPlanMode when ready to implement

## Examples

### GOOD - Use EnterPlanMode:
User: "Add user authentication to the app"
- This requires architectural decisions (session vs JWT, where to store tokens, middleware structure)

User: "Optimize the database queries"
- Multiple approaches possible, need to profile first, significant impact

User: "Implement dark mode"
- Architectural decision on theme system, affects many components

### BAD - Don't use EnterPlanMode:
User: "Fix the typo in the README"
- Straightforward, no planning needed

User: "Add a console.log to debug this function"
- Simple, obvious implementation

User: "What files handle routing?"
- Research task, not implementation planning

## Important Notes

- This tool REQUIRES user approval - they must consent to entering plan mode
- Be thoughtful about when to use it - unnecessary plan mode slows down simple tasks
- If unsure whether to use it, err on the side of starting implementation
- You can always ask the user "Would you like me to plan this out first?"
`,
  },

  async execute(_params, context): Promise<ToolResult> {
    // Trigger UI confirmation flow
    if (context.confirmationHandler) {
      try {
        const response = await context.confirmationHandler.requestConfirmation({
          type: 'enterPlanMode',
          message:
            'The assistant requests to enter Plan mode for this complex task. In Plan mode, the assistant will:\n\n' +
            '1. Research the codebase thoroughly (read-only)\n' +
            '2. Understand existing patterns and architecture\n' +
            '3. Design an implementation approach\n' +
            '4. Present a detailed plan for your approval\n\n' +
            'Do you want to enter Plan mode?',
          details: 'Plan mode enables systematic research before implementation',
        });

        if (response.approved) {
          return {
            success: true,
            llmContent:
              '✅ User approved entering Plan mode.\n\n' +
              'You are now in PLAN MODE. Remember:\n' +
              '- Use ONLY read-only tools: Read, Glob, Grep, WebFetch, WebSearch, Task\n' +
              '- DO NOT use Edit, Write, Bash, or any file-modifying tools\n' +
              '- When your research is complete, call ExitPlanMode with your implementation plan\n' +
              '- For pure research questions, answer directly without ExitPlanMode\n\n' +
              'Begin your research now.',
            displayContent: '✅ Entering Plan mode',
            metadata: {
              approved: true,
              enterPlanMode: true, // Signal to switch to Plan mode
            },
          };
        } else {
          return {
            success: true, // Rejection is not an error
            llmContent:
              '⚠️ User declined to enter Plan mode.\n\n' +
              'Proceed with the task directly without planning phase. ' +
              'You can still use search tools to understand the codebase as needed, ' +
              'but implement the solution directly.',
            displayContent: '⚠️ Plan mode declined, proceeding directly',
            metadata: {
              approved: false,
              enterPlanMode: false,
            },
          };
        }
      } catch (error) {
        return {
          success: false,
          llmContent: `Confirmation flow error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          displayContent: '❌ Failed to request confirmation',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: 'Confirmation flow error',
          },
        };
      }
    }

    // Fallback: if no confirmation handler, return guidance
    return {
      success: true,
      llmContent:
        'Plan mode requested but no interactive confirmation available.\n\n' +
        'Proceeding with research phase. Use read-only tools to explore the codebase, ' +
        'then call ExitPlanMode with your implementation plan when ready.',
      displayContent: 'Plan mode (non-interactive)',
      metadata: { approved: null, enterPlanMode: true },
    };
  },
});
