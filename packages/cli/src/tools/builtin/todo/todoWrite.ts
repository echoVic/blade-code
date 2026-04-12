import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { TodoManager } from './TodoManager.js';
import type { TodoStats } from './types.js';
import { type TodoItem, TodoItemSchema } from './types.js';

/**
 * Create TodoWrite tool
 */
export function createTodoWriteTool(opts: { sessionId: string; configDir: string }) {
  const { sessionId, configDir } = opts;

  return createTool({
    name: 'TodoWrite',
    displayName: 'Todo Write',
    kind: ToolKind.ReadOnly,
    isConcurrencySafe: false, // 写入 Todo 状态

    schema: z.object({
      todos: z.array(TodoItemSchema).min(1, 'At least one task is required'),
    }),

    // 工具描述（对齐 Claude Code 官方）
    description: {
      short:
        'Use this tool to create and manage a structured task list for your current coding session',
      long: `Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool
Use this tool proactively in these scenarios:

1. Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
2. Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
3. User explicitly requests todo list - When the user directly asks you to use the todo list
4. User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
5. After receiving new instructions - Immediately capture user requirements as todos
6. When you start working on a task - Mark it as in_progress BEFORE beginning work. Ideally you should only have one todo as in_progress at a time
7. After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
1. There is only a single, straightforward task
2. The task is trivial and tracking it provides no organizational benefit
3. The task can be completed in less than 3 trivial steps
4. The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Task States and Management

1. **Task States**: Use these states to track progress:
   - pending: Task not yet started
   - in_progress: Currently working on (limit to ONE task at a time)
   - completed: Task finished successfully

   **IMPORTANT**: Task descriptions must have two forms:
   - content: The imperative form describing what needs to be done (e.g., "Run tests", "Build the project")
   - activeForm: The present continuous form shown during execution (e.g., "Running tests", "Building the project")

2. **Task Management**:
   - Update task status in real-time as you work
   - Mark tasks complete IMMEDIATELY after finishing (don't batch completions)
   - Exactly ONE task must be in_progress at any time (not less, not more)
   - Complete current tasks before starting new ones
   - Remove tasks that are no longer relevant from the list entirely

3. **Task Completion Requirements**:
   - ONLY mark a task as completed when you have FULLY accomplished it
   - If you encounter errors, blockers, or cannot finish, keep the task as in_progress
   - When blocked, create a new task describing what needs to be resolved
   - Never mark a task as completed if:
     - Tests are failing
     - Implementation is partial
     - You encountered unresolved errors
     - You couldn't find necessary files or dependencies

4. **Task Breakdown**:
   - Create specific, actionable items
   - Break complex tasks into smaller, manageable steps
   - Use clear, descriptive task names
   - Always provide both forms:
     - content: "Fix authentication bug"
     - activeForm: "Fixing authentication bug"

When in doubt, use this tool. Being proactive with task management demonstrates attentiveness and ensures you complete all requirements successfully.
`,
    },

    async execute(params, context: ExecutionContext): Promise<ToolResult> {
      const { todos } = params;
      const { updateOutput } = context;

      try {
        const targetSessionId = context.sessionId || sessionId;
        const manager = TodoManager.getInstance(targetSessionId, configDir);

        updateOutput?.('Updating TODO list...');

        await manager.updateTodos(todos);

        const sortedTodos = manager.getTodos();
        const stats = calculateStats(sortedTodos);

        updateOutput?.(
          `[OK] TODO list updated (${stats.completed}/${stats.total} completed)`
        );

        return {
          success: true,
          llmContent: {
            todos: sortedTodos,
            stats,
          },
          metadata: { stats, summary: `更新 TODO (${stats.completed}/${stats.total} 完成)` },
        };
      } catch (error) {
        const err = error as Error;
        return {
          success: false,
          llmContent: `Update failed: ${err.message}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: err.message,
            details: error,
          },
          metadata: { summary: '更新 TODO 失败' },
        };
      }
    },

    version: '1.0.0',
    category: 'TODO tools',
    tags: ['todo', 'task', 'management', 'planning'],

    /**
     * 提取签名内容：返回 todos 数量
     */
    extractSignatureContent: (params) => `${params.todos.length} todos`,

    /**
     * 抽象权限规则：返回通配符
     */
    abstractPermissionRule: () => '*',
  });
}

/**
 * 计算统计信息
 */
function calculateStats(todos: TodoItem[]): TodoStats {
  return {
    total: todos.length,
    completed: todos.filter((t) => t.status === 'completed').length,
    inProgress: todos.filter((t) => t.status === 'in_progress').length,
    pending: todos.filter((t) => t.status === 'pending').length,
  };
}
