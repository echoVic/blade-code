/**
 * 增强型Steering控制器
 * 实现实时任务控制和动态重定向功能
 */

import { EventEmitter } from 'events';
import type { AgentTask } from './types.js';

export interface SteeringDirection {
  type: 'pause' | 'resume' | 'redirect' | 'cancel' | 'priority_adjust';
  targetTaskId?: string;
  newTask?: AgentTask;
  priority?: number;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskRedirectResult {
  success: boolean;
  originalTask: AgentTask;
  newTask?: AgentTask;
  redirectTime: number;
  error?: string;
}

export interface MessageEvent {
  id: string;
  type: 'steering' | 'status' | 'error';
  payload: unknown;
  timestamp: number;
  priority: 'high' | 'medium' | 'low';
}

export interface AsyncMessageQueue {
  push(message: MessageEvent): void;
  pop(): Promise<MessageEvent>;
  peek(): MessageEvent | undefined;
  size(): number;
  clear(): void;
}

export interface TaskInterceptor {
  canIntercept(task: AgentTask): boolean;
  intercept(task: AgentTask): Promise<AgentTask | null>;
}

/**
 * 异步消息队列实现 - 支持优先级排序
 */
class PriorityAsyncMessageQueue implements AsyncMessageQueue {
  private messages: MessageEvent[] = [];
  private resolvers: ((message: MessageEvent) => void)[] = [];
  private readonly maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  push(message: MessageEvent): void {
    if (this.messages.length >= this.maxSize) {
      this.messages.shift(); // 删除最早的消息
    }

    // 按优先级和时间排序插入
    const priorityValue = { high: 3, medium: 2, low: 1 };
    const insertIndex = this.messages.findIndex(
      (msg) => priorityValue[msg.priority] < priorityValue[message.priority]
    );

    if (insertIndex === -1) {
      this.messages.push(message);
    } else {
      this.messages.splice(insertIndex, 0, message);
    }

    // 通知等待的接收方
    if (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()!;
      resolver(this.messages.shift()!);
    }
  }

  async pop(): Promise<MessageEvent> {
    if (this.messages.length > 0) {
      return this.messages.shift()!;
    }

    // 等待新消息到来
    return new Promise<MessageEvent>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  peek(): MessageEvent | undefined {
    return this.messages[0];
  }

  size(): number {
    return this.messages.length;
  }

  clear(): void {
    this.messages.length = 0;
    this.resolvers.length = 0;
  }
}

/**
 * 默认任务拦截器
 */
class DefaultTaskInterceptor implements TaskInterceptor {
  private readonly interceptableTaskTypes: string[] = [
    'code_generate',
    'code_review',
    'file_operation',
  ];

  canIntercept(task: AgentTask): boolean {
    return this.interceptableTaskTypes.includes(task.type);
  }

  async intercept(task: AgentTask): Promise<AgentTask | null> {
    // 检查任务是否可被拦截（例如：任务尚未执行关键操作）
    if (!task.metadata || !('executionStage' in task.metadata)) {
      return task; // 可以拦截
    }

    const stage = task.metadata.executionStage as string;
    if (['preparing', 'validating'].includes(stage)) {
      return task; // 可以拦截
    }

    return null; // 不可拦截
  }
}

/**
 * 增强型Steering控制器
 * 扩展标准SteeringController以支持实时控制和动态重定向
 */
export class EnhancedSteeringController extends EventEmitter {
  private readonly messageQueue: AsyncMessageQueue;
  private readonly taskInterceptor: TaskInterceptor;
  private isInitialized = false;
  private isSteeringLoopActive = false;
  private activeTasks = new Map<string, AgentTask>();
  private taskHistory: AgentTask[] = [];
  private steeringLoopInterval?: NodeJS.Timeout;
  private readonly maxHistorySize = 100;

  constructor(messageQueue?: AsyncMessageQueue, taskInterceptor?: TaskInterceptor) {
    super();
    this.messageQueue = messageQueue || new PriorityAsyncMessageQueue();
    this.taskInterceptor = taskInterceptor || new DefaultTaskInterceptor();
  }

  /**
   * 初始化实时控制中心
   */
  public async initializeRealTimeControl(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      this.log('初始化增强型Steering控制器...');

      // 设置消息队列监听
      this.setupMessageQueue();

      // 启用任务拦截机制
      this.enableTaskInterception();

      // 启动实时控制循环
      this.startSteeringLoop();

      this.isInitialized = true;
      this.emit('initialized');
      this.log('增强型Steering控制器初始化完成');
    } catch (error) {
      this.error('初始化失败', error as Error);
      throw error;
    }
  }

  /**
   * 设置消息队列
   */
  private setupMessageQueue(): void {
    // 监听队列中的消息事件
    setImmediate(this.processMessageQueue.bind(this));
  }

  /**
   * 消息队列处理循环
   */
  private async processMessageQueue(): Promise<void> {
    while (this.isInitialized) {
      try {
        const message = await this.messageQueue.pop();
        await this.handleMessage(message);
      } catch (error) {
        this.error('处理消息队列时出错', error as Error);
        await new Promise((resolve) => setTimeout(resolve, 100)); // 短暂延迟后重试
      }
    }
  }

