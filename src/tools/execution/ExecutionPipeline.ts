import { EventEmitter } from 'events';
import type { PermissionConfig } from '../../config/types.js';
import { PermissionMode } from '../../config/types.js';
import type { ToolRegistry } from '../registry/ToolRegistry.js';
import { ToolExecution as ToolExecutionImpl } from '../types/ExecutionTypes.js';
import type {
  ExecutionContext,
  ExecutionHistoryEntry,
  PipelineStage,
  ToolResult,
} from '../types/index.js';
import { ToolErrorType } from '../types/ToolTypes.js';
import {
  ConfirmationStage,
  DiscoveryStage,
  ExecutionStage,
  FormattingStage,
  PermissionStage,
} from './PipelineStages.js';

/**
 * 5阶段执行管道
 * 实现Claude Code的执行管道架构
 */
export class ExecutionPipeline extends EventEmitter {
  private stages: PipelineStage[];
  private executionHistory: ExecutionHistoryEntry[] = [];
  private readonly maxHistorySize: number;
  private readonly sessionApprovals = new Set<string>();

  constructor(
    private registry: ToolRegistry,
    config: ExecutionPipelineConfig = {}
  ) {
    super();

    this.maxHistorySize = config.maxHistorySize || 1000;

    // 使用提供的权限配置或默认配置
    const permissionConfig: PermissionConfig = config.permissionConfig || {
      allow: [],
      ask: [],
      deny: [],
    };
    const permissionMode = config.permissionMode ?? PermissionMode.DEFAULT;

    // 初始化5个执行阶段
    this.stages = [
      new DiscoveryStage(this.registry), // 工具发现
      new PermissionStage(permissionConfig, this.sessionApprovals, permissionMode), // 权限检查（含 Zod 验证和默认值处理）
      new ConfirmationStage(this.sessionApprovals), // 用户确认
      new ExecutionStage(), // 实际执行
      new FormattingStage(), // 结果格式化
    ];
  }

