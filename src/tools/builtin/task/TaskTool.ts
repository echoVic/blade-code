import { randomUUID } from 'crypto';
import { DeclarativeTool } from '../../base/DeclarativeTool.js';
import { BaseToolInvocation } from '../../base/ToolInvocation.js';
import type {
  ConfirmationDetails,
  JSONSchema7,
  ToolInvocation,
  ToolResult,
} from '../../types/index.js';
import { ToolKind } from '../../types/index.js';

/**
 * 任务参数接口
 */
interface TaskParams {
  description: string;
  subagent_type?: string;
  prompt?: string;
  context?: Record<string, any>;
  timeout?: number;
  run_in_background?: boolean;
}

/**
 * 任务状态
 */
enum TaskStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

/**
 * 任务结果
 */
interface TaskResult {
  task_id: string;
  status: TaskStatus;
  description: string;
  subagent_type?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  duration?: number;
  result?: any;
  error?: string;
  background: boolean;
}

/**
 * 任务管理器
 */
class TaskManager {
  private static instance: TaskManager;
  private tasks: Map<string, TaskResult> = new Map();

  static getInstance(): TaskManager {
    if (!TaskManager.instance) {
      TaskManager.instance = new TaskManager();
    }
    return TaskManager.instance;
  }

  createTask(params: TaskParams): TaskResult {
    const taskId = randomUUID();
    const task: TaskResult = {
      task_id: taskId,
      status: TaskStatus.PENDING,
      description: params.description,
      subagent_type: params.subagent_type,
      created_at: new Date().toISOString(),
      background: params.run_in_background || false,
    };

    this.tasks.set(taskId, task);
    return task;
  }

  getTask(taskId: string): TaskResult | undefined {
    return this.tasks.get(taskId);
  }

  getAllTasks(): TaskResult[] {
    return Array.from(this.tasks.values()).sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  }

  updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    data?: Partial<TaskResult>
  ): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = status;

      if (status === TaskStatus.RUNNING && !task.started_at) {
        task.started_at = new Date().toISOString();
      }

      if (
        (status === TaskStatus.COMPLETED || status === TaskStatus.FAILED) &&
        !task.completed_at
      ) {
        task.completed_at = new Date().toISOString();
        if (task.started_at) {
          task.duration =
            new Date(task.completed_at).getTime() - new Date(task.started_at).getTime();
        }
      }

      if (data) {
        Object.assign(task, data);
      }
    }
  }

  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (task && task.status === TaskStatus.PENDING) {
      this.updateTaskStatus(taskId, TaskStatus.CANCELLED);
      return true;
    }
    return false;
  }

  cleanupCompletedTasks(olderThanHours: number = 24): number {
    const cutoffTime = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
    let cleaned = 0;

    for (const [taskId, task] of this.tasks.entries()) {
      if (task.completed_at && new Date(task.completed_at) < cutoffTime) {
        if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) {
          this.tasks.delete(taskId);
          cleaned++;
        }
      }
    }

    return cleaned;
  }
}

/**
 * Task工具调用实现
 */
class TaskToolInvocation extends BaseToolInvocation<TaskParams> {
  constructor(params: TaskParams) {
    super('task', params);
  }

  getDescription(): string {
    const { description, subagent_type, run_in_background } = this.params;
    const agentInfo = subagent_type ? ` (使用${subagent_type}代理)` : '';
    const backgroundInfo = run_in_background ? ' (后台执行)' : '';
    return `创建任务: ${description}${agentInfo}${backgroundInfo}`;
  }

  getAffectedPaths(): string[] {
    return [];
  }

