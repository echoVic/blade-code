/**
 * SubAgent并行执行系统
 * 实现Claude Code风格的SubAgent隔离并行执行
 */

import { EventEmitter } from 'events';
import type { AgentTask, AgentResponse, SubAgentResult } from './types.js';
import type { Agent } from './Agent.js';
import { ErrorFactory } from '../error/index.js';

export interface IsolatedEnvironment {
  id: string;
  task: AgentTask;
  context: SubAgentContext;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: SubAgentResult;
  error?: Error;
  startTime?: number;
  endTime?: number;
  pid?: number; // 进程/PID信息
}

export interface SubAgentContext {
  workspace: string;
  data: Record<string, unknown>;
  sharedMemory: SharedMemoryAccess;
  isolationLevel: 'full' | 'partial' | 'minimal';
  constraints: IsolationConstraints;
  tokens?: { input: number; output: number };
}

export interface SharedMemoryAccess {
  read: string[];
  write: string[];
  lock: boolean;
}

export interface IsolationConstraints {
  maxExecutionTime: number;
  maxMemoryUsage: number;
  maxCpuUsage: number;
  allowedTools: string[];
  forbiddenOperations: string[];
  sandbox?: boolean;
}

export interface ParallelExecutionOptions {
  maxParallelism?: number;
  isolationLevel?: 'full' | 'partial' | 'minimal';
  enableSharedMemory?: boolean;
  resourceLimits?: ResourceLimits;
  fallbackStrategy?: 'fail_fast' | 'best_effort' | 'ignore';
  monitoring?: boolean;
  healthCheck?: boolean;
}

export interface ResourceLimits {
  maxMemory?: number; // MB
  maxCpu?: number; // CPU核心数
  maxTime?: number; // ms
}

export interface ParallelExecutionResult {
  results: SubAgentResult[];
  failed: FailedSubAgentResult[];
  succeeded: SubAgentResult[];
  executionTime: number;
  parallelEfficiency: number;
  resourceUsage: ResourceUsageStats;
}

export interface FailedSubAgentResult {
  agentName: string;
  taskId: string;
  error: Error;
  isolationId: string;
  executionTime: number;
}

export interface ResourceUsageStats {
  totalMemory: number;
  peakMemory: number;
  totalCpu: number;
  executionTime: number;
  isolationInstances: number;
}

/**
 * SubAgent并行执行器 - 实现并行隔离执行
 */
export class ParallelSubAgentExecutor extends EventEmitter {
  private readonly maxParallelism: number;
  private readonly resourceLimits: ResourceLimits;
  private readonly isInitialized: boolean = false;
  private activeEnvironments = new Map<string, IsolatedEnvironment>();
  private sharedMemory = new Map<string, unknown>();
  private resourceMonitor: ResourceMonitor;

  constructor(options: ParallelExecutionOptions = {}) {
    super();

    this.maxParallelism = options.maxParallelism ?? 5;
    this.resourceLimits = options.resourceLimits || {
      maxMemory: 500, // 500MB
      maxCpu: 2, // 2核心
      maxTime: 120000, // 2分钟
    };

    this.resourceMonitor = new ResourceMonitor(this.resourceLimits);
    
    if (options.monitoring) {
      this.startResourceMonitoring();
    }
  }

  /**
   * 初始化执行器
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      this.log('初始化SubAgent并行执行器...');

      // 建立资源监控器
      await this.resourceMonitor.initialize();

      this.log('SubAgent并行执行器初始化完成');
      this.emit('initialized');
    } catch (error) {
      this.error('执行器初始化失败', error as Error);
      throw error;
    }
  }

  /**
   * 并行执行多个任务
   */
  public async executeInParallel(
    tasks: AgentTask[],
    options?: ParallelExecutionOptions
  ): Promise<ParallelExecutionResult> {
    const startTime = Date.now();
    
    try {
      this.log(`开始并行执行 ${tasks.length} 个任务`);

      // 创建隔离环境
      const isolatedEnvironments = await this.createIsolatedEnvironments(tasks, options);

      // 验证资源约束
      await this.validateResourceConstraints(isolatedEnvironments);

      // 执行并行任务
      const executionPromises = isolatedEnvironments.map(env =>
        this.executeInIsolation(env, options)
      );

      // 使用 allSettled 获取所有执行结果
      const settledResults = await Promise.allSettled(executionPromises);

      // 处理执行结果
      const result = this.processParallelResults(settledResults, startTime);

      this.log(`并行执行完成`, {
        totalTime: result.executionTime,
        succeeded: result.succeeded.length,
        failed: result.failed.length,
        efficiency: result.parallelEfficiency,
      });

      return result;
    } catch (error) {
      this.error('并行执行失败', error as Error);
      throw error;
    }
  }

