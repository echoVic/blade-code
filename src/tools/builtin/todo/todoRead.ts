import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { TodoManager } from './TodoManager.js';
import type { TodoItem, TodoStats } from './types.js';

/**
 * 创建 TodoRead 工具
 */
export function createTodoReadTool(opts: { sessionId: string; configDir: string }) {
  const { sessionId, configDir } = opts;

  return createTool({
    name: 'TodoRead',
    displayName: 'TODO任务读取',
    kind: ToolKind.Read,

    schema: z.object({
      filter: z
        .enum(['all', 'pending', 'in_progress', 'completed'])
        .default('all')
        .describe('过滤条件：all(全部)、pending(待执行)、in_progress(执行中)、completed(已完成)'),
    }),

    description: {
      short: '读取当前会话的TODO任务列表',
      long: `
获取当前会话的 TODO 列表，支持按状态过滤。

任务列表会按照以下规则自动排序：
1. 按状态：已完成 < 执行中 < 待执行
2. 按优先级：高优先级 < 中优先级 < 低优先级

这样可以确保正在执行和待执行的高优先级任务始终显示在顶部。
      `.trim(),

      usageNotes: [
        '默认返回所有任务（filter=all）',
        '可以通过 filter 参数过滤特定状态的任务',
        '任务列表已自动排序，无需手动排序',
        '如果没有任务，返回空列表',
      ],

      examples: [
        {
          description: '读取所有任务',
          params: {},
        },
        {
          description: '只读取待执行的任务',
          params: {
            filter: 'pending',
          },
        },
        {
          description: '只读取已完成的任务',
          params: {
            filter: 'completed',
          },
        },
      ],
    },

    requiresConfirmation: async () => null,

    async execute(params, context: ExecutionContext): Promise<ToolResult> {
      const { filter } = params;

      try {
        const manager = TodoManager.getInstance(sessionId, configDir);

        let todos = manager.getTodos();

        if (filter !== 'all') {
          todos = todos.filter(t => t.status === filter);
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
          llmContent: `读取失败: ${error.message}`,
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
  });
}

/**
 * 计算统计信息
 */
function calculateStats(todos: TodoItem[]): TodoStats {
  return {
    total: todos.length,
    completed: todos.filter(t => t.status === 'completed').length,
    inProgress: todos.filter(t => t.status === 'in_progress').length,
    pending: todos.filter(t => t.status === 'pending').length,
  };
}

/**
 * 格式化 TODO 列表显示
 */
function formatTodoList(
  todos: TodoItem[],
  stats: TodoStats,
  filter: string
): string {
  const lines: string[] = [];

  const filterLabel = filter === 'all' ? '全部' : filter === 'pending' ? '待执行' : filter === 'in_progress' ? '执行中' : '已完成';

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
