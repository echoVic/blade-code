import type { SessionStateStorage } from '../../../context/storage/SessionStateStorage.js';
import { Default, StringEnum, Type } from '../../../schema/index.js';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';
import { TaskListManager } from './TaskListManager.js';
import taskCreatePrompt from './task-create.md?raw';
import taskUpdatePrompt from './task-update.md?raw';
import type { TaskListItem, TaskStats, TaskUpdateStatus } from './taskListTypes.js';
import { TaskStatusSchema } from './taskListTypes.js';

interface TaskListToolOptions {
  sessionId: string;
  configDir: string;
  stateStorage?: SessionStateStorage;
}

export function createTaskListTools(opts: TaskListToolOptions) {
  return [
    createTaskCreateTool(opts),
    createTaskGetTool(opts),
    createTaskUpdateTool(opts),
    createTaskListTool(opts),
  ];
}

function createTaskCreateTool(opts: TaskListToolOptions) {
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
        const manager = getManager(context, sessionId, configDir, opts.stateStorage);
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

function createTaskGetTool(opts: TaskListToolOptions) {
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
        const manager = getManager(context, sessionId, configDir, opts.stateStorage);
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

function createTaskUpdateTool(opts: TaskListToolOptions) {
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
        const manager = getManager(context, sessionId, configDir, opts.stateStorage);
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

function createTaskListTool(opts: TaskListToolOptions) {
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
        const manager = getManager(context, sessionId, configDir, opts.stateStorage);
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
  configDir: string,
  stateStorage?: SessionStateStorage
): TaskListManager {
  return TaskListManager.getInstance(
    context.taskListId ||
      context.goalTaskListId ||
      context.sessionId ||
      fallbackSessionId,
    configDir,
    stateStorage
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