  async shouldConfirm(): Promise<ConfirmationDetails | null> {
    const { description, subagent_type, run_in_background } = this.params;

    if (run_in_background || subagent_type) {
      return {
        type: 'execute',
        title: '确认创建任务',
        message: `将创建任务: ${description}`,
        risks: [
          run_in_background ? '任务将在后台执行' : '任务将立即执行',
          subagent_type
            ? `将使用${subagent_type}代理执行任务`
            : '将使用默认代理执行任务',
          '任务可能消耗系统资源',
        ],
        affectedFiles: [],
      };
    }

    return null;
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void
  ): Promise<ToolResult> {
    try {
      this.validateParams();
      this.checkAbortSignal(signal);

      const {
        description,
        subagent_type,
        prompt,
        context,
        timeout = 300000, // 5分钟默认超时
        run_in_background = false,
      } = this.params;

      const taskManager = TaskManager.getInstance();

      updateOutput?.(`创建任务: ${description}`);

      // 创建任务
      const task = taskManager.createTask(this.params);

      if (run_in_background) {
        // 后台任务：立即返回任务ID
        this.scheduleBackgroundTask(task, {
          prompt,
          context,
          timeout,
          signal,
        });

        const metadata = {
          task_id: task.task_id,
          background: true,
          created_at: task.created_at,
        };

        const displayMessage =
          `任务已创建并在后台执行\n` +
          `任务ID: ${task.task_id}\n` +
          `描述: ${description}\n` +
          `使用 task_status 工具查看进度`;

        return this.createSuccessResult(
          {
            task_id: task.task_id,
            status: task.status,
            background: true,
            description: task.description,
          },
          displayMessage,
          metadata
        );
      } else {
        // 前台任务：等待完成
        return await this.executeTaskSync(task, {
          prompt,
          context,
          timeout,
          signal,
          updateOutput,
        });
      }
    } catch (error: any) {
      return this.createErrorResult(error);
    }
  }

  private scheduleBackgroundTask(
    task: TaskResult,
    options: {
      prompt?: string;
      context?: Record<string, any>;
      timeout: number;
      signal: AbortSignal;
    }
  ): void {
    const taskManager = TaskManager.getInstance();

    // 异步执行任务
    setTimeout(async () => {
      try {
        taskManager.updateTaskStatus(task.task_id, TaskStatus.RUNNING);

        // 模拟任务执行（实际应该调用相应的Agent）
        const result = await this.simulateTaskExecution(task, options);

        taskManager.updateTaskStatus(task.task_id, TaskStatus.COMPLETED, {
          result,
        });
      } catch (error: any) {
        taskManager.updateTaskStatus(task.task_id, TaskStatus.FAILED, {
          error: error.message,
        });
      }
    }, 0);
  }

  private async executeTaskSync(
    task: TaskResult,
    options: {
      prompt?: string;
      context?: Record<string, any>;
      timeout: number;
      signal: AbortSignal;
      updateOutput?: (output: string) => void;
    }
  ): Promise<ToolResult> {
    const taskManager = TaskManager.getInstance();

    try {
      updateOutput?.(`开始执行任务: ${task.description}`);
      taskManager.updateTaskStatus(task.task_id, TaskStatus.RUNNING);

      const result = await this.simulateTaskExecution(task, options);

      taskManager.updateTaskStatus(task.task_id, TaskStatus.COMPLETED, {
        result,
      });

      const completedTask = taskManager.getTask(task.task_id)!;

      const metadata = {
        task_id: task.task_id,
        duration: completedTask.duration,
        completed_at: completedTask.completed_at,
      };

      const displayMessage = this.formatDisplayMessage(completedTask);

      return this.createSuccessResult(completedTask, displayMessage, metadata);
    } catch (error: any) {
      taskManager.updateTaskStatus(task.task_id, TaskStatus.FAILED, {
        error: error.message,
      });

      const failedTask = taskManager.getTask(task.task_id)!;

      return this.createErrorResult(`任务执行失败: ${error.message}`, {
        task_id: task.task_id,
        error: error.message,
        failed_at: failedTask.completed_at,
      });
    }
  }

