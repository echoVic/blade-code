import { z } from 'zod';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { TodoManager } from './TodoManager.js';
import type { TodoItem, TodoStats } from './types.js';
import { TodoItemSchema } from './types.js';

/**
 * 创建 TodoWrite 工具
 */
export function createTodoWriteTool(opts: { sessionId: string; configDir: string }) {
  const { sessionId, configDir } = opts;

  return createTool({
    name: 'TodoWrite',
    displayName: 'TODO任务写入',
    kind: ToolKind.Execute,

    schema: z.object({
      todos: z.array(TodoItemSchema).min(1, '至少需要一个任务'),
    }),

    description: {
      short: '创建和更新TODO任务列表，用于跟踪复杂任务的执行进度',
      long: `
管理用户可见的任务分解列表。支持任务状态跟踪、优先级管理和持久化存储。

**任务状态：**
- pending: 待执行的任务
- in_progress: 正在执行的任务（同时只能有一个）
- completed: 已完成的任务

**优先级：**
- high: 高优先级（P0）- 紧急重要任务
- medium: 中优先级（P1，默认）- 正常任务
- low: 低优先级（P2）- 可延后任务

**最佳实践：**
- 将复杂任务分解为 3-8 个可操作的子任务
- 每完成一个任务立即标记为 completed
- 开始新任务时标记为 in_progress
- 任务会自动持久化，下次会话可恢复
      `.trim(),

      usageNotes: [
        '⚠️ todos 参数必须是数组对象,不要序列化为 JSON 字符串',
        '同时只能有一个任务处于 in_progress 状态',
        '任务完成后立即标记为 completed，不要批量处理',
        'content 是任务描述（如 "实现用户登录功能"）',
        'activeForm 是进行时描述（如 "实现用户登录功能中"）',
        '优先级默认为 medium，高优先级任务会优先显示',
        '任务会持久化到 ~/.blade/todos/{sessionId}.json',
        '每个会话的 TODO 列表是独立的',
      ],

      examples: [
        {
          description: '创建复杂任务的分解列表',
          params: {
            todos: [
              {
                content: '分析现有代码架构',
                status: 'in_progress',
                activeForm: '分析现有代码架构中',
                priority: 'high',
              },
              {
                content: '设计新功能的数据模型',
                status: 'pending',
                activeForm: '设计新功能的数据模型中',
                priority: 'high',
              },
              {
                content: '实现核心业务逻辑',
                status: 'pending',
                activeForm: '实现核心业务逻辑中',
                priority: 'medium',
              },
              {
                content: '编写单元测试',
                status: 'pending',
                activeForm: '编写单元测试中',
                priority: 'medium',
              },
              {
                content: '更新文档',
                status: 'pending',
                activeForm: '更新文档中',
                priority: 'low',
              },
            ],
          },
        },
        {
          description: '更新任务状态（完成一个，开始下一个）',
          params: {
            todos: [
              {
                content: '分析现有代码架构',
                status: 'completed',
                activeForm: '分析现有代码架构中',
                priority: 'high',
              },
              {
                content: '设计新功能的数据模型',
                status: 'in_progress',
                activeForm: '设计新功能的数据模型中',
                priority: 'high',
              },
              {
                content: '实现核心业务逻辑',
                status: 'pending',
                activeForm: '实现核心业务逻辑中',
                priority: 'medium',
              },
            ],
          },
        },
      ],

      important: [
        '同时只能有一个 in_progress 任务',
        '任务完成立即标记，保持列表最新',
        '遇到错误时保持任务为 in_progress，添加新任务说明问题',
        '任务描述要具体、可操作，避免模糊描述',
      ],
    },

    requiresConfirmation: async () => null,

    async execute(params, context: ExecutionContext): Promise<ToolResult> {
      const { todos } = params;
      const { updateOutput } = context;

      try {
        const manager = TodoManager.getInstance(sessionId, configDir);

        updateOutput?.('更新 TODO 列表...');

        await manager.updateTodos(todos);

        const sortedTodos = manager.getTodos();
        const stats = calculateStats(sortedTodos);

        const displayContent = formatTodoList(sortedTodos, stats);

        updateOutput?.(`✅ TODO 列表已更新 (${stats.completed}/${stats.total} 完成)`);

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
          llmContent: `更新失败: ${error.message}`,
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
    category: 'TODO工具',
    tags: ['todo', 'task', 'management', 'planning'],
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
