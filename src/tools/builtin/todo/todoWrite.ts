import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { TodoManager } from './TodoManager.js';
import type { TodoItem, TodoStats } from './types.js';
import { TodoItemSchema } from './types.js';

/**
 * Create TodoWrite tool
 */
export function createTodoWriteTool(opts: { sessionId: string; configDir: string }) {
  const { sessionId, configDir } = opts;

  return createTool({
    name: 'TodoWrite',
    displayName: 'Todo Write',
    kind: ToolKind.Memory,

    schema: z.object({
      todos: z.array(TodoItemSchema).min(1, 'At least one task is required'),
    }),

    description: {
      short: 'Create and manage structured TODO lists to track complex work',
      long: `
Create and manage structured TODO lists for the current coding session. Helps track progress, organize complex tasks, and show completeness to the user.

**⚠️ Important: This is NOT the subagent scheduler!**
- To delegate work to a subagent → use the Task tool
- To visually track task progress → use the TodoWrite tool

**When to use (proactively):**
1. Complex multi-step tasks (3+ distinct steps)
2. Non-trivial tasks requiring planning or multiple actions
3. User explicitly requests a TODO list
4. User provides multiple tasks (numbered or comma-separated)
5. Upon receiving new instructions, capture them as TODO items immediately
6. When starting work, mark one task as in_progress (ideally only one at a time)
7. After completing a task, mark it completed and add any follow-up tasks discovered

**When NOT to use:**
1. A single simple task
2. Trivial tasks where tracking adds no value
3. Tasks doable in fewer than 3 simple steps
4. Tasks that are purely conversational or informational

**Note:** If there is only one trivial task, do not use this tool—just do it.

**Task statuses:**
- pending: not started
- in_progress: currently being worked on (limit one at a time)
- completed: finished successfully

**Task description format:**
- content: imperative description of what to do (e.g., "Run tests", "Build project")
- activeForm: present-continuous form shown while active (e.g., "Running tests", "Building project")

**Priorities:**
- high: urgent/important (P0)
- medium: normal (P1, default)
- low: lower priority (P2)

**Task management rules:**
- Update task status in real time
- Mark tasks as completed immediately (no batch updates)
- Exactly one task should be in_progress at any time
- Finish the current task before starting a new one
- Remove tasks that are no longer relevant

**Completion requirements:**
- Only mark completed when fully done
- If blocked/error/unfinished, keep in_progress
- When blocked, create a new task describing what is needed
- Never mark completed when: tests failing, implementation incomplete, unresolved errors, missing files/deps

**Best practices:**
- Break complex tasks into 3-8 concrete, actionable subtasks
- Write clear, descriptive task names
- TODOs persist at ~/.blade/todos/{sessionId}-agent-{sessionId}.json
- Each session has its own TODO list

**When in doubt, use this tool.** Proactive task management shows diligence and keeps work on track.
      `.trim(),

      usageNotes: [
        '⚠️ This is the TODO list tool; launch subagents with the Task tool',
        '⚠️ todos must be an array of objects, not a JSON string',
        'Only one task may be in_progress at a time',
        'Mark tasks completed immediately—no batching',
        'content is an imperative task description (e.g., "Implement user login")',
        'activeForm is the present-progress description (e.g., "Implementing user login")',
        'Priority defaults to medium; high-priority tasks surface first',
        'Use proactively for complex tasks (3+ steps)',
        'Do not use for a single trivial task',
        'Tasks persist and can be restored across sessions',
      ],

      examples: [
        {
          description: 'Add dark mode feature (user requested tests and build)',
          params: {
            todos: [
              {
                content: 'Create dark mode toggle on settings page',
                status: 'in_progress',
                activeForm: 'Creating dark mode toggle on settings page',
                priority: 'high',
              },
              {
                content: 'Add dark mode state management (context/store)',
                status: 'pending',
                activeForm: 'Adding dark mode state management',
                priority: 'high',
              },
              {
                content: 'Implement dark theme CSS-in-JS styles',
                status: 'pending',
                activeForm: 'Implementing dark theme styles',
                priority: 'high',
              },
              {
                content: 'Update existing components to support theme switching',
                status: 'pending',
                activeForm: 'Updating components to support theme switching',
                priority: 'medium',
              },
              {
                content: 'Run tests/builds and fix any failures or errors',
                status: 'pending',
                activeForm: 'Running tests/builds',
                priority: 'medium',
              },
            ],
          },
        },
        {
          description: 'Rename a function across the project (15 hits, 8 files)',
          params: {
            todos: [
              {
                content: 'Find all getCwd occurrences',
                status: 'completed',
                activeForm: 'Searching for getCwd occurrences',
                priority: 'high',
              },
              {
                content: 'Update function definition in src/utils/path.ts',
                status: 'in_progress',
                activeForm: 'Updating src/utils/path.ts',
                priority: 'high',
              },
              {
                content: 'Update 5 call sites in src/commands/*.ts',
                status: 'pending',
                activeForm: 'Updating call sites in src/commands',
                priority: 'high',
              },
              {
                content: 'Update references in test files',
                status: 'pending',
                activeForm: 'Updating test files',
                priority: 'medium',
              },
              {
                content: 'Run tests to ensure nothing was missed',
                status: 'pending',
                activeForm: 'Running tests to ensure nothing was missed',
                priority: 'medium',
              },
            ],
          },
        },
        {
          description: 'Implement e-commerce features (user provided multiple asks)',
          params: {
            todos: [
              {
                content: 'Implement user registration (DB model, API, frontend form)',
                status: 'in_progress',
                activeForm: 'Implementing user registration',
                priority: 'high',
              },
              {
                content: 'Implement product catalog feature',
                status: 'pending',
                activeForm: 'Implementing product catalog',
                priority: 'high',
              },
              {
                content: 'Implement shopping cart',
                status: 'pending',
                activeForm: 'Implementing shopping cart',
                priority: 'high',
              },
              {
                content: 'Implement checkout flow',
                status: 'pending',
                activeForm: 'Implementing checkout flow',
                priority: 'high',
              },
            ],
          },
        },
      ],

      important: [
        '⚠️ This is the TODO list tool—use Task to launch subagents',
        'Only one in_progress task at a time',
        'Mark tasks immediately on completion to keep the list current',
        'If blocked, keep task in_progress and add a new task describing the blocker',
        'Mark completed only when fully done (tests pass, no errors)',
        'Task descriptions must be specific and actionable',
        'Use proactively for complex tasks (3+ steps)',
        'Provide both content (imperative) and activeForm (progressive)',
      ],
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

        const displayContent = formatTodoList(sortedTodos, stats);

        updateOutput?.(`✅ TODO list updated (${stats.completed}/${stats.total} completed)`);

        return {
          success: true,
          llmContent: {
            todos: sortedTodos,
            stats,
          },
          displayContent,
          metadata: { stats },
        };
      } catch (error: any) {
        return {
          success: false,
          llmContent: `Update failed: ${error.message}`,
          displayContent: `❌ 更新 TODO 列表失败: ${error.message}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: error.message,
            details: error,
          },
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

/**
 * 格式化 TODO 列表显示
 */
function formatTodoList(todos: TodoItem[], stats: TodoStats): string {
  const lines: string[] = [];

  const percentage =
    stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0;

  lines.push(`📋 TODO 列表 (${stats.completed}/${stats.total} 完成，${percentage}%)`);
  lines.push('');

  if (todos.length === 0) {
    lines.push('  (暂无任务)');
    return lines.join('\n');
  }

  for (const todo of todos) {
    const icon = todo.status === 'completed' ? '☑' : '☐';

    const priorityLabel = `(P${todo.priority === 'high' ? 0 : todo.priority === 'medium' ? 1 : 2})`;

    const statusFlag = todo.status === 'in_progress' ? ' ⚡' : '';

    const strikethrough = todo.status === 'completed' ? '~~' : '';

    lines.push(
      `  ${icon} ${priorityLabel} ${strikethrough}${todo.content}${strikethrough}${statusFlag}`
    );
  }

  return lines.join('\n');
}
