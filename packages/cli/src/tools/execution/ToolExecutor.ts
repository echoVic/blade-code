import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { PermissionConfig } from '../../config/types.js';
import { PermissionMode } from '../../config/types.js';
import { HookManager } from '../../hooks/HookManager.js';
import type { LspSessionManager } from '../../lsp/LspSessionManager.js';
import { getCwd } from '../../utils/cwd.js';
import type { ToolRegistry } from '../registry/ToolRegistry.js';
import type {
  ExecutionContext,
  ExecutionHistoryEntry,
  ToolResult,
} from '../types/index.js';
import { ToolErrorType } from '../types/index.js';
import type { AutoVerifyRuntime } from './AutoVerify.js';
import {
  type ConcurrencyLimits,
  ConcurrencyScheduler,
} from './ConcurrencyScheduler.js';
import { FileLockManager } from './FileLockManager.js';
import { PermissionResolver, resolvePermissionDecision } from './PermissionResolver.js';
import {
  InMemorySessionApprovalStore,
  type SessionApprovalStore,
} from './SessionApprovalStore.js';
import { ToolApprovalController } from './ToolApprovalController.js';
import { ToolConcurrencyGate } from './ToolConcurrencyGate.js';
import { enforceWorktreeIsolation, validateToolCall } from './ToolExecutionGuards.js';
import { runPostToolUseHooks, runPreToolUseHooks } from './ToolExecutionHooks.js';
import {
  createCancellationResult,
  createRejectedResult,
} from './ToolExecutionResults.js';
import { executeToolInvocation, formatToolResult } from './ToolInvocationRunner.js';

interface ToolExecutorEventMap {
  executionStarted: [
    event: {
      executionId: string;
      toolName: string;
      params: Record<string, unknown>;
      context: ExecutionContext;
      timestamp: number;
    },
  ];
  executionCompleted: [
    event: {
      executionId: string;
      toolName: string;
      result: ToolResult;
      duration: number;
      timestamp: number;
    },
  ];
  executionFailed: [
    event: {
      executionId: string;
      toolName: string;
      error: Error;
      duration: number;
      timestamp: number;
    },
  ];
  historyClear: [event: { timestamp: number }];
}

export class ToolExecutor extends EventEmitter<ToolExecutorEventMap> {
  private readonly executionHistory: ExecutionHistoryEntry[] = [];
  private readonly maxHistorySize: number;
  private readonly scheduler: ConcurrencyScheduler;
  private readonly toolWhitelist: ReadonlySet<string> | null;
  private readonly toolBlacklist: ReadonlySet<string> | null;
  private readonly permissionResolver: PermissionResolver;
  private readonly approvalController: ToolApprovalController;
  private readonly concurrencyGate = new ToolConcurrencyGate();
  private readonly contextDefaults: ExecutionContext;
  private readonly autoVerifyRuntime?: AutoVerifyRuntime;
  private readonly lspManager?: LspSessionManager;
  private readonly onDispose?: () => void;
  private disposed = false;

  constructor(
    private readonly registry: ToolRegistry,
    config: ToolExecutorConfig = {}
  ) {
    super();

    this.maxHistorySize = config.maxHistorySize ?? 1000;
    this.contextDefaults = config.contextDefaults ?? {};
    this.autoVerifyRuntime = config.autoVerifyRuntime;
    this.lspManager = config.lspManager;
    this.onDispose = config.onDispose;
    this.toolWhitelist = config.toolWhitelist?.length
      ? new Set(config.toolWhitelist)
      : null;
    this.toolBlacklist = config.toolBlacklist?.length
      ? new Set(config.toolBlacklist)
      : null;
    this.scheduler =
      config.scheduler ??
      (config.concurrencyLimits
        ? new ConcurrencyScheduler(config.concurrencyLimits)
        : ConcurrencyScheduler.getInstance());

    const approvalStore = config.approvalStore ?? new InMemorySessionApprovalStore();
    this.permissionResolver = new PermissionResolver(
      config.permissionConfig ?? { allow: [], ask: [], deny: [] },
      approvalStore,
      config.permissionMode ?? PermissionMode.DEFAULT
    );
    this.approvalController = new ToolApprovalController(
      approvalStore,
      this.permissionResolver.getPermissionChecker()
    );
  }

  async execute(
    toolName: string,
    params: Record<string, unknown>,
    context: ExecutionContext
  ): Promise<ToolResult> {
    const startTime = Date.now();
    const executionId = `exec_${randomUUID()}`;
    const executionContext: ExecutionContext = {
      ...this.contextDefaults,
      ...context,
      sessionId: context.sessionId ?? this.contextDefaults.sessionId ?? executionId,
      environment: {
        ...this.contextDefaults.environment,
        ...context.environment,
      },
    };

    this.emit('executionStarted', {
      executionId,
      toolName,
      params,
      context: executionContext,
      timestamp: startTime,
    });

    return this.executeFlow(toolName, params, executionContext, executionId, startTime);
  }

