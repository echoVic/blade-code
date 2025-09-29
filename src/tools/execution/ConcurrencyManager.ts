import { EventEmitter } from 'events';
import type {
  ConcurrencyConfig,
  ExecutionContext,
  ToolInvocation,
  ToolResult,
} from '../types/index.js';

/**
 * 并发管理器
 * 控制工具执行的并发数量和执行队列
 */
export class ConcurrencyManager extends EventEmitter {
  private readonly maxConcurrent: number;
  private readonly timeoutMs: number;
  private readonly retryAttempts: number;
  private readonly retryDelayMs: number;

  private running = new Map<string, Promise<ToolResult>>();
  private queue: QueuedExecution[] = [];
  private executionCounter = 0;

  constructor(config: ConcurrencyConfig) {
    super();

    this.maxConcurrent = config.maxConcurrent;
    this.timeoutMs = config.timeoutMs;
    this.retryAttempts = config.retryAttempts;
    this.retryDelayMs = config.retryDelayMs;
  }

  /**
   * 执行工具调用
   */
  async execute<T>(
    invocation: ToolInvocation<T>,
    context: ExecutionContext
  ): Promise<ToolResult> {
    const executionId = this.generateExecutionId();

    // 检查并发限制
    if (this.running.size >= this.maxConcurrent) {
      return this.enqueue(invocation, context, executionId);
    }

    return this.executeImmediate(invocation, context, executionId);
  }

  /**
   * 立即执行
   */
  private async executeImmediate<T>(
    invocation: ToolInvocation<T>,
    context: ExecutionContext,
    executionId: string
  ): Promise<ToolResult> {
    this.emit('executionStarted', {
      executionId,
      toolName: invocation.toolName,
      concurrentCount: this.running.size,
      queueLength: this.queue.length,
    });

    const promise = this.executeWithRetry(invocation, context, executionId);
    this.running.set(executionId, promise);

    try {
      const result = await promise;

      this.emit('executionCompleted', {
        executionId,
        toolName: invocation.toolName,
        success: result.success,
        concurrentCount: this.running.size - 1,
      });

      return result;
    } finally {
      this.running.delete(executionId);
      this.processQueue();
    }
  }

  /**
   * 加入队列
   */
  private async enqueue<T>(
    invocation: ToolInvocation<T>,
    context: ExecutionContext,
    executionId: string
  ): Promise<ToolResult> {
    return new Promise((resolve, reject) => {
      const queuedExecution: QueuedExecution = {
        executionId,
        invocation,
        context,
        resolve,
        reject,
        timestamp: Date.now(),
      };

      this.queue.push(queuedExecution);

      this.emit('executionQueued', {
        executionId,
        toolName: invocation.toolName,
        queuePosition: this.queue.length,
        queueLength: this.queue.length,
      });
    });
  }

  /**
   * 处理队列
   */
  private processQueue(): void {
    while (this.queue.length > 0 && this.running.size < this.maxConcurrent) {
      const queued = this.queue.shift()!;

      this.emit('executionDequeued', {
        executionId: queued.executionId,
        toolName: queued.invocation.toolName,
        waitTime: Date.now() - queued.timestamp,
        queueLength: this.queue.length,
      });

      // 异步执行，不等待结果
      this.executeImmediate(queued.invocation, queued.context, queued.executionId)
        .then(queued.resolve)
        .catch(queued.reject);
    }
  }

  /**
   * 带重试的执行
   */
  private async executeWithRetry<T>(
    invocation: ToolInvocation<T>,
    context: ExecutionContext,
    executionId: string,
    attempt: number = 1
  ): Promise<ToolResult> {
    try {
      return await this.executeWithTimeout(invocation, context);
    } catch (error) {
      const isLastAttempt = attempt >= this.retryAttempts;

      this.emit('executionAttemptFailed', {
        executionId,
        toolName: invocation.toolName,
        attempt,
        error: (error as Error).message,
        willRetry: !isLastAttempt,
      });

      if (isLastAttempt) {
        return {
          success: false,
          llmContent: `工具执行失败 (尝试 ${attempt} 次): ${(error as Error).message}`,
          displayContent: `执行失败: ${(error as Error).message}`,
          error: {
            type: 'EXECUTION_ERROR' as const,
            message: (error as Error).message,
            details: { attempts: attempt },
          },
        };
      }

      // 重试延迟
      await this.delay(this.retryDelayMs * attempt);
      return this.executeWithRetry(invocation, context, executionId, attempt + 1);
    }
  }

  /**
   * 带超时的执行
   */
  private async executeWithTimeout<T>(
    invocation: ToolInvocation<T>,
    context: ExecutionContext
  ): Promise<ToolResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const result = await invocation.execute(controller.signal, context.onProgress);

      clearTimeout(timeoutId);
      return result;
    } catch (error) {
      clearTimeout(timeoutId);

      if (controller.signal.aborted) {
        throw new Error(`工具执行超时 (${this.timeoutMs}ms)`);
      }

      throw error;
    }
  }

  /**
   * 获取运行状态
   */
  getStatus(): ConcurrencyStatus {
    return {
      running: this.running.size,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      totalExecutions: this.executionCounter,
      queuedExecutions: this.queue.map((q) => ({
        executionId: q.executionId,
        toolName: q.invocation.toolName,
        waitTime: Date.now() - q.timestamp,
      })),
    };
  }

  /**
   * 清空队列
   */
  clearQueue(): number {
    const clearedCount = this.queue.length;

    // 拒绝所有排队的执行
    for (const queued of this.queue) {
      queued.reject(new Error('执行队列已清空'));
    }

    this.queue = [];

    this.emit('queueCleared', {
      clearedCount,
      timestamp: Date.now(),
    });

    return clearedCount;
  }

  /**
   * 中止所有执行
   */
  async abortAll(): Promise<void> {
    // 清空队列
    this.clearQueue();

    // 等待所有运行中的执行完成（它们会因为signal.aborted而快速结束）
    await Promise.allSettled(Array.from(this.running.values()));

    this.emit('allExecutionsAborted', {
      timestamp: Date.now(),
    });
  }

  /**
   * 延迟函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 生成执行ID
   */
  private generateExecutionId(): string {
    return `conc_${++this.executionCounter}_${Date.now()}`;
  }
}

/**
 * 队列中的执行
 */
interface QueuedExecution {
  executionId: string;
  invocation: ToolInvocation;
  context: ExecutionContext;
  resolve: (result: ToolResult) => void;
  reject: (error: Error) => void;
  timestamp: number;
}

/**
 * 并发状态
 */
export interface ConcurrencyStatus {
  running: number;
  queued: number;
  maxConcurrent: number;
  totalExecutions: number;
  queuedExecutions: Array<{
    executionId: string;
    toolName: string;
    waitTime: number;
  }>;
}
