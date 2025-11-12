import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { Agent } from '../../../agent/Agent.js';
import type { ChatContext } from '../../../agent/types.js';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext, ToolResult } from '../../types/index.js';
import { ToolErrorType, ToolKind } from '../../types/index.js';

/**
 * 任务状态
 */
export enum TaskStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

/**
 * 任务结果
 */
export interface TaskResult {
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
export class TaskManager {
  private static instance: TaskManager;
  private tasks: Map<string, TaskResult> = new Map();

  static getInstance(): TaskManager {
    if (!TaskManager.instance) {
      TaskManager.instance = new TaskManager();
    }
    return TaskManager.instance;
  }

  createTask(params: {
    description: string;
    subagent_type?: string;
    run_in_background?: boolean;
  }): TaskResult {
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

// Agent 工厂函数
let agentFactory: (() => Promise<Agent>) | undefined;

/**
 * 设置 Agent 工厂函数
 */
export function setTaskToolAgentFactory(factory: () => Promise<Agent>): void {
  agentFactory = factory;
}

/**
 * TaskTool - Agent 任务调度工具
 * 使用新的 Zod 验证设计
 */
export const taskTool = createTool({
  name: 'Task',
  displayName: 'Agent任务调度',
  kind: ToolKind.Execute,
  isReadOnly: true, // 🆕 显式标记为只读（启动子 Agent 不修改系统状态）

  // Zod Schema 定义
  schema: z.object({
    description: z.string().min(1).describe('任务描述'),
    subagent_type: z.string().optional().describe('指定子代理类型(可选)'),
    prompt: z.string().optional().describe('任务提示词(可选)'),
    context: z.record(z.any()).optional().describe('任务上下文数据(可选)'),
    timeout: z
      .number()
      .int()
      .min(5000)
      .max(1800000)
      .default(300000)
      .describe('任务超时时间(毫秒,默认5分钟)'),
    run_in_background: z.boolean().default(false).describe('是否在后台执行任务'),
  }),

  // 工具描述
  description: {
    short: '启动独立的子Agent自主执行复杂的多步骤任务',
    long: `
启动专门的子Agent来自主处理复杂任务。子Agent是独立的执行进程，拥有自己的工具访问权限和执行上下文。

**适用场景：**
- 需要多轮对话和工具调用才能完成的复杂任务
- 需要大量代码搜索、探索和分析的任务
- 需要独立执行上下文的后台任务
- 将大任务委托给专门的子Agent处理

**⚠️ 重要提醒：这不是TODO清单管理工具！**
- 如需可视化跟踪任务进度清单 → 使用 TodoWrite 工具
- 如需委托子Agent独立执行工作 → 使用 Task 工具

**何时不使用此工具：**
- 不要用于管理TODO任务清单（使用 TodoWrite）
- 不要用于简单的文件读取（使用 Read）
- 不要用于单个文件的代码搜索（使用 Grep）
- 不要用于已知路径的文件查找（使用 Glob）
- 不要用于简单的单步操作
    `.trim(),
    usageNotes: [
      '⚠️ 此工具用于启动子Agent，不是TODO清单管理！管理TODO请使用TodoWrite工具',
      'description 参数是必需的，应简短描述任务（3-5个词）',
      'prompt 参数应包含完整详细的任务指令和期望输出格式',
      '可通过 subagent_type 指定特定类型的子 Agent',
      '每个子Agent都是独立进程，消耗独立的资源和token',
      '子Agent无法访问父Agent的对话历史，需要在prompt中提供完整上下文',
      'context 用于传递结构化的任务上下文数据',
      'timeout 默认 5 分钟，最长 30 分钟',
      'run_in_background=true 时任务在后台执行，立即返回task_id',
      '后台任务需要使用 task_status 工具查看进度和结果',
    ],
    examples: [
      {
        description: '启动子Agent分析项目依赖',
        params: {
          description: '分析项目依赖',
          prompt:
            '分析项目中的所有依赖包，检查是否有过时或存在安全漏洞的包，生成详细报告包括：1) 过时包列表 2) 安全漏洞 3) 建议的更新方案',
        },
      },
      {
        description: '指定子代理类型执行优化',
        params: {
          description: '优化数据库查询',
          subagent_type: 'database-optimizer',
          prompt: '分析所有数据库查询语句，找出性能瓶颈，并提供优化建议',
        },
      },
      {
        description: '后台执行长时间测试任务',
        params: {
          description: '运行完整测试套件',
          prompt: '运行项目中的所有单元测试和集成测试，收集测试覆盖率，生成详细报告',
          run_in_background: true,
          timeout: 600000,
        },
      },
      {
        description: '带上下文的数据处理任务',
        params: {
          description: '处理用户数据',
          prompt: '根据context中的user_id和action，执行相应的数据导出操作',
          context: {
            user_id: '12345',
            action: 'export',
          },
        },
      },
    ],
    important: [
      '⚠️ 这不是TODO清单工具！管理任务清单请使用 TodoWrite',
      '任务创建需要用户确认（消耗额外资源）',
      '子 Agent 会消耗独立的系统资源和API token',
      '子Agent是无状态的，无法访问父Agent的对话历史',
      '后台任务需要手动使用 task_status 工具查看状态',
      '任务超时会自动中止，建议合理设置timeout',
      'prompt 应该详细完整，包含所有必要的上下文信息',
    ],
  },

  // 执行函数
  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const {
      description,
      prompt,
      context: taskContext,
      timeout = 300000, // 5分钟默认超时
      run_in_background = false,
    } = params;
    const { updateOutput } = context;
    const signal = context.signal ?? new AbortController().signal;

    try {
      const taskManager = TaskManager.getInstance();

      updateOutput?.(`创建任务: ${description}`);

      // 创建任务
      const task = taskManager.createTask(params);

      if (run_in_background) {
        // 后台任务：立即返回任务ID
        scheduleBackgroundTask(task, {
          prompt,
          context: taskContext,
          timeout,
          signal,
          executionContext: context, // ✅ 传递 ExecutionContext
        });

        const metadata = {
          task_id: task.task_id,
          background: true,
          created_at: task.created_at,
        };

        const displayMessage =
          `✅ 任务已创建并在后台执行\n` +
          `任务ID: ${task.task_id}\n` +
          `描述: ${description}\n` +
          `使用 task_status 工具查看进度`;

        return {
          success: true,
          llmContent: {
            task_id: task.task_id,
            status: task.status,
            background: true,
            description: task.description,
          },
          displayContent: displayMessage,
          metadata,
        };
      } else {
        // 前台任务：等待完成
        return await executeTaskSync(task, {
          prompt,
          context: taskContext,
          timeout,
          signal,
          updateOutput,
          executionContext: context, // ✅ 传递 ExecutionContext
        });
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        return {
          success: false,
          llmContent: '任务执行被中止',
          displayContent: '⚠️ 任务执行被用户中止',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: '操作被中止',
          },
        };
      }

      return {
        success: false,
        llmContent: `任务创建失败: ${error.message}`,
        displayContent: `❌ 任务创建失败: ${error.message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: error.message,
          details: error,
        },
      };
    }
  },

  version: '2.0.0',
  category: '任务工具',
  tags: ['task', 'agent', 'schedule', 'workflow'],

  /**
   * 提取签名内容：返回任务描述和提示组合
   */
  extractSignatureContent: (params) => `${params.description} | ${params.prompt}`,

  /**
   * 抽象权限规则：Task 工具禁用自动生成规则
   * 返回空字符串表示不自动添加权限规则
   */
  abstractPermissionRule: () => '',
});

/**
 * 后台任务调度
 */
function scheduleBackgroundTask(
  task: TaskResult,
  options: {
    prompt?: string;
    context?: Record<string, any>;
    timeout: number;
    signal: AbortSignal;
    executionContext?: ExecutionContext; // ✅ 添加执行上下文参数
  }
): void {
  const taskManager = TaskManager.getInstance();

  // 异步执行任务
  setTimeout(async () => {
    try {
      taskManager.updateTaskStatus(task.task_id, TaskStatus.RUNNING);

      // 模拟任务执行（实际应该调用相应的Agent）
      const result = await simulateTaskExecution(task, options);

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

/**
 * 同步执行任务
 */
async function executeTaskSync(
  task: TaskResult,
  options: {
    prompt?: string;
    context?: Record<string, any>;
    timeout: number;
    signal: AbortSignal;
    updateOutput?: (output: string) => void;
    executionContext?: ExecutionContext; // ✅ 添加执行上下文参数
  }
): Promise<ToolResult> {
  const taskManager = TaskManager.getInstance();

  try {
    options.updateOutput?.(`开始执行任务: ${task.description}`);
    taskManager.updateTaskStatus(task.task_id, TaskStatus.RUNNING);

    const result = await simulateTaskExecution(task, options);

    taskManager.updateTaskStatus(task.task_id, TaskStatus.COMPLETED, {
      result,
    });

    const completedTask = taskManager.getTask(task.task_id)!;

    const metadata = {
      task_id: task.task_id,
      duration: completedTask.duration,
      completed_at: completedTask.completed_at,
    };

    const displayMessage = formatDisplayMessage(completedTask);

    return {
      success: true,
      llmContent: completedTask,
      displayContent: displayMessage,
      metadata,
    };
  } catch (error: any) {
    taskManager.updateTaskStatus(task.task_id, TaskStatus.FAILED, {
      error: error.message,
    });

    const failedTask = taskManager.getTask(task.task_id)!;

    return {
      success: false,
      llmContent: `任务执行失败: ${error.message}`,
      displayContent: `❌ 任务执行失败: ${error.message}`,
      error: {
        type: ToolErrorType.EXECUTION_ERROR,
        message: error.message,
        details: {
          task_id: task.task_id,
          error: error.message,
          failed_at: failedTask.completed_at,
        },
      },
    };
  }
}

/**
 * TODO 模拟任务执行
 */
async function simulateTaskExecution(
  task: TaskResult,
  options: {
    prompt?: string;
    context?: Record<string, any>;
    timeout: number;
    signal: AbortSignal;
    executionContext?: ExecutionContext; // 添加执行上下文参数
  }
): Promise<any> {
  // 尝试使用真实的子 Agent
  if (agentFactory) {
    console.log('🚀 使用真实子 Agent 执行任务...');
    try {
      // 创建子 Agent
      const subAgent = await agentFactory();

      // 构建完整的 ChatContext，传递 confirmationHandler
      const subContext: ChatContext = {
        messages: [], // 子任务从空消息列表开始
        userId: (options.context?.userId as string) || 'subagent',
        sessionId: (options.context?.sessionId as string) || `subagent_${Date.now()}`,
        workspaceRoot: (options.context?.workspaceRoot as string) || process.cwd(),
        signal: options.signal,
        confirmationHandler: options.executionContext?.confirmationHandler,
      };

      // 调用 runAgenticLoop
      const result = await subAgent.runAgenticLoop(
        options.prompt || task.description,
        subContext,
        {
          maxTurns: 10, // 子任务限制为 10 轮
          signal: options.signal,
        }
      );

      if (result.success) {
        return {
          task_description: task.description,
          subagent_type: task.subagent_type || 'general',
          execution_result: result.finalMessage,
          metadata: result.metadata,
          timestamp: new Date().toISOString(),
        };
      } else {
        throw new Error(result.error?.message || '子任务执行失败');
      }
    } catch (error) {
      console.error('子 Agent 执行失败:', error);
      throw error;
    }
  }

  // 降级：使用模拟逻辑
  console.log('⚠️ 未配置 agentFactory，使用模拟逻辑');
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
          execution_result: `任务 "${task.description}" 已成功完成(模拟)`,
          context: options.context,
          timestamp: new Date().toISOString(),
        });
      },
      Math.random() * 2000 + 1000
    ); // 1-3秒随机延迟
  });
}

/**
 * 格式化显示消息
 */
function formatDisplayMessage(task: TaskResult): string {
  let message = `✅ 任务执行完成: ${task.description}`;
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