  private async executeFlow(
    toolName: string,
    initialParams: Record<string, unknown>,
    context: ExecutionContext,
    executionId: string,
    startTime: number
  ): Promise<ToolResult> {
    let resolvedParams = initialParams;
    try {
      const result = await this.runTool(
        toolName,
        initialParams,
        context,
        executionId,
        (params) => {
          resolvedParams = params;
        }
      );
      this.completeExecution(
        executionId,
        toolName,
        resolvedParams,
        context,
        result,
        startTime
      );
      return result;
    } catch (error) {
      return this.failExecution(
        executionId,
        toolName,
        resolvedParams,
        context,
        error,
        startTime
      );
    }
  }

  private async runTool(
    toolName: string,
    initialParams: Record<string, unknown>,
    context: ExecutionContext,
    executionId: string,
    onParamsResolved: (params: Record<string, unknown>) => void
  ): Promise<ToolResult> {
    if (context.signal?.aborted) {
      return createCancellationResult(true);
    }

    const tool = this.registry.get(toolName);
    if (!tool) {
      return createRejectedResult(`Tool "${toolName}" not found`, {
        errorType: ToolErrorType.VALIDATION_ERROR,
      });
    }

    const validation = validateToolCall(
      tool,
      initialParams,
      this.toolWhitelist,
      this.toolBlacklist
    );
    if ('success' in validation) {
      return validation;
    }

    return this.concurrencyGate.run(
      tool.parallelism === 'shared' ||
        (tool.parallelism === undefined && tool.isConcurrencySafe),
      async () => {
        if (context.signal?.aborted) {
          return createCancellationResult(true);
        }

        let { params, invocation } = validation;
        const isolationRejection = await enforceWorktreeIsolation(
          tool,
          params,
          context,
          invocation
        );
        if (isolationRejection) {
          return isolationRejection;
        }

        let rulePermission = this.permissionResolver.resolveRulePermission(
          tool,
          invocation,
          params,
          context
        );
        const hookResult = await runPreToolUseHooks(
          tool,
          params,
          invocation,
          context,
          rulePermission.decision
        );
        if (hookResult.rejection) {
          return hookResult.rejection;
        }

        params = hookResult.params;
        invocation = hookResult.invocation;
        onParamsResolved(params);
        if (hookResult.inputModified) {
          const modifiedInputIsolationRejection = await enforceWorktreeIsolation(
            tool,
            params,
            context,
            invocation
          );
          if (modifiedInputIsolationRejection) {
            return modifiedInputIsolationRejection;
          }
          rulePermission = this.permissionResolver.resolveRulePermission(
            tool,
            invocation,
            params,
            context
          );
        }

        const decision = resolvePermissionDecision(
          rulePermission.decision,
          hookResult.decision
        );
        if (decision.behavior === 'deny') {
          return createRejectedResult(
            decision.reason ||
              `Tool invocation denied by ${decision.source}${
                decision.matchedRule ? ` (${decision.matchedRule})` : ''
              }`,
            { errorType: ToolErrorType.PERMISSION_DENIED }
          );
        }

        const approvalRejection = await this.approvalController.confirmIfNeeded(
          tool,
          invocation,
          params,
          decision,
          rulePermission.signature,
          context
        );
        if (approvalRejection) {
          return approvalRejection;
        }
        if (context.signal?.aborted) {
          return createCancellationResult(true);
        }

        let invocationStarted = false;
        const executeInvocation = () => {
          if (context.signal?.aborted) {
            return Promise.resolve(createCancellationResult(true));
          }
          invocationStarted = true;
          return executeToolInvocation(invocation, context);
        };
        const lockPath = params.file_path ?? params.notebook_path;
        const executeWithLock =
          !tool.isConcurrencySafe && lockPath
            ? () =>
                FileLockManager.getInstance().acquireLock(
                  String(lockPath),
                  executeInvocation
                )
            : executeInvocation;
        const result = await this.scheduler.schedule(tool.kind, executeWithLock);
        if (context.signal?.aborted) {
          return createCancellationResult(!invocationStarted);
        }

        await runPostToolUseHooks(tool, params, result, context, hookResult.toolUseId);
        if (context.signal?.aborted) {
          return createCancellationResult(false);
        }

        await this.lspManager?.afterToolUse(tool.name, params, result, context);
        if (context.signal?.aborted) {
          return createCancellationResult(false);
        }
        await this.autoVerifyRuntime?.verify(tool.name, params, context, result);
        if (context.signal?.aborted) {
          return createCancellationResult(false);
        }
        return formatToolResult(result, executionId, tool.name);
      },
      context.signal,
      () => createCancellationResult(true)
    );
  }

  private completeExecution(
    executionId: string,
    toolName: string,
    params: Record<string, unknown>,
    context: ExecutionContext,
    result: ToolResult,
    startTime: number
  ): void {
    const endTime = Date.now();
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
  }