  /**
   * 处理单个消息事件
   */
  private async handleMessage(message: MessageEvent): Promise<void> {
    switch (message.type) {
      case 'steering':
        await this.handleSteeringMessage(
          message as MessageEvent & { payload: SteeringDirection }
        );
        break;
      case 'status':
        this.handleStatusMessage(message);
        break;
      case 'error':
        this.handleErrorMessage(message);
        break;
      default:
        this.log(`未知消息类型: ${message.type}`);
    }
  }

  /**
   * 启用任务拦截
   */
  private enableTaskInterception(): void {
    this.log('任务拦截机制已启用');
  }

  /**
   * 启动实时控制循环
   */
  private startSteeringLoop(): void {
    if (this.isSteeringLoopActive) {
      return;
    }

    this.isSteeringLoopActive = true;
    this.steeringLoopInterval = setInterval(() => {
      this.executeSteeringLoopCycle();
    }, 50); // 每50ms检查一次，确保<100ms响应时间

    this.log('实时控制循环已启动');
  }

  /**
   * 执行控制循环周期
   */
  private executeSteeringLoopCycle(): void {
    // 检查当前任务状态
    this.checkActiveTasks();

    // 处理高优先级消息
    this.processHighPriorityMessages();
  }

  /**
   * 检查活动任务状态
   */
  private checkActiveTasks(): void {
    for (const [taskId, task] of this.activeTasks) {
      if (task.metadata) {
        const timeoutThreshold = 30000; // 30秒超时
        const startTime = Number(task.metadata.startTime || 0);

        if (Date.now() - startTime > timeoutThreshold) {
          this.emit('taskTimeout', { taskId, task });
          this.activeTasks.delete(taskId);
        }
      }
    }
  }

  /**
   * 处理高优先级消息
   */
  private processHighPriorityMessages(): void {
    while (this.messageQueue.size() > 0) {
      const message = this.messageQueue.peek();
      if (!message || message.priority !== 'high') {
        break; // 只处理高优先级消息
      }

      this.messageQueue.pop();
      // 已移出队列的消息将在下一个处理循环中处理
    }
  }

  /**
   * 处理Steering控制消息
   */
  private async handleSteeringMessage(
    message: MessageEvent & { payload: SteeringDirection }
  ): Promise<void> {
    const direction = message.payload;

    switch (direction.type) {
      case 'pause':
        await this.pauseTask(direction.targetTaskId);
        break;
      case 'resume':
        await this.resumeTask(direction.targetTaskId);
        break;
      case 'redirect':
        await this.redirectTask(direction.targetTaskId!, direction);
        break;
      case 'cancel':
        await this.cancelTask(direction.targetTaskId);
        break;
      case 'priority_adjust':
        await this.adjustTaskPriority(direction.targetTaskId!, direction.priority!);
        break;
    }

    this.emit('steeringExecuted', { direction, timestamp: Date.now() });
  }

  /**
   * 暂停任务
   */
  private async pauseTask(taskId?: string): Promise<void> {
    if (!taskId) {
      // 暂停所有任务
      for (const [id] of this.activeTasks) {
        this.emit('taskPaused', { taskId: id });
      }
    } else {
      if (this.activeTasks.has(taskId)) {
        this.emit('taskPaused', { taskId });
      }
    }
  }

  /**
   * 恢复任务
   */
  private async resumeTask(taskId?: string): Promise<void> {
    if (!taskId) {
      // 恢复所有任务
      for (const [id] of this.activeTasks) {
        this.emit('taskResumed', { taskId: id });
      }
    } else {
      if (this.activeTasks.has(taskId)) {
        this.emit('taskResumed', { taskId });
      }
    }
  }

  /**
   * 取消任务
   */
  private async cancelTask(taskId?: string): Promise<void> {
    if (!taskId) {
      // 取消所有任务
      for (const [id] of this.activeTasks) {
        this.activeTasks.delete(id);
        this.emit('taskCancelled', { taskId: id });
      }
    } else {
      if (this.activeTasks.has(taskId)) {
        this.activeTasks.delete(taskId);
        this.emit('taskCancelled', { taskId });
      }
    }
  }

  /**
   * 调整任务优先级
   */
  private async adjustTaskPriority(taskId: string, newPriority: number): Promise<void> {
    const task = this.activeTasks.get(taskId);
    if (task) {
      task.priority = newPriority;
      this.emit('taskPriorityAdjusted', { taskId, newPriority });
    }
  }

