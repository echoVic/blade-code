import { Default, StringEnum, Type } from '../../../schema/index.js';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { TaskListManager } from './TaskListManager.js';
import type { TaskListItem, TaskStats, TaskUpdateStatus } from './taskListTypes.js';
import { TaskStatusSchema } from './taskListTypes.js';

const taskCreatePrompt = `Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.

## When to Use This Tool

Use this tool proactively in these scenarios:
- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
- Plan mode - When using plan mode, create a task list to track the work
- User explicitly requests a task list
- User provides multiple tasks
- After receiving new instructions - Immediately capture user requirements as tasks
- When you start working on a task - Mark it as in_progress with TaskUpdate BEFORE beginning work
- After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

## Task Fields

- subject: A brief, actionable title in imperative form (for example, "Run tests")
- description: What needs to be done
- activeForm: Present continuous form shown while in_progress (for example, "Running tests")

All tasks are created with status pending. Check TaskList first to avoid creating duplicates.`;

const taskUpdatePrompt = `Use this tool to update a task in the task list.

## When to Use This Tool

- Mark a task in_progress when you start working on it
- Mark a task completed immediately after fully finishing it
- Delete tasks that are no longer relevant by setting status to deleted
- Update task details when requirements change or become clearer
- Establish dependencies with addBlocks or addBlockedBy

Only mark a task completed when it is fully accomplished. If tests are failing, implementation is partial, or you are blocked, keep the task in_progress and create or update a task describing the blocker.

## Status Workflow

Status progresses: pending -> in_progress -> completed

Use deleted to permanently remove a task. Read the latest state with TaskGet before making risky updates.`;

export function createTaskListTools(opts: { sessionId: string; configDir: string }) {
  return [
    createTaskCreateTool(opts),
    createTaskGetTool(opts),
    createTaskUpdateTool(opts),
    createTaskListTool(opts),
  ];
}