  private async failExecution(
    executionId: string,
    toolName: string,
    params: Record<string, unknown>,
    context: ExecutionContext,
    error: unknown,
    startTime: number
  ): Promise<ToolResult> {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    const endTime = Date.now();
    const isTimeout =
      normalizedError.message.includes('timeout') ||
      normalizedError.name === 'TimeoutError';
    let result: ToolResult = {
      success: false,
      llmContent: `Tool execution failed: ${normalizedError.message}`,
      error: {
        type: isTimeout ? ToolErrorType.TIMEOUT_ERROR : ToolErrorType.EXECUTION_ERROR,
        message: normalizedError.message,
      },
    };

    try {
      const hookResult = await HookManager.getInstance().executePostToolUseFailureHooks(
        toolName,
        `tool_use_${executionId}`,
        params,
        normalizedError.message,
        {
          projectDir: context.workspaceRoot || getCwd(),
          sessionId: context.sessionId || 'unknown',
          permissionMode: context.permissionMode || PermissionMode.DEFAULT,
          isInterrupt: false,
          isTimeout,
          abortSignal: context.signal,
        }
      );
      if (hookResult.additionalContext) {
        result = {
          ...result,
          llmContent: `${result.llmContent}\n\n${hookResult.additionalContext}`,
        };
      }
      if (hookResult.warning) {
        console.warn(
          `[ToolExecutor] PostToolUseFailure hook warning: ${hookResult.warning}`
        );
      }
    } catch (hookError) {
      console.warn(
        '[ToolExecutor] PostToolUseFailure hook execution failed:',
        hookError
      );
    }

    this.addToHistory({
      executionId,
      toolName,
      params,
      result,
      startTime,
      endTime,
      context,
    });
    this.emit('executionFailed', {
      executionId,
      toolName,
      error: normalizedError,
      duration: endTime - startTime,
      timestamp: endTime,
    });
    return result;
  }

  async executeAll(
    requests: Array<{
      toolName: string;
      params: Record<string, unknown>;
      context: ExecutionContext;
    }>
  ): Promise<ToolResult[]> {
    return Promise.all(
      requests.map((request) =>
        this.execute(request.toolName, request.params, request.context)
      )
    );
  }

  async executeParallel(
    requests: Array<{
      toolName: string;
      params: Record<string, unknown>;
      context: ExecutionContext;
    }>,
    maxConcurrency = 5
  ): Promise<ToolResult[]> {
    const limit = maxConcurrency > 0 ? maxConcurrency : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(limit) || limit >= requests.length) {
      return this.executeAll(requests);
    }

    const results: ToolResult[] = new Array(requests.length);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < requests.length) {
        const currentIndex = nextIndex++;
        const request = requests[currentIndex];
        results[currentIndex] = await this.execute(
          request.toolName,
          request.params,
          request.context
        );
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(limit, requests.length) }, () => worker())
    );
    return results;
  }

  getSchedulerStats() {
    return this.scheduler.getStats();
  }

  getExecutionHistory(limit?: number): ExecutionHistoryEntry[] {
    return limit ? this.executionHistory.slice(-limit) : [...this.executionHistory];
  }

  clearHistory(): void {
    this.executionHistory.length = 0;
    this.emit('historyClear', { timestamp: Date.now() });
  }

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
      totalDuration += entry.endTime - entry.startTime;
      stats.toolUsage.set(
        entry.toolName,
        (stats.toolUsage.get(entry.toolName) || 0) + 1
      );
    }

    stats.averageDuration =
      stats.totalExecutions > 0 ? totalDuration / stats.totalExecutions : 0;
    return stats;
  }

  getRegistry(): ToolRegistry {
    return this.registry;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.onDispose?.();
    this.removeAllListeners();
  }

  private addToHistory(entry: ExecutionHistoryEntry): void {
    this.executionHistory.push(entry);
    if (this.executionHistory.length > this.maxHistorySize) {
      this.executionHistory.splice(
        0,
        this.executionHistory.length - this.maxHistorySize
      );
    }
  }
}

export interface ToolExecutorConfig {
  maxHistorySize?: number;
  permissionConfig?: PermissionConfig;
  permissionMode?: PermissionMode;
  approvalStore?: SessionApprovalStore;
  toolWhitelist?: readonly string[];
  toolBlacklist?: readonly string[];
  scheduler?: ConcurrencyScheduler;
  concurrencyLimits?: ConcurrencyLimits;
  contextDefaults?: ExecutionContext;
  autoVerifyRuntime?: AutoVerifyRuntime;
  lspManager?: LspSessionManager;
  onDispose?: () => void;
}

export interface ExecutionStats {
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  averageDuration: number;
  toolUsage: Map<string, number>;
  recentExecutions: ExecutionHistoryEntry[];
}