  /**
   * 执行工具
   */
  async execute(
    toolName: string,
    params: unknown,
    context: ExecutionContext
  ): Promise<ToolResult> {
    const startTime = Date.now();
    const executionId = this.generateExecutionId();

    // 创建执行实例
    const execution = new ToolExecutionImpl(toolName, params, {
      ...context,
      sessionId: context.sessionId || executionId,
    });

    this.emit('executionStarted', {
      executionId,
      toolName,
      params,
      context,
      timestamp: startTime,
    });

    try {
      // 依次执行各个阶段
      for (const stage of this.stages) {
        this.emit('stageStarted', {
          executionId,
          stageName: stage.name,
          timestamp: Date.now(),
        });

        await stage.process(execution);

        this.emit('stageCompleted', {
          executionId,
          stageName: stage.name,
          timestamp: Date.now(),
        });

        // 检查是否应该中止
        if (execution.shouldAbort()) {
          break;
        }
      }

      const result = execution.getResult();
      const endTime = Date.now();

      // 记录执行历史
      this.addToHistory({
        executionId,
        toolName,
        params,
        result,
        startTime,
        endTime,
        context,
      });

      this.emit('executionCompleted', {
        executionId,
        toolName,
        result,
        duration: endTime - startTime,
        timestamp: endTime,
      });

      return result;
    } catch (error) {
      const errorResult: ToolResult = {
        success: false,
        llmContent: `工具执行失败: ${(error as Error).message}`,
        displayContent: `错误: ${(error as Error).message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: (error as Error).message,
        },
      };

      const endTime = Date.now();

      this.addToHistory({
        executionId,
        toolName,
        params,
        result: errorResult,
        startTime,
        endTime,
        context,
      });

      this.emit('executionFailed', {
        executionId,
        toolName,
        error,
        duration: endTime - startTime,
        timestamp: endTime,
      });

      return errorResult;
    }
  }

  /**
   * 批量执行工具
   */
  async executeAll(
    requests: Array<{
      toolName: string;
      params: unknown;
      context: ExecutionContext;
    }>
  ): Promise<ToolResult[]> {
    const promises = requests.map((request) =>
      this.execute(request.toolName, request.params, request.context)
    );

    return Promise.all(promises);
  }

  /**
   * 并行执行工具（带并发控制）
   */
  async executeParallel(
    requests: Array<{
      toolName: string;
      params: unknown;
      context: ExecutionContext;
    }>,
    maxConcurrency: number = 5
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    const executing: Promise<ToolResult>[] = [];

    for (let i = 0; i < requests.length; i++) {
      const request = requests[i];
      const promise = this.execute(request.toolName, request.params, request.context);

      executing.push(promise);

      // 控制并发数量
      if (executing.length >= maxConcurrency || i === requests.length - 1) {
        const batchResults = await Promise.all(executing);
        results.push(...batchResults);
        executing.length = 0; // 清空数组
      }
    }

    return results;
  }

  /**
   * 获取执行历史
   */
  getExecutionHistory(limit?: number): ExecutionHistoryEntry[] {
    const history = [...this.executionHistory];
    return limit ? history.slice(-limit) : history;
  }

  /**
   * 清空执行历史
   */
  clearHistory(): void {
    this.executionHistory = [];
    this.emit('historyClear', { timestamp: Date.now() });
  }

  /**
   * 获取执行统计
   */
  getStats(): ExecutionStats {
    const stats: ExecutionStats = {
      totalExecutions: this.executionHistory.length,
      successfulExecutions: 0,
      failedExecutions: 0,
      averageDuration: 0,
      toolUsage: new Map(),
      recentExecutions: this.executionHistory.slice(-10),
    };

    let totalDuration = 0;

    for (const entry of this.executionHistory) {
      if (entry.result.success) {
        stats.successfulExecutions++;
      } else {
        stats.failedExecutions++;
      }

      const duration = entry.endTime - entry.startTime;
      totalDuration += duration;

      // 统计工具使用情况
      const currentCount = stats.toolUsage.get(entry.toolName) || 0;
      stats.toolUsage.set(entry.toolName, currentCount + 1);
    }

    stats.averageDuration =
      stats.totalExecutions > 0 ? totalDuration / stats.totalExecutions : 0;

    return stats;
  }

  /**
   * 添加自定义阶段
   */
  addStage(stage: PipelineStage, position: number = -1): void {
    if (position === -1) {
      // 插入到执行阶段之前
      const executionIndex = this.stages.findIndex((s) => s.name === 'execution');
      this.stages.splice(executionIndex, 0, stage);
    } else {
      this.stages.splice(position, 0, stage);
    }

    this.emit('stageAdded', {
      stageName: stage.name,
      position,
      timestamp: Date.now(),
    });
  }

  /**
   * 移除阶段
   */
  removeStage(stageName: string): boolean {
    const index = this.stages.findIndex((s) => s.name === stageName);
    if (index === -1) {
      return false;
    }

    this.stages.splice(index, 1);

    this.emit('stageRemoved', {
      stageName,
      timestamp: Date.now(),
    });

    return true;
  }

  /**
   * 获取阶段列表
   */
  getStages(): PipelineStage[] {
    return [...this.stages];
  }

  /**
   * 获取工具注册表（用于工具管理）
   */
  getRegistry(): ToolRegistry {
    return this.registry;
  }

  /**
   * 生成执行ID
   */
  private generateExecutionId(): string {
    return `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 添加到历史记录
   */
  private addToHistory(entry: ExecutionHistoryEntry): void {
    this.executionHistory.push(entry);

    // 限制历史记录大小
    if (this.executionHistory.length > this.maxHistorySize) {
      this.executionHistory = this.executionHistory.slice(-this.maxHistorySize);
    }
  }
}

/**
 * 执行管道配置
 */
export interface ExecutionPipelineConfig {
  maxHistorySize?: number;
  enableMetrics?: boolean;
  customStages?: PipelineStage[];
  permissionConfig?: PermissionConfig;
  permissionMode?: PermissionMode;
}

/**
 * 执行统计信息
 */
export interface ExecutionStats {
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  averageDuration: number;
  toolUsage: Map<string, number>;
  recentExecutions: ExecutionHistoryEntry[];
}