  /**
   * 拦截并重定向任务 - 核心功能
   */
  public async interceptAndRedirect(
    currentTask: AgentTask,
    newDirection: SteeringDirection
  ): Promise<TaskRedirectResult> {
    const startTime = Date.now();

    try {
      // 检查是否可以拦截
      if (!this.taskInterceptor.canIntercept(currentTask)) {
        throw new Error(`任务 ${currentTask.id} 当前状态不可拦截`);
      }

      // 执行拦截
      const interceptedTask = await this.taskInterceptor.intercept(currentTask);
      if (!interceptedTask) {
        throw new Error(`任务 ${currentTask.id} 拦截失败`);
      }

      // 创建重定向结果
      let newTask: AgentTask | undefined;
      if (newDirection.newTask) {
        newTask = newDirection.newTask;
        this.emit('taskRedirected', {
          originalTaskId: currentTask.id,
          newTaskId: newTask.id,
          reason: newDirection.reason,
        });
      }

      // 从任务管理中移除原任务
      this.activeTasks.delete(currentTask.id);

      // 添加到历史记录
      this.addToTaskHistory(currentTask);

      return {
        success: true,
        originalTask: interceptedTask,
        newTask,
        redirectTime: Date.now() - startTime,
      };
    } catch (error) {
      this.error(`任务重定向失败: ${currentTask.id}`, error as Error);
      return {
        success: false,
        originalTask: currentTask,
        redirectTime: Date.now() - startTime,
        error: (error as Error).message,
      };
    }
  }

  /**
   * 向任务队列发送Steering指令
   */
  public sendSteeringCommand(
    direction: SteeringDirection,
    priority: 'high' | 'medium' | 'low' = 'medium'
  ): void {
    const messageEvent: MessageEvent = {
      id: this.generateMessageId(),
      type: 'steering',
      payload: direction,
      timestamp: Date.now(),
      priority,
    };

    this.messageQueue.push(messageEvent);
  }

  /**
   * 注册活动任务
   */
  public registerActiveTask(task: AgentTask): void {
    this.activeTasks.set(task.id, {
      ...task,
      metadata: {
        ...task.metadata,
        startTime: Date.now(),
      },
    });

    this.emit('taskRegistered', { taskId: task.id, task });
  }

  /**
   * 注销活动任务
   */
  public unregisterActiveTask(taskId: string): void {
    const task = this.activeTasks.get(taskId);
    if (task) {
      this.activeTasks.delete(taskId);
      this.addToTaskHistory(task);
      this.emit('taskUnregistered', { taskId, task });
    }
  }

  /**
   * 获取活动任务列表
   */
  public getActiveTasks(): AgentTask[] {
    return Array.from(this.activeTasks.values());
  }

  /**
   * 获取历史任务
   */
  public getTaskHistory(limit = 50): AgentTask[] {
    return this.taskHistory.slice(-limit);
  }

  /**
   * 添加到历史记录
   */
  private addToTaskHistory(task: AgentTask): void {
    this.taskHistory.push({ ...task });

    // 保持历史记录大小在限制范围内
    if (this.taskHistory.length > this.maxHistorySize) {
      this.taskHistory.shift();
    }
  }

  /**
   * 获取控制器状态
   */
  public getStatus(): {
    initialized: boolean;
    steeringLoopActive: boolean;
    messageQueueSize: number;
    activeTaskCount: number;
    taskHistoryCount: number;
  } {
    return {
      initialized: this.isInitialized,
      steeringLoopActive: this.isSteeringLoopActive,
      messageQueueSize: this.messageQueue.size(),
      activeTaskCount: this.activeTasks.size,
      taskHistoryCount: this.taskHistory.length,
    };
  }

  /**
   * 销毁控制器
   */
  public async destroy(): Promise<void> {
    this.log('销毁增强型Steering控制器...');

    try {
      this.isInitialized = false;
      this.isSteeringLoopActive = false;

      if (this.steeringLoopInterval) {
        clearInterval(this.steeringLoopInterval);
        this.steeringLoopInterval = undefined;
      }

      this.activeTasks.clear();
      this.taskHistory.length = 0;
      this.messageQueue.clear();

      this.removeAllListeners();
      this.log('增强型Steering控制器已销毁');
    } catch (error) {
      this.error('销毁失败', error as Error);
      throw error;
    }
  }

  private handleStatusMessage(message: MessageEvent): void {
    this.emit('statusUpdate', message.payload);
  }

  private handleErrorMessage(message: MessageEvent): void {
    this.emit('errorOccurred', message.payload);
  }

  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private log(message: string, data?: unknown): void {
    console.log(`[EnhancedSteeringController] ${message}`, data || '');
  }

  private error(message: string, error?: Error): void {
    console.error(`[EnhancedSteeringController] ${message}`, error || '');
  }

  private async redirectTask(targetTaskId: string, direction: SteeringDirection): Promise<void> {
    const task = this.activeTasks.get(targetTaskId);
    if (!task) {
      this.error(`Target task not found: ${targetTaskId}`);
      return;
    }

    this.log(`Redirecting task ${targetTaskId}`, direction);

    // Remove from active tasks
    this.activeTasks.delete(targetTaskId);

    // Add to history
    this.addToTaskHistory(task);

    // Emit redirect event
    this.emit('taskRedirected', {
      originalTaskId: targetTaskId,
      reason: direction.reason || 'Task redirected',
    });
  }
}
