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
    kind: ToolKind.Memory,

    schema: z.object({
      todos: z.array(TodoItemSchema).min(1, '至少需要一个任务'),
    }),

    description: {
      short: '创建和管理结构化的TODO任务清单，跟踪复杂任务的执行进度',
      long: `
为当前编码会话创建和管理结构化的任务清单。帮助跟踪进度、组织复杂任务，并向用户展示工作的完整性。
也帮助用户理解任务进度和整体请求的完成情况。

**⚠️ 重要提醒：这不是子Agent调度工具！**
- 如需委托子Agent独立执行工作 → 使用 Task 工具
- 如需可视化跟踪任务进度清单 → 使用 TodoWrite 工具

**何时使用此工具（主动使用）：**

1. **复杂多步骤任务** - 任务需要 3 个或更多不同的步骤或操作
2. **非平凡的复杂任务** - 需要仔细规划或多个操作的任务
3. **用户明确请求** - 用户直接要求使用待办列表
4. **用户提供多个任务** - 用户提供待办事项列表（编号或逗号分隔）
5. **收到新指令后** - 立即将用户需求捕获为待办事项
6. **开始工作时** - 在开始工作前标记为 in_progress（理想情况下同时只有一个）
7. **完成任务后** - 标记为 completed，并添加实现过程中发现的新后续任务

**何时不使用此工具：**

1. 只有单个简单直接的任务
2. 任务是琐碎的，跟踪它没有组织价值
3. 任务可以在少于 3 个简单步骤内完成
4. 任务纯粹是对话性或信息性的

**注意：** 如果只有一个琐碎任务要做，不应使用此工具。在这种情况下，最好直接完成任务。

**任务状态：**
- pending: 尚未开始的任务
- in_progress: 当前正在执行的任务（同时限制为一个）
- completed: 已成功完成的任务

**任务描述格式要求：**
- content: 命令式形式描述需要做什么（如 "运行测试"、"构建项目"）
- activeForm: 现在进行时形式，执行期间显示（如 "运行测试中"、"构建项目中"）

**优先级：**
- high: 高优先级（P0）- 紧急重要任务
- medium: 中优先级（P1，默认）- 正常任务
- low: 低优先级（P2）- 可延后任务

**任务管理规则：**
- 实时更新任务状态
- 完成后立即标记（不要批量完成）
- 任何时候恰好一个任务为 in_progress（不多不少）
- 在开始新任务前完成当前任务
- 删除不再相关的任务

**任务完成要求：**
- 仅在完全完成任务时才标记为 completed
- 如果遇到错误、阻塞或无法完成，保持 in_progress
- 被阻塞时，创建新任务描述需要解决的问题
- 以下情况永远不要标记为 completed：
  - 测试失败
  - 实现不完整
  - 遇到未解决的错误
  - 找不到必要的文件或依赖项

**最佳实践：**
- 将复杂任务分解为 3-8 个具体可操作的子任务
- 创建具体、可操作的任务项
- 使用清晰、描述性的任务名称
- 任务会自动持久化到 ~/.blade/todos/{sessionId}-agent-{sessionId}.json
- 每个会话的 TODO 列表是独立的

**拿不准时，就使用此工具。** 主动的任务管理展示了细心，并确保成功完成所有要求。
      `.trim(),

      usageNotes: [
        '⚠️ 这是TODO清单管理工具！启动子Agent请使用 Task 工具',
        '⚠️ todos 参数必须是数组对象，不要序列化为 JSON 字符串',
        '同时只能有一个任务处于 in_progress 状态',
        '任务完成后立即标记为 completed，不要批量处理',
        'content 是命令式任务描述（如 "实现用户登录功能"）',
        'activeForm 是现在进行时描述（如 "实现用户登录功能中"）',
        '优先级默认为 medium，高优先级任务会优先显示',
        '主动使用此工具跟踪复杂任务（3+ 步骤）',
        '不要用于单个琐碎任务',
        '任务会持久化，支持跨会话恢复',
      ],

      examples: [
        {
          description: '添加暗色模式功能（用户请求测试和构建）',
          params: {
            todos: [
              {
                content: '在设置页面创建暗色模式切换组件',
                status: 'in_progress',
                activeForm: '在设置页面创建暗色模式切换组件中',
                priority: 'high',
              },
              {
                content: '添加暗色模式状态管理（context/store）',
                status: 'pending',
                activeForm: '添加暗色模式状态管理中',
                priority: 'high',
              },
              {
                content: '实现暗色主题的 CSS-in-JS 样式',
                status: 'pending',
                activeForm: '实现暗色主题的 CSS-in-JS 样式中',
                priority: 'high',
              },
              {
                content: '更新现有组件以支持主题切换',
                status: 'pending',
                activeForm: '更新现有组件以支持主题切换中',
                priority: 'medium',
              },
              {
                content: '运行测试和构建流程，解决任何失败或错误',
                status: 'pending',
                activeForm: '运行测试和构建流程中',
                priority: 'medium',
              },
            ],
          },
        },
        {
          description: '重命名函数跨项目（找到 15 处，8 个文件）',
          params: {
            todos: [
              {
                content: '搜索所有 getCwd 出现位置',
                status: 'completed',
                activeForm: '搜索 getCwd 出现位置中',
                priority: 'high',
              },
              {
                content: '更新 src/utils/path.ts 中的函数定义',
                status: 'in_progress',
                activeForm: '更新 src/utils/path.ts 中',
                priority: 'high',
              },
              {
                content: '更新 src/commands/*.ts 中的 5 处调用',
                status: 'pending',
                activeForm: '更新 src/commands 中的调用',
                priority: 'high',
              },
              {
                content: '更新测试文件中的引用',
                status: 'pending',
                activeForm: '更新测试文件中',
                priority: 'medium',
              },
              {
                content: '运行测试确保没有遗漏',
                status: 'pending',
                activeForm: '运行测试确保没有遗漏中',
                priority: 'medium',
              },
            ],
          },
        },
        {
          description: '电商网站功能实现（用户提供多个功能）',
          params: {
            todos: [
              {
                content: '实现用户注册功能（数据库模型、API、前端表单）',
                status: 'in_progress',
                activeForm: '实现用户注册功能中',
                priority: 'high',
              },
              {
                content: '实现产品目录功能',
                status: 'pending',
                activeForm: '实现产品目录功能中',
                priority: 'high',
              },
              {
                content: '实现购物车功能',
                status: 'pending',
                activeForm: '实现购物车功能中',
                priority: 'high',
              },
              {
                content: '实现结账流程',
                status: 'pending',
                activeForm: '实现结账流程中',
                priority: 'high',
              },
            ],
          },
        },
      ],

      important: [
        '⚠️ 这是TODO清单工具！启动子Agent请使用 Task 工具',
        '同时只能有一个 in_progress 任务',
        '任务完成后立即标记，保持列表最新',
        '遇到错误时保持任务为 in_progress，添加新任务说明问题',
        '仅在完全完成时才标记 completed（测试通过、无错误）',
        '任务描述要具体、可操作，避免模糊描述',
        '主动使用此工具跟踪 3+ 步骤的复杂任务',
        '必须同时提供 content（命令式）和 activeForm（进行时）',
      ],
    },

    async execute(params, context: ExecutionContext): Promise<ToolResult> {
      const { todos } = params;
      const { updateOutput } = context;

      try {
        const targetSessionId = context.sessionId || sessionId;
        const manager = TodoManager.getInstance(targetSessionId, configDir);

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
