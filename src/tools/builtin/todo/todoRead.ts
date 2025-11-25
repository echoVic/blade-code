import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { TodoManager } from './TodoManager.js';
import type { TodoItem, TodoStats } from './types.js';

/**
 * Create TodoRead tool
 */
export function createTodoReadTool(opts: { sessionId: string; configDir: string }) {
  const { sessionId, configDir } = opts;

  return createTool({
    name: 'TodoRead',
    displayName: 'Todo Read',
    kind: ToolKind.Read,

    schema: z.object({
      filter: z
        .enum(['all', 'pending', 'in_progress', 'completed'])
        .default('all')
        .describe(
          'Filter: all, pending, in_progress, completed'
        ),
    }),

    description: {
      short: 'Read the TODO list for the current session',
      long: `
Retrieve TODO items for the current session with optional status filtering.

Tasks are automatically sorted:
1. By status: completed < in_progress < pending
2. By priority: high < medium < low

This keeps high-priority in-progress and pending tasks at the top.
      `.trim(),

      usageNotes: [
        'Defaults to returning all tasks (filter=all)',
        'Use filter to limit tasks by status',
        'Tasks are pre-sorted; no manual sorting needed',
        'Returns an empty list if no tasks exist',
      ],

      examples: [
        {
          description: 'Read all tasks',
          params: {},
        },
        {
          description: 'Read pending tasks only',
          params: {
            filter: 'pending',
          },
        },
        {
          description: 'Read completed tasks only',
          params: {
            filter: 'completed',
          },
        },
      ],
    },

    async execute(params, context: ExecutionContext): Promise<ToolResult> {
      const { filter } = params;

      try {
        const targetSessionId = context.sessionId || sessionId;
        const manager = TodoManager.getInstance(targetSessionId, configDir);

        let todos = manager.getTodos();

        if (filter !== 'all') {
          todos = todos.filter((t) => t.status === filter);
        }

        const stats = calculateStats(todos);
        const displayContent = formatTodoList(todos, stats, filter);

        return {
          success: true,
          llmContent: {
            todos,
            stats,
            filter,
          },
          displayContent,
          metadata: { stats, filter },
        };
      } catch (error: any) {
        return {
          success: false,
          llmContent: `Read failed: ${error.message}`,
          displayContent: `❌ 读取 TODO 列表失败: ${error.message}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: error.message,
            details: error,
          },
        };
      }
    },

    version: '1.0.0',
    category: 'TODO工具',
    tags: ['todo', 'query', 'read'],

    /**
     * 提取签名内容：返回过滤状态
     */
    extractSignatureContent: (params) => params.filter,

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
function formatTodoList(todos: TodoItem[], stats: TodoStats, filter: string): string {
  const lines: string[] = [];

  const filterLabel =
    filter === 'all'
      ? '全部'
      : filter === 'pending'
        ? '待执行'
        : filter === 'in_progress'
          ? '执行中'
          : '已完成';

  const percentage =
    stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0;

  if (filter === 'all') {
    lines.push(`📋 TODO 列表 (${stats.completed}/${stats.total} 完成，${percentage}%)`);
  } else {
    lines.push(`📋 TODO 列表 - ${filterLabel} (${todos.length} 项)`);
  }

  lines.push('');

  if (todos.length === 0) {
    lines.push(`  (暂无${filterLabel}任务)`);
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