  /**
   * 创建隔离执行环境
   */
  private async createIsolatedEnvironments(
    tasks: AgentTask[],
    options?: ParallelExecutionOptions
  ): Promise<IsolatedEnvironment[]> {
    const environments: IsolatedEnvironment[] = [];
    const isolationLevel = options?.isolationLevel || 'full';

    for (const task of tasks) {
      const environmentId = this.generateIsolationId(task);
      
      // 创建子代理上下文
      const context = await this.createSubAgentContext(task, options);

      const environment: IsolatedEnvironment = {
        id: environmentId,
        task,
        context,
        status: 'pending',
      };

      environments.push(environment);
      this.activeEnvironments.set(environmentId, environment);
    }

    return environments;
  }

  /**
   * 创建SubAgent上下文
   */
  private async createSubAgentContext(
    task: AgentTask,
    options?: ParallelExecutionOptions
  ): Promise<SubAgentContext> {
    const isolationLevel = options?.isolationLevel || 'full';
    const enableSharedMemory = options?.enableSharedMemory ?? false;

    // 创建独立工作空间
    const workspace = await this.createIsolatedWorkspace(task, isolationLevel);

    // 设置共享内存访问
    const sharedMemoryAccess: SharedMemoryAccess = {
      read: enableSharedMemory ? ['common_data'] : [],
      write: enableSharedMemory ? ['result_data'] : [],
      lock: false,
    };

    // 设置隔离约束
    const constraints: IsolationConstraints = {
      maxExecutionTime: this.resourceLimits.maxTime || 120000,
      maxMemoryUsage: this.resourceLimits.maxMemory || 500,
      maxCpuUsage: this.resourceLimits.maxCpu || 2,
      allowedTools: this.getTaskAllowedTools(task),
      forbiddenOperations: ['system_call', 'network_raw'], // 禁止潜在危险操作
      sandbox: isolationLevel === 'full',
    };

    return {
      workspace,
      data: task.context || {},
      sharedMemory: sharedMemoryAccess,
      isolationLevel,
      constraints,
    };
  }

  /**
   * 在隔离环境中执行单个任务
   */
  private async executeInIsolation(
    environment: IsolatedEnvironment,
    options?: ParallelExecutionOptions,
  ): Promise<SubAgentResult> {
    const startTime = Date.now();
    const { task, context } = environment;

    try {
      environment.status = 'running';
      environment.startTime = startTime;
      
      this.log(`开始执行隔离任务: ${task.id}`);
      this.emit('taskStarted', { taskId: task.id, isolationId: environment.id });

      // 创建代理实例（轻量级）
      const subAgent = await this.createSubAgent(task, context);

      // 设置执行超时
      const timeout = setTimeout(() => {
        throw new Error(`任务执行超时: ${task.id}`);
      }, context.constraints.maxExecutionTime);

      try {
        // 执行任务
        const response = await this.executeTaskInIsolation(subAgent, task, context);

        clearTimeout(timeout);

        const executionTime = Date.now() - startTime;
        environment.status = 'completed';
        environment.endTime = Date.now();

        const result: SubAgentResult = {
          agentName: task.agentName || 'sub-agent',
          taskType: task.type,
          result: response,
          executionTime,
        };

        environment.result = result;

        this.log(`任务执行成功: ${task.id}`, { executionTime });
        this.emit('taskCompleted', { taskId: task.id, result, executionTime });

        return result;
      } finally {
        // 清理资源
        await this.cleanupSubAgent(subAgent);
      }
    } catch (error) {
      environment.status = 'failed';
      environment.endTime = Date.now();
      environment.error = error as Error;

      this.error(`任务执行失败: ${task.id}`, error as Error);
      this.emit('taskFailed', { taskId: task.id, error });

      throw error;
    } finally {
      this.activeEnvironments.delete(environment.id);
    }
  }

  /**
   * 创建隔离工作空间
   */
  private async createIsolatedWorkspace(task: AgentTask, isolationLevel: string): Promise<string> {
    const taskId = task.id || 'unknown';
    const workspaceId = `subagent_${taskId}_${Date.now()}`;

    switch (isolationLevel) {
      case 'full':
        // 完全隔离：独立的文件系统空间
        return `/tmp/subagent/${workspaceId}`;
      case 'partial':
        // 部分隔离：共享部分资源但有权限限制
        return `/workspace/subagent/${workspaceId}`;
      case 'minimal':
        // 最小隔离：主要靠权限控制
        return `/shared/subagent/${workspaceId}`;
      default:
        throw new Error(`不支持的隔离级别: ${isolationLevel}`);
    }
  }

