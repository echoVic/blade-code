import { EventEmitter } from 'events';
import type { PermissionConfig } from '../../config/types.js';
import { getCwd } from '../../utils/cwd.js';
import { PermissionMode } from '../../config/types.js';
import { HookManager } from '../../hooks/HookManager.js';
import { HookStage } from '../../hooks/HookStage.js';
import { PostToolUseHookStage } from '../../hooks/PostToolUseHookStage.js';
import type { ToolRegistry } from '../registry/ToolRegistry.js';
import { ToolExecution as ToolExecutionImpl } from '../types/ExecutionTypes.js';
import type {
  ExecutionContext,
  ExecutionHistoryEntry,
  PipelineStage,
  ToolResult,
} from '../types/index.js';
import { ToolErrorType, ToolKind } from '../types/ToolTypes.js';
import { FileLockManager } from './FileLockManager.js';
import {
  ConcurrencyScheduler,
  type ConcurrencyLimits,
} from './ConcurrencyScheduler.js';
import {
  InMemorySessionApprovalStore,
  type SessionApprovalStore,
} from './SessionApprovalStore.js';
import {
  ConfirmationStage,
  DiscoveryStage,
  ExecutionStage,
  FormattingStage,
} from './PipelineStages.js';
import { AutoVerifyStage } from './AutoVerifyStage.js';
import { ValidationStage } from './stages/ValidationStage.js';
import { RuleBasedPermissionStage } from './stages/RuleBasedPermissionStage.js';
import { ResolveDecisionStage } from './stages/ResolveDecisionStage.js';

/**
 * 10阶段执行管道
 * Discovery -> Validation -> RulePermission -> Hook(Pre) -> ResolveDecision
 *   -> Confirmation -> Execution -> PostHook -> AutoVerify -> Formatting
 */
export class ExecutionPipeline extends EventEmitter {
  private stages: PipelineStage[];
  private executionHistory: ExecutionHistoryEntry[] = [];
  private readonly maxHistorySize: number;
  private readonly sessionApprovals: SessionApprovalStore;
  private readonly scheduler: ConcurrencyScheduler;

  constructor(
    private registry: ToolRegistry,
    config: ExecutionPipelineConfig = {}
  ) {
    super();

    this.maxHistorySize = config.maxHistorySize || 1000;
    this.sessionApprovals =
      config.approvalStore || new InMemorySessionApprovalStore();
    // scheduler 选择策略:
    // - 显式传 scheduler: 完全尊重调用方
    // - 传 concurrencyLimits: 建立本 pipeline 独立实例 (opt-in 隔离)
    // - 什么都不传: 默认用进程级单例, 多 pipeline/多 agent 共享限流配额
    this.scheduler =
      config.scheduler ??
      (config.concurrencyLimits
        ? new ConcurrencyScheduler(config.concurrencyLimits)
        : ConcurrencyScheduler.getInstance());

    // 使用提供的权限配置或默认配置
    const permissionConfig: PermissionConfig = config.permissionConfig || {
      allow: [],
      ask: [],
      deny: [],
    };
    const permissionMode = config.permissionMode ?? PermissionMode.DEFAULT;

    // 拆分原 PermissionStage 为三个独立 Stage + 新增决策仲裁 Stage
    const rulePermissionStage = new RuleBasedPermissionStage(
      permissionConfig,
      this.sessionApprovals,
      permissionMode
    );

    this.stages = [
      new DiscoveryStage(this.registry), // 工具发现
      new ValidationStage(config.toolWhitelist, config.toolBlacklist), // 黑白名单 + Zod 验证
      rulePermissionStage, // 规则库权限检查 + 模式 + 会话批准 + 安全检查 → ruleDecision
      new HookStage(), // PreToolUse hooks → hookDecision
      new ResolveDecisionStage(), // 仲裁 ruleDecision ⊕ hookDecision → effectiveDecision
      new ConfirmationStage(
        this.sessionApprovals,
        rulePermissionStage.getPermissionChecker()
      ), // 用户确认 (仅当 effectiveDecision = ask)
      new ExecutionStage(), // 实际执行
      new PostToolUseHookStage(), // PostToolUse hooks
      new AutoVerifyStage(), // 自动类型检查验证
      new FormattingStage(), // 结果格式化
    ];
  }

  /**
   * 执行工具
   */
  async execute(
    toolName: string,
    params: Record<string, unknown>,
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

    // 检查工具是否需要文件锁
    const tool = this.registry.get(toolName);
    const needsFileLock = tool && !tool.isConcurrencySafe;
    const filePath =
      needsFileLock && params.file_path ? String(params.file_path) : null;

    // 运行策略:
    // 1. FileLockManager: 同文件写操作串行 (独立于桶配额)
    // 2. ConcurrencyScheduler: 按 ToolKind 桶限流 (readonly ∞ / execute 限 3)
    // 先过 scheduler,再在桶内走 file lock 或直接执行
    const kind = tool?.kind ?? ToolKind.ReadOnly;
    const runPipeline = () =>
      this.executeWithPipeline(execution, executionId, startTime);
    const runWithLock =
      needsFileLock && filePath
        ? () => FileLockManager.getInstance().acquireLock(filePath, runPipeline)
        : runPipeline;

    return this.scheduler.schedule(kind, runWithLock);
  }