function createTaskCreateTool(opts: { sessionId: string; configDir: string }) {
  const { sessionId, configDir } = opts;

  return createTool({
    name: 'TaskCreate',
    displayName: 'Task Create',
    kind: ToolKind.ReadOnly,
    isConcurrencySafe: false,
    schema: Type.Object({
      subject: Type.String({
        minLength: 1,
        description: 'A brief title for the task',
      }),
      description: Type.String({
        minLength: 1,
        description: 'What needs to be done',
      }),
      activeForm: Type.Optional(
        Type.String({
          description: 'Present continuous form shown while in_progress',
        })
      ),
      owner: Type.Optional(Type.String({ description: 'Optional owner for the task' })),
      priority: Default(StringEnum(['high', 'medium', 'low']), 'medium'),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    description: {
      short: 'Create a new task in the task list',
      long: taskCreatePrompt,
    },
    async execute(params, context: ExecutionContext): Promise<ToolResult> {
      try {
        const manager = getManager(context, sessionId, configDir);
        const task = await manager.createTask(params);
        const tasks = await manager.listTasks();
        const stats = manager.getStats();

        return taskResult({
          llmContent: {
            task: toPublicTask(task),
            tasks: tasks.map(toPublicTask),
            stats,
          },
          summary: `创建任务 #${task.id}: ${task.subject}`,
          tasks,
          stats,
        });
      } catch (error) {
        return taskError(error, '创建任务失败');
      }
    },
    version: '1.0.0',
    category: 'Task tools',
    tags: ['task', 'management', 'planning'],
    extractSignatureContent: (params) => params.subject,
    abstractPermissionRule: () => '*',
  });
}

function createTaskGetTool(opts: { sessionId: string; configDir: string }) {
  const { sessionId, configDir } = opts;

  return createTool({
    name: 'TaskGet',
    displayName: 'Task Get',
    kind: ToolKind.ReadOnly,
    isConcurrencySafe: true,
    isRetrySafe: true,
    schema: Type.Object({
      taskId: Type.String({
        minLength: 1,
        description: 'The ID of the task to retrieve',
      }),
    }),
    description: {
      short: 'Retrieve a task by ID',
      long: 'Use this tool to inspect the latest state of a task before updating it.',
    },
    async execute(params, context: ExecutionContext): Promise<ToolResult> {
      try {
        const manager = getManager(context, sessionId, configDir);
        const task = await manager.getTask(params.taskId);

        return {
          success: true,
          llmContent: {
            task: task ? toPublicTask(task) : null,
          },
          metadata: {
            summary: task ? `读取任务 #${task.id}` : `任务 #${params.taskId} 不存在`,
          },
        };
      } catch (error) {
        return taskError(error, '读取任务失败');
      }
    },
    version: '1.0.0',
    category: 'Task tools',
    tags: ['task', 'management', 'planning'],
    extractSignatureContent: (params) => params.taskId,
    abstractPermissionRule: () => '*',
  });
}

function createTaskUpdateTool(opts: { sessionId: string; configDir: string }) {
  const { sessionId, configDir } = opts;

  return createTool({
    name: 'TaskUpdate',
    displayName: 'Task Update',
    kind: ToolKind.ReadOnly,
    isConcurrencySafe: false,
    schema: Type.Object({
      taskId: Type.String({
        minLength: 1,
        description: 'The ID of the task to update',
      }),
      subject: Type.Optional(
        Type.String({ minLength: 1, description: 'New subject for the task' })
      ),
      description: Type.Optional(
        Type.String({ minLength: 1, description: 'New description for the task' })
      ),
      activeForm: Type.Optional(Type.String({ minLength: 1 })),
      status: Type.Optional(Type.Union([TaskStatusSchema, Type.Literal('deleted')])),
      owner: Type.Optional(Type.String()),
      addBlocks: Type.Optional(Type.Array(Type.String())),
      addBlockedBy: Type.Optional(Type.Array(Type.String())),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    description: {
      short: 'Update a task in the task list',
      long: taskUpdatePrompt,
    },
    async execute(params, context: ExecutionContext): Promise<ToolResult> {
      try {
        const manager = getManager(context, sessionId, configDir);
        const status = params.status as TaskUpdateStatus | undefined;

        if (status === 'deleted') {
          const deleted = await manager.deleteTask(params.taskId);
          const tasks = await manager.listTasks();
          const stats = manager.getStats();

          return taskResult({
            llmContent: {
              success: deleted,
              taskId: params.taskId,
              updatedFields: deleted ? ['deleted'] : [],
              error: deleted ? undefined : 'Task not found',
              tasks: tasks.map(toPublicTask),
              stats,
            },
            summary: deleted
              ? `删除任务 #${params.taskId}`
              : `任务 #${params.taskId} 不存在`,
            tasks,
            stats,
          });
        }

        const { task, updatedFields, statusChange } = await manager.updateTask(
          params.taskId,
          {
            subject: params.subject,
            description: params.description,
            activeForm: params.activeForm,
            status,
            owner: params.owner,
            addBlocks: params.addBlocks,
            addBlockedBy: params.addBlockedBy,
            metadata: params.metadata,
          }
        );
        const tasks = await manager.listTasks();
        const stats = manager.getStats();

        return taskResult({
          llmContent: {
            success: task !== null,
            taskId: params.taskId,
            task: task ? toPublicTask(task) : null,
            updatedFields,
            error: task ? undefined : 'Task not found',
            statusChange,
            tasks: tasks.map(toPublicTask),
            stats,
          },
          summary: task
            ? `更新任务 #${params.taskId}`
            : `任务 #${params.taskId} 不存在`,
          tasks,
          stats,
        });
      } catch (error) {
        return taskError(error, '更新任务失败');
      }
    },
    version: '1.0.0',
    category: 'Task tools',
    tags: ['task', 'management', 'planning'],
    extractSignatureContent: (params) => params.taskId,
    abstractPermissionRule: () => '*',
  });
}

function createTaskListTool(opts: { sessionId: string; configDir: string }) {
  const { sessionId, configDir } = opts;

  return createTool({
    name: 'TaskList',
    displayName: 'Task List',
    kind: ToolKind.ReadOnly,
    isConcurrencySafe: true,
    isRetrySafe: true,
    schema: Type.Object({}),
    description: {
      short: 'List all tasks',
      long: 'Use this tool to check the current task list and avoid creating duplicate tasks.',
    },
    async execute(_params, context: ExecutionContext): Promise<ToolResult> {
      try {
        const manager = getManager(context, sessionId, configDir);
        const tasks = await manager.listTasks();
        const stats = manager.getStats();

        return taskResult({
          llmContent: {
            tasks: tasks.map(toPublicTask),
            stats,
          },
          summary:
            tasks.length === 0
              ? '暂无任务'
              : `任务列表 (${stats.completed}/${stats.total} 完成)`,
          tasks,
          stats,
        });
      } catch (error) {
        return taskError(error, '读取任务列表失败');
      }
    },
    version: '1.0.0',
    category: 'Task tools',
    tags: ['task', 'management', 'planning'],
    extractSignatureContent: () => '*',
    abstractPermissionRule: () => '*',
  });
}

function getManager(
  context: ExecutionContext,
  fallbackSessionId: string,
  configDir: string
): TaskListManager {
  return TaskListManager.getInstance(
    context.taskListId ||
      context.goalTaskListId ||
      context.sessionId ||
      fallbackSessionId,
    configDir
  );
}

function taskResult(input: {
  llmContent: Record<string, unknown>;
  summary: string;
  tasks: TaskListItem[];
  stats: TaskStats;
}): ToolResult {
  return {
    success: true,
    llmContent: input.llmContent,
    metadata: {
      summary: input.summary,
      tasks: input.tasks,
      stats: input.stats,
    },
  };
}

function taskError(error: unknown, summary: string): ToolResult {
  const err = error as Error;
  return {
    success: false,
    llmContent: `Task operation failed: ${err.message}`,
    error: {
      type: ToolErrorType.EXECUTION_ERROR,
      message: err.message,
      details: error,
    },
    metadata: { summary },
  };
}

function toPublicTask(task: TaskListItem) {
  return {
    id: task.id,
    subject: task.subject,
    description: task.description,
    status: task.status,
    activeForm: task.activeForm,
    owner: task.owner,
    priority: task.priority,
    blocks: task.blocks,
    blockedBy: task.blockedBy,
    metadata: task.metadata,
  };
}