  /**
   * 创建SubAgent实例
   */
  private async createSubAgent(task: AgentTask, context: SubAgentContext): Promise<Agent> {
    // 基于原始Agent配置创建简化版SubAgent
    // 这里假设Agent类有相应的构造函数
    const subAgentConfig = {
      id: `sub_${task.id}`,
      name: task.agentName || 'sub-agent',
      isolation: context.isolationLevel,
      constraints: context.constraints,
    };

    // 创建Agent实例（具体实现根据现有Agent类调整）
    return new Agent({
      context: context.data,
      workspace: context.workspace,
    });
  }

  /**
   * 在隔离环境中执行任务
   */
  private async executeTaskInIsolation(
    subAgent: Agent,
    task: AgentTask,
    context: SubAgentContext
  ): Promise<unknown> {
    // 设置资源限制
    const resourceController = new ResourceController(context.constraints);

    try {
      // 挂载共享内存
      if (context.sharedMemory.read.length > 0) {
        await this.mountSharedMemory(subAgent, context.sharedMemory.read, 'read');
      }

      // 执行任务
      const result = await resourceController.executeWithLimits(async () => {
        // 模拟执行（实际应该调用Agent的执行逻辑）
        return await subAgent.executeTask(task);
      });

      // 写回结果到共享内存
      if (context.sharedMemory.write.length > 0) {
        await this.writeSharedMemory(result, context.sharedMemory.write);
      }

      return result;
    } finally {
      // 清理资源限制
      await resourceController.cleanup();
    }
  }

  /**
   * 验证资源约束
   */
  private async validateResourceConstraints(environments: IsolatedEnvironment[]): Promise<void> {
    const totalResources = this.calculateTotalResourceRequirements(environments);
    const availableResources = await this.resourceMonitor.getAvailableResources();

    // 检查内存限制
    if (totalResources.totalMemory > availableResources.availableMemory) {
      throw new Error(`内存不足: 需要 ${totalResources.totalMemory}MB, 可用 ${availableResources.availableMemory}MB`);
    }

    // 检查CPU限制
    if (totalResources.totalCpu > availableResources.availableCpu) {
      throw new Error(`CPU核心数不足: 需要 ${totalResources.totalCpu}, 可用 ${availableResources.availableCpu}`);
    }

    // 检查并行数量限制
    if (environments.length > this.maxParallelism) {
      throw new Error(`超过最大并行数: ${environments.length} > ${this.maxParallelism}`);
    }

    this.log('资源约束验证通过', totalResources);
  }

  /**
   * 计算总资源需求
   */
  private calculateTotalResourceRequirements(environments: IsolatedEnvironment[]): {
    totalMemory: number;
    totalCpu: number;
    totalTime: number;
  } {
    let totalMemory = 0;
    let totalCpu = 0;
    let totalTime = 0;

    for (const env of environments) {
      totalMemory += env.context.constraints.maxMemoryUsage;
      totalCpu += env.context.constraints.maxCpuUsage;
      totalTime += env.context.constraints.maxExecutionTime;
    }

    return { totalMemory, totalCpu, totalTime };
  }

  /**
   * 处理并行执行结果
   */
  private processParallelResults(
    settledResults: PromiseSettledResult<SubAgentResult>[],
    startTime: number
  ): ParallelExecutionResult {
    const results: SubAgentResult[] = [];
    const failed: FailedSubAgentResult[] = [];
    const succeeded: SubAgentResult[] = [];
    let totalExecutionTime = 0;

    for (let i = 0; i < settledResults.length; i++) {
      const result = settledResults[i];
      
      if (result.status === 'fulfilled') {
        const successResult = result.value;
        results.push(successResult);
        succeeded.push(successResult);
        totalExecutionTime += successResult.executionTime;
      } else {
        const reason = result.reason as Error;
        const task = this.getTaskFromSettledIndex(i);
        const isolationId = task?.id || 'unknown';
        
        const failedResult: FailedSubAgentResult = {
          agentName: task?.agentName || 'unknown',
          taskId: task?.id || 'unknown',
          error: reason,
          isolationId,
          executionTime: Date.now() - startTime,
        };

        failed.push(failedResult);
      }
    }

    const overallExecutionTime = Date.now() - startTime;
    const parallelEfficiency = succeeded.length / settledResults.length;
    
    const resourceUsage = this.resourceMonitor.getResourceUsageStats();

    return {
      results,
      failed,
      succeeded,
      executionTime: overallExecutionTime,
      parallelEfficiency,
      resourceUsage,
    };
  }