  /**
   * 通过管道执行工具（内部方法）
   */
  private async executeWithPipeline(
    execution: ToolExecutionImpl,
    executionId: string,
    startTime: number
  ): Promise<ToolResult> {
    try {
      // 依次执行各个阶段
      // Plan 模式 只读工具通过权限阶段自动放行，非只读工具走权限确认流程
      for (const stage of this.stages) {
        // 检查取消信号
        if (execution.context.signal?.aborted) {
          execution.abort('任务已被用户中止', {
            shouldExitLoop: true,
            llmContent: '任务已被用户中止',
            summary: '任务已被用户中止',
            abortedBeforeLaunch: true,
          });
          break;
        }

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
        toolName: execution.toolName,
        params: execution.params,
        result,
        startTime,
        endTime,
        context: execution.context,
      });

      this.emit('executionCompleted', {
        executionId,
        toolName: execution.toolName,
        result,
        duration: endTime - startTime,
        timestamp: endTime,
      });

      return result;
    } catch (error) {
      const endTime = Date.now();
      const isTimeout =
        (error as Error).message?.includes('timeout') ||
        (error as Error).name === 'TimeoutError';

      // 构建错误结果
      let errorResult: ToolResult = {
        success: false,
        llmContent: `Tool execution failed: ${(error as Error).message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: (error as Error).message,
        },
      };

      // 执行 PostToolUseFailure Hook
      try {
        const hookManager = HookManager.getInstance();
        const hookResult = await hookManager.executePostToolUseFailureHooks(
          execution.toolName,
          `tool_use_${executionId}`,
          execution.params,
          (error as Error).message,
          {
            projectDir: getCwd(),
            sessionId: execution.context.sessionId || 'unknown',
            permissionMode:
              (execution.context.permissionMode as PermissionMode) ||
              PermissionMode.DEFAULT,
            isInterrupt: false,
            isTimeout,
            abortSignal: execution.context.signal,
          }
        );

        // 如果 hook 返回 additionalContext，附加到错误信息
        if (hookResult.additionalContext) {
          errorResult = {
            ...errorResult,
            llmContent: `${errorResult.llmContent}\n\n${hookResult.additionalContext}`,
          };
        }

        // 如果有警告，记录日志
        if (hookResult.warning) {
          console.warn(
            `[ExecutionPipeline] PostToolUseFailure hook warning: ${hookResult.warning}`
          );
        }
      } catch (hookError) {
        // Hook 执行失败不应阻止错误处理
        console.warn(
          '[ExecutionPipeline] PostToolUseFailure hook execution failed:',
          hookError
        );
      }

      this.addToHistory({
        executionId,
        toolName: execution.toolName,
        params: execution.params,
        result: errorResult,
        startTime,
        endTime,
        context: execution.context,
      });

      this.emit('executionFailed', {
        executionId,
        toolName: execution.toolName,
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
      params: Record<string, unknown>;
      context: ExecutionContext;
    }>
  ): Promise<ToolResult[]> {
    const promises = requests.map((request) =>
      this.execute(request.toolName, request.params, request.context)
    );

    return Promise.all(promises);
  }

  /**
   * 并行执行工具
   *
   * 两层并发控制 (正交):
   * 1. 本批次上限 `maxConcurrency`: batch-level 信号量, 限制同时派发的请求数
   * 2. 桶配额: ConcurrencyScheduler 按 ToolKind 分桶限流 + FileLockManager 同文件串行
   *
   * 即使本批次派发过去, 仍会在 scheduler 桶内排队。
   * `maxConcurrency <= 0` 视为无上限。
   */
  async executeParallel(
    requests: Array<{
      toolName: string;
      params: Record<string, unknown>;
      context: ExecutionContext;
    }>,
    maxConcurrency: number = 5
  ): Promise<ToolResult[]> {
    const limit =
      maxConcurrency > 0 ? maxConcurrency : Number.POSITIVE_INFINITY;

    // 无上限: 直接全部派发
    if (!Number.isFinite(limit) || limit >= requests.length) {
      return Promise.all(
        requests.map((r) => this.execute(r.toolName, r.params, r.context))
      );
    }

    // 有上限: FIFO 信号量, 结果按原始顺序返回
    const results: ToolResult[] = new Array(requests.length);
    let nextIdx = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const i = nextIdx++;
        if (i >= requests.length) return;
        const r = requests[i];
        results[i] = await this.execute(r.toolName, r.params, r.context);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(limit, requests.length) }, () => worker())
    );

    return results;
  }

  /** 获取 scheduler 状态(用于监控/测试) */
  getSchedulerStats() {
    return this.scheduler.getStats();
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
  approvalStore?: SessionApprovalStore;
  toolWhitelist?: readonly string[];
  toolBlacklist?: readonly string[];
  /** 自定义并发调度器; 不传则创建新实例 */
  scheduler?: ConcurrencyScheduler;
  /** 并发桶配额覆盖; 仅在未提供 scheduler 时生效 */
  concurrencyLimits?: ConcurrencyLimits;
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