  private async simulateTaskExecution(
    task: TaskResult,
    options: {
      prompt?: string;
      context?: Record<string, any>;
      timeout: number;
      signal: AbortSignal;
    }
  ): Promise<any> {
    // 这里应该是实际的Agent调用逻辑
    // 为了演示，我们模拟一个简单的任务执行
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('任务执行超时'));
      }, options.timeout);

      const abortHandler = () => {
        clearTimeout(timeoutId);
        reject(new Error('任务被用户中止'));
      };

      options.signal.addEventListener('abort', abortHandler);

      // 模拟任务处理时间
      setTimeout(
        () => {
          clearTimeout(timeoutId);
          options.signal.removeEventListener('abort', abortHandler);

          resolve({
            task_description: task.description,
            subagent_type: task.subagent_type || 'general',
            execution_result: `任务 "${task.description}" 已成功完成`,
            context: options.context,
            timestamp: new Date().toISOString(),
          });
        },
        Math.random() * 2000 + 1000
      ); // 1-3秒随机延迟
    });
  }

  private formatDisplayMessage(task: TaskResult): string {
    let message = `任务执行完成: ${task.description}`;
    message += `\n任务ID: ${task.task_id}`;
    message += `\n状态: ${task.status}`;

    if (task.duration) {
      message += `\n执行时间: ${task.duration}ms`;
    }

    if (task.result) {
      const resultPreview =
        typeof task.result === 'object'
          ? JSON.stringify(task.result, null, 2)
          : String(task.result);

      if (resultPreview.length > 500) {
        message += `\n执行结果:\n${resultPreview.substring(0, 500)}...(已截断)`;
      } else {
        message += `\n执行结果:\n${resultPreview}`;
      }
    }

    return message;
  }
}

/**
 * Agent任务调度工具
 * 创建和管理Agent执行任务
 */
export class TaskTool extends DeclarativeTool<TaskParams> {
  constructor() {
    const schema: JSONSchema7 = {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          minLength: 1,
          description: '任务描述',
        },
        subagent_type: {
          type: 'string',
          description: '指定子代理类型（可选）',
        },
        prompt: {
          type: 'string',
          description: '任务提示词（可选）',
        },
        context: {
          type: 'object',
          description: '任务上下文数据（可选）',
        },
        timeout: {
          type: 'integer',
          minimum: 5000,
          maximum: 1800000, // 30分钟
          default: 300000, // 5分钟
          description: '任务超时时间（毫秒）',
        },
        run_in_background: {
          type: 'boolean',
          default: false,
          description: '是否在后台执行任务',
        },
      },
      required: ['description'],
      additionalProperties: false,
    };

    super(
      'task',
      'Agent任务调度',
      '创建和管理Agent执行任务，支持同步和异步执行模式',
      ToolKind.Execute,
      schema,
      true, // 任务创建需要确认
      '1.0.0',
      '任务工具',
      ['task', 'agent', 'schedule', 'workflow']
    );
  }

  build(params: TaskParams): ToolInvocation<TaskParams> {
    // 验证参数
    const description = this.validateString(params.description, 'description', {
      required: true,
      minLength: 1,
    });

    let subagentType: string | undefined;
    if (params.subagent_type !== undefined) {
      subagentType = this.validateString(params.subagent_type, 'subagent_type', {
        required: false,
        minLength: 1,
      });
    }

    let prompt: string | undefined;
    if (params.prompt !== undefined) {
      prompt = this.validateString(params.prompt, 'prompt', {
        required: false,
      });
    }

    let context: Record<string, any> | undefined;
    if (params.context !== undefined) {
      if (
        typeof params.context !== 'object' ||
        params.context === null ||
        Array.isArray(params.context)
      ) {
        this.createValidationError('context', '上下文必须是对象类型', params.context);
      }
      context = params.context;
    }

    let timeout: number | undefined;
    if (params.timeout !== undefined) {
      timeout = this.validateNumber(params.timeout, 'timeout', {
        min: 5000,
        max: 1800000,
        integer: true,
      });
    }

    const runInBackground = this.validateBoolean(
      params.run_in_background ?? false,
      'run_in_background'
    );

    const validatedParams: TaskParams = {
      description,
      ...(subagentType !== undefined && { subagent_type: subagentType }),
      ...(prompt !== undefined && { prompt }),
      ...(context !== undefined && { context }),
      ...(timeout !== undefined && { timeout }),
      run_in_background: runInBackground,
    };

    return new TaskToolInvocation(validatedParams);
  }
}

// 导出任务管理器以供其他工具使用
export { TaskManager, TaskStatus, type TaskResult };