  /**
   * 获取任务（根据索引）
   */
  private getTaskFromSettledIndex(index: number): AgentTask | undefined {
    const environments = Array.from(this.activeEnvironments.values());
    return environments[index]?.task;
  }

  /**
   * 启动资源监控
   */
  private startResourceMonitoring(): void {
    this.resourceMonitor.start();
    this.log('资源监控已启动');
  }

  /**
   * 停止资源监控
   */
  private stopResourceMonitoring(): void {
    this.resourceMonitor.stop();
    this.log('资源监控已停止');
  }

  /**
   * 挂载共享内存
   */
  private async mountSharedMemory(agent: Agent, keys: string[], access: 'read' | 'write'): Promise<void> {
    for (const key of keys) {
      if (this.sharedMemory.has(key)) {
        // 将共享内存数据注入代理上下文
        const data = this.sharedMemory.get(key);
        // TODO: 实现具体的内存挂载逻辑
      }
    }
  }

  /**
   * 写入共享内存
   */
  private async writeSharedMemory(data: unknown, keys: string[]): Promise<void> {
    for (const key of keys) {
      this.sharedMemory.set(key, data);
    }
  }

  /**
   * 获取任务允许的工具列表
   */
  private getTaskAllowedTools(task: AgentTask): string[] {
    // 根据任务类型和安全策略返回允许的工具
    return ['*']; // 默认允许所有工具
  }

  /**
   * 清理SubAgent资源
   */
  private async cleanupSubAgent(subAgent: Agent): Promise<void> {
    // 清理代理相关资源
    if (subAgent && typeof subAgent.destroy === 'function') {
      await subAgent.destroy();
    }
  }

  /**
   * 生成隔离ID
   */
  private generateIsolationId(task: AgentTask): string {
    return `iso_${task.id}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private log(message: string, data?: unknown): void {
    console.log(`[ParallelSubAgentExecutor] ${message}`, data || '');
  }

  private error(message: string, error?: Error): void {
    console.error(`[ParallelSubAgentExecutor] ${message}`, error || '');
  }
}

/**
 * 资源监控器
 */
class ResourceMonitor {
  private isActive = false;
  private monitoringInterval?: NodeJS.Timeout;
  private readonly resourceLimits: ResourceLimits;
  private resourceUsage: ResourceUsageStats = {
    totalMemory: 0,
    peakMemory: 0,
    totalCpu: 0,
    executionTime: 0,
    isolationInstances: 0,
  };

  constructor(resourceLimits: ResourceLimits) {
    this.resourceLimits = resourceLimits;
  }

  async initialize(): Promise<void> {
    // 初始化资源监控
  }

  start(): void {
    if (this.isActive) return;

    this.isActive = true;
    this.monitoringInterval = setInterval(() => {
      this.updateResourceStats();
    }, 1000); // 每秒更新一次
  }

  stop(): void {
    if (!this.isActive) return;

    this.isActive = false;
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
  }

  async getAvailableResources(): Promise<{
    availableMemory: number;
    availableCpu: number;
  }> {
    // 模拟获取可用资源（实际需要读取系统信息）
    return {
      availableMemory: (this.resourceLimits.maxMemory || 2000) - this.resourceUsage.totalMemory,
      availableCpu: (this.resourceLimits.maxCpu || 4) - this.resourceUsage.totalCpu,
    };
  }

  getResourceUsageStats(): ResourceUsageStats {
    return { ...this.resourceUsage };
  }

  updateIsolationInstance(change: number): void {
    this.resourceUsage.isolationInstances += change;
    if (change > 0) {
      this.resourceUsage.totalMemory += 100; // 每个实例约100MB
      this.resourceUsage.totalCpu += 0.5; // 每个实例约0.5个CPU
    } else {
      this.resourceUsage.totalMemory = Math.max(0, this.resourceUsage.totalMemory - 100);
      this.resourceUsage.totalCpu = Math.max(0, this.resourceUsage.totalCpu - 0.5);
    }
    
    this.resourceUsage.peakMemory = Math.max(this.resourceUsage.peakMemory, this.resourceUsage.totalMemory);
  }

  private updateResourceStats(): void {
    this.resourceUsage.executionTime += 1; // 每秒加1秒
    // 这里可以添加更复杂的资源监控逻辑
  }
}

/**
 * 资源控制器
 */
class ResourceController {
  private readonly constraints: IsolationConstraints;

  constructor(constraints: IsolationConstraints) {
    this.constraints = constraints;
  }

  async executeWithLimits<T>(operation: () => Promise<T>): Promise<T> {
    // 在实际环境中，这里应该设置资源限制
    // 比如使用cgroup等机制
    
    try {
      return await operation();
    } catch (error) {
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    // 清理资源限制
  }
}